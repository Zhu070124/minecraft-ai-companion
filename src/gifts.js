/**
 * 礼物物品清单
 *
 * 玩家在 bot 附近丢弃这些物品 → 视为送礼 → 触发 gift_received
 * 不限于贵重物品，包含花束、食物等有情感表达意味的物品
 */

export const GIFT_ITEMS = new Set([
  // 贵重矿物
  "diamond",
  "emerald",
  "netherite_ingot",
  "netherite_scrap",
  "ancient_debris",

  // 花（所有品种）
  "dandelion",
  "poppy",
  "blue_orchid",
  "allium",
  "azure_bluet",
  "red_tulip",
  "orange_tulip",
  "white_tulip",
  "pink_tulip",
  "oxeye_daisy",
  "cornflower",
  "lily_of_the_valley",
  "wither_rose",
  "sunflower",
  "lilac",
  "rose_bush",
  "peony",
  "torchflower",

  // 甜品/食物
  "cake",
  "cookie",
  "pumpkin_pie",
  "golden_apple",
  "enchanted_golden_apple",
  "golden_carrot",
  "honey_bottle",

  // 情感物品
  "music_disc_13",
  "music_disc_cat",
  "music_disc_blocks",
  "music_disc_chirp",
  "music_disc_far",
  "music_disc_mall",
  "music_disc_mellohi",
  "music_disc_stal",
  "music_disc_strad",
  "music_disc_ward",
  "music_disc_11",
  "music_disc_wait",
  "music_disc_otherside",
  "music_disc_5",
  "music_disc_pigstep",
  "music_disc_relic",
  "totem_of_undying",
  "heart_of_the_sea",
  "nautilus_shell",
  "echo_shard",
  "amethyst_shard",
  "rabbit_foot",

  // 手工/特殊物品
  "writable_book",
  "written_book",
  "name_tag",
  "firework_rocket",
  "beacon",
  "conduit",
  "ender_pearl",
  "ender_eye",
]);

/**
 * 判断一个物品名称是否在礼物清单中
 * @param {string} itemName — minecraft item name, e.g. "diamond" or "red_tulip"
 */
export function isGift(itemName) {
  return GIFT_ITEMS.has(itemName);
}

/**
 * 从 Item 实体中提取物品名称
 * mineflayer 4.x 用 entity.getDroppedItem() 直接拿 Item 对象
 * @param {object} entity — Mineflayer entity
 * @returns {string|null}
 */
export function extractItemName(entity) {
  try {
    if (typeof entity.getDroppedItem === "function") {
      const item = entity.getDroppedItem();
      if (item?.name) return item.name;
    }
  } catch { /* 解析失败 */ }
  return null;
}
