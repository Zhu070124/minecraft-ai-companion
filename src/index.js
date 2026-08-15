/**
 * MC AI Companion — 入口
 *
 * 启动 HTTP 服务（Launcher UI + 配置 API）+ WebSocket（实时仪表盘）
 * 管理 Bot 生命周期：创建、启动、停止、切换人格
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import yaml from "js-yaml";

import { createBot } from "./bot.js";
import { TemperatureEngine } from "./temperature.js";
import { MemoryClient } from "./memory.js";
import { LocalMemory } from "./local-memory.js";
import { EventRouter } from "./router.js";
import { loadSoul } from "./persona.js";
import { pinyin } from "pinyin-pro";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LAUNCHER_DIR = join(ROOT, "launcher");
const CONFIG_DIR = join(ROOT, "config");
const DATA_DIR = join(ROOT, "data");
const PRESETS_DIR = join(CONFIG_DIR, "presets");

const PORT = 8848;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
};

// ─── 全局状态 ───────────────────────────────────────────────

let activeConfig = null;   // { name, preset, soulPath, mcHost, mcPort, llmApiKey }
let bot = null;
let temp = null;
let memory = null;
let router = null;
const wsClients = new Set();

// ─── 初始化目录 ─────────────────────────────────────────────

mkdirSync(DATA_DIR, { recursive: true });
// 恢复上次的配置
const STATE_PATH = join(DATA_DIR, "state.json");
if (existsSync(STATE_PATH)) {
  try {
    activeConfig = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    if (activeConfig?.soulPath && !existsSync(activeConfig.soulPath)) {
      activeConfig = null; // SOUL 文件没了
    }
  } catch { activeConfig = null; }
}

// ─── HTTP Server ────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── API ──────────────────────────────────────────────────
  if (url.pathname.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    handleAPI(req, res, url);
    return;
  }

  // ── Static files ─────────────────────────────────────────
  let filePath;
  if (url.pathname === "/" || url.pathname === "/index.html") {
    filePath = join(LAUNCHER_DIR, "index.html");
  } else if (url.pathname === "/editor.html") {
    filePath = join(LAUNCHER_DIR, "editor.html");
  } else if (url.pathname === "/dashboard.html") {
    filePath = join(LAUNCHER_DIR, "dashboard.html");
  } else {
    filePath = join(LAUNCHER_DIR, url.pathname);
  }

  // 安全：防止路径穿越
  if (!filePath.startsWith(LAUNCHER_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const ext = extname(filePath);
    const contentType = MIME[ext] || "application/octet-stream";
    const data = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
});

// ── WebSocket ───────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));

  // 立即发送当前状态
  sendStatus(ws);
});

function broadcastAll(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function sendStatus(ws) {
  const status = {
    type: "status",
    data: {
      config: activeConfig ? {
        name: activeConfig.name,
        preset: activeConfig.preset,
        botOnline: bot?.entity != null,
        temperature: temp?.serialize() ?? { value: 50, activeGrudges: [], history: [] },
      } : null,
      botOnline: bot?.entity != null,
      version: "0.1.0",
    },
  };
  if (ws.readyState === 1) ws.send(JSON.stringify(status));
}

// ── API 路由 ────────────────────────────────────────────────

async function handleAPI(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  try {
    // GET /api/presets — 列出所有预设人格
    if (path === "/api/presets" && method === "GET") {
      const files = readdirSync(PRESETS_DIR).filter(f => f.endsWith(".yaml"));
      const presets = files.map(f => {
        const id = f.replace(".yaml", "");
        const soul = loadSoul(join(PRESETS_DIR, f));
        return {
          id,
          label: soul.personality?.[0] ?? id,
          personality: soul.personality ?? [],
          previewLine: getPreviewLine(id),
        };
      });
      res.end(JSON.stringify({ presets }));
      return;
    }

    // GET /api/soul?preset=tsundere — 获取预设的完整 SOUL
    if (path === "/api/soul" && method === "GET") {
      const preset = url.searchParams.get("preset") ?? "tsundere";
      const soulPath = join(PRESETS_DIR, `${preset}.yaml`);
      if (!existsSync(soulPath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "preset not found" }));
        return;
      }
      const soul = readFileSync(soulPath, "utf-8");
      res.end(JSON.stringify({ soul }));
      return;
    }

    // GET /api/config — 当前配置
    if (path === "/api/config" && method === "GET") {
      res.end(JSON.stringify({ config: activeConfig }));
      return;
    }

    // POST /api/configure — 保存配置
    if (path === "/api/configure" && method === "POST") {
      const body = await readBody(req);
      const { name, preset, soulYaml } = body;

      if (!name) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "name is required" }));
        return;
      }

      // 如果有自定义 YAML，保存到 config/active.yaml
      let soulPath;
      if (soulYaml) {
        soulPath = join(CONFIG_DIR, "active.yaml");
        // 替换模板变量
        const yamlWithName = soulYaml.replace(/\{\{NAME\}\}/g, name);
        writeFileSync(soulPath, yamlWithName, "utf-8");
      } else {
        // 复制预设
        const presetId = preset ?? "tsundere";
        const presetPath = join(PRESETS_DIR, `${presetId}.yaml`);
        if (!existsSync(presetPath)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "preset not found" }));
          return;
        }
        soulPath = join(CONFIG_DIR, "active.yaml");
        let content = readFileSync(presetPath, "utf-8");
        content = content.replace(/\{\{NAME\}\}/g, name);
        writeFileSync(soulPath, content, "utf-8");
      }

      // 停掉旧 bot
      await stopBot();

      activeConfig = { name, preset: preset ?? "custom", soulPath };
      writeFileSync(STATE_PATH, JSON.stringify(activeConfig, null, 2), "utf-8");

      // 通知所有前端
      for (const ws of wsClients) sendStatus(ws);

      res.end(JSON.stringify({ ok: true, config: activeConfig }));
      return;
    }

    // POST /api/start — 启动 bot
    if (path === "/api/start" && method === "POST") {
      if (!activeConfig) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "no config — configure first" }));
        return;
      }

      const body = await readBody(req).catch(() => ({}));
      const mcHost = body.mcHost ?? "localhost";
      const mcPort = body.mcPort ?? 25565;
      const llmApiKey = body.llmApiKey ?? process.env.LLM_API_KEY ?? "";
      const llmBaseUrl = body.llmBaseUrl ?? "https://api.deepseek.com";
      const llmModel = body.llmModel ?? "deepseek-chat";

      // 停止旧 bot
      await stopBot();

      // 加载 SOUL
      const soul = loadSoul(activeConfig.soulPath);

      // 初始化组件
      temp = new TemperatureEngine({
        events: soul.temperature?.events ?? {},
        grudges: soul.temperature?.grudges ?? {},
        grudgeEnabled: soul.grudge?.enabled !== false,
      });

      // 记忆库：默认本地自带（开源版零依赖）；设 MEMORY_HUB=1 才接外部 Memory Hub
      if (process.env.MEMORY_HUB === "1") {
        memory = new MemoryClient({
          agentName: `mc-${soul.name}`,
          memoryHubUrl: "http://127.0.0.1:8921",
        });
      } else {
        memory = new LocalMemory({
          agentName: `mc-${soul.name}`,
          llmApiKey, llmBaseUrl, llmModel,
        });
      }

      // 创建 bot
      try {
        bot = await createBot({
          host: mcHost,
          port: mcPort,
          username: toMcUsername(activeConfig.name),
          onEvent: (type, data) => {
            if (router) router.handle(type, data).catch(err =>
              console.error("[Router] handle error:", err)
            );
          },
        });

        // 初始化路由器
        router = new EventRouter({
          bot, temp, memory, soul,
          llmApiKey, llmBaseUrl, llmModel,
          broadcast: broadcastAll,
        });

        // bot 已 spawn（spawn 事件在 router 创建前触发，被 if(router) 挡掉了）
        // 这里手动启动 agent loop
        router.start();

        // 保存 MC 连接信息
        activeConfig.mcHost = mcHost;
        activeConfig.mcPort = mcPort;
        writeFileSync(STATE_PATH, JSON.stringify(activeConfig, null, 2), "utf-8");

        for (const ws of wsClients) sendStatus(ws);

        res.end(JSON.stringify({ ok: true, botOnline: true }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /api/stop — 停止 bot
    if (path === "/api/stop" && method === "POST") {
      await stopBot();
      for (const ws of wsClients) sendStatus(ws);
      res.end(JSON.stringify({ ok: true, botOnline: false }));
      return;
    }

    // GET /api/dashboard — 仪表盘数据
    if (path === "/api/dashboard" && method === "GET") {
      res.end(JSON.stringify({
        config: activeConfig ? { name: activeConfig.name, preset: activeConfig.preset } : null,
        botOnline: bot?.entity != null,
        temperature: temp?.serialize() ?? { value: 50, activeGrudges: [], history: [] },
        soul: activeConfig ? loadSoul(activeConfig.soulPath) : null,
      }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    console.error("[API]", path, err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ─── Bot 生命周期 ───────────────────────────────────────────

async function stopBot() {
  if (bot) {
    try {
      if (router) router.stop();
      bot.end();
    } catch { /* ignore */ }
    bot = null;
    router = null;
  }
}

