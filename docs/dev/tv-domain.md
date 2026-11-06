# 影视域实施计划

> 决策与理由见 [ADR 0008](../ADR/0008-扩域-影视库.md)。本文只写**怎么做**。
> 词汇见 [CONTEXT.md](../../CONTEXT.md)(域 / 身份键 / 剧 / 季 / 集 / 缺集)。

## 一、数据模型

三处改动,`av` 域行为不变。

```sql
-- 库:域建库时落定,不可改 (ADR 0009 之后只有 av | video)
alter table libraries add column domain text not null default 'av';   -- av | video

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
       → 扫描**不建条目**:影视的身份要绑定 TMDB 之后才知道,凭名字猜 id 猜错等于整季集名全错
       → counts.shows 报"候选剧目录"个数(一个目录 = 一部剧的候选)
```

**"剧目录"的判定**(v1):从文件往上走,遇到 `Season xx` / `S01` / `第1季` 这种目录就再上一层当剧目录;没有季目录时,直接父目录就是剧目录。
`movie` 域不分组,一个文件一个候选条目。

**识别不出的文件不进 `items`**,只进未识别清单 —— 与 `av` 域的现有行为一致(未识别 = `media_files.number is null`)。

## 三、集号解析(v1 只认这些写法)

实现在 `packages/core/src/domain/episodes.ts`(纯函数,36 条穷举测试)。

| 写法 | 例子 |
|---|---|
| `SxxEyy` | `Show.S01E02.mkv`、`show s1e2.mkv`、`Show.S01.E02.mkv`、`Show_S01_E02.mp4` |
| `第N集 / 话 / 回 / 期` | `某剧 第02集.mp4`、`动画 第12话.mkv`、`综艺 第8期.mp4`、`某剧 第十二集.mp4` |
| `EPnn` / `Enn` | `Show.EP05.mp4`、`Show E05.mp4` |
| 纯数字结尾 | `Show - 07.mkv`、`Show 07.mp4`、`Show_07.mp4` |

- **中文数字认**:`第十二集`、`第一季`(到九百九十九)。
- **季的优先级**:文件名里显式写的 > 季目录(`Season 01`/`S01`/`第1季`/`第一季`)> 1。
- **方括号里的发布组标记先剥掉**:`[Lilith-Raws] Show - 07 [Baha][1080p].mp4` 认成第 7 集。
- **不认**:日期型(`20240115`)、罗马数字、`Part 2` / `Disc 1` / `CD1`、分辨率(`1080p`)、年份(`(2019)`)。
  这些进未识别页人工指定,是第二批的事。
- 剧目录不会走出库根:库根本身叫 `Season 1` 时回落到库根。

## 三之二、每个域的默认整理模板

`{content_type}/{studio}/{number}` 对影视毫无意义(影视没有 `content_type`),照抄会生成一堆叫
`censored` 的目录。所以建库时按域给默认值:

| 域 | 默认模板 |
|---|---|
| `av` | `{content_type}/{studio}/{number}` |
| `tv` | `{series}/Season {season}` |
| `movie` | `{series}` |

(v1 不出手 organize,模板先存着,给 v2 用。)

## 四、来源:TMDB(已实现)

`src/sources/tmdb.ts`,id `tmdb`。key 走 `config.json` 的 `tmdbApiKey`(0600),可用环境变量
`KURA_TMDB_API_KEY` 覆盖;`kura source test tmdb [--probe <tmdb 剧集 id>]` 做真请求自检。

实现要点:

- **不进 registry**:它按 TMDB id 取,不按番号,也没有内容类型路由;`source list` 里单列一行。
- **语言回落是逐字段的**:`zh-CN` 拿到后用 `en-US` 只补空字段(`name`/`overview`,电影是 `title`/`overview`),
  绝不整份覆盖 —— 中文条目常常有剧名没简介,整份回落会把中文标题冲成英文。
- **季不走英文回落**:我们只用集级的 name/overview,逐集回落等于把请求数翻倍;缺中文就留空。
- **key 脱敏**:`api_key` 在 query 里,而 HttpClient 会把 url 放进 `AppError.details` ——
  所有错误出口都过 `redactKey`,把 `api_key=***`。不脱敏等于 key 直接进了 stdout 与 issue。
- 401 → `NEEDS_INPUT`(key 不对,重试没用);404 → `NOT_FOUND`;5xx 交给 HttpClient 重试。
- `originalTitle` 不塞进 `RawFields`:原文名与译文是一对,不该被别的来源逐字段顶掉,
  由刮削层直接落 `items.title_original`。

