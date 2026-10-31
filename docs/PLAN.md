# 陪伴机器人 v2 规划

> 状态：三条调研均已完成，方案已定。

## 0. 实施进度

- ✅ **P0 完成**：SOUL/USER/MEMORY 文件、`update_memory` 工具、SQLite 建表、消息归档、配置段。
- ✅ **P1 完成**：FTS5 检索 + LIKE/最新事实兜底、异步事实抽取（去重/supersede）、日摘要、`recall_memory` 工具、prompt 注入。
- ✅ **P1 增强（参考 DSH 官方实现）**：中文二元/三元切词、按命中数排序、原始对话片段回捞、UTF-8 安全截断、可见预算提示、索引可重建。
- ✅ **P2 完成**：多气泡/延迟/typing、mood/energy/affection 影响语气与主动概率、早安/晚安/空闲/follow-up 触发、`update_mood` 与 `schedule_follow_up` 工具、每日上限。
- ✅ **P3 完成**：图库 `index.json`（caption/keywords/用量）、视觉自动打标（`learn_meme` + 批量脚本）、中文关键词与情绪检索、LRU 避免重复、mood 选图。
- ✅ **混合检索**：本地 BGE-small-zh（512 维）+ sqlite-vec ANN；事实走全量余弦、消息走 ANN，后台批量索引，模型/维度变化自动重建，失败自动退回关键词。
- ⏭ **P3 待做**：图库 metadata/自动打标/避免重复；embedding 混合检索作为可选升级。

## 1. 目标

在现有独立 QQ 机器人（NapCat/OneBot + DeepSeek V4.1 Flash）上补齐：

1. **像真人聊天**：短句、多气泡、有延迟、有情绪、不客服腔。
2. **主动消息/表情包**：按时间、空闲、上次话题主动开口，能配图。
3. **长期跨时间记忆**：跨天/跨月记住事实、偏好、事件、约定，并能自然引用。
4. **自定义人设**：独立人设文件，可编辑、可热更新、可带示例对话。
5. **专用图库**：标签、描述、语义/关键词检索、自动学习、避免重复。

## 2. 调研到的可复用项目

| 项目 | 类型 | 语言/许可 | 可复用什么 | 结论 |
|---|---|---|---|---|
| NousResearch/hermes-agent（约 25.9 万 star） | 通用 Agent | Python | 长期记忆格式、compaction、cron/heartbeat、messaging gateway 设计 | 不整体替换；借鉴记忆和主动机制 |
| landamao/hermes-qq-onebot 等 Hermes OneBot 适配器（个位数到 20 star） | Hermes → QQ 适配 | Python | OneBot 接入思路 | 维护度不足，不作为底座 |
| AstrBot（约 4.5 万 star） | IM 机器人平台 | Python | WebUI、QQ/OneBot、插件、LLM、人设/记忆插件生态 | 功能全但要换 Python 栈，现有 TS 代码作废；暂不选 |
| LangBot（约 1.86 万 star） | IM 机器人平台 | Python | 多平台、Agent、知识库、插件 | 同上；暂不选 |
| yyh-001/dsh-companion（14 star, MIT） | DSH 陪伴插件 | JavaScript | SOUL/USER/MEMORY 文件格式、`update_memory` 语义、字符预算与合并、QQ 分块投递；记忆逻辑约 200 行 | **直接移植设计** |
| yyh-001/dsh-meme（462 star, MIT） | DSH 表情包插件 | JavaScript | 图库索引、语义检索、情绪分类、mood 主动发图、QQ 缩图、AI 学图 | **直接移植/改造成独立模块** |
| hermes-snow-search | Hermes 记忆插件 | Python，开源 | SQLite FTS5 unicode61 + trigram、BM25、时间排序、CJK 路由 | 借鉴检索层；已用 node:sqlite 复现 |
| Mnemosyne | Hermes 记忆 provider | Python，MIT | SQLite+sqlite-vec+FTS5；50% 向量/30% FTS/20% importance；working/episodic/scratchpad；时序 KG `valid_from/valid_to/as_of` | 借鉴分层、时序失效与混合检索 |
| plur | Hermes 记忆 provider | TS，Apache-2.0 | YAML engram、BM25+BGE-small、ACT-R 衰减、反馈、22 工具 | 排序/衰减可借鉴；`@plur-ai/core` 偏编码 agent |
| mem0 | 通用记忆层 | Python+TS，Apache-2.0 | 多级记忆、LLM 抽取、语义+BM25+实体；需向量库/云 | 重；单机自用不引入 |
| Claude Code / Anthropic memory tool | 设计参考 | — | 原子记忆文件 + 索引 + description 召回 + 明确保存规则 | **借鉴文件组织原则** |

