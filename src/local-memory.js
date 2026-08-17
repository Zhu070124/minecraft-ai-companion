/**
 * 本地记忆库（开源版默认）—— 单模型调用，零外部依赖
 *
 * 区别于 memory.js（MemoryClient 依赖外部 Memory Hub 服务），
 * 本模块是项目内自带的轻量记忆：
 *   - 存储：JSON 文件（data/memory.json），每条带 lens 分类
 *   - 检索：复用 DeepSeek（单模型）判断哪些记忆与当前对话相关
 *   - 降级：LLM 检索失败时退回关键词匹配，保证不崩
 *
 * API 与 MemoryClient 对齐（search / remember / profile），
 * 所以 router 无需改动，只需在 index.js 选择用哪个实现。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(__dirname, "..", "data", "memory.json");

export class LocalMemory {
  constructor(config = {}) {
    this.llmApiKey = config.llmApiKey;
    this.llmBaseUrl = config.llmBaseUrl ?? "https://api.deepseek.com";
    this.llmModel = config.llmModel ?? "deepseek-chat";
    this.agentName = config.agentName ?? "mc-companion";
    this.path = config.path ?? DEFAULT_PATH;
    this.maxCandidates = config.maxCandidates ?? 30; // 检索候选上限（太旧的不参与）
    this.maxSelfEntries = config.maxSelfEntries ?? 20; // self 认知上限（自我认知是演化的，不无限累积）
    this.forgetAfterDays = config.forgetAfterDays ?? 14; // 旧且未被使用的非重要记忆，超过此天数被遗忘
    this._cache = null; // 内存缓存，避免每次读写全量磁盘 JSON
  }

  // ─── 存储层 ─────────────────────────────────────────────

  _load() {
    if (this._cache) return this._cache; // 命中内存缓存，不重复读盘
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ memories: [] }, null, 2), "utf-8");
    }
    try {
      this._cache = JSON.parse(readFileSync(this.path, "utf-8"));
    } catch {
      this._cache = { memories: [] };
    }
    return this._cache;
  }

  _save(store) {
    this._cache = store; // 同步更新缓存
    writeFileSync(this.path, JSON.stringify(store, null, 2), "utf-8");
  }

  // ─── 公共 API（对齐 MemoryClient）───────────────────────

  /**
   * 写入一条记忆
   * @param {string} content
   * @param {object} opts - { lens, confidence, priority, tags }
   */
  async remember(content, opts = {}) {
    const store = this._load();
    const lens = opts.lens ?? "general";

    // ── self 治理：相似去重 + 上限（自我认知是演化的，不是无限累积）──
    if (lens === "self") {
      const selfEntries = store.memories.filter((m) => m.lens === "self");
      // 相似去重（bigram Dice 系数 > 0.6 视为已存在，不写）
      if (selfEntries.some((m) => this._similar(m.content, content) > 0.6)) {
        return { id: null, status: "duplicate" };
      }
      // 超上限一次性清到 maxSelfEntries-1，为新写入腾位（否则历史累积清不掉）
      if (selfEntries.length >= this.maxSelfEntries) {
        const toDelete = selfEntries.length - (this.maxSelfEntries - 1);
        for (let i = 0; i < toDelete; i++) {
          const oldestIdx = store.memories.findIndex((m) => m.lens === "self");
          if (oldestIdx >= 0) store.memories.splice(oldestIdx, 1);
        }
      }
    }

    const entry = {
      id: `m_${Date.now()}_${store.memories.length}`,
      content: content.slice(0, 500),
      source: this.agentName,
      lens,
      confidence: opts.confidence ?? "observed",
      priority: opts.priority ?? "P1",
      tags: opts.tags ?? [],
      links: opts.links ?? [], // 关联记忆 id（认知⇄事件 的因果链）
      access_count: 0,
      last_accessed: null,
      created_at: new Date().toISOString(),
    };
    store.memories.push(entry);
    this._gc(store); // 懒 GC：遗忘「旧且未被使用」的低价值记忆（真人会忘）
    this._save(store);
    return { id: entry.id, status: "recorded" };
  }

  /**
   * 检索与 query 相关的记忆
   * 单模型：调 DeepSeek 让 LLM 从候选里挑相关的
   */
  async search(query, lens = null) {
    const store = this._load();
    let candidates = store.memories;
    if (lens) candidates = candidates.filter(m => m.lens === lens);
    candidates = candidates.slice(-this.maxCandidates).reverse(); // 最近的在前

    if (candidates.length === 0) return [];

    let picked;
    try {
      const relevantIds = await this._llmRetrieve(query, candidates);
      picked = candidates.filter(m => relevantIds.includes(m.id));
      if (picked.length === 0) picked = this._keywordSearch(query, candidates);
    } catch (err) {
      // LLM 检索失败 → 降级关键词匹配
      console.error("[Memory] LLM 检索失败，降级关键词:", err.message);
      picked = this._keywordSearch(query, candidates);
    }

    // 访问追踪：命中即 +1 并更新最后访问时间（供 GC 判断「是否还在用」）
    const nowIso = new Date().toISOString();
    for (const m of picked) {
      m.access_count = (m.access_count ?? 0) + 1;
      m.last_accessed = nowIso;
    }
    this._save(store);

    // 一跳扩散：带出命中记忆 link 的关联记忆（认知 ⇄ 事件的因果链）
    const result = [...picked];
    const seen = new Set(picked.map((m) => m.id));
    for (const m of picked) {
      for (const linkId of (m.links ?? [])) {
        if (typeof linkId !== "string" || seen.has(linkId)) continue;
        const linked = store.memories.find((x) => x.id === linkId);
        if (linked) { result.push(linked); seen.add(linkId); }
      }
    }
    return result;
  }

  /** 按 lens 拉画像 */
  async profile(lens = null) {
    const store = this._load();
    const filtered = lens ? store.memories.filter(m => m.lens === lens) : store.memories;
    return filtered.slice(-20).reverse();
  }

  /** 消解未满足：某个动作做成了，移除对应「想做没做成」的牵挂 */
  async resolveUnfinished(action) {
    if (!action) return { resolved: false };
    const store = this._load();
    const idx = store.memories.findIndex((m) => m.lens === "unfinished" && (m.content ?? "").includes(action));
    if (idx >= 0) {
      store.memories.splice(idx, 1);
      this._save(store);
      return { resolved: true };
    }
    return { resolved: false };
  }

  // ─── 检索：DeepSeek 单模型 ───────────────────────────────

  async _llmRetrieve(query, candidates) {
    const tools = [{
      type: "function",
      function: {
        name: "select_memories",
        description: "从候选记忆中选出与玩家当前说的话相关的记忆（最多 5 条），没有相关的就返回空数组",
        parameters: {
          type: "object",
          properties: {
            relevant_ids: {
              type: "array",
              items: { type: "string" },
              description: "相关记忆的 id 列表",
            },
          },
          required: ["relevant_ids"],
        },
      },
    }];

    const candidateText = candidates.map(m => `[${m.id}] (${m.lens}) ${m.content}`).join("\n");

    const messages = [
      { role: "system", content: "你是记忆检索器。根据玩家当前说的话，从候选记忆中选出真正相关的（最多 5 条）。无关的不要选，宁缺毋滥。没有相关的就返回空数组。" },
      { role: "user", content: `玩家当前说：${query}\n\n候选记忆：\n${candidateText}` },
    ];

    const res = await fetch(`${this.llmBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.llmApiKey}`,
      },
      body: JSON.stringify({
        model: this.llmModel,
        messages,
        max_tokens: 200,
        temperature: 0,
        tools,
        tool_choice: { type: "function", function: { name: "select_memories" } },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`LLM ${res.status}`);
    }

    const data = await res.json();
    const toolCalls = data.choices?.[0]?.message?.tool_calls ?? [];
    for (const call of toolCalls) {
      if (call?.function?.name === "select_memories") {
        try {
          const args = JSON.parse(call.function.arguments);
          return Array.isArray(args.relevant_ids) ? args.relevant_ids : [];
        } catch (err) {
          console.error("[Memory] 解析 select_memories 参数失败:", err.message);
          return [];
        }
      }
    }
    return [];
  }

  // ─── 降级：关键词匹配 ───────────────────────────────────

  _keywordSearch(query, candidates) {
    const q = (query ?? "").toLowerCase();
    return candidates
      .filter(m => m.content.toLowerCase().includes(q) || (m.tags ?? []).some(t => String(t).toLowerCase().includes(q)))
      .slice(0, 5);
  }

  // ─── 生命周期：遗忘（真人会忘，记忆不无限累积）────────────────

  /**
   * 懒 GC：遗忘「旧 + 从未被使用 + 非重要」的记忆
   * 保留：self（有专门治理）、P0（重要）、被 link 引用、新鲜期内、被访问过的
   */
  _gc(store, now = Date.now()) {
    const DAY = 24 * 60 * 60 * 1000;
    const MAX = 1000;

    // 被 link 引用的 id（删了会导致认知的因果链悬空）
    const linkedIds = new Set();
    for (const m of store.memories) {
      for (const l of (m.links ?? [])) if (typeof l === "string") linkedIds.add(l);
    }

    const before = store.memories.length;

    // 1. 遗忘：旧 + 从未被访问 + 非 P0 + 非 self + 未被 link
    store.memories = store.memories.filter((m) => {
      if (m.lens === "self") return true;                 // self 有专门治理
      if (m.priority === "P0") return true;               // 重要永不自动遗忘
      if (linkedIds.has(m.id)) return true;               // 被因果链引用，不删
      const age = now - new Date(m.created_at).getTime();
      if (age < this.forgetAfterDays * DAY) return true;  // 新鲜期内不忘
      if ((m.access_count ?? 0) >= 2) return true;        // 被用过的留着
      return false;                                       // 旧 + 未用 + 非重要 → 遗忘
    });

    // 2. 硬上限兜底：仍超 MAX 就从最旧开始丢（跳过 self 和被 link 的）
    if (store.memories.length > MAX) {
      let overflow = store.memories.length - MAX;
      for (let i = 0; i < store.memories.length && overflow > 0; i++) {
        const m = store.memories[i];
        if (m.lens === "self" || linkedIds.has(m.id)) continue;
        store.memories.splice(i, 1);
        i--; overflow--;
      }
    }

    const forgotten = before - store.memories.length;
    if (forgotten > 0) {
      console.log(`[Memory] 遗忘 ${forgotten} 条旧且未被使用的记忆`);
    }
  }

  // ─── 相似度：bigram Dice 系数（用于 self 相似去重）────────────

  _similar(a, b) {
    const bigrams = (s) => {
      const set = new Set();
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      return set;
    };
    const A = bigrams(a ?? "");
    const B = bigrams(b ?? "");
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return (2 * inter) / (A.size + B.size);
  }
}
