/**
 * 世界快照 — 把 Mineflayer 的环境数据压缩成 LLM 能理解的 3-5 行文本
 *
 * 优先级筛选：P1(生死) > P2(危险) > P3(环境) > P4(社交) > P5(氛围)
 * 封顶 5 行，P1/P2 挤满就砍 P5。
 * 带冷却机制 + 温度联动。
 */

const MAX_LINES = 5;
const NEAR = 5;        // "附近" 判定距离
const VIEW = 3;        // 玩家朝向危险判定距离

// 敌对生物名单
const HOSTILE = new Set([
  "zombie", "skeleton", "spider", "cave_spider", "creeper", "witch",
  "enderman", "blaze", "ghast", "husk", "stray", "drowned", "pillager",
  "vindicator", "evoker", "hoglin", "piglin_brute", "wither_skeleton",
  "zombified_piglin", "phantom", "slime", "magma_cube", "warden", "shulker",
]);

// 稀有矿物名单
const RARE_ORES = new Set(["diamond_ore", "deepslate_diamond_ore", "emerald_ore",
  "deepslate_emerald_ore", "ancient_debris", "nether_quartz_ore"]);

// 危险方块
const DANGER_BLOCKS = new Set(["lava", "flowing_lava", "fire"]);

export class SnapshotEngine {
  constructor(bot, temp) {
    this.bot = bot;
    this.temp = temp;
    this.cooldowns = {};   // ruleId -> 下次可触发时间戳
    this.lastState = {};   // 记录上次状态用于变化检测
    // 挂机检测状态
    this.lastPlayerPos = null;
    this.lastPlayerMoveTime = Date.now();
  }

  /** 生成快照文本，返回字符串（可能为空） */
  generate() {
    const lines = [];
    const emit = (ruleId, cooldownMs, text) => {
      if (!text) return;
      // 冷却检查
      if (this._cooling(ruleId, cooldownMs)) return;
      lines.push({ ruleId, priority: this._priority(ruleId), text });
    };

    // ── P1 生死攸关 ──────────────────────────────────────
    emit("p1_health", 15000, this._healthAlert());
    emit("p1_fire", 10000, this._fireAlert());
    emit("p1_drown", 15000, this._drownAlert());
    emit("p1_fall", 5000, this._fallAlert());
    emit("p1_creeper", 8000, this._creeperAlert());
    emit("p1_poison", 20000, this._poisonAlert());
    emit("p1_lava", 10000, this._lavaAlert());

    // ── P2 即时危险 ──────────────────────────────────────
    emit("p2_hostile", 20000, this._hostileAlert());
    emit("p2_front", 20000, this._frontDangerAlert());
    emit("p2_self", 30000, this._selfDangerAlert());
    emit("p2_void", 15000, this._voidAlert());

    // ── P3 重要环境 ──────────────────────────────────────
    emit("p3_night", 60000, this._nightAlert());
    emit("p3_thunder", 60000, this._thunderAlert());
    emit("p3_rare_ore", 60000, this._rareOreAlert());
    emit("p3_valuable_hold", 60000, this._valuableHoldAlert());
    emit("p3_chest", 60000, this._chestAlert());
    emit("p3_tool_low", 120000, this._toolLowAlert());

    // ── P4 社交（温度联动）───────────────────────────────
    emit("p4_afk", 300000, this._afkAlert());
    emit("p4_silent", 600000, this._silentAlert());

    // ── P5 环境氛围（兜底）───────────────────────────────
    emit("p5_pos", 30000, this._positionLine());

    // 排序：priority 升序，然后截断
    lines.sort((a, b) => a.priority - b.priority);
    const selected = lines.slice(0, MAX_LINES);
    return selected.map(l => l.text).join("\n");
  }

  _priority(ruleId) {
    return parseInt(ruleId.split("_")[0].slice(1));
  }

  _cooling(ruleId, ms) {
    const now = Date.now();
    if (this.cooldowns[ruleId] && this.cooldowns[ruleId] > now) return true;
    this.cooldowns[ruleId] = now + ms;
    return false;
  }

  // ─── 工具：获取玩家 ────────────────────────────────────
  _player() {
    const key = Object.keys(this.bot.players).find(k => k !== this.bot.username);
    return key ? this.bot.players[key] : null;
  }

  _playerEntity() {
    const p = this._player();
    return p?.entity ?? null;
  }