### 2.1 Hermes Agent 关键事实

- 仓库：259k star / 57k fork / **52k open issues** / 1.38 GB / Python，MIT。
- 记忆：`MEMORY.md`（2200 字符）+ `USER.md`（1375 字符），`memory` 工具 add/patch/remove；超限报错不自压；系统提示里是**会话开始时的冻结快照**（保 prefix cache）；跨会话靠 `session_search`（SQLite FTS5 + LLM 摘要）。
- **记忆按 profile 隔离，不按 QQ 用户隔离**——多用户陪伴场景是硬伤。
- 人设：`SOUL.md` 占系统提示 slot #1，逐字注入；`/personality` 会话级覆盖，内置 14 种 + 自定义；**没有示例对话/角色卡/few-shot 机制**。
- 主动：持久化 cron + `/heartbeat`（会话空闲注入，≤60s，重启恢复），是它的强项。
- 图片：base64 视觉输入；发送图片走平台适配器；**没有表情包库/选图能力**。
- 部署：Python 3.11-3.14、49 个精确 pin 依赖、自带 Node/FFmpeg；配置面极大（示例配置 131 KB）。
- 内置官方 QQ Bot API（非 NapCat），与我们现在的 NapCat 链路不同。

### 2.2 Hermes OneBot/NapCat 适配器

| 仓库 | star | 最近提交 | 许可 | 架构 | 评价 |
|---|---:|---|---|---|---|
| landamao/hermes-qq-onebot | 20 | 2026-08-05 | MIT | 纯插件，反向 WS + 可选 HTTP | 私聊/群聊、@/正则、白名单、图片/语音/视频/文件、`[表情:id]`、CQ 直发、长消息合并转发；**综合最优** |
| DNAlec/hermes-onebot-adapter | 6 | 2026-10-23 | MIT | 独立服务 + WebUI（3 端口） | 最活跃，但部署最重，**Windows 必须 WSL2** |
| shubyi/hermes-napcat | 14 | 2026-04-21 | pyproject MIT，无 LICENSE | pip 包 + **patch Hermes 核心** | 48 个 QQ 工具、群管、向导装 NapCat；已半年未更新，易被上游改崩 |
| tiny-ai-ops/hermes-agent-onebot | 7 | 2026-04-06 | MIT | **7 个核心 patch** | 已停更，风险最高 |
| 其他 | 0-17 | — | — | 独立 bridge/个人 fork | 生态碎片化，无事实标准 |

扫码登录：适配器都不负责，实际由 NapCat 完成；只有 shubyi 的向导自动化了“装 NapCat + 显示二维码”。

### 2.3 方案对比

| 方案 | 工作量 | 主要风险 |
|---|---|---|
| A 直接换 Hermes | 装通 1-3 天；补齐 parity 2-3 周 | 记忆按 profile 共享；无表情包库；多数适配器 patch 核心，上游日更即碎；52k issues；默认开放终端/浏览器工具，QQ 好友可提示注入 |
| **B 保留 TS，借鉴设计** | **1-2 周** | 要自己实现检索/压缩；但完全可控，无 Python 运维 |
| C 混合（Hermes 做记忆服务） | 2-3 周 | Hermes 没暴露独立记忆 API，只能走 `/v1` 全 agent（每轮可能触发工具，延迟/成本高） |

**选 B。** 可直接借鉴：① MEMORY/USER 双层字符预算 + 显式写入工具 + 会话起始冻结快照；② FTS5 会话检索；③ SOUL.md 单一身份 + 会话级 personality 覆盖；④ 空闲 heartbeat 与持久 cron 分离。若以后确实需要跨会话用户建模，再单独接 Honcho/Mem0，不整体迁移。

