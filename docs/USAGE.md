# 独立版 QQ 机器人（不依赖 DSH）

这个仓库保留了两套入口：

| 入口 | 用途 | 是否需要 DSH |
|---|---|---|
| `lib/index.js` | 原来的 DSH 插件 | 需要 |
| `dist/standalone/main.js` | 独立进程，直接用 NapCat 登录你的 QQ 小号 | **不需要** |

独立版复用了原项目的 OneBot/NapCat 传输层、媒体处理、出站分段和表情包发送能力，把 DSH 的 agent/session/tool 层换成了自己的实现：一个 OpenAI 兼容的 LLM 客户端、按会话持久化的上下文、工具循环和主动消息调度器。

> **当前项目布局**：源码在 `D:\E\programming\qqbot`（入口 `src/standalone`），运行配置 `config.json` 和 `data/` 在项目根目录 `D:\E\programming`。在源码目录直接运行时，`--config` 用 `..\config.json`；根目录的 `start-all.bat` 已经处理好路径。

## 功能

- 只允许**一个 QQ 号**私聊机器人，其他人发消息静默丢弃（不回、不报错）。
- 群聊默认完全忽略。
- 支持图片：你发的图会作为视觉输入交给模型；表情包可以收藏进图库。
- 表情包：按 `data/memes/<标签>/` 组织，模型可调用 `send_meme` 挑图发送；`index.json` 记录描述/关键词/用量，`learn_meme` 会自动识图打标，6 小时内不重复发同一张（有替代图时）。
- 主动消息：早安/晚安/空闲/到点 follow-up 四类触发，支持免打扰时段、空闲要求、每日上限和 mood 缩放概率。
- 表达层：回复拆成 1-3 个气泡，带 typing 和按字数延迟；mood/energy/affection 会写进系统提示并影响语气。
- 所有状态都在本地：会话 JSON、媒体临时文件、表情包目录。

## 前置

- Node.js ≥ 22
- Windows 上的 QQ NT（本项目按 Windows 开发）
- NapCat（OneBot 11 实现，负责登录你的 QQ 小号）
- 一个 OpenAI 兼容的 LLM API（DeepSeek / ARK / Kimi / OpenAI / GLM 等）

## 安装

```bash
npm install --include=dev --legacy-peer-deps
npm run build:standalone
```

`--legacy-peer-deps` 是为了绕开上游 `@deepseek-ai/*` prerelease peer 的 npm 解析冲突；独立版构建本身不会引用这些包，可以用下面的命令验证：

```bash
./node_modules/.bin/tsc -p tsconfig.standalone.json --listFiles --noEmit | grep @deepseek-ai
# 应该没有任何输出
```

## 配置

在项目根目录 `D:\E\programming` 执行（已有 `config.json` 就跳过）：

```bat
copy config.example.json config.json
```

至少改这几项：

```jsonc
{
  "owner": { "qq": "", "name": "主人", "mode": "learn", "pairingCode": "" },
  "napcat": {
    "mode": "reverse",
    "port": 8643,
    "accessToken": "生成一个长随机字符串"
  },
  "llm": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-...",          // 或设置环境变量 LLM_API_KEY
    "model": "deepseek-chat"
  }
}
```

- `owner.qq` **可以留空**：
  - 留空 = 自动绑定模式。机器人收到的**第一条私聊**的发送者会绑定为主人，写入 `data/owner.json`，之后其他号一律静默。小号没有好友、只和大号对话时，这一条就会绑定你的大号。
  - 填了 QQ = 固定模式，只认这个号，第一条私聊是谁都不影响。
  - 想更稳可以在自动绑定模式下设置 `pairingCode`，第一条私聊必须包含这个字符串才会绑定；绑定成功后不再需要。
- `accessToken` 必须和 NapCat 里填的 token 完全一致；reverse 模式留空会拒绝启动。
- `llm.apiKey` 也可以不写，改用环境变量 `LLM_API_KEY`。

### 视觉模型

如果文本模型不支持图片，把视觉请求指到另一个 OpenAI 兼容端点：

```jsonc
"llm": {
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-chat",
  "visionBaseUrl": "https://ark.cn-beijing.volces.com/api/v3",
  "visionApiKey": "ARK_KEY",
  "visionModel": "doubao-vision-..."
}
```

不配置时 `vision*` 会回退到文本的 `baseUrl/apiKey/model`。如果模型不支持图片，图片消息仍会以 `[图片]` 文本形式进入上下文，但模型看不到内容。

## 启动 NapCat 并登录小号

