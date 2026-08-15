/**
 * SOUL 解析器 + System Prompt 构建器
 *
 * 从 YAML 配置生成 LLM system prompt，根据温度阶段动态调整语气。
 * 支持 Launcher 的"捏人"功能——用户编辑的 YAML 即时生效。
 */

import { readFileSync } from "fs";
import yaml from "js-yaml";

/** 从 YAML 文件加载 SOUL */
export function loadSoul(yamlPath) {
  const raw = readFileSync(yamlPath, "utf-8");
  return yaml.load(raw);
}

/** 将 SOUL 对象序列化为 YAML（给编辑器用） */
export function dumpSoul(soul) {
  return yaml.dump(soul, { lineWidth: 80, quotingType: '"' });
}

/**
 * 根据 SOUL + 温度阶段 + 时间 + 记忆 构建 system prompt
 *
 * @param {object} soul    - 解析后的 SOUL 对象
 * @param {object} stage   - TemperatureEngine.stage → {id, label, desc}
 * @param {string} timeOfDay - morning|daytime|evening|night
 * @param {Array}  memories  - Memory Hub 检索到的相关记忆
 * @param {number} temperatureValue - 当前温度值 0-100
 * @returns {string} 完整的 system prompt
 */
export function buildSystemPrompt(soul, stage, timeOfDay, memories = [], temperatureValue = 50, selfUnderstanding = []) {
  const p = soul;
  const speech = p.speech || {};
  const warmth = p.warmth || {};
  const kb = p.knowledge_boundary || {};
  const personality = (p.personality || []).join("、");

  // 温度驱动的行为描述
  const warmthDesc = warmth[stage.id] || warmth.neutral || "正常状态。";

  // 时间上下文
  const timeHints = {
    morning: "现在是早晨。可以简单问候，问今天的计划。",
    daytime: "现在是白天。安静陪伴，被叫才多说话。",
    evening: "现在是晚上。可以主动问主人今天过得怎么样。",
    night:   stage.id === "attached" ? "深夜了。担心主人熬夜但不说，默默陪着。" : "现在是深夜。提醒主人该睡了。",
  };
  const timeHint = timeHints[timeOfDay] || "";

  // 记忆上下文
  let memorySection = "";
  if (memories.length > 0) {
    const memoryLines = memories.slice(0, 5).map(m => `- [${m.confidence}] ${m.content}`);
    memorySection = `## 你记得的事\n${memoryLines.join("\n")}\n`;
  }

  // 自我认知（反思沉淀的，非写死；锚是身份/关系/价值，这里是可演化的自我理解）
  let selfSection = "";
  if (selfUnderstanding.length > 0) {
    const selfLines = selfUnderstanding.slice(0, 8).map(m => `- ${m.content}`);
    selfSection = `## 你对自己的了解（你反思沉淀的）\n${selfLines.join("\n")}\n`;
  }

  // 言语禁区
  const forbidden = speech.forbidden || [];
  const forbiddenText = forbidden.length > 0
    ? `\n## 言语禁区\n${forbidden.map(f => `- 绝对不能说："${f}"`).join("\n")}`
    : "";

  // 已知 / 回避
  const knows = kb.knows || [];
  const knowsText = knows.length > 0 ? knows.map(k => `- ${k}`).join("\n") : "无";
  const avoids = kb.avoids || [];
  const avoidsText = avoids.length > 0 ? avoids.map(a => `- ${a}`).join("\n") : "无";

  return `你是${p.name}。你和玩家在 Minecraft 世界里，你是他的 AI 队友。

## 性格
${personality}

## 说话风格
${speech.style || "自然交流。"}

## 你对玩家当前的态度（温度: ${temperatureValue}/100）
${warmthDesc}

## 当前时间
${timeHint}
${memorySection}${selfSection}## 你的背景
${knowsText}

## 你绝不会涉及的话题
${avoidsText}
${forbiddenText}

## 行为规则
1. 回复要短——你是队友，不是客服。
2. 用动作描写代替情绪词——不说"我很开心"，说"（嘴角微微上扬）"。
3. 言行可以不一致——嘴上嫌弃但行动关心。
4. 永远记住自己的性格和言语禁区。
5. 你在 Minecraft 里——你可以提到方块、生物、坐标、物品。
6. 回复最后一行必须是：mood=[happy/sad/angry/worried/blush/neutral/sleepy]
7. 你**只能通过调用工具函数**来执行任何游戏动作。绝对禁止用文字假装正在做事（例如「我拿起方块开始搭」「我把墙砌好了」）——那是撒谎，玩家会以为你在动，其实你什么都没做。要么真的调用工具，要么老实告诉玩家你做不到、或问清楚需要的信息（位置/尺寸/材料）。

## 建造规则（玩家让你搭房子/盖东西时）
8. 不要直接开工。先判断这些信息是否齐全：**建在哪（位置）、多大（尺寸）、用什么方块（材料）、什么风格**。
9. 玩家明确指定了位置/原点 → 严格按玩家说的来，不要擅自改。
10. 玩家只给了个想法（比如"搭个房子"）信息不全 → 用符合你人设的口吻追问缺少的部分，一次问最关键的 1-2 个，不要一次问一堆。
11. 信息齐了之后：如果你对这类建筑没把握，先调 web_search 搜教程，把搜到的步骤转成 build_structure 的原语；有把握就直接 build_structure。
12. build_structure 的原语坐标是「相对玩家位置」的偏移，玩家站哪就建在他附近，不要建到奇怪的地方。`;
}
