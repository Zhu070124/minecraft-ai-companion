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
  }

  // ─── 存储层 ─────────────────────────────────────────────

  _load() {
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ memories: [] }, null, 2), "utf-8");
    }
    try {
      return JSON.parse(readFileSync(this.path, "utf-8"));
    } catch {
      return { memories: [] };
    }
  }

  _save(store) {
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
    const entry = {
      id: `m_${Date.now()}_${store.memories.length}`,
      content: content.slice(0, 500),
      source: this.agentName,
      lens: opts.lens ?? "general",
      confidence: opts.confidence ?? "observed",
      priority: opts.priority ?? "P1",
      tags: opts.tags ?? [],
      created_at: new Date().toISOString(),
    };
    store.memories.push(entry);
    // 控制总量，太旧的丢弃（轻量库不无限膨胀）
    if (store.memories.length > 200) store.memories = store.memories.slice(-200);
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

    try {
      const relevantIds = await this._llmRetrieve(query, candidates);
      const picked = candidates.filter(m => relevantIds.includes(m.id));
      return picked.length > 0 ? picked : this._keywordSearch(query, candidates);
    } catch (err) {
      // LLM 检索失败 → 降级关键词匹配
      console.error("[Memory] LLM 检索失败，降级关键词:", err.message);
      return this._keywordSearch(query, candidates);
    }
  }

  /** 按 lens 拉画像 */
  async profile(lens = null) {
    const store = this._load();
    const filtered = lens ? store.memories.filter(m => m.lens === lens) : store.memories;
    return filtered.slice(-20).reverse();
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
        tool_choice: "auto",
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
        const args = JSON.parse(call.function.arguments);
        return Array.isArray(args.relevant_ids) ? args.relevant_ids : [];
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
}
