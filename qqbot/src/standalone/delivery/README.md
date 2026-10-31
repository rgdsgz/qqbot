# delivery

表达层：把模型输出变成像真人发的消息。

- `humanize.ts`：拆气泡、按字数延迟、typing 开关。切分规则参考 dsh-companion 的 `channelTextChunks`：
  - 短闲聊（≤240 字、≤4 行、无结构）按行 + 句末标点拆，最多 `maxBubbles` 个；
  - 列表/代码/长文保持完整，超过 900 字再按空行分段；
  - 超出气泡上限时合并最短的相邻段，不丢文本。
- 正在输入状态由 `transport/bridge` 提供，Humanizer 只负责开关时机。

配置：`config.humanize`（`enabled`、`maxBubbles`、`minDelayMs`、`maxDelayMs`、`delayPerCharMs`）。
`stickerFirstProbability` 预留给 P3 的 mood 选图，当前未使用。
