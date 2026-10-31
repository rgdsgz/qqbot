# QQ bot source（独立版）

这个目录是个人 QQ 机器人的源码。它最初从 dsh-onebot 改造而来，但**运行时不依赖 DSH/Cordis**。

## 当前有效的部分

```
src/standalone/          机器人本体
  main.ts                启动与装配
  agent/                 LLM 回合、工具循环
  memory/                长期记忆、混合检索、向量索引
  persona/               SOUL/USER/MEMORY
  meme/                  图库、自动打标、LRU 选图
  proactive/             主动消息触发与调度
  delivery/              多气泡、typing、延迟
  transport/bridge.ts    OneBot 事件过滤与发送

src/connection.ts        OneBot/NapCat 连接（复用）
src/media.ts             入站媒体（复用）
src/outbound.ts          出站分段（复用）
src/inbound.ts           CQ 码解析（复用）
src/shared-types.ts      共享类型
src/cq.ts, src/t2i/      消息解析与文字转图（按需复用）
dist/standalone/         构建产物
scripts/                 构建、验证、打标、向量回填
```

## 上游 DSH 插件遗留（机器人不使用）

`src/index.ts` 等顶层插件源码、`lib/`、`bin/`、`cordis.patch.yml`、`dsh.plugin.json`、`tsconfig.json`、`tests/`、`docs/`、`README.upstream.md`、`README.en.md`、`DEVLOG.md` 都是 dsh-onebot 上游内容，保留作参考；不要把它们当作当前运行入口。

## 命令

```bash
npm install --include=dev --legacy-peer-deps
npm run build:standalone

node scripts/verify-memory-recall.mjs
node scripts/verify-p2.mjs
node scripts/verify-p3.mjs
node scripts/verify-hybrid.mjs

npm run tag:memes          # 图库批量打标
npm run embed:memory       # 历史记忆向量回填
```

启动请回项目根目录用 `start-bot.bat` / `start-all.bat`；配置在根目录 `config.json`，数据在根目录 `data/`。用户文档见根目录 `docs/USAGE.md`。
