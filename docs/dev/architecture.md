# 架构

> 只解释**为什么**这样分层、**何时会失效**。字段与签名去源码读。
> 选型背景见 [ADR 0001](../ADR/0001-栈选择.md),CLI 对外契约见 [cli-contract.md](cli-contract.md)。

## 三个进程形态,一份 core

```
apps/desktop/electron/main.ts   ──┐
                                  ├──► packages/core/src/index.ts ──► SQLite (kura.db)
packages/cli/src/main.ts        ──┘
apps/desktop/src/*.vue  ──IPC──►  (渲染进程不碰 core, 也不碰 Node)
```

- **`packages/core` 是唯一有状态的一层**,公开面只有 `src/index.ts` 导出的符号。内部文件可自由重排。
- **`packages/cli` 只做四件事**:决定输出模式、解析参数、打开 runtime、把错误映射成退出码。出现业务分支就是分层漏了。
- **`apps/desktop/electron/main.ts` 是第二个宿主**:持有 runtime、注册 IPC、管窗口生命周期。
- **渲染进程禁止 import core**:它没有 Node 内建模块,所有数据经 `preload.cjs` 暴露的 `window.kura` 走 IPC。

## 三条接缝

域逻辑只在三个纯函数接缝上,都在 `packages/core/src/domain/`:

| 接缝 | 签名 | 不变量 |
|---|---|---|
| `identify` | `(文本) → ItemKey` | 无 IO、无配置;番号与站点键分命名空间 |
| `aggregate` | `(SourceRecord[], 路由) → 字段 + 来源` | 单源取首个非空、列表不做并集、URL 拼接去重 |
| `materialize` | `(Metadata, Library) → Plan` | 只算目标路径与 NFO 内容,不碰磁盘 |

`tasks/` 只负责把这三条接缝接到 IO 上(磁盘/网络/DB),自己不做判定。
扩到第二个域时新增的是另一套 `domain/`,而不是把这三个函数改成万能函数 —— 原因见 ADR 0002。

## 任务与 IO 的边界

| 任务 | 读 | 写 |
|---|---|---|
| `scan` | 磁盘 | `media_files` + 条目占位行 |
| `scrape` | 网络 | `items` + `snapshots` |
| `organize` | 无(只读 DB) | 磁盘(仅 `apply`)+ `media_files.path` |

`organize` 移动成功后必须同步索引路径,否则下一次 `scan` 会把同一文件判成 removed + added。

## 组合根

`openRuntime()` / `withRuntime()` 是唯一允许 `new Database` 的地方。规则:

- 下游函数**接收** `Runtime`,不读全局环境变量、不自建连接。
- 一次进程 = 一个 `Runtime`;CLI 用 `finally` 保证 `close()`,GUI 在 `window-all-closed` / `before-quit` 关闭。
- 需要在测试里换库 → 传 `{ dataDir }`,不要 mock 全局。

## 双 runtime 的唯一接缝

`core/src/db/driver.ts` 抹平两种 SQLite:

| 宿主 | 模块 | 差异 |
|---|---|---|
| Electron / Node | `node:sqlite` | `prepare(sql).run(...)` |
| Bun(CLI 二进制) | `bun:sqlite` | `run(sql, ...)` / `query(sql).get()` |

动态 import 用的是**变量说明符**(`const spec = isBun ? "bun:sqlite" : "node:sqlite"`),因为打包器会静态解析 `bun:sqlite` 并在 Node/Electron 构建期报 "Could not resolve"。

**只有这一个文件知道 runtime 差异**。core 其余部分只依赖 `Db` 接口。新增数据库能力时,先改 `Db` 接口,再补两个实现。

## 无守护进程的并发规则

GUI 与 CLI 是两个独立进程,共享一个库文件:

1. 连接参数固定为 `journal_mode=wal` + `busy_timeout=5000` + `foreign_keys=on`(在 driver 里,不在业务代码)。
2. 写操作必须在事务里(`begin` / `commit` / `rollback`),见 `core/src/tasks/scan.ts`。
3. 长事务是禁止的:它会把 `busy_timeout` 吃光,让另一个进程的写失败。
4. 遇到 `SQLITE_BUSY` / `SQLITE_LOCKED` 一律映射为退出码 3(可重试),不要包装成"内部错误"。

## 数据目录

`resolvePaths()`:环境变量 `KURA_DATA_DIR` > 平台默认(XDG / `%APPDATA%` / `Application Support`)。

- `dataDir` 归进程自己管,可以同步 IO。
- 用户媒体目录**不归我们管**,所有遍历/读取都按"可能很慢(FUSE / NAS)"对待:大文件用流式 hash,不要 `readFile`。

## 迁移

`core/src/db/schema.ts` 用 `pragma user_version` 递增,不引入迁移框架。规则:**只追加、不改已发布条目**;每条必须在旧库上幂等。

## 会失效的地方

- **想实时同步 GUI 与 CLI 状态** → 当前没有推送通道,需要监听 `-wal` 或加变更表。
- **想跑超过窗口生命周期的任务** → GUI 内的任务会被 `quit` 掐断,必须走 CLI + 计划任务。
- **想在渲染进程里直接读写文件** → 不要。加一个 IPC 方法,而不是打开 `nodeIntegration`。
- **想加第三个宿主(如 MCP server)** → 允许,但必须复用 `openRuntime()`,并遵守 cli-contract 的输出/退出码语义。
