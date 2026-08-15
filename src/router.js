/**
 * Agent Loop 调度器
 *
 * 让 bot 从「被动响应」变成「自主 agent」：
 *   感知 → LLM 决策 → 行动 → 结果进下轮感知 → 循环
 *
 * 决策权在 LLM，温度/记忆/世界状态都是决策输入。
 * 触发方式：事件驱动（玩家说话/受伤/死亡/送礼）+ 定时兜底（每 15 秒自主决策）。
 * 温度实时注入到发给 LLM 的 user 消息首句。
 */

import { buildSystemPrompt } from "./persona.js";
import { BehaviorEngine } from "./behaviors.js";
import { isGift } from "./gifts.js";
import { SnapshotEngine } from "./snapshot.js";
import { TavilySearch } from "./providers/tavily.js";
import { expandPrimitives } from "./blueprint.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SESSION_PATH = join(__dirname, "..", "data", "session.json");

// ─── Function Calling 工具定义 ─────────────────────────────
const TOOLS = [
  { type: "function", function: { name: "move_to_player", description: "走到玩家面前", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "follow_player", description: "跟随玩家走", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "chop_tree", description: "砍附近的树（收集原木）", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "mine", description: "挖附近的矿石", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "collect_block", description: "采集指定方块（如 sand 沙子、clay 黏土、gravel 砂砾）", parameters: { type: "object", properties: { block: { type: "string", description: "方块名，如 sand" } }, required: ["block"] } } },
  { type: "function", function: { name: "place_block", description: "放置方块（放在脚下往上叠，可用于建造/垫高）。会自动检查库存并装备。", parameters: { type: "object", properties: { block: { type: "string", description: "方块名，如 oak_planks 橡木木板、cobblestone 圆石、dirt 泥土" }, count: { type: "integer", description: "放置数量，默认 1" } }, required: ["block"] } } },
  { type: "function", function: { name: "attack_entity", description: "攻击指定生物（如 ender_dragon 末影龙、zombie 僵尸）", parameters: { type: "object", properties: { entity: { type: "string", description: "生物名" } }, required: ["entity"] } } },
  { type: "function", function: { name: "attack_nearest", description: "攻击最近的敌对生物", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "stop", description: "停止当前动作", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "jump", description: "跳一下（用于让开自己身体挡住的方块，或需要跳跃的场景）", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "web_search", description: "联网搜索 Minecraft 建筑教程/攻略，返回文字步骤。当玩家要求建造你没把握的建筑时，先搜教程再动手。", parameters: { type: "object", properties: { query: { type: "string", description: "搜索词，如 minecraft 简易木屋 建造教程" } }, required: ["query"] } } },
  { type: "function", function: { name: "build_structure", description: "按图纸建造。用结构化原语描述建筑（floor 地板/wall 墙/pillar 柱子/box 盒子），代码会自动展开成精确坐标并逐格放置。原语格式见参数说明。", parameters: { type: "object", properties: { primitives: { type: "array", description: "建筑原语数组。floor: {action:'floor',block,size:{x,z},offset:{x,z}} 铺地板；wall: {action:'wall',block,axis:'x'|'z',length,height,offset:{x,y,z}} 砌墙；pillar: {action:'pillar',block,height,offset:{x,z}} 柱子；box: {action:'box',block,size:{x,y,z},hollow:true,offset:{x,y,z}} 空心盒子。offset 相对玩家位置（或玩家指定原点）。", items: { type: "object" } } }, required: ["primitives"] } } },
];

// 反思专用工具：强制结构化输出（自我认知 + 情感变化），LLM 不遵守文本格式，必须 function calling
const REFLECT_TOOL = [
  {
    type: "function",
    function: {
      name: "record_reflection",
      description: "记录一条自我认知和对应的情感变化",
      parameters: {
        type: "object",
        properties: {
          insight: { type: "string", description: "一句具体朴素的自我认知（关于你或你和玩家的关系），不超过20字。禁止元反思（禁止反思「反思」本身）、禁止抽象空转。没有新的认识就填空字符串。" },
          temperature_delta: { type: "integer", description: "情感变化：正数=更亲近/依赖，负数=更疏远，0=无变化，范围 -5 到 +5" },
        },
        required: ["insight", "temperature_delta"],
      },
    },
  },
];

