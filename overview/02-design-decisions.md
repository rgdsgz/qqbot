# 搭建思路、关键决策与踩坑记录

## 1. 需求起点

目标不是做一个公开 Bot，而是：

- 用**自己的 QQ 小号**当机器人，大号私聊它；
- 只服务主人一个人；
- 日常聊天要像真人：短句、多气泡、会发表情包、会主动找人；
- 有长期记忆，能记住跨天/跨月的事实、偏好、约定；
- 所有数据存在本地；
- 以后可以自己改人设、图库和说话方式。

## 2. 为什么选 dsh-onebot + NapCat

调研过的仓库：

| 仓库 | 结论 |
|---|---|
| `mario841859784/dsh-onebot` | 有完整的 OneBot/NapCat 传输、媒体、出站、表情包能力；最终作为底座 |
| `xmanrui/dsh-im` / `MichengAI/dsh-im-connect` | 偏多平台 IM 接入，改造量大 |
| `yyh-001/dsh-meme` | 图库、情绪分类、AI 学图、QQ 缩图；借鉴图库与打标设计 |
| `zaofan-make/dsh-qqbot` | 本地 BGE embedding、CLS pooling、查询前缀、失败退避；借鉴混合检索细节 |
| Hermes / DSH 官方 | 记忆分层、prompt 预算、FTS5 检索、compaction；借鉴设计，不整体迁移 |

选择 NapCat 的原因：QQ NT 协议稳定、WebUI 扫码登录、OneBot 11 生态成熟。代价是登录个人 QQ 有封号风险，所以只建议用小号。

## 3. 为什么脱离 DSH

dsh-onebot 原本是 DSH 插件。实际使用中遇到：

- 宿主版本与插件 API 不匹配，master 分支要求新宿主，旧宿主编译失败；
- 插件依赖 Cordis/DSH 的 peer 依赖，部署和升级都重；
- 想要一个“双击启动就常驻”的独立进程，而不是挂在 DSH 里。

最终方案：**保留 dsh-onebot 的 OneBot/NapCat 传输层，重写 agent/session/tools**，做成独立 Node/TS 进程。`qqbot/src/standalone/` 是当前唯一运行入口；`lib/`、`bin/`、`cordis.patch.yml` 等是上游插件遗留，只作参考。

## 4. 运行方式的决策

- **NapCat 反向 WS**：NapCat 主动连机器人 `ws://127.0.0.1:8643`，机器人不主动轮询。
- **只监听本机**：8643 和 WebUI 6099 都只绑定 `127.0.0.1`，避免局域网访问。
- **`NAPCAT_DISABLE_MULTI_PROCESS=1`**：不设置时 NapCat worker 会崩。
- **独立窗口启动**：`start-all.bat` 调 `start-napcat.bat` / `start-bot.bat`；后台 shell 启动会被父进程带走，所以必须保留窗口。
- **进程持久化**：`start-bot.bat` 窗口不关，机器人就一直在；`stop-all.bat` 统一停止。

## 5. 记忆体系的决策

采用三层：

1. **文件层**：`SOUL.md` / `USER.md` / `MEMORY.md`
   - SOUL 是身份与说话方式；
   - USER 是稳定用户画像（预算 1375 字符）；
   - MEMORY 是长期事件/约定（预算 2200 字符）；
   - `§` 分隔条目，原子写，超预算时保留最新条目并显示截断提示。
2. **SQLite 层**：`messages` / `facts` / `summaries` / `state` / `follow_ups`
   - 原文永久保留，支持追溯；
   - 事实用 subject/predicate/object 去重，冲突走 `superseded`，不物理删；
   - 抽取异步执行，不阻塞回复。
3. **向量层**：`embeddings` + `vec_messages`
   - 事实与消息都可做语义召回；
   - 模型/维度/算法版本变化时清空旧向量重建。

关键取舍：

- 抽取不是每轮都跑，而是 **10 轮或空闲 10 分钟**，控制成本；
- 摘要按天/按量生成，不替代原文；
- 检索结果有预算上限，宁缺毋滥；
- 记忆按“主人当前的话优先”，冲突时以新话为准。

## 6. 检索的演进过程

1. **FTS5 trigram**：对中文 ≥3 字有效；1–2 字用 LIKE。
2. **中文切词**：自然问句没有空格，直接整句 MATCH 基本命中不了；改为把中文连续段切成 2 字/3 字 shingle，3 字进 FTS，2 字进 LIKE。
3. **排序**：借鉴 DSH 官方 session-query：先按命中查询词数量，再按重要性/置信度/时间，最后用 id 保证确定性。
4. **原始片段**：事实不够时回捞旧消息，围绕命中词截取有界片段；当前用户消息在 prompt 构建之后才归档，避免检索到自己。
5. **混合检索**：
   - 事实：全量向量余弦 + 关键词 + 重要性 + 时间衰减；
   - 消息：sqlite-vec ANN + 关键词；
   - 本地 BGE-small-zh（512 维），CLS pooling，查询侧加 BGE 检索前缀，文档侧不加；
   - 模型没就绪时这一轮走关键词，后台索引不阻塞回复；
   - 语义单独命中要求阈值（默认 0.4），消息片段更严（0.6），避免短句噪音。