  // ─── P1 规则 ───────────────────────────────────────────

  _healthAlert() {
    const e = this._playerEntity();
    if (!e || e.health == null) return null;
    if (e.health < 10) return `⚠️ 玩家血量只剩 ${Math.round(e.health)}/20 了`;
    return null;
  }

  _fireAlert() {
    try {
      const e = this._playerEntity();
      if (!e) return null;
      // mineflayer 4.x metadata 是索引数组，[0] 是实体状态位（bit0=着火）
      const flags = e.metadata && e.metadata[0];
      if (typeof flags === "number" && (flags & 0x01) === 0x01) {
        return "你着火了！快跳水里";
      }
    } catch { /* metadata 结构未知，安全忽略 */ }
    return null;
  }

  _drownAlert() {
    const e = this._playerEntity();
    if (!e) return null;
    // 玩家在水下且氧气低（用位置 + 水方块判断）
    if (!this.bot.entity) return null;
    const head = e.position.offset(0, 1.5, 0);
    const block = this.bot.blockAt(head);
    if (block && (block.name === "water" || block.name === "bubble_column")) {
      // 粗略判断氧气：无法直接读，用时长
      return "你在水下，注意氧气";
    }
    return null;
  }

  _fallAlert() {
    const e = this._playerEntity();
    if (!e || !this.bot.entity) return null;
    // 检查玩家下方 5 格
    let drops = 0;
    for (let dy = 1; dy <= 5; dy++) {
      const block = this.bot.blockAt(e.position.offset(0, -dy, 0));
      if (!block || block.name === "air" || block.name === "cave_air" || block.name === "void_air") {
        drops++;
      } else break;
    }
    if (drops >= 5) return "⚠️ 你脚下是空的，要摔了";
    return null;
  }

  _creeperAlert() {
    const e = this._playerEntity();
    if (!e) return null;
    const creeper = this.bot.nearestEntity(en =>
      en.name === "creeper" && e.position.distanceTo(en.position) < 3
    );
    return creeper ? "快跑！苦力怕要炸了！" : null;
  }

  _poisonAlert() {
    const e = this._playerEntity();
    if (!e) return null;
    // 检查效果（中毒 19 / 凋零 20）
    const effects = e.effects || {};
    if (effects[19] || effects[20]) return "你中毒了，快喝牛奶";
    return null;
  }

  _lavaAlert() {
    const e = this._playerEntity();
    if (!e || !this.bot.entity) return null;
    const foot = this.bot.blockAt(e.position);
    if (foot && DANGER_BLOCKS.has(foot.name)) return "你站在岩浆里！";
    return null;
  }

  // ─── P2 规则 ───────────────────────────────────────────

  _hostileAlert() {
    const e = this._playerEntity();
    if (!e) return null;
    const hostiles = Object.values(this.bot.entities)
      .filter(en => HOSTILE.has(en.name) && e.position.distanceTo(en.position) < NEAR)
      .sort((a, b) => a.position.distanceTo(e.position) - b.position.distanceTo(e.position))
      .slice(0, 2);
    if (hostiles.length === 0) return null;
    const desc = hostiles.map(h => `${h.name}（${Math.round(e.position.distanceTo(h.position))}格外）`).join("、");
    return `附近有 ${desc}`;
  }

  _frontDangerAlert() {
    const e = this._playerEntity();
    if (!e || !this.bot.entity) return null;
    // 玩家前方 3 格
    const yaw = e.yaw ?? 0;
    const dirX = -Math.sin(yaw);
    const dirZ = -Math.cos(yaw);
    for (let d = 1; d <= VIEW; d++) {
      const pos = e.position.offset(dirX * d, 0, dirZ * d);
      const block = this.bot.blockAt(pos);
      if (block && DANGER_BLOCKS.has(block.name)) return `⚠️ 你前方有${block.name === "lava" || block.name === "flowing_lava" ? "岩浆" : "火"}`;
    }
    return null;
  }

  _selfDangerAlert() {
    if (!this.bot.entity) return null;
    if (this.bot.health < 10) return "（我快不行了，先躲一下）";
    return null;
  }

  _voidAlert() {
    const e = this._playerEntity();
    if (!e || !this.bot.entity) return null;
    if (e.position.y < 0) return "下面是虚空，别往前！";
    return null;
  }

  // ─── P3 规则 ───────────────────────────────────────────

