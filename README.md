# Minecraft AI 队友（minecraft-ai-companion）

一个「无限接近活人」的 Minecraft AI 队友——可选人格、情感温度、持久记忆、自我认知演化、自主性。

> 不是工具型 bot，是「选一个合得来的队友」。没有温度系统、没有情感弧线、没有自我认知演化的 bot，都只是工具。

## 特性

- **可选人格**：傲娇 / 甜妹 / 高冷 / 暖心 四种预设，也可自定义 YAML
- **情感温度引擎（Tempura）**：0-100 温度驱动态度（冷漠→疏离→平常→亲近→依恋），事件驱动（送礼升温、被坑记仇），跨会话持久化
- **持久记忆**：送礼、对话记忆，`lens` 分类
- **自我认知演化（慢反思 loop）**：认知 ⇄ 情感强链接——被触动时反思、沉淀自我认知、情绪反哺温度
- **自主性（欲望层）**：情绪态派生「内心欲望」（想亲近/想疏远/无聊/想给惊喜），驱动自主行为，而非纯反应
- **联网搜索 + 图纸建造**：Tavily 搜索教程 → 结构化原语 → 逐格放置
- **事件日志 + 会话持久化**：对话/工具结果/温度全部落盘，重启不丢

## 架构

```
感知 → LLM 决策 → 行动 → 结果进下轮感知 → 循环
```

| 文件 | 职责 |
|---|---|
| `src/router.js` | Agent Loop 调度器：事件日志、工具循环、慢反思、欲望层 |
| `src/behaviors.js` | 行动层：导航、建造、采集、跳跃 |
| `src/temperature.js` | 情感温度引擎（Tempura） |
| `src/persona.js` | SOUL 解析 + System Prompt 构建 |
| `src/bot.js` | Mineflayer 封装（聊天/送礼/生命周期） |
| `src/blueprint.js` | 图纸解析（LLM 原语 → 坐标矩阵） |
| `src/local-memory.js` | 本地记忆库 |
| `config/presets/` | 预设人格 YAML |

## 快速开始

### 依赖
- Node.js ≥ 18
- Minecraft 服务器（1.21.x，`online-mode=false`）

### 安装
```bash
npm install
```

### 配置
```bash
export LLM_API_KEY=sk-xxx   # DeepSeek API key
```

### 启动
```bash
node src/index.js
# 或 Windows 双击 start.bat
```

打开 http://localhost:8848 配置人格，点「启动」连上 MC 服务器（默认 `localhost:65293`，可在 `/api/start` 时指定）。

## 设计哲学

核心不是「让 bot 会更多技能」，而是「让 bot 有个会成长的自我」：

- **锚（写死不动）**：身份 + 关系 + 价值——「我是小西柚，我是泡芙的队友，我想成为更好的队友」
- **可演化层**：行为表达（甜妹怎么说话）、自我认知（`lens:self` 记忆）——随经历沉淀
- **认知 ⇄ 情感强链接**：情绪事件触发反思，反思反哺情绪，两者是同一个东西

## 测试

`test/player.js` 是一个模拟玩家的 bot（自动送礼物、发对话），`test/verify.js` 用于验证建造是否落地：

```bash
node test/player.js   # 需要先启动 companion + 一个 MC 服
```

## License

[MIT](LICENSE)