## 3. 推荐架构

保留现有 TS 机器人，新增四个模块：

```
src/standalone/
├─ persona.ts      人设 + 用户画像 + 记忆文件的加载/渲染/预算
├─ memory/
│  ├─ db.ts        SQLite：messages / facts / summaries / state / follow_ups
│  ├─ extract.ts   每 N 轮异步抽取事实、摘要、情绪
│  ├─ recall.ts    FTS5 + LIKE + 时间/重要性排序
│  └─ store.ts     USER.md / MEMORY.md 的读写、合并、压缩
├─ humanize.ts     多气泡、延迟、打字状态、表情穿插
└─ mood.ts         情绪/精力/好感度状态
```

现有文件改动点：

- [agent/index.ts](../qqbot/src/standalone/agent/index.ts)：`systemPrompt()` 改为组装 SOUL/USER/MEMORY/检索结果/心情；回合结束后触发异步记忆抽取。
- [session/store.ts](../qqbot/src/standalone/session/store.ts)：保留最近消息；新增写入 SQLite 的归档。
- [proactive/scheduler.ts](../qqbot/src/standalone/proactive/scheduler.ts)：增加早安/晚安、空闲、follow-up、随机四类触发；每日上限。
- [meme/library.ts](../qqbot/src/standalone/meme/library.ts)：增加 metadata、自动打标、LRU、mood 选图。
- [transport/bridge.ts](../qqbot/src/standalone/transport/bridge.ts)：`sendText` 增加 humanize 模式。

## 4. 记忆设计

### 4.1 三层

1. **原始消息**：`messages` 表，保留全部对话（本地 SQLite）。
2. **摘要**：每天/每 N 轮生成 `summaries`，用于长上下文压缩。
3. **结构化事实**：`facts` 表，存偏好、事件、人物、约定、边界；带来源、置信度、时间。

### 4.2 文件层（Hermes / dsh-companion 风格）

```
data/persona/
├─ SOUL.md     人设：身份、性格、说话方式、边界、示例对话
├─ USER.md     稳定用户画像（预算约 1375 字）
└─ MEMORY.md   长期事件/约定（预算约 2200 字，§ 条目）
```

- 每轮实时读取，改文件即生效；提供 `update_memory` 工具（add/replace/remove/set/clear）。
- 超预算时让模型合并/压缩，而不是无限追加。
- 文件可读可编辑，用户随时可以改或删。

### 4.3 SQLite 表草案

```sql
messages(id INTEGER PRIMARY KEY, chat_id TEXT, role TEXT, content TEXT,
         created_at INTEGER, tokens INTEGER, message_id TEXT, meta_json TEXT);
messages_fts USING fts5(content, content='messages',
  content_rowid='id', tokenize='trigram');

summaries(id INTEGER PRIMARY KEY, level TEXT, period_start INTEGER, period_end INTEGER,
          content TEXT, msg_ids TEXT, tokens INTEGER, created_at INTEGER);

-- 事实用 subject/predicate/object 去重，文本另存一份供检索/注入
facts(id INTEGER PRIMARY KEY, kind TEXT, subject TEXT, predicate TEXT, object TEXT,
      text TEXT, confidence REAL, importance REAL,
      valid_from INTEGER, valid_to INTEGER, due_at INTEGER,
      source_msg_ids TEXT, superseded_by INTEGER,
      status TEXT DEFAULT 'active', last_used_at INTEGER, use_count INTEGER,
      created_at INTEGER, updated_at INTEGER);
facts_fts USING fts5(text, subject, object, content='facts',
  content_rowid='id', tokenize='trigram');

state(key TEXT PRIMARY KEY, value TEXT);          -- mood/energy/affection
follow_ups(id INTEGER PRIMARY KEY, topic TEXT, due_at INTEGER, status TEXT, created_at INTEGER);
injection_log(turn_id TEXT, fact_ids TEXT, tokens INTEGER, created_at INTEGER);

CREATE INDEX idx_facts_status_kind ON facts(status, kind);
CREATE INDEX idx_facts_subject ON facts(subject);
CREATE INDEX idx_messages_chat_time ON messages(chat_id, created_at);
```

