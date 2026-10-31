# 系统架构与目录结构

## 1. 总体架构

```text
主人 QQ（大号）
      │ 私聊
      ▼
QQ 小号（QQ NT，F:\QQ）── NapCat（napcat\NapCat.Shell）
      │  反向 WebSocket 127.0.0.1:8643
      ▼
OneBotConnection（qqbot\src\connection.ts）
      │  OneBot 11 事件/动作
      ▼
StandaloneBridge（src\standalone\transport\bridge.ts）
      │  绑定校验 / 媒体落盘 / 发送
      ▼
ChatAgent（src\standalone\agent\index.ts）
      │  回合队列 + 工具循环
      ├── LLM：DeepSeek OpenAI 兼容接口
      ├── PersonaStore：SOUL/USER/MEMORY 文件
      ├── MemoryService：SQLite + FTS5 + 向量
      ├── MemeLibrary：图库 + 视觉打标 + LRU
      └── Humanizer：多气泡 + typing + 延迟
      ▼
QQ 小号 → 主人
```

旁路服务：

- `ProactiveScheduler`：每 2 分钟检查一次，决定是否主动说话。
- `MemoryIndexer`：后台把消息/事实/摘要写成向量。
- `OwnerStore`：主人绑定关系持久化。
- `SessionStore`：每个会话最近的上下文 JSON。

## 2. 一条普通消息的完整流程

1. NapCat 收到私聊，经反向 WS 推给 `OneBotConnection`。
2. `StandaloneBridge.handleEvent` 过滤：
   - 只看私聊，群聊默认忽略；
   - 只接受 `data/owner.json` 里绑定的 QQ；
   - 绑定前 learn 模式会把第一条私聊发送者写成主人。
3. 图片/语音等媒体由 `MediaStore` 下载到 `data/media/`；`memes.autoLearn=true` 时额外存入 `data/memes/inbox/`（不触发识图）。
4. `ChatAgent.handleInbound` 按 chatId 串行排队，避免同一会话并发。
5. 构建系统提示：
   - `PersonaStore.render()`：SOUL + USER + MEMORY，带字符预算和截断提示；
   - `MemoryService.recall()`：混合检索事实/旧对话片段；
   - 当前时间、对方昵称、mood 状态；
   - 工具说明（工具名、使用规则）。
6. 注意顺序：**先构建 prompt，再归档当前用户消息**，避免检索把当前问题当成历史片段。
7. 进入 `runRounds` 工具循环：
   - 调 LLM；
   - 有 tool_calls 就执行工具，把结果作为 tool 消息继续；
   - 最多 `llm.maxToolRounds` 轮；
   - 工具预算耗尽后再无工具请求一次，保证有可读回复。
8. 最终文本交给 `Humanizer.send`：拆 1–3 个气泡，开 typing，按字数延迟，首条额外 0.5–0.85 秒。
9. 归档 assistant 消息；`afterTurn` 增加轮次并重置空闲抽取定时器。

## 3. 主动消息流程

```text
每 2 分钟 tick
  ├─ 免打扰？连接正常？agent 忙碌？→ 跳过
  ├─ 到点的 follow-up？        → 优先触发
  ├─ 早安窗口且今天没发过？      → morning
  ├─ 晚安窗口且今天没发过？      → evening
  ├─ 距上次主动够久 + 空闲够久 + 概率命中？→ idle
  └─ 都没有 → 继续睡
```

触发后：

1. `agent.proactiveTurn(chatId, trigger)`；
2. 系统提示追加“主动发言模式”和本次触发说明；
3. 走同一个 LLM/工具循环；
4. 有文字或表情图发出才算成功；
5. 成功的 follow-up 标记为 done；问候失败有 30 分钟冷却。

## 4. 记忆与检索流程

### 写入

- 每条用户/assistant 消息 → `messages` 表；
- 每 10 轮或空闲 10 分钟 → 一次抽取 LLM：
  - 持久事实 → `facts`（subject/predicate/object 去重，冲突走 supersede）；
  - 情绪变化 → `state` 里的 mood/energy/affection；
  - 跟进事项 → `follow_ups`；
- 累计 20 条或隔天 6 条 → 生成 ≤200 字摘要 → `summaries`；
- `MemoryIndexer` 每 10 秒把新增消息/事实/摘要向量化，写入 `embeddings` 和 `vec_messages`。

### 读取

```text
用户当前这句话
  ├─ 本地 BGE 生成查询向量（带检索前缀）
  ├─ 事实：FTS5/LIKE 候选 + 全量向量余弦 → 加权排序
  ├─ 消息：FTS5/LIKE 候选 + sqlite-vec ANN → 加权排序
  └─ 最近摘要
        ↓
  【长期记忆】【相关对话片段】【最近摘要】
  用 <system-reminder> 包住，声明“只是背景，以当前话为准”
```

模型没就绪、向量表不可用或调用失败时，整条链路自动回退到纯 FTS5 + LIKE。

