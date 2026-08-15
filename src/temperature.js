/**
 * Tempura Engine — JavaScript port
 * 驱动 AI 队友对你的态度：0-100 温度，事件驱动，言行解耦
 *
 * API 兼容原版 Python Tempura Engine:
 *   apply(event) → delta
 *   stage → {id, label, desc}
 *   describe() → "label(value)"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(__dirname, "..", "data", "temperature.json");

const STAGES = [
  { id: "cold",     label: "冷漠", min:  0, max: 20, desc: "公事公办，不多说一个字" },
  { id: "cool",     label: "疏离", min: 21, max: 40, desc: "简短回复，不带情绪" },
  { id: "neutral",  label: "平常", min: 41, max: 60, desc: "正常对话，不冷不热" },
  { id: "warm",     label: "亲近", min: 61, max: 80, desc: "主动分享，回忆上次话题" },
  { id: "attached", label: "依恋", min: 81, max: 100, desc: "信任、舍不得你走" },
];

// 基础事件 delta（与原版 Tempura 兼容）
const DEFAULT_EVENTS = {
  daily_first:     3,
  praised:         8,
  ignored:        -10,
  midnight:        15,
  daily_decay:     -2,
  swear:          -20,
  fed:              5,
  starving:       -10,
  // MC 特有事件
  rescued:         12,   // 你救了他
  betrayed:       -25,   // 你坑了他（推岩浆等）
  gift_received:    7,   // 收到礼物
  friendly_fire:  -10,   // 你误伤他
  mine_helped:      5,   // 你帮他挖矿
  build_together:   4,   // 一起盖东西
  afk_too_long:    -3,   // 你挂机太久
  greeted_back:     3,   // 你回应了他的招呼
};

// 记仇配置：严重事件会持续降温
const DEFAULT_GRUDGE_CONFIG = {
  betrayed:       { label: "坑过我",       dailyDecay: 2,  durationDays: 7 },
  friendly_fire:  { label: "打过我",       dailyDecay: 1,  durationDays: 2 },
  killed_pet:     { label: "杀了我的宠物", dailyDecay: 1,  durationDays: 14 },
};

export class TemperatureEngine {
  /**
   * @param {object} config
   * @param {number} config.startValue - 初始温度 (默认 50)
   * @param {object} config.events - 自定义事件 delta
   * @param {object} config.grudges - 自定义记仇事件
   * @param {boolean} config.grudgeEnabled - 是否启用记仇
   * @param {number} config.grudgeDecayPerDay - 记仇每天消退点数
   */
  constructor(config = {}) {
    this.value = config.startValue ?? 50;
    this.events = { ...DEFAULT_EVENTS, ...config.events };
    this.grudgeConfig = { ...DEFAULT_GRUDGE_CONFIG, ...config.grudges };
    this.grudgeEnabled = config.grudgeEnabled !== false;
    this.grudgeDecayPerDay = config.grudgeDecayPerDay ?? 2;
    this.activeGrudges = config.initialGrudges ?? [];
    this.history = [];
    this.path = config.path ?? DEFAULT_PATH;
    this._load(); // 加载持久化的情感态（覆盖 startValue）
  }

  // ─── 公共 API（兼容原版 Tempura）──────────────────────────

  /** 应用一个事件，返回 delta */
  apply(event) {
    let delta = this.events[event] ?? 0;

    // 记仇事件：记录到活跃列表
    if (this.grudgeEnabled && this.grudgeConfig[event]) {
      const gc = this.grudgeConfig[event];
      const expiresAt = Date.now() + gc.durationDays * 86400_000;
      this.activeGrudges.push({
        event,
        label: gc.label,
        expiresAt,
        dailyDecay: gc.dailyDecay,
      });
    }

    this.cleanGrudges();
    this.value = Math.max(0, Math.min(100, this.value + delta));
    this.history.push({ event, delta, value: Math.round(this.value), ts: Date.now() });
    this._save();
    return delta;
  }

  /** 应用一个原始 delta（反思反哺等非事件来源） */
  nudge(delta) {
    this.value = Math.max(0, Math.min(100, this.value + delta));
    this.history.push({ event: "reflection", delta, value: Math.round(this.value), ts: Date.now() });
    this._save();
    return delta;
  }

  /** 从磁盘加载情感态（跨重启存续） */
  _load() {
    try {
      if (existsSync(this.path)) {
        const data = JSON.parse(readFileSync(this.path, "utf-8"));
        if (data && typeof data.value === "number") {
          this.value = data.value;
          this.activeGrudges = data.activeGrudges ?? [];
          this.history = data.history ?? [];
        }
      }
    } catch (err) {
      console.error("[Tempura] 加载失败，用初始值:", err.message);
    }
  }

  /** 把情感态写入磁盘 */
  _save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.serialize()), "utf-8");
    } catch (err) {
      console.error("[Tempura] 持久化失败:", err.message);
    }
  }

  /** 当前阶段 */
  get stage() {
    for (const s of STAGES) {
      if (this.value >= s.min && this.value <= s.max) return { ...s };
    }
    return { ...STAGES[0] };
  }

  /** 可读描述 */
  describe() {
    return `${this.stage.label}(${Math.round(this.value)})`;
  }

  /** 当前活跃的记仇列表 */
  get grudges() {
    return this.activeGrudges.filter(g => g.expiresAt > Date.now());
  }

  // ─── 维护 ─────────────────────────────────────────────────

  cleanGrudges() {
    this.activeGrudges = this.activeGrudges.filter(g => g.expiresAt > Date.now());
  }

  /** 每天调用一次，让记仇降温 + 自然衰减 */
  dailyTick() {
    this.cleanGrudges();
    // 每条活跃记仇每天降温 dailyDecay 点
    const grudgePenalty = this.activeGrudges.reduce((sum, g) => sum + g.dailyDecay, 0);
    // 注：记仇到期由 cleanGrudges/grudges 的 Date.now() > expiresAt 判断，这里不再手动改 expiresAt
    this.value = Math.max(0, Math.min(100, this.value - grudgePenalty));
    // 自然衰减（从事件表取，不经过 apply 避免递归）
    const decay = this.events["daily_decay"] ?? -2;
    this.value = Math.max(0, Math.min(100, this.value + decay));
    this.history.push({ event: "daily_tick", delta: -(grudgePenalty - decay), value: Math.round(this.value), ts: Date.now() });
    this._save();
  }

  // ─── 序列化 ───────────────────────────────────────────────

  serialize() {
    return {
      value: this.value,
      activeGrudges: this.activeGrudges.map(g => ({ ...g })),
      history: this.history.slice(-100),
    };
  }

  /** 从序列化数据恢复 */
  static deserialize(data, config) {
    const engine = new TemperatureEngine(config);
    if (data) {
      engine.value = data.value ?? 50;
      engine.activeGrudges = data.activeGrudges ?? [];
      engine.history = data.history ?? [];
    }
    return engine;
  }
}