| 域 | 请求 | 落库 |
|---|---|---|
| `tv` | `GET /tv/{id}?language=zh-CN&append_to_response=credits,external_ids` | `title`(name)、`title_original`(original_name)、`plot`(overview)、`release_date`(first_air_date)、`studio`(networks[0].name)、`tags`(genres[].name)、`duration_min`(episode_run_time[0])、`actors`(credits.cast,剧级) |
| `tv` | `GET /tv/{id}/season/{n}?language=zh-CN` | `episodes` 表:episode_number → `episode`、name → `title`、overview → `plot`、air_date、runtime |
| `movie` | `GET /movie/{id}?language=zh-CN&append_to_response=credits` | 同上,`duration_min`(runtime)、`studio`(production_companies[0].name) |
| 绑定 | `GET /search/tv?query=…&language=zh-CN` / `/search/movie` | 只服务「未识别 → 手动绑定」,不参与自动匹配 |

`field_sources` 记 `tmdb`。`zh-CN` 缺字段时回落 `?language=en-US` 再取一次,**不机翻**。

## 四之二、绑定(task/bind.ts)

扫描只准备候选,`bindDirectory` 才让候选变成条目。粒度为**目录**(一个目录 = 一部剧)。

```
kura file dirs [--library 库]                       # 待绑定目录清单: 文件数 / 已解析集数 / 有哪些季
kura file bind <目录> --tmdb tmdb:tv:1399 [--dry-run]
kura file unbind <目录> [--library 库]
kura file set-episode <路径> --episode 5 [--season 1]   # 绑了目录但文件名没集号的文件
```

规矩:

- **只动 `number is null` 的文件**。已经绑过的不碰 —— 静默改绑会让"我以为只绑了这一部"变成灾难;要改先 `unbind`。
- **域与身份种类必须一致**:tv 库绑 `tmdb:movie:...` 直接报 USAGE。
- 认不出集号的文件绑了目录后**仍然有身份**(`number` 落上),但没有 `episodes` 行 —— 它们出现在 `BindResult.stillUnparsed`,等人 `set-episode`。
- 记条目占位行时 `content_type` 存**空串**:它是 av 域的概念,而列是 `not null`(改成可空要重建表,不值得)。
- `unbind` 把文件退回未识别;条目没有文件指向时一并删除(否则列表里会出现"0 个文件的剧")。

## 四之三、声明集 vs 盘上集(两者不许混)

`episodes` 表只装**来源声明的集**(刮削写入, 带 `field_sources`)。
盘上有哪些集看 `media_files.season/episode`。

混着写过一次, 后果是"成长的烦恼 165 个文件 → 声明 310 集"(真声明 166 + 165 个文件行)。
迁移 v13 清掉了那批没有 `field_sources` 的行; 绑定与改季现在都不再写 `episodes`。

**合并集与特别篇**:
- `[BLEACH][52-53].rmvb` 这种"两集合一"按**起始集号**登记(52), 缺集名单会照实说 53 缺
  —— 它确实在同一个文件里。跨多集(`[01-12]`)是整季合集包, 不认, 交给人。
- `13.5` 这种小数是特别篇, **不当成第 13 集** —— 认错会跟真正的第 13 集抢同一个目标位置。

**扫描不覆盖已有的 (季, 集)**(那是绑定/改季/摊到各季定的), 所以解析规则改准之后,
老库里已经写死的错误季集不会自己消失。`kura file clear-episode <路径>` 是显式的"重来一次"。

**合集包的绝对集号**: 国内资源站常给 `001集 … 165集` 这种跨季连续编号, 文件名里没有季号,
于是全部落在第 1 季、与声明的第 1 季对不上。这类条目用「摊到各季」
(`spreadAbsoluteEpisodes`): 按播出顺序把第 i 个文件映射到声明的第 i 集 —— 只认 aired order。

详情页会提示"盘上有 N 集不在来源的集列表里", 并把那些集的标签标成「集号对不上」。

## 四之四、图片与 NFO 的形状(媒体服务器兼容)

**图片地址是拼出来的**: TMDB 只给 `poster_path`(`/abc.jpg`), 完整地址是
`https://image.tmdb.org/t/p/<size><path>`(`imageUrls()`)。这个 CDN 不占 API 额度也不需要 key。
漏了这一步的后果是"下载图片"直接报「该条目没有图片 URL」。

**图片落位按媒体服务器的习惯**:
- 剧: 剧目录 `poster.jpg` + `fanart.jpg`(不逐集复制 —— 165 集的剧会变成 165 份同一张图, 而且 Emby 一张都不认)
- 电影: 视频旁边 `<视频名>-poster.jpg` / `-thumb.jpg`

**NFO 根元素按类型分**: 剧 `tvshow.nfo`(`<tvshow>`), 集 `<视频名>.nfo`(`<episodedetails>`),
电影 `<视频名>.nfo`(`<movie>`)。电影**不能**写 `tvshow.nfo` —— Emby 见到会把整个文件夹当电视剧。

**身份写两遍**: `<tmdbid>` (Kodi 老版本) + `<uniqueid type="tmdb" default="true">`
(Emby / Jellyfin 只认带 `default="true"` 的那个当主 id)。少写一个, 对方的刮削器会按文件名自己重搜。