1. 下载 [NapCat Release](https://github.com/NapNeko/NapCatQQ/releases) 里的 `NapCat.Shell.zip`，解压到一个独立目录。
2. 双击 `launcher.bat`（Windows 10 用 `launcher-win10.bat`），按提示用**QQ 小号**扫码登录。
3. 打开 NapCat 的 WebUI（控制台会打印地址和 token），进入 **网络配置**。
4. 推荐用 reverse 模式：
   - 新增 **WebSocket 客户端**
   - URL：`ws://127.0.0.1:8643/ws`
   - Token：和 `config.json` 的 `napcat.accessToken` 一致
   - 消息格式：**数组**
   - 启用并保存
5. 或者用 forward 模式：在 NapCat 启用 **WebSocket 服务端**（默认 3001），把 `config.json` 的 `napcat.mode` 改成 `"forward"`，`url` 填 `ws://127.0.0.1:3001`。

## 运行

```bash
# 正式运行
npm start -- --config ..\config.json

# 或者直接跑编译产物
node dist/standalone/main.js --config ..\config.json

# 不调用模型，只测 NapCat 链路
npm run standalone:echo -- --config ..\config.json
```

看到 `NapCat 已连接` 后，用你的大号私聊小号即可。

## 关机重启后怎么启动

### 一键启动（推荐）

双击项目根目录 `D:\E\programming` 下的 **`start-all.bat`**。它会：

1. 带 `NAPCAT_DISABLE_MULTI_PROCESS=1` 启动 NapCat（QQ 小号）；
2. 等 3 秒后启动独立机器人；
3. 如果 8643 端口已经有机器人在跑，会跳过重复启动。

会打开两个窗口（NapCat / QQBot），**不要关掉**，关掉窗口就等于停止服务。

- 查看状态：双击项目根目录的 `status.bat`
- 停止：双击项目根目录的 `stop-all.bat`（会杀掉 QQ 小号，下次启动可能需要重新扫码）

### 手动启动

```bat
:: 窗口 1：NapCat + QQ 小号
cd /d D:\E\programming\napcat\NapCat.Shell
set NAPCAT_DISABLE_MULTI_PROCESS=1
launcher-user.bat

:: 窗口 2：机器人
cd /d D:\E\programming\qqbot
node dist\standalone\main.js --config config.json
```

顺序无所谓：机器人先起会监听 8643，NapCat 后连上；反过来 NapCat 会按 5 秒间隔重连。

### 重启后哪些东西还在

| 数据 | 是否保留 |
|---|---|
| 主人绑定 | ✅ `data/owner.json` |
| 聊天上下文 | ✅ `data/sessions/` |
| 表情包库 | ✅ `data/memes/` |
| NapCat 的 OneBot 配置 | ✅ `config/onebot11_<QQ>.json` |
| QQ 登录态 | ⚠️ 通常保留，掉登录时打开 WebUI 扫码 |
| API Key / 机器人配置 | ✅ `config.json` |

如果重启后机器人日志一直不出现 `NapCat 已连接`，打开 `http://127.0.0.1:6099/webui` 看小号是否在线；NapCat 的 WebUI token 在 `D:\E\programming\napcat\NapCat.Shell\config\webui.json`。

## 目录结构

```
data/
  sessions/     每个会话一个 JSON（最近上下文）
  media/        入站图片（ttlHours=0 时永久保留）
  outbox/       你想让机器人发送的本地图片放这里
  memes/        表情包库，子目录名就是标签
    happy/
    angry/
    ...
  memory/       长期记忆 SQLite（chat.db）
  persona/      SOUL.md / USER.md / MEMORY.md
  logs/         机器人日志
```

## 表情包

- 把图片按情绪放进 `data/memes/<标签>/`；下次调用表情包工具时会自动重扫（最多每分钟一次），重启也会重扫。
- 你跟机器人说“发个开心点的图”，它会调 `send_meme tag=happy`。
- 你发一张表情包，说“把这张收进图库”，它会调 `learn_meme` 收藏，并用视觉模型自动打标（分类/描述/关键词）。
- 已有图片可以批量补标：`npm run tag:memes`（默认 20 张）。
- `config.memes.autoLearn` 设为 `true` 会把收到的每张图都自动存进 `inbox`（不触发识图），默认关闭；`config.memes.autoTag` 控制 `learn_meme` 时是否自动识图，默认开启。
- 发送本地图片的路径被限制在 `data/media`、`data/memes`、`data/outbox` 内，防止模型被诱导发送任意系统文件。

## 长期记忆与混合检索

默认使用本地中文向量模型 `Xenova/bge-small-zh-v1.5`（512 维）：

- 模型缓存在 `data/models/`，首次启动从 `hf-mirror.com` 下载约 22MB，之后离线可用；
- 查询侧用 BGE 官方的检索前缀 + CLS pooling，文档侧不加前缀（参考 dsh-qqbot 的 `local-embed` 实践）；
- 事实走“关键词 + 余弦”全量排序，消息走 sqlite-vec ANN；
- 新消息/事实/摘要在后台批量索引，不阻塞回复；模型没就绪时这一轮自动走关键词；
- 换模型或维度会清空旧向量并重建；向量扩展不可用时自动退回纯 FTS5/LIKE。

```jsonc
"embedding": {
  "enabled": true,
  "provider": "local",                 // local | remote
  "model": "Xenova/bge-small-zh-v1.5",
  "dimensions": 512,
  "mirror": "https://hf-mirror.com",   // 本地模型下载镜像
  "cacheDir": "",                      // 默认 data/models
  "batchSize": 32,
  "intervalSeconds": 10,
  "minScore": 0.4,                     // 语义单独命中时的最低余弦
  "remoteBaseUrl": "",                 // provider=remote 时使用
  "remoteApiKey": "",
  "remoteModel": ""
}
```

历史数据可以一次性回填：

```bash
npm run embed:memory          # 一直跑到没有新行
npm run embed:memory -- 50    # 最多 50 批
```

## 主动消息

```jsonc
"proactive": {
  "enabled": true,
  "minIntervalMinutes": 90,   // 两次随机主动消息之间的下限
  "maxIntervalMinutes": 240,  // 上限
  "quietStart": "23:30",      // 免打扰开始
  "quietEnd": "08:30",        // 免打扰结束（支持跨午夜）
  "idleMinutes": 45,          // 至少安静这么久才随机主动
  "probability": 0.6,         // 到点后真正开口的概率
  "tickMinutes": 2,           // 每 2 分钟检查一次触发
  "maxPerDay": 6,             // 每天最多几条（follow-up 不计入）
  "morningStart": "08:30",    // 早安窗口
  "morningEnd": "10:30",
  "eveningStart": "20:30",    // 晚安窗口
  "eveningEnd": "23:00"
}
```

触发顺序：到点 follow-up → 早安 → 晚安 → 空闲随机。主人提到未来安排时，模型可以调用 `schedule_follow_up` 记下来，到点自然问起。主动消息也会走同一个 agent 和工具循环，所以它可以自己决定配一张表情包。注意：这只适合自用，不要把 `owner.qq` 配成别人的号。

## 与 DSH 插件共存

- 独立版不会读写 DSH 的 profile、config、凭据。
- 原来的 DSH 插件仍然存在：`./scripts/build.sh` 构建它，`dsh plugin ...` 安装它。
- 两套代码共享 `src/connection.ts`、`src/inbound.ts`、`src/outbound.ts`、`src/media.ts`、`src/t2i/` 等文件，改动会同时影响两边。

## 备份与恢复（加密）

停止机器人后运行根目录 `backup.bat`：

- 打包 `data\`（排除 `data\models\`）和 `config.json`；
- 用 AES-256-GCM + PBKDF2-SHA256 加密；
- 输出 `backups\qqbot-时间.qbak`；
- 密码提示两次，不保存；忘记密码无法恢复。

恢复时运行 `restore-backup.bat`，输入密码，解密到 `restore-时间\`（不会覆盖现有数据），确认后再复制 `data\` 和 `config.json` 到项目根目录。

旧版明文 `.zip` 备份已移除其中的 `config.json`，不再含 API Key；建议新加密备份验证后删除。

## 常见问题

| 现象 | 排查 |
|---|---|
| `reverse mode requires a non-empty accessToken` | `config.napcat.accessToken` 为空 |
| NapCat 显示连接成功但机器人没反应 | 私聊的号不是已绑定的主人（看 `config.owner.qq` / `data/owner.json`）；或 NapCat 的消息格式不是数组 |
| 绑定错了号 | 停掉进程，改 `config.owner.qq`（当前 `mode=fixed`），再启动 |
| 机器人回复「我这会儿连不上模型」 | `llm.baseUrl` / `apiKey` / 网络；看控制台日志里的 `LLM HTTP ...` |
| 图片消息模型看不懂 | 未配置视觉模型，或当前模型不支持 image 输入 |
| 端口 8643 被占用 | 改 `napcat.port`，NapCat 的 URL 同步改 |
| `npm install` 报 ERESOLVE | 加 `--legacy-peer-deps` |
| 想清空上下文 | 删除 `data/sessions/` 下对应 JSON，或重启后重建 |

## 安全与风险

- 机器人登录的是你的 **QQ 小号**，协议模拟违反腾讯用户协议，**有封号风险**。不要用主号，不要绑定支付或重要业务。
- `config.json` 里有 API Key 和 NapCat token，不要提交到 git、不要发到群里。项目的 `.gitignore` 已排除 `config.json`、`data/`、`backups/`、`napcat/` 和构建产物。
- 默认只接受 `owner.qq` 的私聊；不要把 `owner.qq` 改成不确定的号。
- 敏感目录的 Windows ACL 已收紧；迁移机器或恢复备份后可重新运行 `qqbot\scripts\secure-acl.ps1`。
- 备份是加密的 `.qbak`；密码请存密码管理器，不要和备份放在一起。
