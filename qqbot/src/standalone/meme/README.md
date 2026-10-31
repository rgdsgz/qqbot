# meme

本地表情包库：文件夹是标签，`index.json` 补上描述、关键词和用量。

## 文件

- `library.ts`：扫描、索引合并、`learn`、`pick`、`updateMetadata`、`tagMissing`。
- `metadata.ts`：`index.json` 的校验与原子读写；索引损坏会重建，图片本身才是资产。
- `search.ts`：情绪桶展开、中文关键词打分、二元组兜底、LRU 选择（纯函数）。
- `tag.ts`：视觉模型识图，返回 `{ tag, caption, keywords }`。

## 行为

- 新图片通过 `learn_meme` 收藏时自动识图打标；显式给了 tag 时标签以主人/模型指定为准，但仍会补描述和关键词。
- `bridge` 的 `autoLearn` 只归档，不触发识图（避免每张图都花一次视觉调用）。
- 搜索顺序：情绪/tag 限定 → 关键词命中数 → 全部命中优先；长中文词没命中会自动拆二元组。
- 避免重复：`avoidRepeatHours`（默认 6 小时）内发过的图，在有新图时跳过；全都发过时按最久未用轮换。
- 没给 tag 时用当前 mood 推断桶（开心/难过/困/日常）；再不行就全库随机。

## 批量补标

```bash
npm run tag:memes        # 最多 20 张
npm run tag:memes -- 50  # 最多 50 张
```

运行时数据：`data/memes/index.json`；图片在 `data/memes/<标签>/`。