## 四之五、整理(organize)的目录形状

影视库的整理**不走模板** —— 剧与电影的形状差两层, 而模板是库级的一个字符串。

```
<库根>/剧名 (1985)/
         tvshow.nfo
         poster.jpg  fanart.jpg
         Season 01/
           剧名 - S01E01.mkv
           剧名 - S01E01.nfo
<库根>/片名 (1994)/
         片名 (1994).mkv
         片名 (1994).nfo
         片名 (1994)-poster.jpg  fanart.jpg
```

- 文件名用 `SxxEyy`: 媒体服务器靠它认集号, 靠 `Season NN` 目录分季。
  原来的 `第3集` 也能认, 但没有季信息, 七季的剧会全落第 1 季。
- 同一部剧的多个源目录会**合并**到一个剧目录(仁医 + 仁医2 → `仁医 (2009)/Season 01|02/`)。
- 认不出集号的文件不搬(留在原地), 并在计划里给出提醒 —— 猜一个集号搬过去, 比不搬更糟。
- 两个文件抢同一集(修复版/多版本)只搬第一个, 其余明确跳过。
- 搬完立刻改 `media_files.path`, 否则下次扫描会判成"旧路径消失 + 新路径出现"。
- 源目录里的旧 nfo / 图片不跟着搬, 会留在原地(可能变成孤儿文件)。整理不清空、不删除任何目录。

## 五、缺集

```
声明集数 = sum(TMDB 各季 episode_number 的数量)
盘上集数 = count(episodes 有绑定文件的)
```

`声明 > 盘上` 即缺集。只是**角标**(`9/12`)与详情页提示,**不是错误**,不阻塞刮削,不影响 NFO 导出。

## 六、NFO 导出(单向) —— 已实现

实现在 `domain/nfo-tv.ts`(标签词表与渲染/合并) + `tasks/nfo-tv.ts`(落盘与报告)。

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
| T5 ✅ | 未识别 → 目录级绑定(搜索 + 一次绑整目录;剩余文件留未识别可补集号) | T2,T4 | 绑定后该目录文件全部有 `number` 与 `(season,episode)` |
| T6 | 刮削剧:剧级字段 + 各季集落 `episodes`(剧级任务记账) | T4,T5 | 一次刮削写出剧字段与该季全部集;缺集角标数字正确 |
| T7 ✅ | 集级 NFO 导出(`tvshow.nfo` + 每集 nfo,单向、字段级、原子写) | T6 | 干跑出清单;`--apply` 后 Emby 能读;再跑一次 `changed: []` 不抖 mtime |
| T8 ✅ | GUI:库类型角标、剧详情页季/集展开、缺集角标、未识别目录视图 | T5,T6 | 截图验收;`av` 域界面零变化 |
| T9 | CLI 表面 + `cli-contract.md` + README | T6 | `kura schema --json` 自描述正确 |

`movie` 域与 `tv` 共用 T1/T3/T4/T6 的代码路径,差异只在「不分组、无集表」,不单开 ticket —— 但每个 ticket 的测试都要带一条 `movie` 用例。

## 八之二、界面(已实现)

- **建库选域**: 侧栏「+」弹出三个选项(番号制 / 剧集 / 电影) → 再选目录。域决定识别方式、来源与模板, 建库后不可改。
- **库类型角标**: 影视库在侧栏显示「剧集」/「电影」, 一眼能分清哪个库走哪套规则。
- **未识别页**: 影视库换成**目录视图**(目录名 / 文件数 / 已解析集号数 / 有哪些季), 每行一个「绑定到 TMDB」。
- **绑定面板**: 预填目录名去 TMDB 搜, 列表里人挑一部 → 绑整个目录**并顺手刮一次**(不用再点一次刮削)。
  选错会让整季集名全错, 所以永远不自动挑。
- **列表角标**: 影视条目在标题后显示 `盘上/声明`(如 `15/87`), 缺集标黄。
- **详情页**: 影视条目宽度加到 400px, 集按季分组; 缺集的行显示「盘上没有」。顶部有「重新刮削」。
- 影视条目的**「类型」下拉不显示**: 内容类型是 av 概念, 对它们改了也没用。

## 九、一排就崩的地方(踩之前先看)

- **`items.number` 一个列装三种身份**:任何 `like 'ABC-%'` 式的番号判断都要先看 `domain`。
- **`content_type` 对影视为空**:整理模板、列表筛选、`retryThis` 之类的地方都要容忍 null。
- **扫描的删除安全阀(30%)**:影视库第一次扫描时"已有一半条目但文件全变"的场景不同,别让只索引库的第一次扫描被安全阀拦掉。
- **`pruneActors`**:演员按域标记后,`av` 库的清理不能把影视演员当孤儿删掉。
- **翻译任务**:影视条目必须在 `pendingTranslationKeys` 里被排除,否则会白跑一遍日文检测。