// ─── 工具 ───────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function getPreviewLine(presetId) {
  const lines = {
    tsundere: "（回头瞥了你一眼）别死了啊笨蛋。",
    sweet:    "哇，你好厉害耶！",
    cold:     "……嗯。",
    warm:     "累了？我帮你。",
  };
  return lines[presetId] ?? "你好！";
}

/**
 * 把用户起的名字（可能是中文）转成合法的 MC 用户名。
 * MC 用户名规则：3-16 位，仅 a-z A-Z 0-9 下划线。
 * 策略：
 *   1. 本身就是合法英文名 → 原样返回
 *   2. 中文名 → 转拼音（泡芙 → paofu）
 *   3. 拼音超长 → 截断到 16 位
 *   4. 兜底 → 固定 PuffBot
 */
function toMcUsername(name) {
  const s = String(name ?? "").trim();

  // 1. 合法英文名直接返回
  if (/^[a-zA-Z0-9_]{3,16}$/.test(s)) return s;

  // 2. 中文转拼音
  try {
    const py = pinyin(s, { toneType: "none", type: "array" })
      .join("")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    if (py.length >= 3) return py.slice(0, 16); // 超长截断
  } catch { /* 转拼音失败，走兜底 */ }

  // 3. 兜底
  return "PuffBot";
}

// ─── 启动 ───────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n  🎮 MC AI Companion v0.1.0`);
  console.log(`  Launcher: http://localhost:${PORT}`);
  console.log(`  API:      http://localhost:${PORT}/api/`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`\n  预设人格: ${readdirSync(PRESETS_DIR).filter(f => f.endsWith('.yaml')).map(f => f.replace('.yaml', '')).join(', ')}`);
  if (activeConfig) {
    console.log(`  当前配置: ${activeConfig.name} (${activeConfig.preset})`);
  }
  console.log();
});

// 优雅退出
process.on("SIGINT", async () => {
  console.log("\n正在关闭...");
  await stopBot();
  wss.close();
  server.close();
  process.exit(0);
});