  _nightAlert() {
    const e = this._playerEntity();
    if (!e || !this.bot.entity) return null;
    const t = this.bot.time?.timeOfDay ?? 6000;
    // 13000-23000 为夜晚
    if (t >= 13000 && t <= 23000) {
      // 判断是否在户外（上方没有实心方块）
      const above = this.bot.blockAt(e.position.offset(0, 4, 0));
      const inOpen = !above || above.name === "air";
      if (inOpen) return "天黑了，怪物要出来了";
    }
    return null;
  }

  _thunderAlert() {
    return this.bot.thunderState > 0 ? "打雷了，小心被劈" : null;
  }

  _rareOreAlert() {
    const e = this._playerEntity();
    if (!e || !this.bot.entity) return null;
    const p = e.position;
    for (let dx = -8; dx <= 8; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dz = -8; dz <= 8; dz++) {
          const b = this.bot.blockAt(p.offset(dx, dy, dz));
          if (b && RARE_ORES.has(b.name)) {
            return `你附近有${b.name.includes("diamond") ? "钻石" : b.name.includes("emerald") ? "绿宝石" : "远古残骸"}！`;
          }
        }
      }
    }
    return null;
  }

  _valuableHoldAlert() {
    const e = this._playerEntity();
    if (!e) return null;
    const held = e.heldItem;
    if (held && ["enchanted_golden_apple", "netherite_ingot", "netherite_sword", "diamond_sword"].some(n => held.name.includes(n))) {
      return "你拿着那么好的东西，小心点";
    }
    return null;
  }

  _chestAlert() {
    const e = this._playerEntity();
    if (!e || !this.bot.entity) return null;
    const chest = this.bot.findBlock({
      matching: (b) => b.name.includes("chest") || b.name === "barrel" || b.name === "shulker_box",
      maxDistance: 5,
      count: 1,
    });
    return chest ? "附近有个箱子" : null;
  }

  _toolLowAlert() {
    const e = this._playerEntity();
    if (!e) return null;
    const held = e.heldItem;
    if (held && held.durabilityUsed != null && held.maxDurability != null) {
      const ratio = 1 - held.durabilityUsed / held.maxDurability;
      if (ratio < 0.15) return "你的工具快断了";
    }
    return null;
  }

  // ─── P4 规则（温度联动）───────────────────────────────

  _afkAlert() {
    const e = this._playerEntity();
    if (!e) return null;
    const pos = e.position;
    const now = Date.now();

    // 首次采样：记录位置
    if (!this.lastPlayerPos) {
      this.lastPlayerPos = { x: pos.x, y: pos.y, z: pos.z };
      this.lastPlayerMoveTime = now;
      return null;
    }

    // 检测位移（1.5 格阈值过滤微小抖动）
    const dx = pos.x - this.lastPlayerPos.x;
    const dy = pos.y - this.lastPlayerPos.y;
    const dz = pos.z - this.lastPlayerPos.z;
    if (dx * dx + dy * dy + dz * dz > 2.25) {
      this.lastPlayerPos = { x: pos.x, y: pos.y, z: pos.z };
      this.lastPlayerMoveTime = now;
      return null; // 还在动，不算挂机
    }

    // 挂机时长
    const idleSec = (now - this.lastPlayerMoveTime) / 1000;
    if (idleSec < 60) return null; // 不到 60 秒不打扰

    // 温度越高越主动关心
    const stage = this.temp.stage.id;
    const lines = {
      cold: null,
      cool: null,
      neutral: null,
      warm: "（看了你一眼）站那发什么呆呢？",
      attached: "（走到你身边，抬头看你）怎么了？一直不动。",
    };
    return lines[stage] || null;
  }

  _silentAlert() {
    const stage = this.temp.stage.id;
    const lines = {
      cold: null,
      cool: null,
      neutral: null,
      warm: "（看了你一眼）",
      attached: "（悄悄跟在你身边）",
    };
    return lines[stage] || null;
  }

  // ─── P5 兜底 ───────────────────────────────────────────

  _positionLine() {
    const e = this._playerEntity();
    if (!e || !this.bot.entity) return null;
    const p = e.position;
    const dist = Math.round(this.bot.entity.position.distanceTo(p));
    const held = e.heldItem ? e.heldItem.name : "空手";
    return `玩家在 (${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})，拿着${held}，离我 ${dist} 格`;
  }
}
