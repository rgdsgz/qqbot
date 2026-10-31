# QQ 私人 AI 机器人

通过 NapCat 登录一个 QQ 小号，用大号私聊它。只响应绑定的主人，支持图片识别、表情包收发和主动消息。

## 目录结构

```
D:\E\programming\
├─ start-all.bat       一键启动：NapCat + 机器人
├─ start-napcat.bat    只启动 NapCat（独立窗口）
├─ start-bot.bat       只启动机器人（独立窗口）
├─ stop-all.bat        停止机器人和 NapCat/QQ
├─ status.bat          查看端口、进程和机器人日志
├─ backup.bat          加密备份 data + config 到 backups\（.qbak）
├─ restore-backup.bat  解密恢复到 restore-* 目录
├─ config.json         机器人配置（含 LLM API Key，不要外传）
├─ config.example.json 配置模板
├─ data\               运行数据（全部本地）
│  ├─ owner.json       已绑定的主人 QQ
│  ├─ sessions\        最近聊天上下文
│  ├─ memory\          长期记忆 SQLite（chat.db，含向量）
│  ├─ models\          本地 embedding 模型缓存（可重新下载）
│  ├─ persona\         SOUL.md / USER.md / MEMORY.md
│  ├─ memes\           表情包库（子目录名=标签，index.json 存描述/关键词）
│  ├─ media\           收到的图片（永久保留）
│  ├─ outbox\          想主动发送的本地图片
│  └─ logs\bot.log     机器人日志
├─ backups\            加密备份 .qbak（不含 models；旧 zip 保留为历史）
├─ docs\               文档
│  ├─ USAGE.md         详细使用、配置与排障
│  ├─ PLAN.md          功能规划与进度
│  └─ STRUCTURE.md     目录与模块结构
├─ overview\           项目概览与交接文档
│  ├─ README.md        5 分钟交接
│  ├─ 01-architecture.md
│  ├─ 02-design-decisions.md
│  ├─ 03-operations-handover.md
│  └─ 04-code-map.md
├─ qqbot\              机器人源码（独立版；入口 src\standalone）
│  └─ dist\standalone\ 编译产物
└─ napcat\
   ├─ NapCat.Shell\    NapCat 本体
   └─ NapCat.Shell.zip 安装包备份
```

## 启动 / 停止

**启动**：双击根目录 **`start-all.bat`**。

- 如果 NapCat（6099 端口）已经在跑，会跳过；
- 如果机器人（8643 端口）已经在跑，会跳过；
- 会打开两个窗口：NapCat / QQBot。**不要关掉**，关掉即停止。
- 小号掉登录时，打开 `http://127.0.0.1:6099/webui` 扫码。

**查看状态**：双击 `status.bat`。

**停止**：双击 `stop-all.bat`（会杀掉 QQ 小号，下次启动可能需要重新扫码）。

## 配置

编辑根目录 `config.json`：

```jsonc
{
  "owner": {
    "qq": "",              // 留空 = 第一条私聊自动绑定；填了 = 只认这个号
    "mode": "learn",
    "pairingCode": ""      // 可选的绑定码
  },
  "llm": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-...",
    "model": "deepseek-flash",
    "visionModel": "deepseek-flash"
  },
  "proactive": {
    "enabled": true,
    "minIntervalMinutes": 90,
    "maxIntervalMinutes": 240,
    "quietStart": "23:30",
    "quietEnd": "08:30",
    "idleMinutes": 45,
    "probability": 0.6
  }
}
```

改完配置重启机器人即可，不需要重新编译。

## 表情包

把图片放到 `data\memes\<标签>\`，标签用 `happy` / `angry` / `sad` / `shy` / `confused` / `daily` / `work` / `sleep` 之一（也支持中文同义词）。

- 你发一张图，说“把这张收进图库，标签 happy”，它会用 `learn_meme` 收藏；
- 说“发个开心点的表情包”，它会用 `send_meme` 挑图发回来；
- 主动消息时它也会自己配图。

## 重要说明

- NapCat 必须带 `NAPCAT_DISABLE_MULTI_PROCESS=1` 启动（脚本已处理），否则会出现 worker 崩溃。
- 机器人只接受已绑定主人的私聊，其他号和群聊一律静默。
- `config.json` 里有 API Key，已排除在 git 之外，不要提交或发给别人。
- NapCat 登录个人 QQ 违反腾讯用户协议，有封号风险，建议只用小号。
- 详细配置、混合检索、表情包和排障说明见 `docs\USAGE.md`；源码入口是 `qqbot\src\standalone\`。
- 交接/架构/决策/代码地图见 `overview\README.md`。

## 重启后数据

| 数据 | 位置 | 重启后 |
|---|---|---|
| 主人绑定 | `data\owner.json` | 保留 |
| 聊天上下文 | `data\sessions\` | 保留 |
| 表情包 | `data\memes\` | 保留 |
| 配置/Key | `config.json` | 保留 |
| QQ 登录态 | NapCat 内部 | 通常保留，掉登录需扫码 |