// 信息型工具：执行后结果要回灌 LLM 做下一轮决策（区别于动作型直接执行）
const INFO_TOOLS = new Set(["web_search"]);
const MAX_TOOL_ROUNDS = 4; // 最多几轮工具往返，防止死循环

const AUTO_INTERVAL = 15000;       // 自主决策间隔（15 秒）
const SPEECH_INTERVAL = 120000;    // 自主发言间隔（2 分钟）——决策照跑，但别每 15 秒都开口

/** 安全解析 LLM 返回的 JSON 参数：剥 markdown 代码块 + 容错（LLM 输出不可信） */
function safeJsonParse(str) {
  if (!str) return {};
  let s = String(str).trim();
  s = s.replace(/^```(?:json|javascript|js)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    return null; // 解析失败，调用方据此跳过并记录
  }
}

export class EventRouter {
  constructor(opts) {
    this.bot = opts.bot;
    this.temp = opts.temp;
    this.memory = opts.memory;
    this.soul = opts.soul;
    this.llmApiKey = opts.llmApiKey;
    this.llmBaseUrl = opts.llmBaseUrl ?? "https://api.deepseek.com";
    this.llmModel = opts.llmModel ?? "deepseek-chat";
    this.broadcast = opts.broadcast ?? (() => {});
    this.behaviors = new BehaviorEngine(opts.bot, (result) => this._onActionResult(result));
    this.snapshot = new SnapshotEngine(opts.bot, opts.temp, opts.boundPlayer ?? process.env.BOUND_PLAYER ?? null);
    this.tavily = new TavilySearch(opts.tavilyApiKey);

    this.sessionPath = opts.sessionPath ?? DEFAULT_SESSION_PATH;
    this.events = this._loadSession(); // 追加式对话事件日志（dsh 启发），落盘持久化
    this.recentEvents = [];   // 最近事件（{type, ...}）
    this._decideChain = Promise.resolve(); // 决策串行队列：不丢并发事件
    this.timer = null;
    this.currentAction = "发呆";  // 当前正在做的动作，喂给 LLM 避免它随手打断
    this.lastSpeech = 0;       // 上次发言时间戳（自主发言节流用）
    this._decisionCount = 0;   // 决策计数（每 N 次触发一次慢反思兜底）
    this._reflectEvery = 20;  // 反思兜底间隔（约 5 分钟）
    this._lastReflectAt = 0;  // 上次反思时间戳（冷却用）
    this._reflectCooldown = 90000; // 反思冷却（90 秒，事件驱动 + 定时兜底共用）
    this._lastPlayerInteractionAt = Date.now(); // 上次玩家互动时间（冷场追踪，欲望派生用）
    this._dailyTimer = null;   // 每日 tick 定时器
    this._pendingCount = 0;    // 决策队列里排队的事件数（限长用）
    this.boundPlayer = opts.boundPlayer ?? process.env.BOUND_PLAYER ?? null; // 绑定玩家名（多人服务器用）
  }

  // ─── 生命周期 ─────────────────────────────────────────────

  start() {
    if (this.timer) return;
    this._scheduleNext();
    // 每日 tick：记仇逐日衰减 + 温度自然衰减（每小时检查，距上次超 24h 才跑，重启不重置周期）
    if (!this._dailyTimer) {
      this._dailyTimer = setInterval(() => {
        if (Date.now() - (this.temp.lastDailyTickAt ?? 0) >= 24 * 3600 * 1000) {
          this.temp.dailyTick();
          console.log("[Agent] 每日 tick:", this.temp.describe());
        }
      }, 3600 * 1000);
    }
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this._dailyTimer) { clearInterval(this._dailyTimer); this._dailyTimer = null; }
  }

  _scheduleNext() {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.decide("autonomous").catch(err =>
        console.error("[Agent] 自主决策失败:", err.message)
      );
      this._scheduleNext();
    }, AUTO_INTERVAL);
  }

  // ─── 事件入口 ─────────────────────────────────────────────

  async handle(type, data) {
    switch (type) {
      case "chat":
        if (data.sender === this.bot.username) return;
        this._lastPlayerInteractionAt = Date.now();
        this._pushEvent("chat", data);
        await this.decide("chat", data);
        break;

      case "hurt":
        this._pushEvent("hurt", data);
        if (data.isPlayer) {
          this._lastPlayerInteractionAt = Date.now();
          this.temp.apply("betrayed");
          this._triggerReflect({ trigger: `${this._playerName()}打了我` });
        }
        await this.decide("hurt", data);
        break;

      case "death":
        this.temp.apply("ignored");
        this._pushEvent("death", data);
        this._triggerReflect({ trigger: "我死了" });
        await this.decide("death", data);
        break;

      case "item_drop":
        await this._handleItemDrop(data);
        break;

      case "spawn":
        this.start();
        this.broadcast("status", {
          online: true,
          health: data.health,
          temperature: this.temp.serialize(),
        });
        break;

      case "end":
      case "kicked":
        this.stop();
        this.broadcast("status", { online: false, reason: data.reason });
        break;
    }
  }

  // ─── 核心：决策循环 ───────────────────────────────────────

  async decide(reason, data) {
    // 串行化：每个决策排在上一个后面，绝不丢弃并发事件
    // （原来 isDeciding 会直接 return 丢掉并发来的 chat，导致 bot「不理人」）
    // 队列限长：堆积超过阈值就丢弃低优先级事件（自主/反思），保留玩家核心事件
    if (this._pendingCount >= 30 || (this._pendingCount >= 10 && (reason === "autonomous" || reason === "reflect"))) {
      return Promise.resolve(); // 30 全局硬上限防刷屏堆积；10 起丢低优先级
    }
    this._pendingCount++;
    const run = async () => {
      try { await this._decide(reason, data); }
      finally { this._pendingCount--; }
    };
    this._decideChain = this._decideChain.then(run, run);
    return this._decideChain;
  }

  async _decide(reason, data) {
    try {
      // 反思：同一个 loop 内多一种 reason，不分裂出 meta-agent（主体=对象）
      if (reason === "reflect") {
        await this._reflect(data);
        return;
      }
      // 1. 感知
      const perception = await this._perceive(reason, data);
      // 1.5 玩家消息先入日志（否则信息型工具结果会排到玩家消息前面，顺序错乱）
      if (reason === "chat" && data?.text) {
        this._pushLog({ type: "user", content: data.text });
        // 新指令到来：中断正在执行的长任务（建造/采集/导航），保证 currentAction 与实际一致
        this.behaviors.abort();
        this.currentAction = "发呆";
      }
      // 2. 工具调用循环（每轮从事件日志重新派生消息）
      const { text, actionCalls } = await this._toolLoop(perception);
      // 3. 行动（带 reason，autonomous 的发言会被节流）
      this._execute(text, actionCalls, reason);
      // 4. 计数 + 定时兜底反思（无事件时也会偶尔沉淀）
      this._decisionCount++;
      if (this._decisionCount >= this._reflectEvery) {
        this._decisionCount = 0;
        this._triggerReflect();
      }
    } catch (err) {
      console.error("[Agent] 决策失败:", err.message);
      // LLM 故障降级：玩家说话时至少回一句，别彻底沉默
      if (reason === "chat") {
        this.bot.chat("（我好像有点卡住了，稍等我一下）");
      }
    }
  }

  /**
   * Agentic tool loop：调 LLM → 遇到信息型工具就执行并回灌 → 再调 LLM
   * 直到不再调信息型工具（或到达 MAX_TOOL_ROUNDS）。
   * 信息型工具结果写入事件日志，下一轮 _buildMessages 会重新派生出来。
   * @returns {{text:string|null, actionCalls:Array}} text + 待执行的动作型工具
   */
  async _toolLoop(perception) {
    let text = null;
    const actionCalls = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // 每轮从事件日志重新派生消息（含上一轮信息型工具结果）
      const messages = this._buildMessages(perception);
      const { text: t, toolCalls } = await this._callLLM(messages);
      if (t) text = t; // 保留最后一轮说的话

      if (!toolCalls || toolCalls.length === 0) break;

      const infoCalls = [];
      const actionThisRound = [];
      for (const call of toolCalls) {
        const name = call?.function?.name;
        if (INFO_TOOLS.has(name)) infoCalls.push(call);
        else actionThisRound.push(call);
      }
      // 只保留最后一轮的动作（信息型工具回灌后的最终结论），避免多轮动作堆积冲突
      actionCalls.length = 0;
      actionCalls.push(...actionThisRound);

      // 没有信息型工具了 → 结束循环，交给 _execute
      if (infoCalls.length === 0) break;

      // 信息型工具结果进事件日志（assistant tool_calls + tool 结果成对，deriveMessages 会拼成消息）
      this._pushLog({ type: "assistant", content: null, toolCalls: infoCalls });
      for (const call of infoCalls) {
        const result = await this._runInfoTool(call);
        this._pushLog({ type: "tool", toolCallId: call.id, name: call.function.name, result });
      }
    }

    return { text, actionCalls };
  }

  /** 执行信息型工具，返回要回灌给 LLM 的文本 */
  async _runInfoTool(call) {
    const name = call?.function?.name;
    const args = safeJsonParse(call.function.arguments) ?? {};

    if (name === "web_search") {
      try {
        const result = await this.tavily.search(args.query, { maxResults: 3 });
        console.log("[Agent] web_search:", args.query, "→", result.length, "字符");
        return result;
      } catch (err) {
        console.error("[Agent] web_search 失败:", err.message);
        return `搜索失败：${err.message}`;
      }
    }

    return `未知信息型工具: ${name}`;
  }

  /** 触发一次反思（带 90 秒冷却，事件驱动和定时兜底共用） */
  _triggerReflect(context) {
    const now = Date.now();
    if (now - this._lastReflectAt < this._reflectCooldown) return;
    this._lastReflectAt = now;
    this.decide("reflect", context).catch(() => {});
  }

  /**
   * 慢反思 loop：认知 ⇄ 情感强链接
   * - 输入：触发上下文（哪个温度事件触发）+ 最近事件 + 已有自我认知
   * - 输出：结构化「自我认知 + 情感变化」，认知写 lens:self，情感变化反哺温度
   */
  async _reflect(context) {
    try {
      const self = await this.memory.profile("self").catch(() => []);
      const recent = this.recentEvents.slice(-8).map((e) => `- ${this._formatEvent(e)}`);
      const triggerText = context?.trigger ? `\n【触发这次反思的事】\n${context.trigger}` : "";
      // 没有任何近期经历可反思就跳过（避免空转）
      if (recent.length === 0 && !context?.trigger) return;
      const messages = [
        { role: "system", content: `你是${this.soul.name}。回顾刚刚发生的事，沉淀一条具体的自我认知。调用 record_reflection 工具。` },
        { role: "user", content:
          `【反思时刻】${triggerText}\n最近发生的事：\n${recent.join("\n") || "- （还没发生什么）"}` },
      ];
      const { toolCalls } = await this._callLLM(messages, { tools: REFLECT_TOOL });
      const call = toolCalls?.find((c) => c.function?.name === "record_reflection");
      if (!call) return;
      let args = {};
      try { args = JSON.parse(call.function.arguments); } catch { return; }
      const insight = (args.insight ?? "").trim().slice(0, 60); // 硬截断，防长篇空转
      const rawDelta = Number(args.temperature_delta);
      const delta = Number.isFinite(rawDelta) ? rawDelta : 0;

      // 只有产出具体 insight 才写记忆 + 反哺温度（空 insight = 没新认识 = 不动情绪）
      if (insight && !/^无[。.]?$/.test(insight)) {
        const dup = self.some((s) => s.content === insight);
        if (!dup) {
          await this.memory.remember(insight, { lens: "self", confidence: "inferred", priority: "P2" });
          console.log("[Agent] 反思沉淀:", insight);
        }
        if (delta !== 0) {
          const clamped = Math.max(-5, Math.min(5, delta));
          const oldStage = this.temp.stage.id;
          this.temp.nudge(clamped);
          const newStage = this.temp.stage.id;
          console.log(`[Agent] 反思反哺温度: ${clamped > 0 ? "+" : ""}${clamped} → ${this.temp.describe()}`);
          if (oldStage !== newStage) {
            this.broadcast("temperature", { oldStage, newStage, value: Math.round(this.temp.value) });
          }
        }
      }
    } catch (err) {
      console.error("[Agent] 反思失败:", err.message);
    }
  }

  async _perceive(reason, data) {
    // 世界快照（崩溃不影响决策）
    let world = "";
    try { world = this.snapshot.generate(); }
    catch (err) { console.error("[Agent] 快照失败:", err.message); }

    // 温度 + 记仇
    const tempState = this.temp.describe();
    const grudges = this.temp.grudges;

    // 记忆（有对话时检索相关记忆）
    let memories = [];
    if (reason === "chat" && data?.text) {
      try { memories = await this.memory.search(data.text); } catch { /* ignore */ }
    }

    // 最近事件（保留 5 条）
    const recentEvents = this.recentEvents.slice(-5);

    // 自我认知（lens:self，持久，影响行为）
    let selfUnderstanding = [];
    try { selfUnderstanding = await this.memory.profile("self"); } catch { /* ignore */ }

    return { reason, data, world, tempState, grudges, memories, recentEvents, selfUnderstanding };
  }

  _buildMessages(perception) {
    const { reason, data, world, tempState, grudges, memories, recentEvents } = perception;

    // 温度注入首句（用户要求：实时注入到消息首句）
    const grudgeText = grudges.length > 0
      ? `【记仇中：${grudges.map(g => g.label).join("、")}】`
      : "";
    const tempLine = `【当前温度：${tempState}】${grudgeText}`;

    // 世界状态
    const worldText = world ? `\n[你此刻看到的周围]\n${world}` : "";

    // 记忆
    const memoryText = memories.length > 0
      ? `\n[你记得]\n${memories.slice(0, 5).map(m => `- ${m.content}`).join("\n")}`
      : "";

    // 最近事件
    const eventText = recentEvents.length > 0
      ? `\n[最近发生]\n${recentEvents.map(e => `- ${this._formatEvent(e)}`).join("\n")}`
      : "";

    // 自主决策提示（发言节流：没到 2 分钟就提醒 LLM 少说话）
    const canSpeak = this._canSpeakNow();
    const speakHint = canSpeak
      ? "现在到了可以主动开口的时机，如果你有什么想分享、想提醒的，可以说。"
      : "现在还不是你主动开口的时机（刚说过没多久），保持安静、专注做手上的事，除非有真正重要的事（危险、玩家明确叫你）。";
    const autoHint = reason === "autonomous"
      ? (() => {
          const desires = this._deriveDesires();
          const desireText = desires.length > 0
            ? desires.map((d) => `- ${d}`).join("\n") + "\n（这些是倾向，不是命令，自己判断何时行动。）"
            : "平静。没什么特别想做的。";
          return `\n[你此刻的内心]\n${desireText}\n\n[当前动作]\n你正在：${this.currentAction}\n\n[现在]\n这是你的自主时刻。根据内心的倾向和当前状态自己判断该做什么。如果你正在做一件有意义的事，不要轻易 stop 打断它，除非有更重要的事（危险、玩家明确叫你）。内心平静就安静待着。\n\n[发言节奏]\n${speakHint}`;
        })()
      : "";

    const userContent = `${tempLine}${worldText}${memoryText}${eventText}${autoHint}`;

    const systemPrompt = buildSystemPrompt(
      this.soul, this.temp.stage, this._getTimeOfDay(), memories, Math.round(this.temp.value), perception.selfUnderstanding ?? []
    );

    return [
      { role: "system", content: systemPrompt },
      ...this._deriveMessages(),
      { role: "user", content: userContent },
    ];
  }

  _execute(text, toolCalls, reason) {
    // 执行工具调用（不管发不发言，动作照做）
    for (const call of toolCalls) {
      try {
        const fnName = call?.function?.name;
        const args = safeJsonParse(call.function.arguments);
        if (args == null) {
          console.error("[Agent] 工具参数 JSON 解析失败:", call?.function?.arguments);
          continue;
        }
        console.log("[Agent] 工具调用:", fnName, args);
        this._executeTool(fnName, args);
      } catch (err) {
        console.error("[Agent] 工具执行失败:", err.message, "| 原始 args:", call?.function?.arguments);
      }
    }

    // 发送文本：事件驱动（chat/送礼/受伤/死亡）立即说；autonomous 要受 2 分钟节流
    if (text) {
      if (reason === "autonomous" && !this._canSpeakNow()) {
        console.log("[Agent] 自主发言节流：距上次发言不足 2 分钟，闭嘴只做事");
      } else {
        const safeReply = this._sanitizeChat(text);
        if (safeReply) {
          this.bot.chat(safeReply);
          this.broadcast("chat", { sender: this.soul.name, text: safeReply, direction: "out" });
          this._pushLog({ type: "assistant", content: safeReply });
          this.lastSpeech = Date.now();
        }
      }
    }
  }

  /** autonomous 发言是否已过 2 分钟冷却 */
  _canSpeakNow() {
    return Date.now() - this.lastSpeech >= SPEECH_INTERVAL;
  }

  /**
   * 发送前清洗：剥离 mood 标签、拦截命令注入、违禁词兜底、限长
   * @returns {string|null} 可安全发送的文本；null = 拦截不发
   */
  _sanitizeChat(text) {
    // 1. 剥离 mood 标签（system prompt 要求最后一行 mood=xxx，但不该发到公屏）
    let t = String(text ?? "").replace(/\n?mood=[a-z]+\s*$/i, "").trim();
    if (!t) return null;
    // 2. 只取第一行，限长 100 字
    if (t.includes("\n")) t = t.split("\n")[0];
    t = t.slice(0, 100);
    // 3. 拦截以 / 开头的命令注入（防止 LLM 输出 /kick /op /stop 等）
    if (t.startsWith("/")) {
      console.warn("[Safety] 拦截命令注入:", t);
      return null;
    }
    // 4. 违禁词兜底（命中则替换成中性回应）
    const forbidden = this.soul?.speech?.forbidden ?? [];
    for (const w of forbidden) {
      if (w && t.includes(w)) {
        console.warn("[Safety] 命中违禁词:", w);
        return "……";
      }
    }
    return t;
  }

  /** 从情绪态确定性派生出「内心欲望」（倾向不是命令；空数组=内心平静） */
  _deriveDesires() {
    const desires = [];
    const stage = this.temp.stage.id;
    const grudges = this.temp.grudges;
    const idleMin = Math.floor((Date.now() - this._lastPlayerInteractionAt) / 60000);

    if (stage === "attached" || stage === "warm") {
      desires.push(`想待在${this._playerName()}身边`);
    } else if (stage === "cold" || stage === "cool") {
      desires.push("想保持距离，不太想主动靠近");
    }
    if (grudges.length > 0) {
      desires.push(`心里还有点芥蒂（记仇中），不太想主动搭理${this._playerName()}`);
    }
    if (idleMin >= 3) {
      desires.push("有点无聊了，想自己找点事做");
    }
    if (stage === "attached" && idleMin >= 5) {
      desires.push(`想给${this._playerName()}准备点小惊喜`);
    }
    if (this._getTimeOfDay() === "night") {
      desires.push("天黑了，想找个安全的地方待着");
    }
    return desires;
  }

  /** 取交互目标玩家：优先绑定的玩家，否则退回第一个非 bot 玩家 */
  _getPlayer() {
    if (this.boundPlayer && this.bot.players[this.boundPlayer]) {
      return this.bot.players[this.boundPlayer];
    }
    const playerKey = Object.keys(this.bot.players).find(k => k !== this.bot.username);
    return playerKey ? this.bot.players[playerKey] : null;
  }

  /** 当前玩家称呼（绑定玩家名，兜底「玩家」），避免硬编码固定称谓导致人设割裂 */
  _playerName() {
    return this.boundPlayer ?? "玩家";
  }

  _executeTool(fnName, args = {}) {
    const player = this._getPlayer();
    console.log("[Agent] bot.players keys:", Object.keys(this.bot.players).join(","), "| bot.username:", this.bot.username, "| player.entity:", player?.entity ? "存在" : "null");

    // 记录当前动作（stop 表示回到发呆）
    this.currentAction = fnName === "stop" ? "发呆" : fnName;

    switch (fnName) {
      case "move_to_player":
        if (player?.entity) {
          this.behaviors.approach(player);
        } else {
          // 玩家实体未加载（离太远，超出 MC 实体加载范围），无法定位
          console.log("[Agent] move_to_player 失败：玩家实体未加载");
          this.bot.chat("（你离我太远了，我看不到你，走近一点嘛）");
        }
        break;
      case "follow_player":
        if (player?.entity) this.behaviors.follow(player, this._followDistance());
        break;
      case "chop_tree":
        this.behaviors.chopTree();
        break;
      case "mine":
        this.behaviors.mine();
        break;
      case "collect_block":
        this.behaviors.collectBlock(b => b.name === args.block);
        break;
      case "place_block":
        this.behaviors.placeBlock(args.block, args.count ?? 1);
        break;
      case "attack_entity":
        this.behaviors.attackEntity(args.entity);
        break;
      case "attack_nearest":
        this.behaviors.attackNearest();
        break;
      case "stop":
        this.behaviors.stopMoving();
        break;
      case "jump":
        this.behaviors.jump();
        break;
      case "build_structure":
        this._buildStructure(args.primitives, player);
        break;
      default:
        console.log("[Agent] 未知工具:", fnName);
    }
  }

  /** 按图纸建造：原语 → 坐标矩阵 → 逐格放置 */
  _buildStructure(primitives, player) {
    // 原点：玩家位置。玩家不可见就拒绝，不擅自用 bot 位置（会建错地方）
    if (!player?.entity?.position) {
      console.log("[Agent] build_structure 失败：玩家不可见");
      this.bot.chat("（我看不到你，没法确定在哪里建，你走近一点再试试吧）");
      return;
    }
    const origin = player.entity.position;

    const result = expandPrimitives(primitives, origin);
    if (!result.ok) {
      console.log("[Agent] build_structure 图纸错误:", result.error);
      this._pushEvent("action_failed", { action: "build", reason: result.error });
      this.bot.chat(`（图纸有点问题：${result.error}）`);
      return;
    }

    console.log(`[Agent] build_structure: ${result.blocks.length} 块，原点 (${Math.round(origin.x)},${Math.round(origin.y)},${Math.round(origin.z)})`);
    this.currentAction = "build";
    this.behaviors.buildFromMatrix(result.blocks, origin);
  }

  _followDistance() {
    const stage = this.temp.stage.id;
    return { cold: 10, cool: 8, neutral: 5, warm: 3, attached: 2 }[stage] || 5;
  }

  // ─── 送礼 ─────────────────────────────────────────────────

  async _handleItemDrop(data) {
    const { username, itemName } = data;
    if (!isGift(itemName)) return;
    this._lastPlayerInteractionAt = Date.now();
    const delta = this.temp.apply("gift_received");
    this._pushEvent("gift", { from: username, item: itemName });
    this.memory.remember(`${username} 送了${this.soul.name}一个${itemName}`, {
      lens: "general", confidence: "observed", priority: "P1",
    }).catch(() => {});
    this.broadcast("event", { type: "gift_received", from: username, item: itemName, tempDelta: delta });
    this._triggerReflect({ trigger: `${username} 送了我一个 ${itemName}` });
    await this.decide("gift", { from: username, item: itemName });
  }

  // ─── LLM 调用 ─────────────────────────────────────────────

  async _callLLM(messages, { tools = true } = {}) {
    const payload = {
      model: this.llmModel,
      messages,
      max_tokens: 2048,
      temperature: 0.8,
    };
    if (tools === true) {
      payload.tools = TOOLS;
      payload.tool_choice = "auto";
    } else if (Array.isArray(tools)) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }
    const res = await fetch(`${this.llmBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.llmApiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`LLM API ${res.status}: ${errText.slice(0, 100)}`);
    }

    const data = await res.json();
    const message = data.choices?.[0]?.message;
    console.log(`[LLM][debug] tool_calls=${message?.tool_calls?.length ?? 0} | text=${(message?.content ?? "").slice(0, 60)}`);
    return {
      text: message?.content?.trim() ?? null,
      toolCalls: message?.tool_calls ?? [],
    };
  }

  // ─── 工具函数 ─────────────────────────────────────────────

  _pushEvent(type, data) {
    this.recentEvents.push({ type, ...data, ts: Date.now() });
    if (this.recentEvents.length > 20) this.recentEvents = this.recentEvents.slice(-20);
  }

  /** 追加事件到对话日志（唯一写入口），并落盘持久化 */
  _pushLog(event) {
    this.events.push(event);
    // 控制日志长度（60 事件），截断时丢弃开头的孤儿 tool 结果（它们的 assistant 被切掉了）
    if (this.events.length > 60) {
      let start = this.events.length - 60;
      while (start < this.events.length && this.events[start]?.type === "tool") start++;
      this.events = this.events.slice(start);
    }
    this._saveSession();
  }

  /** 从磁盘加载上次会话日志（崩溃恢复） */
  _loadSession() {
    try {
      if (existsSync(this.sessionPath)) {
        const data = JSON.parse(readFileSync(this.sessionPath, "utf-8"));
        if (Array.isArray(data)) return data;
      }
    } catch (err) {
      console.error("[Session] 加载失败，用空日志:", err.message);
    }
    return [];
  }

  /** 把会话日志写入磁盘 */
  _saveSession() {
    try {
      mkdirSync(dirname(this.sessionPath), { recursive: true });
      writeFileSync(this.sessionPath, JSON.stringify(this.events), "utf-8");
    } catch (err) {
      console.error("[Session] 持久化失败:", err.message);
    }
  }

  /**
   * 从事件日志派生出 LLM 消息数组（dsh 启发：日志是真相源，消息每次派生）
   * user/assistant/tool 事件 → messages；action 事件不进消息（通过 recentEvents 注入）
   */
  _deriveMessages(limit = 16) {
    const msgs = [];
    for (const e of this.events) {
      if (e.type === "user") {
        msgs.push({ role: "user", content: e.content });
      } else if (e.type === "assistant") {
        const m = { role: "assistant", content: e.content ?? null };
        if (e.toolCalls?.length) m.tool_calls = e.toolCalls;
        msgs.push(m);
      } else if (e.type === "tool") {
        msgs.push({ role: "tool", tool_call_id: e.toolCallId, content: e.result });
      }
    }
    // 截断：保留最近 N 条，但不把 tool 结果和它的 assistant tool_calls 拆开
    if (msgs.length > limit) {
      let start = msgs.length - limit;
      while (start > 0 && msgs[start]?.role === "tool") start--; // 回退到 tool 对之前的 assistant
      return msgs.slice(start);
    }
    return msgs;
  }

  _formatEvent(e) {
    switch (e.type) {
      case "chat": return `玩家说："${e.text}"`;
      case "hurt": return "你受伤了";
      case "death": return "你死了";
      case "gift": return `${e.from} 送你一个 ${e.item}`;
      case "action_done": return `你刚才的「${e.action}」成功了`;
      case "action_failed": return `你刚才的「${e.action}」失败了（${e.reason}）`;
      default: return e.type;
    }
  }

  /** 行动结果回调：成功和失败都记录到最近事件，让 LLM 下一轮知道上次动作结果（dsh 启发：结果不能丢） */
  _onActionResult(result) {
    console.log("[Action] 结果:", JSON.stringify(result));
    this._pushEvent(result.success ? "action_done" : "action_failed", {
      action: result.action,
      reason: result.reason,
    });
  }

  _getTimeOfDay() {
    // 用 Minecraft 游戏内时间（0-24000），不是现实时间
    // 0=日出, 6000=正午, 12000=日落, 18000=午夜
    const t = this.bot.time?.timeOfDay ?? 6000;
    if (t < 1000) return "morning";    // 日出
    if (t < 12000) return "daytime";   // 白天
    if (t < 13000) return "evening";   // 日落
    return "night";                     // 夜晚
  }
}
