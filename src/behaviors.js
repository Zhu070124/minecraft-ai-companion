/**
 * 行动层 — bot 的动作执行
 *
 * 这是 agent loop 的「行动」环节，决策权在 LLM。
 * 本层负责三件事（Kimi 提的"让她自主但别蠢"）：
 *   1. 行动前可行性检查（能不能走到那儿）
 *   2. 行动后结果验证（我做到预期了吗）
 *   3. 失败回滚策略（卡住了/走丢了怎么办）
 * 移动统一用 mineflayer-navigate（bot.navigate）。
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { Vec3 } = require("vec3");

const HOSTILE_NAMES = [
  "zombie", "skeleton", "spider", "cave_spider", "creeper", "witch",
  "enderman", "blaze", "ghast", "husk", "stray", "drowned", "pillager",
  "vindicator", "evoker", "hoglin", "piglin_brute", "wither_skeleton",
  "zombified_piglin", "phantom", "slime", "magma_cube",
];

const LOGS = ["oak_log", "birch_log", "spruce_log", "jungle_log",
  "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log",
  "pale_oak_log", "mushroom_stem", "crimson_stem", "warped_stem"];

const MAX_DISTANCE = 150;   // navigate 寻路最远距离（TOO_FAR_THRESHOLD）
const MAX_HEIGHT_DIFF = 15; // 高度差超过这个值大概率爬不上去
const STUCK_TIMEOUT = 60000; // 移动超过 60 秒没结果视为卡住
const PATH_TIMEOUT = 1500;  // A* 寻路超时(ms)——防找不到路径时同步阻塞事件循环导致掉线

export class BehaviorEngine {
  constructor(bot, onActionResult) {
    this.bot = bot;
    this.onActionResult = onActionResult || (() => {});
    this.currentAction = "发呆";
    this.stuckTimer = null;

    // ─── navigate 结果验证 + 回滚 ─────────────────────────
    try {
      bot.navigate.on("pathFound", (path) =>
        console.log("[Navigate] ✅ 找到路径，长度:", path?.length)
      );

      bot.navigate.on("arrived", () => {
        console.log("[Navigate] ✅ 到达目标");
        this._clearStuck();
        // build 模式下由 buildFromMatrix 统一汇报，这里不重复报「成功」
        if (this.currentAction !== "build") {
          this.onActionResult({ success: true, action: this.currentAction });
        }
      });

      bot.navigate.on("cannotFind", (closestPath) => {
        console.log("[Navigate] ❌ 找不到路径，走到最近点");
        this._clearStuck();
        // build 模式下由 buildFromMatrix 统一汇报 + 不触发回滚走位
        if (this.currentAction !== "build") {
          this.onActionResult({ success: false, reason: "cannotFind", action: this.currentAction });
          // 回滚：走到能走的最远点，尽量靠近目标
          if (closestPath && closestPath.length > 0) {
            bot.navigate.walk(closestPath).catch(() => {});
          }
        }
      });

      bot.navigate.on("interrupted", () => console.log("[Navigate] ⚠️ 被打断"));
    } catch (err) { /* navigate 可能未加载 */ }
  }

  // ─── 可行性检查 ─────────────────────────────────────────

  /** 判断能否走到目标（距离 + 高度差预检） */
  _canReach(targetPos) {
    if (!this.bot.entity) return { ok: false, reason: "bot 未生成" };
    const myPos = this.bot.entity.position;
    const dist = myPos.distanceTo(targetPos);
    const heightDiff = Math.abs(targetPos.y - myPos.y);
    if (dist > MAX_DISTANCE) return { ok: false, reason: `太远(${Math.round(dist)}格)` };
    if (heightDiff > MAX_HEIGHT_DIFF) return { ok: false, reason: `高度差太大(${Math.round(heightDiff)}格)` };
    return { ok: true };
  }

  // ─── 统一移动（可行性检查 + 卡住超时回滚）──────────────

  _move(targetPos, endRadius, actionName) {
    const check = this._canReach(targetPos);
    if (!check.ok) {
      console.log(`[Action] ${actionName} 可行性检查失败：${check.reason}`);
      this.onActionResult({ success: false, reason: check.reason, action: actionName });
      return false;
    }
    this.currentAction = actionName;
    this.bot.navigate.to(targetPos, { endRadius, timeout: PATH_TIMEOUT });
    this._startStuckTimer(actionName);
    return true;
  }

  _startStuckTimer(actionName) {
    this._clearStuck();
    this.stuckTimer = setTimeout(() => {
      console.log(`[Action] ${actionName} 卡住超时(${STUCK_TIMEOUT / 1000}s)，放弃`);
      try { this.bot.navigate.stop(); } catch { /* ignore */ }
      this.onActionResult({ success: false, reason: "stuck", action: actionName });
    }, STUCK_TIMEOUT);
  }

  _clearStuck() {
    if (this.stuckTimer) { clearTimeout(this.stuckTimer); this.stuckTimer = null; }
  }

  /**
   * 导航并等待到达（供建造等「必须到位再动手」的场景用）
   * 区别于 _move 的开火即忘：这里 await 到 arrived/cannotFind/obstructed/超时。
   * @returns {Promise<boolean>} 是否成功到达
   */
  _navigateTo(targetPos, endRadius, actionName) {
    return new Promise((resolve) => {
      const check = this._canReach(targetPos);
      if (!check.ok) {
        console.log(`[Action] ${actionName} 可行性检查失败：${check.reason}`);
        this.onActionResult({ success: false, reason: check.reason, action: actionName });
        resolve(false);
        return;
      }
      this.currentAction = actionName;

      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        this._clearStuck();
        this.bot.navigate.removeListener("arrived", onArrived);
        this.bot.navigate.removeListener("cannotFind", onCannotFind);
        this.bot.navigate.removeListener("obstructed", onObstructed);
        this.bot.navigate.removeListener("interrupted", onInterrupted);
        resolve(ok);
      };
      const onArrived = () => finish(true);
      const onCannotFind = () => finish(false);
      const onObstructed = () => finish(false);
      const onInterrupted = () => finish(false); // stop/打断也要 resolve，否则永久挂起

      this.bot.navigate.on("arrived", onArrived);
      this.bot.navigate.on("cannotFind", onCannotFind);
      this.bot.navigate.on("obstructed", onObstructed);
      this.bot.navigate.on("interrupted", onInterrupted);

      this.bot.navigate.to(targetPos, { endRadius, timeout: PATH_TIMEOUT });

      this._clearStuck();
      this.stuckTimer = setTimeout(() => {
        console.log(`[Action] ${actionName} 卡住超时(${STUCK_TIMEOUT / 1000}s)，放弃`);
        try { this.bot.navigate.stop(); } catch { /* ignore */ }
        finish(false);
      }, STUCK_TIMEOUT);
    });
  }

  // ─── 动作方法 ───────────────────────────────────────────

  /** 走到玩家面前 */
  approach(player) {
    if (!player?.entity) return false;
    const pos = player.entity.position;
    this.bot.lookAt(pos.offset(0, 1.6, 0));
    return this._move(pos.offset(0, 0, 0), 2, "approach");
  }

  /** 跟随玩家（保持距离由温度决定） */
  follow(player, distance = 5) {
    if (!player?.entity) return false;
    const pos = player.entity.position;
    this.bot.lookAt(pos.offset(0, 1.6, 0));
    return this._move(pos.offset(0, 0, 0), distance, "follow");
  }

  /** 停止移动 */
  stopMoving() {
    this._clearStuck();
    try { this.bot.navigate.stop(); } catch { /* ignore */ }
  }

  /** 跳一下（用于让开自己身体挡住的方块） */
  async jump() {
    this.bot.setControlState("jump", true);
    await new Promise((r) => setTimeout(r, 200));
    this.bot.setControlState("jump", false);
  }

  /** 判断 bot 自己身体是否占了目标方块（脚底到头顶） */
  _isSelfOccupying(pos) {
    if (!this.bot.entity) return false;
    const p = this.bot.entity.position;
    const h = this.bot.entity.height ?? 1.8;
    const yMin = Math.floor(p.y);
    const yMax = Math.floor(p.y + h - 0.01);
    return Math.floor(p.x) === pos.x && pos.y >= yMin && pos.y <= yMax && Math.floor(p.z) === pos.z;
  }

  /** 采集指定方块：找到最近的匹配方块，走过去挖掉 */
  collectBlock(matchFn, maxDistance = 20) {
    try {
      const block = this.bot.findBlock({ matching: matchFn, maxDistance });
      if (!block) return false;
      this._move(block.position, 3, "collect");
      this.bot.dig(block).catch(() => {});
      return true;
    } catch { return false; }
  }

  /** 砍树 */
  chopTree() {
    return this.collectBlock(b => LOGS.includes(b.name), 20);
  }

  /** 挖矿 */
  mine() {
    return this.collectBlock(b => b.name.endsWith("_ore"), 20);
  }

  /** 攻击指定生物（按名字匹配） */
  attackEntity(name) {
    try {
      const target = this.bot.nearestEntity(e =>
        e.name === name || (e.displayName && e.displayName === name)
      );
      if (!target) return false;
      this._move(target.position, 3, "attack");
      this.bot.lookAt(target.position.offset(0, 1.5, 0));
      this.bot.attack(target);
      return true;
    } catch { return false; }
  }

  /** 攻击最近的敌对生物 */
  attackNearest() {
    try {
      const hostile = this.bot.nearestEntity(e => HOSTILE_NAMES.includes(e.name));
      if (!hostile) return false;
      this._move(hostile.position, 3, "attack");
      this.bot.lookAt(hostile.position.offset(0, 1.5, 0));
      this.bot.attack(hostile);
      return true;
    } catch { return false; }
  }

  /**
   * 放置方块（建造地基）
   * 库存检查 → 装备到手上 → 放在脚下参考方块的正上方（可连续调用往上垫）
   * @param {string} blockName - 方块名，如 oak_planks / cobblestone / dirt
   * @param {number} count - 放置数量，默认 1
   */
  async placeBlock(blockName, count = 1) {
    try {
      // 1. 库存检查
      const item = this.bot.inventory.items().find(i => i.name === blockName);
      if (!item) {
        this.onActionResult({ success: false, reason: `库存没有 ${blockName}`, action: "place" });
        return false;
      }

      // 2. 装备到手上
      await this.bot.equip(item, "hand");

      // 3. 找脚下参考方块
      if (!this.bot.entity) return false;
      let refBlock = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
      if (!refBlock || refBlock.name === "air" || refBlock.name === "cave_air") {
        this.onActionResult({ success: false, reason: "脚下没有可作参考的方块", action: "place" });
        return false;
      }

      // 4. 逐块放置（放在参考方块正上方，faceVector 朝上）
      this.currentAction = "place";
      for (let i = 0; i < count; i++) {
        await this.bot.placeBlock(refBlock, { x: 0, y: 1, z: 0 });
        // 每放一块，脚下参考自动变成刚放的那块（位置往上挪一格）
        refBlock = this.bot.blockAt(refBlock.position.offset(0, 1, 0));
        if (!refBlock || refBlock.name === "air") break;
      }
      this.onActionResult({ success: true, action: "place" });
      return true;
    } catch (err) {
      this.onActionResult({ success: false, reason: err.message, action: "place" });
      return false;
    }
  }

  /**
   * 判断目标方块位置是否被实体（玩家/生物）身体占用
   * 占用了就不能 placeBlock（会 5 秒超时），跳过留给 retry 补
   */
  _isOccupiedByEntity(pos) {
    for (const entity of Object.values(this.bot.entities)) {
      if (entity === this.bot.entity) continue; // 自己会站到邻格，不算
      if (entity.name === "item" || entity.name === "Item") continue; // 掉落物不挡放置
      const p = entity.position;
      if (!p) continue;
      const h = entity.height ?? 1.8;
      const yMin = Math.floor(p.y);
      const yMax = Math.floor(p.y + h - 0.01);
      if (Math.floor(p.x) === pos.x && pos.y >= yMin && pos.y <= yMax && Math.floor(p.z) === pos.z) {
        return true;
      }
    }
    return false;
  }

  /**
   * 按坐标矩阵建造（build_structure 的行动层）—— reach 分组放置
   * 方块列表已按 y 升序（从下往上）。每格：
   *   已放则跳过 → 实体占用则跳过 → 库存+装备 → 够得着直接放 / 够不着导航到附近 → 试 6 邻格放置
   * @param {Array<{block:string,x:number,y:number,z:number}>} blocks - 绝对坐标矩阵
   */
  async buildFromMatrix(blocks, origin) {
    if (!Array.isArray(blocks) || blocks.length === 0) return false;
    this.currentAction = "build";

    const oy = origin?.y ?? this.bot.entity?.position?.y ?? 0; // 站位地面层（不是目标块高度，高层块悬空走不到）
    const REACH = 4; // 放方块的最大距离（够得着就不导航，只挪一次覆盖一片）

    let placed = 0;
    const failed = [];

    for (const b of blocks) {
      try {
        const targetVec = new Vec3(b.x, b.y, b.z);

        // 0. 已放好的方块跳过（避免重复放 + 白走一趟）
        const existing = this.bot.blockAt(targetVec);
        if (existing && existing.name !== "air" && existing.name !== "cave_air") {
          placed++;
          continue;
        }

        // 1. 目标位置被实体（玩家/生物）占着就跳过
        if (this._isOccupiedByEntity(targetVec)) {
          failed.push({ ...b, reason: "位置被实体占用" });
          continue;
        }

        // 2. 库存 + 装备
        const item = this.bot.inventory.items().find((i) => i.name === b.block);
        if (!item) {
          failed.push({ ...b, reason: `库存没有 ${b.block}` });
          continue;
        }
        await this.bot.equip(item, "hand");

        // 3. 够得着就直接放；够不着导航到目标附近（地面层，reach 半径，覆盖一片）
        const dist = this.bot.entity.position.distanceTo(targetVec.offset(0.5, 0.5, 0.5));
        if (dist > REACH) {
          const navTarget = new Vec3(b.x, oy, b.z);
          const arrived = await this._navigateTo(navTarget, REACH, "build");
          if (!arrived) {
            failed.push({ ...b, reason: "导航失败（到不了目标）" });
            continue;
          }
        }

        // 4. 试 6 邻格找参考方块放置
        const ok = await this._placeAt(targetVec);
        if (ok) placed++;
        else failed.push({ ...b, reason: "找不到参考方块" });
      } catch (err) {
        failed.push({ ...b, reason: err.message });
      }
    }

    this.onActionResult({
      success: failed.length === 0,
      action: "build",
      reason: failed.length > 0 ? `${placed} 成功 / ${failed.length} 失败（${failed.slice(0, 3).map((f) => f.reason).join("; ")}）` : undefined,
    });
    return failed.length === 0;
  }

  /**
   * 在目标位置放方块：试 6 个邻格找参考方块，用正确的 faceVec 放置；自挡则起跳让开
   * @param {Vec3} targetVec - 目标方块坐标
   * @returns {Promise<boolean>}
   */
  async _placeAt(targetVec) {
    const adj = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

    // 自挡则先起跳让开
    const selfBlocked = this._isSelfOccupying(targetVec);
    if (selfBlocked) {
      this.bot.setControlState("jump", true);
      await new Promise((r) => setTimeout(r, 120));
    }
    try {
      for (const [dx, dy, dz] of adj) {
        const refBlock = this.bot.blockAt(targetVec.offset(dx, dy, dz));
        if (!refBlock || refBlock.boundingBox !== "block") continue;
        try {
          const faceVec = targetVec.minus(refBlock.position); // 参考方块 → 目标 的方向向量
          await this.bot.lookAt(refBlock.position.offset(0.5, 0.5, 0.5));
          await this.bot.placeBlock(refBlock, faceVec);
          return true;
        } catch {
          // 这个参考方块不行，试下一个
        }
      }
      return false;
    } finally {
      if (selfBlocked) this.bot.setControlState("jump", false);
    }
  }
}