- `valid_from/valid_to/as_of`：事实有时效，冲突走 `superseded_by` 链而不是物理删除。
- `due_at`：约定/提醒类事实，供主动消息的 follow-up 使用。
- `injection_log`：记录每轮注入了哪些事实，观察命中率、避免重复注入。
- 工程：开启 WAL、单写者串行；Node 25 的 `node:sqlite` 可用（带 ExperimentalWarning），生产可换 `better-sqlite3`。
- 已实测：`trigram` 对中文 ≥3 字可命中；1-2 字关键词用 `LIKE` 兜底，或另建 jieba 分词列配 `unicode61`。

### 4.4 读路径（每轮）

1. 收到消息 → 写 `messages`。
2. 一次 FTS5 查询 + 一次 SQL：候选约 30 条 → 去重/重排取 6-10 条。
3. 组装 system prompt：SOUL + USER + MEMORY + 检索事实 + 最近摘要 + 当前时间/心情 + 工具说明。
4. 调模型 → 发送回复。
5. 另提供 `recall_memory(query)` 深搜工具，避免自动注入过多；用户问“还记得…”时可主动深挖。

### 4.5 写路径（异步，不阻塞回复）

- 触发：每 10 轮、空闲 10 分钟、会话结束，三者任一；用户说“记住…”时立即写并回执。
- 抽取：用便宜模型 + JSON schema，输出 `{facts:[{kind,subject,predicate,object,text,confidence,source_msg_ids}], mood_delta, follow_ups}`。
- 去重：按 `(subject, predicate, normalized object)` 合并；冲突走 supersede 链；低置信度（<0.6）不注入。
- 摘要：日/周两级，带时间段和 `msg_ids`；用于压缩上下文和回答“上周/上次”。
- 巩固：夜间去重合并、衰减（参考 ACT-R）、过期归档；`/forget` 硬删并重建 FTS。

### 4.6 每轮预算（建议）

| 块 | 预算 |
|---|---|
| 固定画像（SOUL/USER） | ≤ 300 字 |
| 事实 | 6-10 条，每条 ≤ 50 字，合计 ≤ 500 字 |
| 摘要 | 1-2 条，≤ 300 字 |
| 最近对话 | 6-10 条，≤ 600 字 |
| 记忆块合计 | 常规 800-1000 tokens，硬上限 1500 tokens |

- 事件渲染成“10 月 20 日（11 天前）”，模型才能自然引用旧事。
- 同一事实 7 天内不重复注入，除非用户再次提及。

### 4.7 检索策略与升级

- MVP：FTS5 trigram + LIKE 短词兜底 + 时间衰减 + 重要性 + 置信度。
- 升级触发：100-200 条真实问法的 recall@5 < 80%，或大量“上次那个/那种”改写。
- 升级方案：本地 `bge-small-zh-v1.5` 或 `multilingual-e5-small`（transformers.js/ONNX），向量存 BLOB，1 万条内 JS 暴力余弦足够；与 FTS5 用 RRF 融合，不引入向量库。
- 不引入 Mem0/Mnemosyne 运行时；只借鉴它们的排序/分层/衰减设计。Mem0 的 TS SDK 重且依赖云/向量库，不适合单机自用。

## 5. 人设设计

`SOUL.md` 建议结构：

```markdown
# 身份
名字 / 年龄 / 与主人的关系

# 性格
3-5 个特质，带具体行为

# 说话方式
句长、口头禅、语气词、emoji/表情包频率、禁用词

# 喜欢 / 讨厌
...

# 边界
不做什么、不说什么

# 示例对话
主人：...
你：...
```

- 支持多套人设（`SOUL.<name>.md`），配置选择或 QQ 命令切换。
- 每轮重申关键边界，减少人设漂移。
- 可用 `persona.md` 或 YAML 扩展性格维度。

## 6. 像真人的表达层

- **多气泡**：把回复拆成 1-3 条，间隔 0.8-2.5 秒；长文保持整段。
- **打字状态**：等待模型时持续 `set_input_status`（已有）。
- **延迟**：按字数增加 1-3 秒，避免秒回。
- **表情穿插**：合适时先发一张表情包再说话，或说完补一张。
- **情绪状态**：`mood`（-100..100）、`energy`（0..100）、`affection`（0..100），影响语气、主动概率、表情包选择。
- **去 AI 味**：禁 Markdown、禁“作为一个 AI”、少总结句，多用短句和反问。

