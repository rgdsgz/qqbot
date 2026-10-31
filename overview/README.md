# 项目概览（交接用）

> 整理时间：2026-10-31  
> 当前状态：P0–P3 + 混合检索已完成；服务当前处于**停止**状态，等待试运行和调参。  
> 代码目录：`D:\E\programming\qqbot`（原 `dsh-onebot`）  
> 运行数据：`D:\E\programming\data`

## 5 分钟交接

这是一个**只供主人自己使用**的 QQ 聊天机器人：

- 用一个 QQ 小号登录（NapCat + QQ NT），大号私聊它；
- 只响应 `data/owner.json` 里绑定的那个 QQ，其他人和群聊一律沉默；
- 聊天走 DeepSeek OpenAI 兼容接口（当前 `deepseek-flash`）；
- 全部数据保存在本地：人设文件、SQLite 长期记忆、向量、表情包、图片、日志；
- 有长期记忆、混合检索、多气泡回复、心情状态、主动消息、表情包自动打标。

日常只需要三个脚本：

```bat
start-all.bat    启动 NapCat + 机器人
status.bat       看端口、进程、最近日志
stop-all.bat     停止机器人和 QQ/NapCat
```

改完配置或代码后：

```bat
cd /d D:\E\programming\qqbot
npm run build:standalone
```

然后重新 `start-all.bat`。

## 文档索引

| 文件 | 内容 |
|---|---|
| [01-architecture.md](01-architecture.md) | 系统架构、运行流程、目录结构、模块职责、数据流 |
| [02-design-decisions.md](02-design-decisions.md) | 从 dsh-onebot 到独立版的搭建思路、关键决策、踩过的坑 |
| [03-operations-handover.md](03-operations-handover.md) | 环境、启动/停止/备份/恢复、配置说明、排障、已知限制 |
| [04-code-map.md](04-code-map.md) | 文件级代码地图：每个文件干什么、改功能去哪里 |

已有文档（更偏使用/规划）：

- [../docs/USAGE.md](../docs/USAGE.md)：安装、配置、功能、排障
- [../docs/PLAN.md](../docs/PLAN.md)：功能规划与完成进度
- [../docs/STRUCTURE.md](../docs/STRUCTURE.md)：目录结构速查

## 当前快照

| 项目 | 值 |
|---|---|
| Node.js | v25.2.1 |
| 机器人源目录 | `D:\E\programming\qqbot` |
| 机器人监听 | `127.0.0.1:8643`（OneBot 反向 WS） |
| NapCat WebUI | `127.0.0.1:6099` |
| LLM | `deepseek-flash`（OpenAI 兼容） |
| 本地 embedding | `Xenova/bge-small-zh-v1.5`，512 维，CLS + 查询前缀 |
| 向量索引 | sqlite-vec 0.1.9（消息 ANN）+ 事实全量余弦 |
| 记忆库 | `data/memory/chat.db` |
| 表情包 | `data/memes/`，`index.json` 存描述/关键词/用量 |
| 主人绑定 | `config.owner.qq` 固定为主人 QQ（`data/owner.json` 保留记录） |
| 备份 | `backups/*.qbak`，AES-256-GCM 加密，不含 `data/models`；密码不保存 |

## 三条红线

1. **`config.json` 含 LLM API Key**，不要提交、外发或截图。
2. **NapCat 登录个人 QQ 违反腾讯用户协议**，有封号风险；只建议用小号。
3. **不要删除 `data/`**：人设、记忆、表情包、绑定关系都在里面；`data/models` 可以删，会重新下载。

## 交接时先看哪里

1. 本文 + `01-architecture.md`：知道东西在哪、怎么转。
2. `03-operations-handover.md`：能启动、能停机、能备份、能排障。
3. `04-code-map.md`：要改功能时按表找文件。
4. `02-design-decisions.md`：理解为什么这样设计，避免重复踩坑。
