# memory

长期记忆：原始消息、结构化事实、摘要、情绪状态、跟进事项。

## 文件

- `index.ts`：`MemoryService` 门面：归档、检索、异步抽取、摘要、索引重建。
- `db.ts`：`node:sqlite` 打开、WAL、所有权校验、消息/事实/摘要/状态查询。
- `schema.ts`：表与 FTS5 触发器（`messages_fts`、`facts_fts` 是派生索引）。
- `types.ts`：行与输入类型。
- `extract.ts`：每 10 轮 / 空闲 10 分钟异步抽取；输入按字符预算裁剪，事实批内去重并限量。
- `recall.ts`：中文二元/三元切词 → FTS5 + LIKE → 按命中数、重要性、置信度、时间排序；再回捞有界原始对话片段。纯关键词兜底。
- `embedding.ts`：本地 `Xenova/bge-small-zh-v1.5`（512 维，transformers.js）或远程 OpenAI 兼容 `/embeddings`；模型懒加载，首次从 hf-mirror 下载。
- `hybrid.ts`：关键词候选 + 向量余弦合并；事实全量扫描，消息用 sqlite-vec ANN；语义命中低于阈值时只保留关键词命中。
- `indexer.ts`：后台批量索引事实/摘要/消息，模型就绪前不阻塞回复；`embed:memory` 脚本可回填历史。
- `summaries.ts`：日摘要，保留专有名词、数字、约定和未完成事项。
- `state.ts`：mood/energy/affection，0-100，按半衰期向基线漂移；注入 prompt 并缩放主动概率。
- `followups.ts`：跟进事项的写入、去重、到期查询与完成。

运行时数据：`data/memory/chat.db`。

## 检索设计（参考 DSH 官方实现）

- **中文无空格**：把每个 CJK 连续段切成 2 字和 3 字 shingle；3 字进 trigram FTS，2 字进 LIKE 兜底。问句里的“什么/记得/上次”等脚手架词先过滤。
- **先精确、后兜底**：关键词有命中就只用命中；完全没有命中才退回最新/最重要的事实，避免把无关旧事硬塞进 prompt。
- **排序确定**：命中查询词条数 → 重要性/置信度/时间评分 → 更新时间 → id，结果可复现。
- **原始片段**：事实不足以回答时，检索旧消息并按匹配词定位，截取有界片段（`maxSnippetChars`）。当前这条用户消息在检索之后才归档，不会检索到自己。
- **预算可见**：`maxRecallChars` 管事实块，`maxRecallSnippets × maxSnippetChars` 管片段块；超出预算时整条丢弃而不是硬塞。
- **索引可重建**：`MemoryService.rebuildIndexes()` / `MemoryDb.rebuildIndexes()` 从源表重建两个 FTS5 索引；索引只是派生数据。
- **库所有权**：打开时检查 `PRAGMA application_id`；已有 `messages` 表的旧库会被接管，其他 SQLite 文件直接拒绝。
