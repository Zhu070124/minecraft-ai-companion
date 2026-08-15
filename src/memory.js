/**
 * Memory Hub 客户端
 *
 * 桥接 Node.js Bot Runtime → Python Memory Hub (localhost:8921)
 * 如果 Memory Hub 未启动，fallback 到本地 JSON 文件。
 *
 * API 完全对齐 Memory Hub hub.py:
 *   GET  /search?q=&lens=      → {results: [...], count: N}
 *   GET  /profile?lens=        → {insights: [...], count: N}
 *   POST /insight               → {content, source, lens, confidence, priority, tags}
 *   POST /stale                 → {id}
 *   POST /confirm               → {id}
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_PATH = join(__dirname, "..", "data", "local-memories.json");

export class MemoryClient {
  constructor(config = {}) {
    this.baseUrl = config.memoryHubUrl ?? "http://127.0.0.1:8921";
    this.agentName = config.agentName ?? "mc-companion";
    this.fallbackEnabled = config.localFallback !== false;
    this.online = false;
    this._check();
  }

  async _check() {
    try {
      const res = await fetch(`${this.baseUrl}/sources`, { signal: AbortSignal.timeout(2000) });
      this.online = res.ok;
    } catch { this.online = false; }
  }

  // ─── 对齐 Memory Hub API ──────────────────────────────────

  /**
   * 全文搜索相关记忆
   * GET /search?q=term&lens=
   */
  async search(query, lens = null) {
    const params = new URLSearchParams({ q: query });
    if (lens) params.set("lens", lens);

    if (this.online) {
      try {
        const res = await fetch(`${this.baseUrl}/search?${params}`);
        if (res.ok) {
          const data = await res.json();
          return data.results ?? [];
        }
      } catch { this.online = false; }
    }
    return this._localSearch(query);
  }

  /**
   * 获取用户画像
   * GET /profile?lens=
   */
  async profile(lens = null) {
    const params = lens ? `?lens=${lens}` : "";

    if (this.online) {
      try {
        const res = await fetch(`${this.baseUrl}/profile${params}`);
        if (res.ok) return (await res.json()).insights ?? [];
      } catch { this.online = false; }
    }
    return this._localProfile(lens);
  }

  /**
   * 写入一条记忆
   * POST /insight
   */
  async remember(content, opts = {}) {
    const body = {
      content: content.slice(0, 500),
      source: this.agentName,
      lens: opts.lens ?? "general",
      confidence: opts.confidence ?? "observed",
      priority: opts.priority ?? "P1",
      tags: opts.tags ?? [],
    };

    if (this.online) {
      try {
        const res = await fetch(`${this.baseUrl}/insight`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) return await res.json();
      } catch { this.online = false; }
    }

    // 本地 fallback
    if (this.fallbackEnabled) {
      this._writeLocal(body);
      return { id: null, status: "local_fallback" };
    }
    return null;
  }

  // ─── 本地 fallback ────────────────────────────────────────

  _ensureLocal() {
    if (!existsSync(LOCAL_PATH)) {
      mkdirSync(join(__dirname, "..", "data"), { recursive: true });
      writeFileSync(LOCAL_PATH, JSON.stringify({ memories: [] }, null, 2));
    }
    try {
      return JSON.parse(readFileSync(LOCAL_PATH, "utf-8"));
    } catch {
      return { memories: [] };
    }
  }

  _writeLocal(data) {
    const store = this._ensureLocal();
    store.memories.push({
      ...data,
      id: `local_${Date.now()}`,
      created_at: new Date().toISOString(),
    });
    if (store.memories.length > 200) store.memories = store.memories.slice(-200);
    writeFileSync(LOCAL_PATH, JSON.stringify(store, null, 2));
  }

  _localSearch(query) {
    const store = this._ensureLocal();
    const q = query.toLowerCase();
    return store.memories
      .filter(m => m.content.toLowerCase().includes(q) || (m.tags ?? []).some(t => t.toLowerCase().includes(q)))
      .slice(-10)
      .reverse();
  }

  _localProfile(lens) {
    const store = this._ensureLocal();
    const filtered = lens ? store.memories.filter(m => m.lens === lens) : store.memories;
    return filtered.slice(-20).reverse();
  }
}