## 7. 主动消息设计

触发类型：

1. 时段：早安（8-10 点）、晚安（22-24 点）。
2. 空闲：超过 N 小时没聊。
3. Follow-up：用户提过“周末去看电影”，到时间问一句。
4. 随机：在允许时段内按概率开口。

约束：

- 免打扰时段、每日上限（建议 4-6 条）、概率、刚聊过不打扰。
- 主动前检索最近摘要 + 待跟进事项 + 当前心情。
- 可调用 `send_meme` 配图；避免连续发同一张。

新增工具：

- `schedule_follow_up(topic, when)`：把“以后要问的事”写入 `follow_ups`。
- `update_memory`：写 USER/MEMORY。
- `set_mood` 可选（或由抽取步骤自动更新）。

## 8. 图库设计

在现有目录标签基础上增加：

- `data/memes/index.json`：path、tags、description、keywords、hash、addedAt、lastUsedAt、useCount。
- 学习时用视觉模型生成描述/标签（自动打标）。
- 检索：标签 + 关键词 + 描述；升级后接 embedding。
- 选图：匹配后按 `lastUsedAt` 优先未用过的图，避免重复。
- 情绪选图：`mood` → 标签映射（开心→happy，累→sleep/work，难过→sad）。
- QQ 缩图：沿用 dsh-meme 的 200-450px 长边策略。

## 8.1 配置草案

```jsonc
"persona": {
  "soulFile": "./data/persona/SOUL.md",
  "userFile": "./data/persona/USER.md",
  "memoryFile": "./data/persona/MEMORY.md",
  "maxUserChars": 1375,
  "maxMemoryChars": 2200
},
"memory": {
  "enabled": true,
  "dbPath": "./data/memory/chat.db",
  "extractEveryTurns": 10,
  "idleExtractMinutes": 10,
  "maxRecallFacts": 8,
  "maxRecallChars": 500,
  "minConfidence": 0.6,
  "summaryHour": 3
},
"humanize": {
  "enabled": true,
  "maxBubbles": 3,
  "minDelayMs": 800,
  "maxDelayMs": 2500,
  "delayPerCharMs": 30,
  "stickerFirstProbability": 0.2
},
"mood": { "enabled": true },
"proactive": {
  "enabled": true,
  "dailyLimit": 6,
  "morningWindow": ["08:00", "10:00"],
  "nightWindow": ["22:00", "23:30"],
  "idleHours": 6
}
```

## 8.2 记忆抽取 prompt 草案

```text
你是记忆抽取器。只输出 JSON，不要解释。
输入：最近 10 轮对话 + 时间。
输出：
{
  "facts": [
    {"kind": "preference|event|agreement|profile",
     "subject": "用户", "predicate": "喜欢", "object": "冰美式",
     "text": "用户喜欢冰美式", "confidence": 0.9, "source_msg_ids": [12,15]}
  ],
  "mood_delta": {"mood": 5, "energy": -10},
  "follow_ups": [
    {"topic": "周末电影", "due_at": "2026-11-02T10:00:00+08:00"}
  ]
}
规则：
- 只存持久事实（偏好/事件/约定/画像），不存临时任务、文件路径、一次性情绪。
- 每条事实必须能对应到 source_msg_ids。
- 不确定的不要写；置信度低于 0.6 的事实不要输出。
- 同一事实用 subject/predicate/object 归一化，便于去重。
```

## 9. 分阶段实施

| 阶段 | 内容 | 预计 |
|---|---|---|
| P0 | 人设文件 + 记忆表结构 + 配置项 | 1 天 |
| P1 | 事实/摘要抽取 + FTS5 检索 + prompt 注入 | 2-3 天 |
| P2 | 多气泡/延迟/情绪状态 | 1-2 天 |
| P3 | 主动场景 + follow-up + 图库 metadata/自动打标 | 1-2 天 |
| P4 | 可选：embedding 混合检索 + 管理命令/界面 | 1-2 天 |

MVP 约 5-7 天；完整版 8-10 天。

## 10. 风险

