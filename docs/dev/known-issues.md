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
