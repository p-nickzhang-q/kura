# 影视域实施计划

> 决策与理由见 [ADR 0008](../ADR/0008-扩域-影视库.md)。本文只写**怎么做**。
> 词汇见 [CONTEXT.md](../../CONTEXT.md)(域 / 身份键 / 剧 / 季 / 集 / 缺集)。

## 一、数据模型

三处改动,`av` 域行为不变。

```sql
-- 库:域建库时落定,不可改
alter table libraries add column domain text not null default 'av';   -- av | movie | tv

-- 条目:冗余一列,权威是库
alter table items add column domain text not null default 'av';

-- 集:只有 tv 域有行
create table episodes (
  number     text not null references items(number) on delete cascade,
  season     integer not null default 1,
  episode    integer not null,
  title      text,
  plot       text,
  air_date   text,
  duration_min integer,
  field_sources text,
  primary key (number, season, episode)
);

-- 集 → 文件:一个视频文件属于一集;av 域为 null
alter table media_files add column season integer;
alter table media_files add column episode integer;

-- 演员按域标记
alter table actors add column domain text not null default 'av';
```

约定:

- **季不建表**。季只在 `episodes.season` 里当整数;要季海报时再加表,`episodes` 不用改。
- `items.number` 存影视键 `tmdb:tv:1399` / `tmdb:movie:603`。`isSiteKey()` 已能识别这种形态。
- `items.content_type` 对影视条目**置空**(它是 `av` 域的概念)。列表筛选、整理模板都要容忍空值。
- 迁移对老库是纯加法:所有现有行 `domain = 'av'`,行为逐字不变。

## 二、扫描按域分流

```
scan(library)
  ├─ library.domain === 'av'   → 现有路径(extractNumber / 辅助媒体 / nfo 计数),一行不改
  └─ library.domain === 'movie' | 'tv'
       → walk 收文件(同样跳过辅助媒体: extras/behind the scenes/sample/trailer…)
       → 按"剧目录"分组:tv 时一个目录 = 一部剧的候选
       → 解析集号;解析出的集登记为 media_file(season, episode)
       → 解析不出的进未识别(计数 counts.unparsed)
```

**"剧目录"的判定**(v1):从文件往上走,遇到 `Season xx` / `S01` / `第1季` 这种目录就再上一层当剧目录;没有季目录时,直接父目录就是剧目录。
`movie` 域不分组,一个文件一个候选条目。

**识别不出的文件不进 `items`**,只进未识别清单 —— 与 `av` 域的现有行为一致(未识别 = `media_files.number is null`)。

## 三、集号解析(v1 只认这些写法)

| 写法 | 例子 |
|---|---|
| `SxxEyy` | `Show.S01E02.mkv`、`show s1e2.mkv`、`Show.S01.E02.mkv` |
| `第N集` / `第N话` / `第N回` | `某剧 第02集.mp4`、`动画 第12话.mkv` |
| `EPnn` / `Enn` | `Show.EP05.mp4`、`Show E05.mp4` |
| 纯数字结尾 | `Show - 07.mkv`、`Show 07.mp4` |

季来自目录(`Season 01`/`S01`/`第1季`/`第一季`);解析不出季一律 `season = 1`。

**不认**:日期型(`20240115`)的综艺期号、罗马数字、`Part 2`、合集驱动盘的"第 N 张"。这些进未识别页人工指定,是第二批的事。

## 四、来源:TMDB

新增 `source`:`src/sources/tmdb.ts`,id `tmdb`。key 走 `config.json` 的 `tmdbApiKey`,可用环境变量 `KURA_TMDB_API_KEY` 覆盖;`kura source test tmdb` 校验。

| 域 | 请求 | 落库 |
|---|---|---|
| `tv` | `GET /tv/{id}?language=zh-CN&append_to_response=credits,external_ids` | `title`(name)、`title_original`(original_name)、`plot`(overview)、`release_date`(first_air_date)、`studio`(networks[0].name)、`tags`(genres[].name)、`duration_min`(episode_run_time[0])、`actors`(credits.cast,剧级) |
| `tv` | `GET /tv/{id}/season/{n}?language=zh-CN` | `episodes` 表:episode_number → `episode`、name → `title`、overview → `plot`、air_date、runtime |
| `movie` | `GET /movie/{id}?language=zh-CN&append_to_response=credits` | 同上,`duration_min`(runtime)、`studio`(production_companies[0].name) |
| 绑定 | `GET /search/tv?query=…&language=zh-CN` / `/search/movie` | 只服务「未识别 → 手动绑定」,不参与自动匹配 |

