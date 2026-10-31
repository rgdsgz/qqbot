# 运行、维护与交接手册

## 1. 环境要求

| 项 | 当前值 / 要求 |
|---|---|
| 操作系统 | Windows 11 |
| Node.js | v25.2.1（需要支持 `node:sqlite`） |
| npm | 11.x |
| QQ | QQ NT，当前装在 `F:\QQ` |
| NapCat | `D:\E\programming\napcat\NapCat.Shell` |
| LLM | DeepSeek OpenAI 兼容接口，当前 `deepseek-flash` |
| 本地 embedding | `Xenova/bge-small-zh-v1.5`，缓存在 `data/models` |
| 端口 | 机器人 `127.0.0.1:8643`，NapCat WebUI `127.0.0.1:6099` |

## 2. 第一次部署

```bat
cd /d D:\E\programming\qqbot
npm install --include=dev --legacy-peer-deps
npm run build:standalone
```

然后在项目根目录：

1. 复制 `config.example.json` 为 `config.json`（如果还没有）；
2. 填 `llm.apiKey`（或用环境变量 `LLM_API_KEY` / `DEEPSEEK_API_KEY`）；
3. `owner.qq` 留空 = 第一条私聊自动绑定；填了 = 只认这个号；
4. 双击 `start-all.bat`；
5. 如果小号需要登录，打开 `http://127.0.0.1:6099/webui` 扫码。

依赖说明：`--legacy-peer-deps` 是为了绕开上游 DSH peer 依赖的 npm 解析冲突；独立版运行并不依赖 DSH。

## 3. 日常操作

| 操作 | 方法 |
|---|---|
| 启动全部 | 双击 `start-all.bat` |
| 只启动 NapCat | 双击 `start-napcat.bat` |
| 只启动机器人 | 双击 `start-bot.bat` |
| 查看状态 | 双击 `status.bat`（端口/进程/最近日志） |
| 停止全部 | 双击 `stop-all.bat`（会杀掉 QQ 小号，下次可能要扫码） |
| 备份 | 先 `stop-all.bat`，再双击 `backup.bat`，生成加密的 `backups\qqbot-时间.qbak` |
| 恢复 | 双击 `restore-backup.bat`，输入密码，解密到 `restore-时间\`（不覆盖现有数据） |

注意：

- `start-bot.bat` 的窗口**不要关**，关掉机器人就停。
- `stop-all.bat` 会 `taskkill QQ.exe`，如果本机还登着大号，也会一起关掉。
- 机器人只监听本机；不要把 8643/6099 暴露到局域网。

## 4. 配置说明（根目录 `config.json`）

### 4.1 owner / bot

```jsonc
"owner": {
  "qq": "<主人QQ>",    // 当前固定为主人号；留空才是 learn
  "name": "主人",
  "mode": "fixed",     // learn | fixed
  "pairingCode": ""
}
```

- 当前已填主人 QQ、`mode=fixed`，只认这个号；`data/owner.json` 仍保留作记录，但配置优先。
- 换主人：停止机器人，改 `config.owner.qq`（或清空后重新走 learn），再启动。
- 不要为了省事把 `qq` 留空且不设 `pairingCode`，否则 `owner.json` 丢失后可能被重新绑定。

### 4.2 llm

| 字段 | 说明 |
|---|---|
| `baseUrl` | OpenAI 兼容地址，默认 `https://api.deepseek.com/v1` |
| `apiKey` | 必填（或在环境变量里） |
| `model` | 文本模型，当前 `deepseek-flash` |
| `visionModel` | 图片识别/表情包打标模型，当前同 `deepseek-flash` |
| `maxTokens` / `temperature` / `timeoutMs` | 生成参数与超时 |
| `maxToolRounds` | 工具循环上限，默认 5 |
| `contextMessages` / `contextChars` | 单次上下文预算 |

### 4.3 napcat

```jsonc
"napcat": {
  "mode": "reverse",
  "host": "127.0.0.1",
  "port": 8643,
  "accessToken": "***"
}
```

`accessToken` 必须与 NapCat 侧配置一致；不要外传。

### 4.4 memory

| 字段 | 说明 |
|---|---|
| `enabled` | 长期记忆开关 |
| `dbPath` | 默认 `<dataDir>/memory/chat.db` |
| `extractEveryTurns` | 每多少轮触发抽取，默认 10 |
| `idleExtractMinutes` | 空闲多少分钟触发抽取，默认 10 |
| `maxRecallFacts` / `maxRecallChars` | 事实注入条数与字符预算 |
| `maxRecallSnippets` / `maxSnippetChars` | 原始对话片段预算 |
| `extractMaxChars` | 单次抽取输入上限 |
| `minConfidence` | 事实最低置信度（低于不存） |
| `summaryHour` | 预留字段 |

