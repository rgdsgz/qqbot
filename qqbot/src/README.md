# src

- `standalone/`：当前机器人本体，入口 `standalone/main.ts`。
- 顶层其它 `.ts` 文件和 `t2i/`：从 dsh-onebot 复用的 OneBot/媒体/出站模块，以及上游 DSH 插件源码。
- `index.ts`、`chat.ts`、`tools.ts` 等插件入口不在独立版运行路径上，保留作参考。

改代码前先看 `standalone/` 的 import：删除顶层文件可能影响连接、媒体或出站模块。
