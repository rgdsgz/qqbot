# proactive

主动消息：定时醒来，判断“现在该不该说话、为什么说”。

- `triggers.ts`（纯函数）：按优先级选触发——
  1. 到点的 follow-up（不受每日上限限制）；
  2. 早安窗口（`morningStart`-`morningEnd`，每天一次，需空闲 10 分钟）；
  3. 晚安窗口（`eveningStart`-`eveningEnd`，每天一次）；
  4. 空闲随机（距上次主动 ≥ 随机间隔、空闲 ≥ `idleMinutes`、概率 × mood 系数）；
  5. 都没有就继续睡。
- `scheduler.ts`：每 `tickMinutes` 检查一次；负责免打扰、连接/忙碌判断、每日上限、失败冷却和 follow-up 完成后置为 done。

触发只决定“说什么方向”；具体措辞仍由 agent 结合最近聊天、长期记忆和当前 mood 生成。