### 4.5 embedding

| 字段 | 说明 |
|---|---|
| `enabled` | 混合检索开关 |
| `provider` | `local` 或 `remote` |
| `model` | 本地 HF 模型 id，默认 BGE-small-zh |
| `dimensions` | 512 |
| `mirror` | 首次下载镜像，默认 `https://hf-mirror.com` |
| `cacheDir` | 默认 `<dataDir>/models` |
| `batchSize` / `intervalSeconds` | 后台索引批量与检查间隔 |
| `minScore` | 语义单独命中的最低余弦，默认 0.4 |
| `remoteBaseUrl` / `remoteApiKey` / `remoteModel` | 远程 OpenAI 兼容 `/embeddings` 时使用 |

换模型或维度后，启动时会自动清空旧向量并重建；也可以手动回填：

```bat
cd /d D:\E\programming\qqbot
npm run embed:memory
```

### 4.6 memes

| 字段 | 说明 |
|---|---|
| `dirs` | 额外图库目录；`<dataDir>/memes` 永远包含 |
| `autoLearn` | 收到的每张图自动存进 `inbox`（不触发识图），默认 false |
| `autoTag` | `learn_meme` 时是否视觉打标，默认 true |
| `avoidRepeatHours` | 多少小时内避免重复发同一张，默认 6 |
| `tags` | 情绪标签列表 |

### 4.7 proactive / humanize / mood

- `proactive`：随机间隔、免打扰、空闲要求、概率、tick、每日上限、早晚窗口。
- `humanize`：气泡数、按字数延迟、首条额外 0.5–0.85 秒。
- `mood`：是否让 mood/energy/affection 影响语气和主动概率。

## 5. 安全加固现状

已完成（2026-11-01）：

- `config.json`、`data/`、`backups/`、`napcat/NapCat.Shell/config/` 的 ACL 收紧为“当前用户 + SYSTEM + Administrators”，移除了 `Users`、`ALL APPLICATION PACKAGES` 和旧 SID；
- 备份改为 AES-256-GCM 加密 `.qbak`，密码不保存；
- 旧明文 zip 已移除其中的 `config.json`（不再含 API Key）；
- 主人改为 `config.owner.qq` 固定绑定；
- 日志级别从 `debug` 降为 `info`。

迁移到新机器或恢复备份后，重新跑一次：

```bat
pwsh -NoProfile -ExecutionPolicy Bypass -File qqbot\scripts\secure-acl.ps1
```

不要随意放开 `data/` 或 `config.json` 的权限；不要把 `.qbak` 密码写在备份同目录。

## 6. 备份与恢复

### 备份（加密）

```bat
stop-all.bat
backup.bat
```

`backup.bat` 会：

1. 用 Windows `tar` 打包 `data\`（排除 `data\models\`）和 `config.json`；
2. 用 AES-256-GCM + PBKDF2-SHA256（600k 次）加密；
3. 输出 `backups\qqbot-时间.qbak`，并删除临时 zip。

密码会提示输入两次，**不会保存到任何文件**。忘记密码 = 备份无法恢复。备份文件本身包含 `config.json`（API Key）和全部聊天数据，因此必须保管好密码和 `.qbak` 文件。

> 旧的 `.zip` 明文备份已移除其中的 `config.json`（不再含 API Key），但聊天数据仍是明文。建议在新加密备份验证可用后删除旧 `.zip`。

### 恢复

1. 停止机器人和 NapCat；
2. 双击 `restore-backup.bat`（默认选最新的 `.qbak`）；
3. 输入密码，脚本解密并解压到 `restore-时间\`，**不会覆盖现有文件**；
4. 检查 `restore-时间\data\` 和 `config.json`，确认无误后复制到项目根目录；
5. 启动 `start-all.bat`；
6. 如果 QQ 登录态丢失，打开 WebUI 扫码。

指定某个备份文件：

```bat
pwsh -NoProfile -ExecutionPolicy Bypass -File qqbot\scripts\restore-encrypted.ps1 -BackupFile backups\qqbot-xxxx.qbak
```

`data/models` 不需要备份；首次启动会从 hf-mirror 重新下载约 22MB。

## 7. 维护任务

| 任务 | 操作 |
|---|---|
| 新表情包 | 放进 `data/memes/<标签>/`，下次工具调用自动重扫；或让机器人 `learn_meme` |
| 批量补标 | `npm run tag:memes`（默认 20 张，`-- 50` 指定数量） |
| 回填记忆向量 | `npm run embed:memory` |
| 重建 FTS 索引 | 代码里 `MemoryService.rebuildIndexes()`；正常不需要 |
| 换 LLM | 改 `config.llm`，重启机器人，不需要重编译 |
| 换 embedding 模型 | 改 `config.embedding`，启动时自动清空旧向量并重建 |
| 改人设 | 直接编辑 `data/persona/SOUL.md`，重启或下一轮生效 |
| 改用户画像/长期记忆 | 编辑 `USER.md` / `MEMORY.md`，或让机器人用 `update_memory` |

## 8. 验证脚本

```bat
cd /d D:\E\programming\qqbot
npm run build:standalone

