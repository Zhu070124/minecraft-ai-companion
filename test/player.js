/**
 * 测试玩家 bot — 连进 MC 服当「玩家」，脚本化驱动 companion bot
 *
 * 用法: node test/player.js
 * 前置: companion bot（src/index.js 启动）已在线；TestPlayer 背包已 /give 好礼物
 *
 * 场景（三条腿一起验）：
 *   t=8s   丢 diamond 送礼          → 测记忆存储（memory.remember）
 *   t=20s  问「还记得我送啥了吗」    → 测记忆检索（memory.search）
 *   t=35s  说「建中式八角凉亭」      → 测 web_search（复杂建筑触发联网搜索）
 */

import mineflayer from "mineflayer";

const HOST = "127.0.0.1";
const PORT = 65293;
const USERNAME = "TestPlayer";
const COMPANION = "xiaoxiyou";

const SCENARIO = [
  { at: 8000,  gift: "diamond" },
  { at: 20000, chat: "你还记得我刚才送你什么了吗？" },
  { at: 35000, chat: "帮我建一个中式八角凉亭吧，要飞檐" },
];

// 建屋/建筑请求后，companion 若追问细节 → 自动补答（最多一次）
const AUTO_ANSWER = "就建在我旁边，不用太大，用橡木，八角形带飞檐，简单点";
const BUILD_FOLLOWUP_WINDOW = 25000;
let buildRequestedAt = 0;
let autoAnswered = false;

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, auth: "offline" });

bot.once("spawn", () => {
  const p = bot.entity.position.floored();
  console.log(`[TestPlayer] 已生成 @ (${p.x}, ${p.y}, ${p.z})`);
  for (const step of SCENARIO) {
    setTimeout(async () => {
      if (step.chat) {
        console.log(`[TestPlayer] 说: ${step.chat}`);
        bot.chat(step.chat);
        if (step.chat.includes("建")) buildRequestedAt = Date.now();
      } else if (step.gift) {
        try {
          const item = bot.inventory.items().find((i) => i.name === step.gift);
          if (!item) { console.log(`[TestPlayer] 背包没有 ${step.gift}，跳过送礼`); return; }
          await bot.tossStack(item);
          console.log(`[TestPlayer] 送礼: ${step.gift}（丢出）`);
        } catch (e) {
          console.error(`[TestPlayer] 送礼失败:`, e.message);
        }
      }
    }, step.at);
  }
});

bot.on("message", (msg, position, sender) => {
  if (position !== "chat") return;
  const text = msg.toString().trim();
  if (!text) return;
  let senderName = sender;
  for (const name of Object.keys(bot.players)) {
    if (bot.players[name].uuid === sender) { senderName = name; break; }
  }
  if (senderName === USERNAME) return;
  console.log(`[${senderName}] ${text}`);

  const sinceBuild = Date.now() - buildRequestedAt;
  if (!autoAnswered && buildRequestedAt && sinceBuild > 0 && sinceBuild < BUILD_FOLLOWUP_WINDOW && /[？?吗]/.test(text)) {
    autoAnswered = true;
    setTimeout(() => { console.log(`[TestPlayer] 补答: ${AUTO_ANSWER}`); bot.chat(AUTO_ANSWER); }, 2500);
  }
});

bot.on("error", (e) => console.error("[TestPlayer] 错误:", e.message));
bot.on("kicked", (r) => console.error("[TestPlayer] 被踢:", JSON.stringify(r)));
bot.on("end", (r) => console.log("[TestPlayer] 断开:", r));
