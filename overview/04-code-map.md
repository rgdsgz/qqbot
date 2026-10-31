# 代码地图：每个文件负责什么

## 1. 项目根目录

| 文件/目录 | 作用 |
|---|---|
| `README.md` | 项目入口：启动、目录、基本说明 |
| `start-all.bat` | 启动 NapCat + 机器人；检测 6099/8643 |
| `start-napcat.bat` | 只启动 NapCat（带 `NAPCAT_DISABLE_MULTI_PROCESS=1`） |
| `start-bot.bat` | 只启动机器人，窗口保持不关 |
| `stop-all.bat` | 停止机器人 + QQ/NapCat |
| `status.bat` | 查看端口、进程、最近日志 |
| `backup.bat` | 加密备份 `data\`（排除 models）+ `config.json`，输出 `.qbak` |
| `restore-backup.bat` | 解密最新的 `.qbak` 到 `restore-*`，不覆盖现有数据 |
| `config.json` | 运行配置，含 API Key（不要外传） |
| `config.example.json` | 配置模板 |
| `docs/` | `USAGE.md` 使用说明、`PLAN.md` 进度、`STRUCTURE.md` 结构速查 |
| `overview/` | 本交接文档 |
| `data/` | 全部运行数据 |
| `backups/` | 备份 zip |
| `qqbot/` | 机器人源码 |
| `napcat/` | NapCat 本体 |

## 2. 运行数据 `data/`

| 路径 | 内容 | 能否删 |
|---|---|---|
| `owner.json` | 主人 QQ 绑定 | 不能（删了需重新绑定） |
| `sessions/*.json` | 每会话最近上下文 | 可删，但会丢上下文 |
| `memory/chat.db` | 消息/事实/摘要/状态/向量 | 不能（长期记忆本体） |
| `models/` | BGE 模型缓存 | 可删，会重新下载 |
| `persona/SOUL.md` | 人设 | 建议备份 |
| `persona/USER.md` | 用户画像 | 建议备份 |
| `persona/MEMORY.md` | 长期事件/约定 | 建议备份 |
| `memes/` | 表情包 + `index.json` | 图片是资产，建议备份 |
| `media/` | 收到的图片（永久） | 建议保留 |
| `outbox/` | 主动发送用本地图片 | 可管理 |
| `logs/bot.log` | 机器人日志 | 可清理 |
| `logs/archive/` | 旧日志 | 可清理 |

## 3. `qqbot/src/standalone/`：机器人本体

### 启动与配置

| 文件 | 职责 |
|---|---|
| `main.ts` | 装配所有服务：连接、媒体、出站、Agent、记忆、人设、图库、主动调度；优雅退出 |
| `config.ts` | 配置默认值、合并、校验、数值 clamp、路径解析 |

### Agent 与工具

| 文件 | 职责 |
|---|---|
| `agent/index.ts` | 回合队列、system prompt 组装、工具循环、普通/主动回合、humanize 调用 |
| `agent/llm.ts` | OpenAI 兼容客户端：文本/视觉端点、重试、超时、tool_calls 解析 |
| `agent/tools.ts` | 工具定义与执行：`send_meme`、`send_image`、`learn_meme`、`list_memes`、`update_memory`、`recall_memory`、`get_time`、`update_mood`、`schedule_follow_up` |

### 传输与表达

| 文件 | 职责 |
|---|---|
| `transport/bridge.ts` | OneBot 事件过滤、主人校验、媒体解析、文本/图片发送、typing、去重 |
| `delivery/humanize.ts` | 拆 1–3 个气泡、按字数延迟、首条额外延迟、typing 开关 |

### 记忆

| 文件 | 职责 |
|---|---|
| `memory/index.ts` | `MemoryService` 门面：归档、混合检索、异步抽取、摘要、mood、follow-up、embedding 启动 |
| `memory/schema.ts` | SQLite 表：messages/facts/summaries/state/follow_ups/embeddings + FTS5 触发器 |
| `memory/db.ts` | 数据库访问：消息、事实、摘要、FTS、向量表、sqlite-vec、索引重建 |
| `memory/types.ts` | 行类型与抽取载荷类型 |
| `memory/recall.ts` | 纯关键词检索：中文 shingle、FTS5/LIKE、排序、片段截取、渲染 |
| `memory/hybrid.ts` | 混合检索：关键词 + 余弦，事实全量、消息 ANN，阈值与回退 |
| `memory/embedding.ts` | 本地 BGE / 远程 OpenAI 兼容 embedding；CLS + 查询前缀；懒加载 |
| `memory/indexer.ts` | 后台批量索引事实/摘要/消息；历史回填 |
| `memory/extract.ts` | 异步抽取事实/情绪/follow-up；输入裁剪、JSON 校验、批内去重 |
| `memory/summaries.ts` | 日摘要生成 |
| `memory/state.ts` | mood/energy/affection、半衰期漂移、mood 选图桶 |
| `memory/followups.ts` | 跟进事项写入、去重、到期、完成 |

### 人设、图库、会话、主人

| 文件 | 职责 |
|---|---|
| `persona/index.ts` | 加载/渲染 SOUL+USER+MEMORY；`update_memory` 的 add/replace/remove/set/clear |
| `persona/files.ts` | `§` 条目解析、去重、预算裁剪、原子写、码点安全截断 |
| `persona/defaults.ts` | 默认人设与文件头 |
| `meme/library.ts` | 图库扫描、index.json 合并、learn、pick、updateMetadata、tagMissing |
| `meme/metadata.ts` | `index.json` 校验与原子读写 |
| `meme/search.ts` | 情绪桶、关键词打分、二元组兜底、LRU 选择 |
| `meme/tag.ts` | 视觉模型识图：返回 tag/caption/keywords |
| `session/store.ts` | 每会话 JSON、裁剪、图片懒编码、原子保存 |
| `owner/store.ts` | `data/owner.json` 读写 |

### 主动消息

| 文件 | 职责 |
|---|---|
| `proactive/triggers.ts` | 纯函数：免打扰、早安/晚安窗口、follow-up、空闲随机、每日上限 |
| `proactive/scheduler.ts` | 每 2 分钟 tick；连接/忙碌判断、触发、失败冷却、follow-up 完成 |

### 各目录 README

`src/standalone/*/README.md` 是各模块的局部说明，改代码前值得先看。

## 4. `qqbot/src/` 顶层的复用模块

这些不是 standalone 独有，独立版按需复用：

| 文件 | 作用 |
|---|---|
| `connection.ts` | OneBot 11 WebSocket（反向 server / 正向 client）、echo 关联、重连 |
| `media.ts` | 入站图片/语音下载、URL/base64/file 解析、临时文件清理 |
| `outbound.ts` | 出站串行链、分段、t2i 卡片、离线重发队列 |
| `inbound.ts` | OneBot 11 事件归一化 |
| `cq.ts` | CQ 码/消息段解析 |
| `chat.ts` | chatId 解析 |
| `split.ts` | 文本分段、Markdown/敏感内容处理 |
| `errors.ts` | 错误描述 |
| `image-shrink.ts` | 图片压缩 |
| `t2i/` | 文字转图（当前主流程基本不用，保留能力） |
| `shared-types.ts` | 出站等共享类型 |
| `trace.ts` | 发送链路 trace |

## 5. `qqbot/scripts/`

| 脚本 | 作用 |
|---|---|
| `clean-dist.mjs` | 构建前清空 `dist/` |
| `verify-memory-recall.mjs` | 验证关键词检索/片段/预算 |
| `verify-p2.mjs` | 验证气泡、mood、主动触发、follow-up |
| `verify-p3.mjs` | 验证图库元数据、打标、LRU |
| `verify-hybrid.mjs` | 验证混合检索、sqlite-vec、回退 |
| `tag-memes.mjs` | `npm run tag:memes`：批量视觉打标 |
| `embed-memory.mjs` | `npm run embed:memory`：历史记忆向量回填 |
| `backup-encrypted.ps1` | AES-256-GCM 加密备份（`backup.bat` 调用） |
| `restore-encrypted.ps1` | 解密 `.qbak` 到 `restore-*` |
| `secure-acl.ps1` | 收紧 config/data/backups/NapCat config 的 Windows ACL |
| `build.sh` / `link-host.sh` | 上游 DSH 插件构建/宿主链接，独立版不用 |
| `replay.mjs` / `verify-injected-context.mjs` / `verify-lan-management.mjs` | 上游插件辅助脚本，独立版不用 |

## 6. 上游 DSH 插件遗留

以下内容**不属于**当前机器人运行路径，保留作参考：

- `qqbot/src/index.ts`、`chat.ts`、`tools.ts`、`commands.ts`、`health.ts` 等顶层插件入口；
- `qqbot/lib/`（插件编译产物）、`qqbot/bin/`、`cordis.patch.yml`、`dsh.plugin.json`；
- `qqbot/tests/`（上游插件测试，缺 peer 依赖/ffmpeg 时会失败）；
- `qqbot/docs/`（上游文档）、`README.upstream.md`、`README.en.md`、`DEVLOG.md`；
- `tsconfig.json`（插件构建）；独立版用 `tsconfig.standalone.json`。

## 7. 改功能去哪里

| 想改什么 | 去哪 |
|---|---|
| 人设/说话风格 | `data/persona/SOUL.md`，必要时 `persona/defaults.ts` |
| 用户画像/长期记忆 | `data/persona/USER.md`、`MEMORY.md`，或 `update_memory` 工具 |
| 新增一个工具 | `agent/tools.ts` 的 `TOOL_DEFS` + `executeTool`，再更新 `agent/index.ts` 的 `TOOL_GUIDE` |
| 上下文裁剪/图片预算 | `session/store.ts` |
| 检索排序/片段 | `memory/recall.ts`、`memory/hybrid.ts` |
| 抽取 prompt/字段 | `memory/extract.ts`、`memory/types.ts` |
| 摘要风格 | `memory/summaries.ts` |
| mood 规则 | `memory/state.ts` |
| follow-up 逻辑 | `memory/followups.ts`、`proactive/triggers.ts` |
| 主动消息何时发 | `proactive/triggers.ts` |
| 主动消息调度/冷却 | `proactive/scheduler.ts` |
| 回复拆几个气泡/延迟 | `delivery/humanize.ts`、`config.humanize` |
| 表情包选图/去重 | `meme/search.ts`、`meme/library.ts` |
| 视觉打标 prompt | `meme/tag.ts` |
| LLM 接口/重试 | `agent/llm.ts` |
| OneBot 连接/重连 | `src/connection.ts` |
| 发送分段/出站 | `src/outbound.ts`、`transport/bridge.ts` |
| 配置默认值/校验 | `standalone/config.ts` |
| 启动装配 | `standalone/main.ts` |

## 8. 依赖方向（避免循环）

```text
main
 ├─ transport/bridge → agent / meme / owner / 复用模块
 ├─ agent → memory / persona / meme / session / delivery / proactive(trigger 类型)
 ├─ proactive → agent / memory / session
 ├─ memory → db / embedding / indexer / recall / hybrid / state / followups
 ├─ persona → files
 └─ meme → metadata / search / tag
```

原则：`memory`、`persona`、`meme`、`delivery`、`util` 不反向依赖 `agent`；运行时数据只通过门面访问，不在 agent 里直接拼 SQL 或路径。