`field_sources` 记 `tmdb`。`zh-CN` 缺字段时回落 `?language=en-US` 再取一次,**不机翻**。

## 五、缺集

```
声明集数 = sum(TMDB 各季 episode_number 的数量)
盘上集数 = count(episodes 有绑定文件的)
```

`声明 > 盘上` 即缺集。只是**角标**(`9/12`)与详情页提示,**不是错误**,不阻塞刮削,不影响 NFO 导出。

## 六、NFO 导出(单向)

| 文件 | 内容 |
|---|---|
| `<剧目录>/tvshow.nfo` | `<title>` `<originaltitle>` `<plot>` `<premiered>` `<studio>` `<genre>` `<actor>`(剧级) `<uniqueid type="tmdb">` |
| `<视频文件名>.nfo` | `<title>`(集名) `<season>` `<episode>` `<plot>` `<aired>` `<runtime>` |

- 走现有 `updateNfoContent` 的**字段级改写**思路:已存在的 nfo 保留别的工具写的元素,只覆盖我们管的字段。
- 原子写(`.kura-tmp` → `rename`),沿用 `writeFileAtomic`。
- `nfo sync` 在影视库只有写方向;`--apply` 才落盘,默认干跑出清单。

## 七、CLI 表面

```
library add <名字> <根目录> --domain av|movie|tv     # 默认 av
library list                                         # 每行带 domain
item list --domain tv                                # 跨库查询;不带则按库
item episodes <剧的影视键>                            # 列集的绑定情况
file bind <目录> --tmdb tv:1399                      # 目录级绑定(未识别 → 剧)
file set-episode <路径> --season 2 --episode 5       # 单个文件补集号
source test tmdb
```

`scan` / `scrape` / `organize` **不加** `--domain`:按库执行,库自带域。`cli-contract.md` 同步更新。

## 八、Ticket 拆分(按阻塞边排序)

| # | ticket | 阻塞于 | 验收 |
|---|---|---|---|
| T1 | schema 迁移:`libraries.domain` / `items.domain` / `episodes` / `media_files.season,episode` / `actors.domain` | — | 老库升级后 3885 条全为 `av`,`av` 域全部测试不变 |
| T2 | 扫描按域分流 + 剧目录分组 + 集号解析(纯函数) | T1 | 假数据:1 个剧目录 12 个文件 → 1 个候选剧 + 12 个集,解析表覆盖第三节全部写法 |
| T3 | `library add --domain`;建库不可改域;同目录跨域拒绝 | T1 | 同一根目录加第二个域的库直接报错 |
| T4 | TMDB 来源(key 配置、`source test tmdb`、tv/movie/season 三个请求 + zh-CN 回落) | T1 | 录制 fixture 解析出剧字段与整季集列表 |
| T5 | 未识别 → 目录级绑定(搜索 + 一次绑整目录;剩余文件留未识别可补集号) | T2,T4 | 绑定后该目录文件全部有 `number` 与 `(season,episode)` |
| T6 | 刮削剧:剧级字段 + 各季集落 `episodes`(剧级任务记账) | T4,T5 | 一次刮削写出剧字段与该季全部集;缺集角标数字正确 |
| T7 | 集级 NFO 导出(`tvshow.nfo` + 每集 nfo,单向、字段级、原子写) | T6 | 干跑出清单;`--apply` 后 Emby 能读;再跑一次 `changed: []` 不抖 mtime |
| T8 | GUI:库类型角标、剧详情页季/集展开、缺集角标、未识别目录视图 | T5,T6 | 截图验收;`av` 域界面零变化 |
| T9 | CLI 表面 + `cli-contract.md` + README | T6 | `kura schema --json` 自描述正确 |

`movie` 域与 `tv` 共用 T1/T3/T4/T6 的代码路径,差异只在「不分组、无集表」,不单开 ticket —— 但每个 ticket 的测试都要带一条 `movie` 用例。

## 九、一排就崩的地方(踩之前先看)

- **`items.number` 一个列装三种身份**:任何 `like 'ABC-%'` 式的番号判断都要先看 `domain`。
- **`content_type` 对影视为空**:整理模板、列表筛选、`retryThis` 之类的地方都要容忍 null。
- **扫描的删除安全阀(30%)**:影视库第一次扫描时"已有一半条目但文件全变"的场景不同,别让只索引库的第一次扫描被安全阀拦掉。
- **`pruneActors`**:演员按域标记后,`av` 库的清理不能把影视演员当孤儿删掉。
- **翻译任务**:影视条目必须在 `pendingTranslationKeys` 里被排除,否则会白跑一遍日文检测。
