# persona

人设与可读记忆层。

计划文件：

- `index.ts`：门面，加载/渲染 SOUL + USER + MEMORY。
- `files.ts`：`§` 条目解析、预算校验、原子写、超预算合并。
- `render.ts`：把三份文件渲染成 system prompt 段。

运行时数据：`data/persona/SOUL.md`、`USER.md`、`MEMORY.md`。
