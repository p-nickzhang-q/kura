# 已知问题

> 用户报上来的**已经坏掉**的缺陷。
> 「想清楚了但决定先不做」的功能在 [roadmap.md](../roadmap.md);技术选型的取舍在 `docs/ADR/`。
>
> 每条写清楚:现象 / 来源 / **代码上能确认的事实** / 复现 / 可选做法 / 验收口径。
> 没复现过的条目不许写成「已定位」—— 事实和假设分两栏写。
>
> **已修的条目留在原地**(标 ✅ 并写明修在哪),不删:同一个现象还可能被再报一次,
> 留着能一眼看出「修过了、当时量到多少、别再犯什么」。

## 1. 上万条目的库, 翻页卡顿、偶发「假死」 — ✅ 已修 (schema v17)

**来源**:B 站 [`BV1kTyZzfEGz`](https://www.bilibili.com/video/BV1kTyZzfEGz) 评论(2026-11-26, @阿一土鳖大叔):

> 大数据量太慢, 海报墙翻页会假死, 时不时的就会假死, 我说的是上万数据的时候, 几十个我试过, 正常。

### 实测(2026-11-20, 2 万条目 / 2.02 万文件)

拆开一次 `item:list` 的五个动作,各跑 5 次取中位:

| 动作 | 修前 | 修后 |
|---|---|---|
| `listItems` 第 1 页 | 33.5 ms | 27.6 ms |
| `countItems` | 14.3 ms | 7.7 ms |
| **`countPending`** | **10,808 ms** | **16.0 ms** |
| `countExhausted` | 679 ms | 13.3 ms |
| `episodeStats` | 0.0 ms | 0.0 ms |
| **合计** | **11,535 ms** | **64.6 ms** |

**用户自己的库(3,904 条目)是 438ms**,每翻一页白等半秒 —— 还没到"假死"但已经能感觉到。

### 根因(已证实,不是推测)

`libraryClause()` 里的 correlated `exists`:

```sql
exists (select 1 from media_files m where m.number = items.number and m.library_id = ?)
```

`explain query plan` 显示优化器挑了只有 `library_id` 的索引:

```
SEARCH m EXISTS USING INDEX media_files_library (library_id=?)
```

于是 `items` 的**每一行**都要把这个库的**全部** `media_files` 扫一遍找 `number` —— O(n²)。
条目数翻倍,耗时翻四倍:2,000→102ms / 4,000→438ms / 10,000→2,613ms / 20,000→10,643ms。

### 当时的几个猜测, 量完都是错的

- ❌ **`json_each` 逐行解析 JSON 占大头** —— 实测 4.6ms。整个 `pendingWhere()` 单独跑是 5.3ms。
- ❌ **`items` 表缺索引** —— 补 `content_type` / `scrape_attempts` 后从 5.3ms 变 5.5ms,没有区别。
- ❌ **`countItems` 也慢** —— 14ms。因为它走的是 `in (子查询)` 写法(在 `itemFilters()` 里),
  同一个意思两种写法,一个 14ms 一个 10 秒。
- ❌ **`episodeStats` 是负担** —— 0.0ms。

**教训**:这份文档原先写的「哪一项占大头还没验证」是对的,先量再改。凭代码读出来的直觉在这里全错。

### 修法(schema v17)

```sql
create index media_files_library_number on media_files(library_id, number);
drop index media_files_library;   -- 复合索引的前缀, 冗余
```

```
SEARCH m EXISTS USING COVERING INDEX media_files_library_number (library_id=? AND number=?)
```

**10,685ms → 8.8ms(1200 倍)**。同时把 `libraryClause()` 从 `exists` 改成 `in` 子查询
(和 `itemFilters()` 同一个形状),这样即便索引没生效也不会退化成二次。

### 验收

- ✅ 上万条目、海报墙视图:一次 `item:list` 64.6ms(原口径要求 < 200ms)
- ✅ `packages/core/tests/query-plan.test.ts` 校验查询计划:出现全表扫就红
- ⬜ **深翻页仍是 47.5ms**(offset 近 2 万)—— `limit/offset` 的固有成本,量不大,
  真要治得改 keyset 分页,见下方"还没做的"
- ⬜ 渲染端 `goPage()` 仍无在途保护(连点"下一页"会排请求),见下方

### 还没做的 (量过, 但优先级低于上面这条)

1. **渲染端在途保护**:`goPage()`(`apps/desktop/src/App.vue`)直接改 `page` 再 `await refreshItems()`,
   连点会排一串请求。`refreshSeq` 只保证过期结果不覆盖新数据,**不会取消**已经在算的活。
   现在单次 64ms 不太能感觉到,但深翻页或大库仍会堆。**这条最便宜,值得做。**
2. **计数缓存**:按 `(libraryId, 筛选)` 缓存,写操作后失效。项目里已有先例 ——
   待办贵数字存库(`perf(todo): 贵数字存库, 点进库不再干等 20 秒`,schema v16 的 `todo_cache`)。
   现在 24ms 没必要了。
3. **keyset 分页**(`where updated_at < ?` 替代 `offset`):解决深翻页。改动面大,等真有需求。
4. **给 `items` 补索引**(`content_type` / `scrape_attempts` / `domain`):实测无收益,不做。

## 2. 点「待办」再点「条目」会「未响应」 — ✅ 已修

**来源**:用户报(2026-11-27)。原话「只要从待办, 进入条目, 就会未响应」。

### 一开始找不到

开发机上复现不出来:切 tab、翻页、切库,每个操作 1~12ms,主线程长任务 0 个。
差别在**媒体盘** —— 同步 `stat`/`readdir` 落在一块离线或慢速网络盘上,一次就是
一次系统超时,而主进程是单线程,整个 IPC 队列陪着一起等。

**所以先加度量, 再改代码**:`registerIpc` 里所有 handler 统一过一个计时包装,超过
150ms 写 `logs/slow-ipc.log`。用户复现一次, 日志第一次就指认了:

```
22505ms  todo:plans
```

### 根因

切到「待办」时, `todo_cache` 一过期就 `todoPlans(force)`, 而它要整库干跑
(`organize`) —— 每个库根先过一次同步 `statSync`(`assertLibraryMounted`)。
三块离线盘 × 每个约 7 秒系统超时 = 22505ms,全程锁死主进程。

上一轮给 `item:list` 加的可达性判断只护住了"拼封面 URL"这条路径,`todo:plans` 没护到。

### 修法

`isLibraryReachable(root, 800ms)`:异步 `stat` + `race` 封顶。`todoPlans` 先把库分两批,
读不到的直接不参与(整理计划与 nfo 比对都一样)。

**没有**把 `assertLibraryMounted` 改成异步 —— 两道门各司其职:探测走异步(要的是别卡),
真动手前仍走同步断言(那时卡住是对的,宁可拒绝也不能在半离线的盘上搬文件)。

顺带:`reachableLibraryIds` 加 in-flight 去重,`library:list` 复用它 —— 以前启动时
`libraries` / `items` / `todo` 各探一轮盘,三处各自白等 1 秒。

### 验收

- ✅ `todo:plans` 全部库(三块离线盘):22505ms → **813ms**
- ✅ 启动日志:三条 1000ms → 一条 804ms
- ✅ 用户复现:未再出现
- ⬜ 盘**在线但响应 > 800ms** 时会被判"不可达":那一轮少显示几张封面、整理计划显示 0。

### 学到什么

1. **复现不了就先加度量**。这次如果继续按"猜哪条路径"改,大概率改错地方 ——
   前一轮已经修了 `item:list`、`libraries()`,都不是它。
2. **主进程被同步阻塞时, 同期别的 handler 也会一起变慢**。看到日志里一片 channel
   同时几百毫秒,说明卡的不是它们,而是中间夹着的那次同步 IO。
3. 加包装时 `replace("ipcMain.handle(", "handle(")` 会把包装自己内部那行也换掉,
   变成自我递归、启动即爆栈。改完要**真的跑一次**,typecheck 不会报这个。
