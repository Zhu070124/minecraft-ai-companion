/**
 * Tavily 搜索 Provider
 *
 * 联网搜索建筑教程，返回干净文本给 LLM 解析。
 *
 * 鉴权策略：
 *   - 有 TAVILY_API_KEY 环境变量 → Bearer 鉴权（免费 1000 credits/月）
 *   - 无 key → keyless 模式（X-Tavily-Access-Mode: keyless，限流但免费）
 *
 * API: POST https://api.tavily.com/search
 * 响应: { results: [{ title, url, content }], answer }
 */

const ENDPOINT = "https://api.tavily.com/search";

export class TavilySearch {
  constructor(apiKey = process.env.TAVILY_API_KEY) {
    this.apiKey = apiKey ?? null;
  }

  /**
   * 搜索，返回压缩成文本的结果（适合直接塞进 LLM 上下文）
   * @param {string} query - 搜索词
   * @param {object} opts
   * @param {number} opts.maxResults - 结果数，默认 3（省 token）
   * @param {boolean} opts.includeAnswer - 是否要 LLM 摘要答案，默认 false
   * @returns {Promise<string>} 格式化文本
   */
  async search(query, opts = {}) {
    const maxResults = opts.maxResults ?? 3;
    const includeAnswer = opts.includeAnswer ?? false;

    const headers = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else {
      headers["X-Tavily-Access-Mode"] = "keyless";
    }

    const body = {
      query,
      search_depth: "basic",
      max_results: maxResults,
      include_answer: includeAnswer,
      topic: "general",
    };

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Tavily ${res.status}: ${errText.slice(0, 120)}`);
    }

    const data = await res.json();
    return this._format(data, query);
  }

  /** 把响应压成一段紧凑文本，给 LLM 当上下文 */
  _format(data, query) {
    const parts = [];

    if (data.answer) {
      parts.push(`[摘要] ${data.answer}`);
    }

    const results = data.results ?? [];
    if (results.length === 0) {
      return `搜索「${query}」没有结果。`;
    }

    results.forEach((r, i) => {
      const title = r.title ?? "";
      const content = (r.content ?? "").trim();
      parts.push(`[${i + 1}] ${title}\n${content}`);
    });

    return parts.join("\n\n");
  }
}
