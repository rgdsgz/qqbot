# 项目目录结构

## 1. 根目录

```
D:\E\programming\
├─ README.md               项目说明
├─ start-all.bat           一键启动 NapCat + 机器人
├─ start-napcat.bat        只启动 NapCat
├─ start-bot.bat           只启动机器人
├─ stop-all.bat            停止
├─ status.bat              查看状态
├─ backup.bat              加密备份 data + config（.qbak）
├─ restore-backup.bat      解密恢复到 restore-* 目录
├─ config.json             运行配置（含 API Key）
├─ config.example.json     配置模板
├─ data\                   全部运行数据（本地）
├─ backups\                加密备份 .qbak（旧 zip 为历史）
├─ docs\                   文档
│  ├─ USAGE.md             使用、配置与排障
│  ├─ PLAN.md              功能规划与进度
│  └─ STRUCTURE.md         本文件
├─ overview\               项目概览与交接
│  ├─ README.md
│  ├─ 01-architecture.md
│  ├─ 02-design-decisions.md
│  ├─ 03-operations-handover.md
│  └─ 04-code-map.md
├─ qqbot\                  机器人源码（独立版，入口 src\standalone）
│  ├─ src\standalone\      机器人本体
│  ├─ src\                 复用的 OneBot/媒体/出站模块 + 上游插件遗留
│  ├─ scripts\             构建、验证、打标、向量回填
│  └─ dist\standalone\     编译产物
└─ napcat\                 NapCat 本体
```

## 2. 运行数据 `data/`

```
data/
├─ owner.json              已绑定主人
├─ sessions\               每个会话的最近上下文 JSON
├─ memory\
│  ├─ chat.db              SQLite：messages / facts / summaries / embeddings / state / follow_ups
│  └─ summaries\           日/周摘要的 Markdown 导出（可选）
├─ models\                 本地 embedding 模型缓存（可重新下载）
├─ persona\
│  ├─ SOUL.md              人设：身份、性格、说话方式、边界、示例对话
│  ├─ USER.md              稳定用户画像（预算 1375 字符）
│  └─ MEMORY.md            长期事件/约定（预算 2200 字符，§ 条目）
├─ memes\
│  ├─ index.json           图库索引：path/tag/caption/keywords/hash/lastUsedAt
│  ├─ happy\               标签目录
│  ├─ angry\
│  ├─ sad\
│  ├─ shy\
│  ├─ confused\
│  ├─ daily\
│  ├─ work\
│  ├─ sleep\
│  └─ inbox\               新收藏待整理
├─ media\                  收到的图片/语音（永久保留）
├─ outbox\                 想主动发送的本地图片
└─ logs\
   └─ bot.log              机器人日志
```

规则：

- 所有持久数据都在 `data/`，`backup.bat` 会加密打包 `data/`（排除 models）+ `config.json`，输出 `backups/*.qbak`；密码不保存，忘了无法恢复。
- `media/` 永久保留（不再按 6 小时清理）。
- `memory/chat.db` 是长期记忆的真相源；`USER.md` / `MEMORY.md` 是可读导出/编辑层。
- `memes/index.json` 可随时重建（扫描目录），图片文件本身才是资产。

## 3. 源码 `qqbot/src/standalone/`

按功能分层：

```
src/standalone/
├─ main.ts                 启动、装配、优雅退出
├─ config.ts               配置加载/校验/默认值
├─ owner\                  主人绑定
│  └─ store.ts
├─ transport\              OneBot/NapCat 接入层
│  └─ bridge.ts           事件过滤、媒体解析、发送、typing
├─ agent\                  Agent 回合
│  ├─ index.ts             ChatAgent：回合队列、工具循环、主动回合
│  ├─ llm.ts               OpenAI 兼容客户端
│  ├─ prompt.ts            系统提示组装（人设 + 记忆 + 时间 + 工具）
│  └─ tools.ts             工具定义与执行（send_meme/send_image/learn_meme/…）
├─ session\                最近上下文
│  └─ store.ts             每聊天 JSON、裁剪、图片编码
├─ persona\                人设与文件记忆
│  ├─ index.ts             加载/渲染 SOUL+USER+MEMORY
│  ├─ files.ts             读写、§ 条目、预算、原子写
│  └─ render.ts            渲染成 prompt 段
├─ memory\                 长期记忆（P1 已实现）
│  ├─ index.ts             MemoryService 门面：归档/检索/抽取/摘要
│  ├─ db.ts                SQLite 打开/WAL/消息/事实/摘要/状态/follow-up
│  ├─ schema.ts            建表与 FTS5 触发器
│  ├─ types.ts             行与输入类型
│  ├─ extract.ts           异步抽取事实/情绪/follow-up
│  ├─ recall.ts            FTS5 + LIKE + 排序 + 摘要（纯关键词兜底）
│  ├─ embedding.ts         本地 BGE / 远程 OpenAI 兼容 embedding
│  ├─ hybrid.ts            关键词 + 余弦混合排序（事实全量、消息 ANN）
│  ├─ indexer.ts           后台批量向量索引 / 回填
│  ├─ summaries.ts         日摘要生成
│  ├─ state.ts             mood/energy/affection 与半衰期漂移
│  └─ followups.ts         跟进事项写入/去重/到期/完成
├─ meme\                   图库
│  ├─ library.ts           MemeLibrary：扫描/索引/learn/pick/tagMissing
│  ├─ metadata.ts          index.json 读写（caption/keywords/用量）
│  ├─ search.ts            情绪桶/关键词/二元组/LRU 选择
│  └─ tag.ts               视觉自动打标（JSON：tag/caption/keywords）
├─ delivery\               表达层
│  └─ humanize.ts          拆气泡/延迟/typing（typing 开关由 bridge 提供）
├─ proactive\              主动消息
│  ├─ scheduler.ts         每 2 分钟 tick、免打扰、每日上限、失败冷却
│  └─ triggers.ts          早安/晚安/follow-up/空闲随机（纯函数）
└─ util\
   ├─ log.ts               分级日志
   ├─ time.ts              时间格式化/相对时间
   └─ atomic.ts            原子写 JSON/文件
```

依赖方向（避免循环）：

```
main → transport / agent / proactive / memory / persona / meme
agent → memory / persona / meme / session / delivery
proactive → agent / memory / session
transport → agent / meme / owner
memory / persona / meme / delivery / util：不反向依赖 agent
```

## 4. 功能与文件对照

| 功能 | 主要文件 |
|---|---|
| 收消息/发消息 | `transport/bridge.ts` |
| 像真人聊天 | `agent/index.ts` + `delivery/humanize.ts` + `persona/render.ts` |
| 长期记忆 | `memory/*` + `persona/files.ts` |
| 人设 | `persona/*` + `data/persona/SOUL.md` |
| 主动消息 | `proactive/*` + `memory/followups.ts` + `memory/state.ts` |
| 表情包 | `meme/*` + `data/memes/*` |
| 图片识别 | `agent/llm.ts`（vision 端点）+ `meme/learn.ts` |
| 配置 | `config.ts` + `config.json` |

## 5. 命名约定

- 一个功能一个目录；目录内 `index.ts` 是门面，其余按职责拆。
- 纯函数/算法放独立文件（如 `search.ts`、`resize.ts`），便于测试。
- 运行时数据只通过 `MemoryService` / `PersonaStore` / `MemeLibrary` 访问，不在 agent 里直接拼 SQL/路径。
- 任何写盘都用 `util/atomic.ts`，避免半截文件。
