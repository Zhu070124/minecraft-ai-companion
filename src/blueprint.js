/**
 * 图纸解析层 —— 决策 B 的核心
 *
 * LLM 不直接吐坐标（容易算错），而是输出「结构化建筑原语」，
 * 本层把原语展开成精确坐标矩阵，再交给行为层逐格放置。
 *
 * 原语类型（LLM 输出这些，代码算坐标）：
 *   floor  铺地板   { action:"floor", block, offset:{x,z}, size:{x,z} }
 *   wall   砌墙     { action:"wall",  block, offset:{x,y,z}, axis:"x"|"z", length, height }
 *   pillar 立柱子   { action:"pillar", block, offset:{x,z}, height }
 *   box    完整盒子 { action:"box", block, offset:{x,y,z}, size:{x,y,z}, hollow }
 *
 * 所有 offset 相对「原点」（玩家位置或玩家指定位置）。
 * 放置顺序按 y 升序 —— mineflayer 放方块需要下方有参考方块，必须从下往上。
 */

const MAX_SIZE = 32;   // 单轴最大跨度，防止 LLM 输出离谱尺寸
const MAX_BLOCKS = 500; // 单次建造最大方块数

/**
 * 展开原语序列为坐标矩阵
 * @param {Array} primitives - LLM 输出的原语数组
 * @param {{x:number,y:number,z:number}} origin - 原点（绝对坐标）
 * @returns {{ok:boolean, blocks?:Array, error?:string}} 排序去重后的方块列表
 */
export function expandPrimitives(primitives, origin) {
  if (!Array.isArray(primitives) || primitives.length === 0) {
    return { ok: false, error: "空图纸：没有建造原语" };
  }

  const set = new Map(); // "x,y,z" -> blockName（去重，后写的覆盖前写的）
  const o = origin ?? { x: 0, y: 0, z: 0 };

  for (const p of primitives) {
    const err = _validatePrimitive(p);
    if (err) return { ok: false, error: err };

    let coords;
    switch (p.action) {
      case "floor":  coords = _floor(p); break;
      case "wall":   coords = _wall(p); break;
      case "pillar": coords = _pillar(p); break;
      case "box":    coords = _box(p); break;
      default: return { ok: false, error: `未知原语: ${p.action}` };
    }

    for (const c of coords) {
      set.set(`${c.x},${c.y},${c.z}`, p.block);
    }
  }

  if (set.size > MAX_BLOCKS) {
    return { ok: false, error: `图纸太大（${set.size} 块），上限 ${MAX_BLOCKS}` };
  }

  const blocks = [...set.entries()].map(([key, block]) => {
    const [x, y, z] = key.split(",").map(Number);
    return { block, x: o.x + x, y: o.y + y, z: o.z + z };
  });

  // 排序：先按 y 升序（从下往上，保证每格下方有支撑）；
  // 同一层按「离原点距离」降序（从外往里放，避免 bot 放完外圈后挡自己去内圈的路）
  const ox = o.x, oz = o.z;
  blocks.sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    const da = (a.x - ox) ** 2 + (a.z - oz) ** 2;
    const db = (b.x - ox) ** 2 + (b.z - oz) ** 2;
    return db - da;
  });

  return { ok: true, blocks };
}

// ─── 原语校验 ─────────────────────────────────────────────

function _validatePrimitive(p) {
  if (!p || typeof p !== "object") return "原语必须是对象";
  if (!p.action) return "原语缺少 action";
  if (!p.block) return `原语 ${p.action} 缺少 block`;

  const s = p.size ?? {};
  const len = p.length ?? 0;
  const h = p.height ?? 0;

  // 尺寸上限校验
  const dims = [s.x ?? 0, s.y ?? 0, s.z ?? 0, len, h];
  if (dims.some(d => d > MAX_SIZE || d < 0)) {
    return `原语 ${p.action} 尺寸超限（单轴最大 ${MAX_SIZE}）`;
  }
  return null;
}

// ─── 各原语展开 ───────────────────────────────────────────

/** 地板：从 offset 铺 x×z 的一层（y=offset.y，默认 0） */
function _floor(p) {
  const ox = p.offset?.x ?? 0;
  const oy = p.offset?.y ?? 0;
  const oz = p.offset?.z ?? 0;
  const sx = p.size?.x ?? 1;
  const sz = p.size?.z ?? 1;
  const out = [];
  for (let x = 0; x < sx; x++)
    for (let z = 0; z < sz; z++)
      out.push({ x: ox + x, y: oy, z: oz + z });
  return out;
}

/** 墙：沿 axis 方向长 length、高 height（y 从 offset.y 起） */
function _wall(p) {
  const ox = p.offset?.x ?? 0;
  const oy = p.offset?.y ?? 0;
  const oz = p.offset?.z ?? 0;
  const len = p.length ?? 1;
  const h = p.height ?? 1;
  const axis = p.axis === "z" ? "z" : "x";
  const out = [];
  for (let i = 0; i < len; i++)
    for (let y = 0; y < h; y++) {
      if (axis === "x") out.push({ x: ox + i, y: oy + y, z: oz });
      else out.push({ x: ox, y: oy + y, z: oz + i });
    }
  return out;
}

/** 柱子：从 offset 起垂直 height 高 */
function _pillar(p) {
  const ox = p.offset?.x ?? 0;
  const oz = p.offset?.z ?? 0;
  const oy = p.offset?.y ?? 0;
  const h = p.height ?? 1;
  const out = [];
  for (let y = 0; y < h; y++) out.push({ x: ox, y: oy + y, z: oz });
  return out;
}

/** 盒子：size xyz 的实心/空心结构 */
function _box(p) {
  const ox = p.offset?.x ?? 0;
  const oy = p.offset?.y ?? 0;
  const oz = p.offset?.z ?? 0;
  const sx = p.size?.x ?? 1;
  const sy = p.size?.y ?? 1;
  const sz = p.size?.z ?? 1;
  const hollow = p.hollow ?? false;
  const out = [];
  for (let x = 0; x < sx; x++)
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++) {
        const isEdge = x === 0 || x === sx - 1 || y === 0 || y === sy - 1 || z === 0 || z === sz - 1;
        if (!hollow || isEdge) out.push({ x: ox + x, y: oy + y, z: oz + z });
      }
  return out;
}
