/**
 * 一次性验证脚本 — 连进服，扫描原点附近方块，确认建造是否落地
 * 用法: node test/verify.js
 */
import { createRequire } from "module";
import mineflayer from "mineflayer";
const require = createRequire(import.meta.url);
const { Vec3 } = require("vec3");

const HOST = "127.0.0.1";
const PORT = 65293;
const ORIGIN = { x: -4, y: -60, z: -5 };
const RANGE = 14;

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: "Verifier", auth: "offline" });

bot.once("spawn", async () => {
  const me = bot.entity.position.floored();
  console.log(`[Verifier] 生成 @ (${me.x},${me.y},${me.z})`);
  await bot.waitForChunksToLoad();
  console.log("[Verifier] chunk 已加载，开始扫描");

  const counts = {};
  const samples = {};
  let nullCount = 0;
  for (let x = ORIGIN.x - RANGE; x <= ORIGIN.x + RANGE; x++) {
    for (let z = ORIGIN.z - RANGE; z <= ORIGIN.z + RANGE; z++) {
      for (let y = ORIGIN.y - 3; y <= ORIGIN.y + 6; y++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (b === null || b === undefined) { nullCount++; continue; }
        if (b.name === "air" || b.name === "cave_air" || b.name === "void_air") continue;
        counts[b.name] = (counts[b.name] || 0) + 1;
        if (!samples[b.name]) samples[b.name] = `(${x},${y},${z})`;
      }
    }
  }
  console.log(`=== 扫描区域: 原点 ${JSON.stringify(ORIGIN)} ±${RANGE}，y 范围 ${ORIGIN.y - 3}~${ORIGIN.y + 6} ===`);
  console.log(`=== 未加载块(blockAt 返回 null): ${nullCount} ===`);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [name, n] of sorted) console.log(`  ${name}: ${n}  例 ${samples[name]}`);
  const materials = ["oak_planks", "spruce_planks", "cobblestone", "oak_log", "glass"];
  const totalBuilt = sorted.filter(([n]) => materials.includes(n)).reduce((s, [, c]) => s + c, 0);
  console.log(`=== 建造材料方块合计: ${totalBuilt} 块（预期约 55）===`);
  bot.quit();
  setTimeout(() => process.exit(0), 500);
});

bot.on("error", (e) => { console.error("verify error:", e.message); process.exit(1); });
setTimeout(() => { console.log("超时退出"); process.exit(1); }, 20000);
