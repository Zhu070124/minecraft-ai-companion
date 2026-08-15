/**
 * Mineflayer Bot 封装
 *
 * 职责：
 *   1. 连接 MC 服务器（单机 LAN 或远程）
 *   2. 暴露 MC 事件给 Event Router
 *   3. 执行动作（说话、移动、交互）
 *   4. 加载 pathfinder 插件用于寻路
 */

import { createRequire } from "module";
import mineflayer from "mineflayer";
import pathfinder from "mineflayer-pathfinder";
import navigate from "mineflayer-navigate";

const require = createRequire(import.meta.url);

/**
 * @param {object} opts
 * @param {string} opts.host        - MC 服务器地址（默认 localhost）
 * @param {number} opts.port        - MC 服务器端口（默认 25565）
 * @param {string} opts.username    - bot 的名字
 * @param {function} opts.onEvent   - 事件回调 (type, data)
 * @returns {Promise<import('mineflayer').Bot>}
 */
export function createBot(opts) {
  const {
    host = "localhost",
    port = 25565,
    username = "Puff",
    onEvent = () => {},
  } = opts;

  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({
      host,
      port,
      username,
      // 离线模式（本地测试）
      auth: "offline",
      // 不渲染画面
      hideErrors: false,
    });

    // 加载 pathfinder（navigate 依赖它）
    bot.loadPlugin(pathfinder.pathfinder);
    // 加载 navigate（工厂函数：navigate() 返回插件，loadPlugin 再调用注入）
    bot.loadPlugin(navigate());
    const { Movements } = pathfinder;

    // ─── 生命周期 ───────────────────────────────────────────

    bot.once("spawn", () => {
      // 配置移动方式
      const mcData = require("minecraft-data")(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.canDig = true;
      defaultMove.allowParkour = false;
      defaultMove.maxDropDown = 3;
      bot.pathfinder.setMovements(defaultMove);

      onEvent("spawn", {
        username: bot.username,
        entity: bot.entity,
        health: bot.health,
        food: bot.food,
        position: bot.entity.position,
      });
      console.log("[Bot] 已生成 @", bot.entity.position.floored());

      // 对话：监听聊天（mineflayer 4.x 用 message 事件，签名 (msg, position, sender, verified)）
      bot.on("message", (msg, position, sender) => {
        if (position !== "chat") return; // 只处理玩家公屏聊天，忽略系统消息/快捷栏
        const text = msg.toString();
        if (!text) return;
        // 把 sender UUID 转成玩家名字
        let senderName = sender;
        for (const name of Object.keys(bot.players)) {
          if (bot.players[name].uuid === sender) { senderName = name; break; }
        }
        // 忽略 bot 自己说的话（UUID 规范化比较 + 名字比较，双保险）
        const norm = (u) => String(u || "").replace(/-/g, "").toLowerCase();
        if (norm(sender) === norm(bot.uuid)) return;
        if (senderName === bot.username) return;
        onEvent("chat", { sender: senderName, text });
      });

      // 受伤害
      bot.on("hurt", (attacker) => {
        const isPlayer = attacker?.type === "player" || !!attacker?.username;
        onEvent("hurt", {
          health: bot.health,
          attacker: attacker?.username ?? (attacker?.name ?? "unknown"),
          isPlayer,
        });
      });

      // 死亡
      bot.on("death", () => {
        onEvent("death", { position: bot.entity.position });
      });

      // 玩家加入/离开
      bot.on("playerJoined", (player) => {
        onEvent("player_join", { username: player.username });
        // Memory: 第一次见到的玩家
      });

      bot.on("playerLeft", (player) => {
        onEvent("player_leave", { username: player.username });
      });

      // 礼物检测：玩家在 bot 附近丢出物品 → 送礼
      // 必须用 mineflayer 内置的 itemDrop 事件（此时 metadata 已加载，getDroppedItem 才可用）；
      // 不能用 entitySpawn —— spawn 包先到、metadata 后到，那时 getDroppedItem() 返回 null
      const processedItemIds = new Map(); // id -> 时间戳（防无限增长，定期清理）
      bot.on("itemDrop", (entity) => {
        const now = Date.now();
        // 定期清理 60 秒前的旧条目
        if (processedItemIds.size > 500) {
          for (const [id, ts] of processedItemIds) {
            if (now - ts > 60000) processedItemIds.delete(id);
          }
        }
        // 同一实体只处理一次
        if (processedItemIds.has(entity.id)) return;
        processedItemIds.set(entity.id, now);
        // 只在 bot 附近检测（8 格内，留足 spawn 抖动余量）
        if (!bot.entity || entity.position.distanceTo(bot.entity.position) > 8) return;
        // 找到最近的玩家（不是 bot 自己）
        let closestPlayer = null;
        let closestDist = Infinity;
        for (const pname of Object.keys(bot.players)) {
          if (pname === bot.username) continue;
          const p = bot.players[pname];
          if (p?.entity) {
            const dist = entity.position.distanceTo(p.entity.position);
            if (dist < 3 && dist < closestDist) {
              closestDist = dist;
              closestPlayer = pname;
            }
          }
        }
        if (!closestPlayer) return;
        // 提取真实物品名
        let itemName = entity.name;
        try {
          const item = entity.getDroppedItem();
          if (item?.name) itemName = item.name;
        } catch { /* ignore */ }
        onEvent("item_drop", {
          username: closestPlayer,
          itemName,
          position: entity.position,
          distance: closestDist,
        });
      });

      resolve(bot);
    });

    // 错误处理
    bot.on("error", (err) => {
      console.error("[Bot] Error:", err.message);
      onEvent("error", { message: err.message });
    });

    bot.on("kicked", (reason) => {
      const reasonText = typeof reason === "string" ? reason : JSON.stringify(reason);
      console.error("[Bot] Kicked:", reasonText);
      onEvent("kicked", { reason: reasonText });
    });

    bot.on("end", (reason) => {
      console.log("[Bot] Disconnected:", reason);
      onEvent("end", { reason });
    });

    // 30秒超时
    setTimeout(() => {
      if (!bot.entity) {
        reject(new Error("Bot spawn timeout — 检查 MC 服务器是否在运行"));
      }
    }, 30000);
  });
}