- **记忆幻觉/重复**：事实必须带来源消息；置信度低于阈值不注入；定期合并去重。
- **上下文膨胀**：注入上限（建议 1200-2000 字/8 条）；摘要压缩。
- **成本**：抽取每 10 轮或空闲 10 分钟一次、摘要每天一次；用 flash 模型。
- **隐私**：全部本地 SQLite/Markdown；不接外部记忆服务。
- **主动打扰**：每日上限 + 免打扰 + 概率。
- **人设漂移**：SOUL + 示例对话 + 每轮边界重申。
- **Node SQLite 实验性**：Node 25 可用；若升级出问题，退回 JSONL 索引。

## 11. 待确认

1. 保持当前 TS 机器人，还是愿意整体换 Hermes/AstrBot？（建议保持）
2. 记忆 MVP 先用 FTS5 关键词，还是直接上 embedding？（建议先用 FTS5）
3. 人设你希望自己写，还是我先根据你的描述生成一版 `SOUL.md`？
4. 主动消息每日上限、免打扰时段、默认频率？
5. 多气泡/延迟的默认强度：轻（1-2 条、0.8-1.5s）还是明显（2-3 条、1-2.5s）？

## 12. 验收标准

1. **记忆召回**：一周后问“我之前说过喜欢什么/上次那件事后来怎样”，能准确说出，且不编造。
2. **跨时间引用**：主动消息能接上几天前的话题，例如“你上次说的电影去了吗”。
3. **人设稳定**：连续多天、多次重启后语气/称呼/边界一致，不自我介绍、不客服腔。
4. **真人感**：回复拆成 1-3 条短消息，间隔自然；不是每条都秒回；合适时配表情包。
5. **主动克制**：不在免打扰时段发，每日不超过上限，刚聊过不打扰。
6. **可纠正**：用户说“记错了/忘掉这个”时能删除或修正，文件可手动编辑。
7. **图库可用**：能收藏新图、按情绪/关键词发图、避免连续重复。

## 13. MVP 实施清单

| 文件 | 工作 |
|---|---|
| `src/standalone/persona/index.ts` | 读取 `data/persona/SOUL.md` / `USER.md` / `MEMORY.md`，预算校验，渲染成 prompt 段；文件不存在时用 config 兜底 |
| `src/standalone/memory/db.ts` | `node:sqlite` 打开库、WAL、建表/触发器、prepared statements |
| `src/standalone/memory/recall.ts` | FTS5 trigram 查询 + <3 字 LIKE 兜底 + bm25/重要性/时间衰减/置信度排序，取 6-10 条 |
| `src/standalone/memory/extract.ts` | 每 10 轮/空闲 10 分钟异步抽取事实、情绪、follow-up；JSON schema；按 subject/predicate/object 去重/supersede |
| `src/standalone/persona/files.ts` | USER/MEMORY 的 § 条目读写、原子写、超预算合并/压缩 |
| `src/standalone/delivery/humanize.ts` | 拆气泡、延迟、打字状态、表情穿插；可配置 |
| `src/standalone/memory/state.ts` | mood/energy/affection 状态读写，影响 prompt 和主动概率 |
| `agent.ts` | systemPrompt 注入 SOUL/USER/MEMORY/检索结果/心情；回合后触发抽取；新增工具 |
| `proactive.ts` | 增加早安/晚安/空闲/follow-up/随机触发，每日上限 |
| `meme.ts` | 增加 metadata、自动打标、LRU、mood 选图 |
| `config.json` | 新增 `persona` / `memory` / `humanize` / `mood` / `proactive` 配置段 |

新增工具：

- `update_memory(target=user|memory, action=add|replace|remove|set|clear, content, old_text?)`
- `recall_memory(query)`
- `schedule_follow_up(topic, when)`
- `set_mood(mood?, energy?)`（可选，或由抽取步骤自动更新）

明确不做：

- 不整体切换到 Hermes/AstrBot（OneBot 适配层要重做，风险大于收益）。
- 不让模型每轮自由写记忆（成本高、容易脏）；批量异步抽取。
- MVP 不引入向量库/embedding；先用 FTS5。
- 不把原始长对话直接塞进 prompt；用摘要 + Top-K 事实。