node scripts/verify-memory-recall.mjs   # 关键词检索/片段/预算
node scripts/verify-p2.mjs              # 气泡、mood、主动触发、follow-up
node scripts/verify-p3.mjs              # 图库元数据、打标、LRU
node scripts/verify-hybrid.mjs          # 混合检索、sqlite-vec、回退
```

四个脚本都通过再上线，基本不会有大问题。

## 9. 排障

| 现象 | 检查 |
|---|---|
| 8643 没监听 | 机器人窗口是否还开着；`status.bat`；`data\logs\bot.log` |
| NapCat 没连上 | NapCat 窗口/WebUI；`accessToken` 是否一致；6099 是否在监听 |
| 小号掉登录 | 打开 `http://127.0.0.1:6099/webui` 扫码 |
| 收不到回复 | 是否主人 QQ；`owner.json` 是否正确；日志是否有 LLM 错误 |
| LLM 报错 | API Key、余额、`baseUrl`、模型名；日志里的 HTTP 状态 |
| 一直显示 facts 0 | 正常，需 10 轮或空闲 10 分钟才抽取 |
| 混合检索没生效 | 日志是否有 embedding 模型就绪；`data/models` 是否完整；模型下载失败会退回关键词 |
| 表情包不重复失效 | 图库太少时会复用；`avoidRepeatHours` 可调 |
| 主动消息过多/过少 | `proactive.probability`、`maxPerDay`、窗口、`idleMinutes` |
| 机器人窗口关了 | 重新 `start-all.bat`；窗口必须保留 |
| `ExperimentalWarning: SQLite` | Node 自带 sqlite 的实验警告，可忽略 |
| 目录改名被占用 | 关闭 VS Code/终端/MCP 进程后再改；启动脚本兼容新旧名 |
| 插件测试失败 | `qqbot/tests` 是上游 DSH 插件测试，缺 peer 依赖/ffmpeg/符号链接权限，和独立版无关 |

## 10. 已知限制

- **只支持一个主人、一个私聊会话**；群聊忽略。
- **主动消息质量依赖模型**，触发对了不代表话一定说得好，需要试运行调参。
- **事实抽取有延迟**（10 轮/10 分钟），不是实时记忆。
- **图库目前是关键词/情绪检索**，没接向量；图多了以后可以复用同一个 embedder 做语义搜图。
- **本地模型是 CPU 推理**；100k 条消息的首次向量回填需要一段时间，之后增量很快。
- **没有做成 Windows 服务**；依赖两个窗口常驻。
- **NapCat 登录个人 QQ 有封号风险**，只建议小号。
- `qqbot/tests`、`lib/`、`bin/`、`cordis.patch.yml` 等是上游 DSH 插件遗留，不属于当前运行路径。

## 11. 交接清单

接手的人至少确认：

- [ ] `start-all.bat` 能启动，`status.bat` 能看到 8643/6099；
- [ ] 大号私聊小号能收到回复；
- [ ] `config.owner.qq` 是正确的主人 QQ，且 `mode=fixed`；
- [ ] `config.json` 的 Key 有效，且没有被提交/外发；
- [ ] `backup.bat` 能生成加密 `.qbak`，且 `restore-backup.bat` 能解密到 `restore-*`；
- [ ] 四个 `verify-*.mjs` 能跑通；
- [ ] 知道 `data/` 不能删，`data/models` 可以删；
- [ ] 知道改完代码要 `npm run build:standalone` 再重启；
- [ ] 知道 NapCat 掉登录要去 6099 扫码。