参考来源：

- DSH 官方：agent-instructions 的预算/去重/可见提示，session-query 的 FTS 查询与排序；
- dsh-qqbot：BGE 本地模型、CLS + 查询前缀、失败退避；
- dsh-meme：情绪桶、关键词打分、二元组兜底、AI 打标提示词；
- dsh-companion：SOUL/USER/MEMORY 格式、§ 条目、QQ 分块投递。

没有照搬的：

- DSH 的 unicode61：不适合中文无空格检索；
- Hermes 整体迁移：Python 栈重，且没有独立记忆 API；
- 独立向量数据库：单机自用，SQLite + sqlite-vec 足够；
- 远程 embedding 作为默认：DeepSeek 没有 `/embeddings`（实测 404），默认改用本地模型。

## 7. 表达层与主动消息

- **多气泡**：借鉴 dsh-companion 的 `channelTextChunks`：短闲聊按行/句拆，结构化文本不拆，超过气泡数合并最短相邻段。
- **延迟**：按字数计算，首条额外 0.5–0.85 秒；typing 在延迟期间保持开启。
- **mood**：mood/energy/affection 三个 0–100 值，按半衰期向基线漂移；注入 prompt 影响语气，并缩放主动概率。
- **主动消息**：早安/晚安/空闲/follow-up 四类触发；免打扰、每日上限、失败冷却、问候每天一次。
- **follow-up**：抽取或工具写入 `follow_ups`，到点自然跟进，不说“提醒事项”。

## 8. 表情包

- 文件夹名就是标签；`index.json` 记录 tag/caption/keywords/hash/用量；
- `learn_meme` 收藏时用视觉模型自动打标；
- 搜索：情绪桶 + 关键词命中数 + 二元组兜底；
- 避免重复：6 小时内发过的图，有替代图时跳过；全都发过按最久未用轮换；
- 没给 tag 时按当前 mood 推断桶；
- 已有图可批量补标：`npm run tag:memes`。

## 9. 安全与隐私

- 只接受主人私聊；陌生人/群聊静默丢弃；
- 本地图片发送限制在 `data/media`、`data/memes`、`data/outbox`；
- 记忆注入用 `<system-reminder>` 围栏并转义闭合标签；
- 不保存隐藏推理；
- API Key 只在 `config.json`，不写进日志和文档；
- `config.json`、`data/`、`backups/`、NapCat 配置的 Windows ACL 已收紧为“当前用户 + SYSTEM + Administrators”，移除了 Users、UWP 应用和旧 SID；
- 备份改为 AES-256-GCM 加密的 `.qbak`，密码不保存；旧明文 zip 已移除其中的 `config.json`；
- 主人改为 `config.owner.qq` 固定绑定，避免 `owner.json` 丢失后被重新绑定；
- 日志级别从 `debug` 降为 `info`，减少工具细节落盘。

## 10. 踩过的坑（交接重点）

| 问题 | 原因 | 处理 |
|---|---|---|
| npm ERESOLVE | DSH peer 依赖 prerelease | `npm install --include=dev --legacy-peer-deps` |
| 插件编译失败 | master 要求新宿主 API | 切到 `v0.9.7`，最终独立化 |
| NapCat worker 崩 | 多进程模式 | `NAPCAT_DISABLE_MULTI_PROCESS=1` |
| 后台启动打印二维码后退出 | stdin/pause 被父进程影响 | 用独立窗口 bat |
| 机器人被父 shell 带走 | 生命周期绑定父进程 | `start-bot.bat` 独立窗口 |
| WebUI 对局域网开放 | 默认 host `::` | 改 `127.0.0.1` |
| 人设重复 `# 你是谁` | 渲染器与 SOUL 都带标题 | 渲染时去掉 SOUL 开头标题 |
| 记忆路径不跟随 dataDir | 默认路径写死 | 空路径回退到 `<dataDir>/persona`、`<dataDir>/memory` |
| facts 一直是 0 | 抽取需要 10 轮/空闲 10 分钟 | 属于正常，不是故障 |
| embedding 模型换 pooling 后分数异常 | 旧向量与新查询不兼容 | 签名带算法版本，变化时清空重建 |
| sqlite-vec 插入报 UNIQUE | vec0 不支持 `INSERT OR REPLACE` | 先 DELETE 再 INSERT |
| 目录改名提示被占用 | IDE/会话/MCP 进程持有目录 | 关闭 IDE 后重命名；启动脚本兼容新旧名 |

## 11. 阶段与验证

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 | 人设文件、update_memory、SQLite 建表、消息归档 | 真实 QQ 对话 |
| P1 | FTS5/LIKE、异步抽取、摘要、recall_memory | 模拟两轮 + 真实抽取 |
| P2 | 多气泡、mood、主动消息、follow-up 工具 | `verify-p2.mjs` + 真实晚安消息 |
| P3 | 图库元数据、自动打标、LRU、mood 选图 | `verify-p3.mjs` + 现有真实图打标 |
| 混合检索 | BGE + sqlite-vec + 后台索引 | `verify-hybrid.mjs` + 线上消息全部向量化 |

当前所有验证脚本都在 `qqbot/scripts/verify-*.mjs`，改完相关模块后应至少跑对应脚本。