## 5. 目录结构（当前）

```text
D:\E\programming\
├─ README.md                    项目入口说明
├─ start-all.bat                一键启动 NapCat + 机器人
├─ start-napcat.bat             只启动 NapCat
├─ start-bot.bat                只启动机器人
├─ stop-all.bat                 停止机器人和 QQ/NapCat
├─ status.bat                   端口/进程/最近日志
├─ backup.bat                   加密备份 data + config（不含 models）
├─ restore-backup.bat           解密恢复到 restore-* 目录
├─ config.json                  运行配置（含 API Key）
├─ config.example.json          配置模板
├─ data\                        全部运行数据
│  ├─ owner.json                主人绑定
│  ├─ sessions\                 每会话最近上下文 JSON
│  ├─ memory\chat.db            消息/事实/摘要/状态/向量
│  ├─ models\                   BGE 模型缓存（可重新下载）
│  ├─ persona\                  SOUL.md / USER.md / MEMORY.md
│  ├─ memes\                    表情包 + index.json
│  ├─ media\                    收到的图片（永久）
│  ├─ outbox\                   主动发送用本地图片
│  └─ logs\bot.log              机器人日志
├─ backups\                     加密备份 .qbak（旧 zip 为历史）
├─ docs\                        USAGE / PLAN / STRUCTURE
├─ overview\                    本交接文档
├─ qqbot\                       机器人源码
│  ├─ src\standalone\           机器人本体
│  ├─ src\connection.ts 等      复用的 OneBot/媒体/出站模块
│  ├─ scripts\                  构建、验证、打标、向量回填
│  ├─ dist\standalone\          编译产物
│  └─ 上游 DSH 插件遗留           lib/bin/tests 等，仅参考
└─ napcat\                      NapCat 本体
```

## 6. 模块职责

| 模块 | 文件 | 职责 |
|---|---|---|
| 启动装配 | `src/standalone/main.ts` | 读配置、建服务、连 NapCat、优雅退出 |
| 配置 | `src/standalone/config.ts` | 默认值、校验、clamp、路径解析 |
| 传输桥 | `src/standalone/transport/bridge.ts` | 事件过滤、主人校验、媒体、发送、typing |
| Agent | `src/standalone/agent/index.ts` | 回合队列、system prompt、工具循环、主动回合 |
| LLM 客户端 | `src/standalone/agent/llm.ts` | OpenAI 兼容、重试、超时、视觉端点 |
| 工具 | `src/standalone/agent/tools.ts` | send_meme / send_image / learn_meme / list_memes / update_memory / recall_memory / get_time / update_mood / schedule_follow_up |
| 人设 | `src/standalone/persona/*` | SOUL/USER/MEMORY 读写、§ 条目、预算、渲染 |
| 记忆门面 | `src/standalone/memory/index.ts` | 归档、检索、抽取、摘要、mood、follow-up、向量启动 |
| 记忆库 | `src/standalone/memory/db.ts` / `schema.ts` | SQLite、FTS5、embeddings、vec_messages |
| 检索 | `memory/recall.ts` / `hybrid.ts` | 关键词检索 + 混合排序 + 片段截取 |
| Embedding | `memory/embedding.ts` / `indexer.ts` | 本地 BGE / 远程接口、后台批量索引 |
| 抽取/摘要 | `memory/extract.ts` / `summaries.ts` | 异步事实/情绪/follow-up、日摘要 |
| 状态/跟进 | `memory/state.ts` / `followups.ts` | mood 半衰期、跟进事项生命周期 |
| 图库 | `meme/library.ts` 等 | 扫描、index.json、learn、pick、tagMissing |
| 图库检索/打标 | `meme/search.ts` / `tag.ts` | 情绪桶/关键词/LRU、视觉 JSON 打标 |
| 表达层 | `delivery/humanize.ts` | 拆气泡、typing、延迟 |
| 主动消息 | `proactive/triggers.ts` / `scheduler.ts` | 触发选择、免打扰、日限、冷却 |
| 会话 | `session/store.ts` | 每会话 JSON、裁剪、图片懒编码 |
| 主人 | `owner/store.ts` | `data/owner.json` 绑定 |

## 7. 数据与安全边界

- 所有持久数据在 `data/`；复制 `data/ + config.json` 即可迁移。
- `data/models/` 只是缓存，可删；`backup.bat` 已排除，并用 AES-256-GCM 加密备份。
- 机器人只监听 `127.0.0.1`，NapCat WebUI 也只对本机开放。
- 发送本地图片只允许 `data/media`、`data/memes`、`data/outbox` 内的路径。
- 记忆注入用 `<system-reminder>` 围栏，并转义闭合标签，避免被记忆内容越权。
- 不保存模型隐藏推理（DeepSeek 的 `reasoning_content` 被忽略）。
- `config.json` 含 API Key；不要提交到任何仓库或发给别人。
