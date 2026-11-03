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

## 待刮削的判据

"待刮削"不等于"标题为空"。从旧库回读的 NFO 会先把标题种进去, 这些条目一次网络请求都
没发过, 却会显得已经刮完了 —— 于是界面上永远显示 NFO 里的旧演员, 而正该发生的
"网络数据覆盖 NFO" 永远不发生。

判据因此是**两个条件取或**:

```
title 为空
或 field_sources 里除 'nfo' 再没有别的来源
```

三处必须用同一个谓词(`pendingWhere()`):`pendingKeys`(刮削队列)、`countPending`
(界面徽标)、`itemFilters` 的 `state = unscraped`(列表筛选)。少一处就会出现
"未刮削 76" 点进去是另一批。

而且**三个列表状态的加总必须等于各自的计数**, 所以 `state` 是互斥的:

| 状态 | 判据 | 对应计数 |
|---|---|---|
| `unscraped` | 待刮削 **且** `scrape_attempts < 3` | `countPending` |
| `exhausted` | 待刮削 **且** `scrape_attempts >= 3` | `countExhausted` |
| `scraped` | 不是待刮削 | 总数 − 上两者 |

真事故: `unscraped` 只判"待刮削"、没判次数, 而徽标用的是 `countPending`(含次数) ——
于是「未刮削 0」点进去躺着 76 条已经试满次数、带着 nfo 元数据的条目。

`scrape_attempts` 上限仍然压在上面:试满次数的条目算"已达上限", 要显式重试
(CLI `--include-failed`, 或界面里勾选后「刮削选中」)。

## NFO 是种子, 网络永远覆盖

回读的 NFO 只种下它填了的字段, 并把每个字段的来源记成 `nfo`(不是只记 title/plot)。

刮削时的覆盖顺序:

1. **网络值覆盖一切**, 包括 NFO 种下的值;
2. 用户锁定的字段保留原值;
3. 网络这次没给的字段, 用 NFO 的值兜底。

第 3 条不能省:有的来源不给演员, 只按"本次返回什么就写什么"的话, 重刮一次就会把
NFO 里对得上的演员抹掉, 条目看起来"越刮越空"。

手工改过的字段记成 `manual` —— 它和 `nfo` 一样不属于"网络来源", 但同样说明
"这条不是还没刮", 所以手工改过的标题不会被下一轮批量刮削当成空条目重新抓。

## 辅助媒体不算影片

Emby / Jellyfin 会在影片目录里放 `backdrops\theme_video.mp4`(主题视频)与 `trailers\trailer.mp4`(预告片)。
番号是从**目录名**解析出来的, 所以这些文件会被当成"同一番号的另一个文件":

- 扫描时:不登记(`isAuxiliaryMedia` 跳过, 计入 `counts.auxiliary`)
- 同步 NFO 时:跳过, 否则会去改写 Emby 自己的 `theme_video.nfo` / `trailer.nfo`,
  把影片元数据塞进辅助媒体的元数据里

目录约定:`backdrops` `trailers` `extras` `featurettes` `sample(s)` `behind the scenes` `deleted scenes` `interviews` `scenes`;
文件名约定:`theme(_video)` `trailer` `movie-trailer` `sample`。目录判断不含文件名本身 —— 影片叫 "sample 女教师" 是合法的。

同一份 nfo 路径只处理一次(多段 `-cd1`/`-cd2` 路径不同, 各自写)。

## NFO 同步: 读写是同一件事

Emby / Jellyfin / Kodi 读的是**视频旁的 `.nfo` 文件**, 不是 Kura 的库。所以"读 nfo"和"写 nfo"
必须成对出现, 否则两边永远对不上: 只读不写, 播放器里是旧演员; 只写不读, 换机器就丢元数据。

`nfo sync` 一次过, 每个文件只做一个方向, 规则确定、没有需要人裁决的冲突:

| 库里的状态 | 动作 |
|---|---|
| 没有网络来源(`field_sources` 只有 `nfo`/`manual`) | 读 nfo → 只补**空字段**, 并记 `nfo` 来源 |
| 有网络来源 | 写回 nfo: 改 Kura 认识的字段, 其它标签原样保留 |
| 旁边没有 nfo | 新建一份 `buildNfo` |

`scan` **不再读 nfo 入库**(它只读磁盘元信息), 但会数出 `counts.nfoPending` 并提示跑 `nfo sync`。
两个动作共用同一份 `importNfoFields()`, 不会出现"扫描读的是 A、同步读的是 B"。

写回是**字段级**的(`updateNfoContent`), 不是整份重写: 用户的 nfo 多半由别的工具生成, 里面有
`<outline>` `<originalplot>` `<sorttitle>` `<mpaa>` `<maker>` `<poster>` `<website>`、actor 里的
`<type>` 等等 Kura 完全不认识的标签 —— 整份重写等于删掉它们, 而播放器读的正是这些。
标签与导演取**并集**(只追加, 不删别的工具写的 `480P`/`中文字幕`), 值没变就不写盘(不抖 mtime)。

与 `organize` 的边界: 同步**不动视频、不改名、不建目录**。新建 nfo、移动文件属于整理。

## 任务记录

判据: **耗时长 + 逐条可能失败** 才进任务(刮削 / 翻译 / 同步 NFO)。扫描和修正内容类型不进 ——
前者只读磁盘、有独立进度; 后者是一次批量 SQL, 秒级且要么全成要么报错。

| 任务类型 | 入口 |
|---|---|
| `scrape.pending` / `scrape.keys` | 主按钮「刮削 «库»」/ 勾选后「刮削选中」 |
| `translate.pending` / `translate.items` | 「翻译待处理」/ 「翻译选中」 |
| `nfo.sync` | 「同步 NFO」(GUI 面板 / CLI `nfo sync`) |

GUI 与 CLI 都走 `*Task` 版本 —— 早先 GUI 的「刮削选中」直接在主进程里 for 循环调 `scrape`,
不写任务, 于是"刮过很多次, 任务页一直空"。

三条配套规则:

1. **进度节流写库**:`run.progress` 每 500ms 才更新一次 `tasks` 行(否则 3883 条 = 3883 次 WAL 提交),
   界面上的实时进度走 IPC 事件, 不落库。
2. **失败详情在 jsonl 里, 不在数据库**:`taskFailures()` 读 `logs/tasks/<id>-*.jsonl` 里
   `event: "item"` 且失败的行走。失败项是"记录"不是"状态", 一次 3883 条里的 21 个失败不该塞进表。
3. **任务表只留最近 200 条**(`TASK_KEEP`), 更老的连同 jsonl 一起删。

**重跑是真的再跑一遍**, 不是把行改成 `queued`:没有守护进程, 没人会消费 `queued` 行,
那样界面会说"已重新入队"而实际什么都不发生。两个模式:整批重跑 / **只重跑失败项**
(读 jsonl 拿失败番号, 21 个失败不该逼人重扫 2641 个文件)。

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

## 演员索引只有一个写入口

`items.actors` 是快照，`item_actors` 是从它派生的索引。**写 JSON 与重建索引是一件事**，
所以只准走 `db/actors.ts` 的 `setItemActors(db, number, names)`，不许各处直接 `update items set actors`。

吃过一次亏：0.6.11 从 nfo 读演员时只写了 JSON 没建索引，76 条条目的演员在「点演员看全部」里
根本不存在（搜「真琴」搜不到），而且因为它们在只索引库里、刮削又已试满次数，没有任何代码路径
会再碰它们 —— 数据就这么一直漂着。0.6.18 的迁移 v10 一次性修好，并加了 `doctor` 的 `actorDrift`
自检：非 0 就是有路径绕过了这个入口。

占位文本（`未知演员`、`N/A`、`---`）同样在入库前丢弃（`sanitizeActorNames`）：
它们进索引后会变成能点但点不出东西的假演员。
