<p align="center"><img src="assets/icon.png" width="112" alt="Kura"></p>

<h1 align="center">Kura</h1>

<p align="center">本地影片库管理器。<b>影视</b>（电影 / 剧集 / 动画 / 综艺）与<b>番号制</b>两种库。<br>
Electron 桌面应用 + 面向 agent 的 CLI，共享一份 TypeScript core 和一个 SQLite 文件。</p>

<p align="center">
  <a href="https://github.com/p-nickzhang-q/kura/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/p-nickzhang-q/kura?color=blue"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green"></a>
</p>

<p align="center"><b>中文</b> · <a href="README.en.md">English</a></p>

---

- **没有服务端、没有常驻进程**：打开软件才运行，关了就退出。
- **CLI 是单文件二进制**，冷启动 ~40ms，零依赖。
- GUI 与 CLI 不通过端口通信，只共享同一个库文件。
- **三个动作互不触发**：`scan`（只读磁盘）→ `scrape`（只读网络）→ `organize`（默认 dry-run）。

领域词汇见 [CONTEXT.md](CONTEXT.md)，产品边界见 [ADR 0002](docs/ADR/0002-产品边界.md)，技术选型见 [ADR 0001](docs/ADR/0001-栈选择.md)。

> **适用范围**：Kura 是**元数据与文件整理工具**，不提供、不托管、不下载任何内容。
> 它只读你本地已有的文件，并为它们抓取公开可查的信息（标题、发行日期、演员等）。
> 请只用于你自己合法持有的内容，并遵守所在地法律与服务条款。
>
> 番号库那几张截图来自 `scripts/make-demo-data.mjs` 生成的假数据；影视库那几张来自真实库，
> 只显示公开影片名与你自己的目录名，不含任何影片内容。

## 它做什么

48 个文件全堆在根目录 → 55 个目录，视频和 NFO 一起搬，认不出的原地不动：

![整理前后对比](docs/images/organize.gif)

## 截图

**待办** —— 打开就知道还剩什么，点一行就做：

![待办](docs/images/todo.png)

**影视库**（条目 / 详情）：身份是 TMDB id，集数会显示 `盘上/声明`：

![影视条目](docs/images/items-video.png)

![影视详情](docs/images/detail-video.png)

**番号库**（条目 / 详情）：字段按来源分别记录，可逐字段锁定：

![番号条目](docs/images/items-av.png)

![番号详情](docs/images/detail-av.png)

**整理预览** —— 默认只出计划，看清楚了才动磁盘：

![整理预览](docs/images/organize.png)

**设置** —— 数据目录、来源凭据、翻译端点、代理、检查更新：

![设置](docs/images/settings.png)

## 下载

最新版：**[Releases](https://github.com/p-nickzhang-q/kura/releases/latest)**

| 产物 | 说明 |
|---|---|
| `Kura-x.y.z-setup.exe` | Windows 安装包（选目录、桌面/开始菜单快捷方式、卸载器） |
| `Kura-x.y.z-portable.exe` | 免安装，双击即用 |
| `kura-x.y.z-win-x64.exe` | 命令行工具，给人和 agent 用 |

> 均**未签名**，Windows 会提示「未知发布者」，点「更多信息 → 仍要运行」。
> 卸载**不会删除** `%APPDATA%\kura`（媒体库索引与配置）。

## CLI 命令

`kura --help` 看概览，`kura schema --json` 拿机器可读的完整清单（**参数解析、`--help`、`schema`
共用同一份声明**，所以它们永远不会不同步）。

**全局参数**：`--json`（机器通道，非 TTY 时自动开启）· `--stream`（JSONL 流式事件）·
`--data-dir <路径>`（覆盖数据目录）· `--yes`

### 媒体库

| 命令 | 说明 |
|---|---|
| `library list` | 列出所有库（名称 / 根目录 / 域 / 文件数 / 是否允许整理） |
| `library add <名称> <根目录> [--domain av\|video] [--no-organize]` | 建库。**域建库时落定，之后不可改** |
| `library rename <库> --to <新名>` | 改名（撞名直接报错，不自动加序号） |
| `library relocate <库> <新根> [--apply]` | 换盘/搬家后只改索引，不搬文件 |
| `library set-template <库> --dimension <维度>` | 按预设维度切模板 |
| `library set-template <库> --template '<模板>'` | 自定义模板，如 `'{actor}/{year}/{number}'` |
| `library set-organize <库> --no-organize` | 设为「只索引」：永不移动 / 改名 / 建目录 |
| `library repair-paths [库] [--apply]` | 修「文件搬走了、索引没跟上」的陈旧路径 |
| `library remove <库>` | 删库。**只删索引，磁盘不动，条目保留** |

维度预设：`number` `actor` `actors` `studio` `label` `series` `content_type` `year`。

### 扫描与刮削

| 命令 | 说明 |
|---|---|
| `scan <库> [--dry-run] [--force]` | 只读磁盘：登记文件、解析番号、建条目占位。`--force` 才允许一次移除 >30% 已登记文件 |
| `scrape <番号> [--source a,b] [--dry-run]` | 只读网络：多源取字段、逐字段择优、落库 + 存快照 |
| `scrape <番号> --type <类型>` | 无番号条目必须显式给类型（`site:id` 形式） |
| `scrape --pending [--limit N] [--retry-failed]` | 批量刮所有还没标题的条目 |
| `scrape --library <影视库>` | 影视库按 TMDB 刮这个库里的剧 / 电影 |

### 整理与 NFO

| 命令 | 说明 |
|---|---|
| `organize <库> [--apply]` | **默认 dry-run**：列出 move / write-nfo / copy-image / skip。`--apply` 才动磁盘 |
| `nfo sync [库\|番号] [--apply] [--include-unscraped] [--limit N]` | **双向**：库里没网络来源 → 读 nfo 补空字段；有 → 写回 nfo（只改 Kura 认识的字段） |
| `nfo write` / `nfo import` | 只写 / 只读 |
| `nfo recover <影视库> [--apply]` | 按盘上 nfo 的 TMDB id 建条目、绑文件（换电脑/换盘用） |
| `cleanup [库] [--apply]` | 删掉只剩海报 / nfo 的空壳目录 |

### 条目

| 命令 | 说明 |
|---|---|
| `item list [--library 库] [--state unscraped\|scraped\|exhausted] [--limit N] [--offset N]` | 分页列条目 |
| `item list [--type] [--actor] [--studio] [--label] [--series] [--director] [--tag] [-q 关键词]` | 各种筛选，可组合 |
| `item list --sort number\|title\|release\|studio\|duration\|updated [--desc]` | 排序，空值永远排最后 |
| `item get <番号>` | 完整元数据 + 每个字段的来源 |
| `item set <番号> --title … --plot … --actors a,b …` | 手动改字段，**默认自动锁定** |
| `item lock <番号> title,plot` / `item unlock …` | 锁住的字段重新刮削不会被覆盖 |
| `item retype <番号> <类型>` | 改内容类型（它决定刮削路由与 `{content_type}` 目录） |
| `item retype --detect [--apply]` | 按当前解析器找出所有判错的条目 |
| `item merge <from> --into <to>` | 同一部片被拆成两个条目时合并（只做电影） |

### 影视库的文件绑定

| 命令 | 说明 |
|---|---|
| `file list [--library 库] [--unparsed] [--limit N]` | 列出索引里的文件 |
| `file reveal <番号>` | 这个番号在磁盘上的路径 |
| `file dirs` | 列出待绑定的目录划分（每个目录几个文件、几个认得出集号） |
| `file bind <目录> --tmdb tmdb:tv:1399 [--season N]` | 整目录绑到 TMDB 身份，顺手刮一次 |
| `file bind <目录> --local [--title 名] [--type movie\|tv]` | **手动加入**：`local:` 身份，标 UGC，不连任何来源 |
| `file unbind <目录>` | 解绑 |
| `file set-season <目录> --season N` | 强制季号（同一部剧拆在多个目录时用） |
| `file set-episode <路径> --episode N` / `file clear-episode <路径>` | 单集号纠错 |

### 其他

| 命令 | 说明 |
|---|---|
| `resource fetch <番号>` | 下载海报（竖版）+ 缩略图（横版）到本地缓存 |
| `translate <番号>` / `translate --pending [--limit N]` | 日 → 中，只翻标题与简介 |
| `translate --repair` | 只用本地缓存恢复「翻过但没记录」的条目（不发请求） |
| `source list` | 各来源状态与缺失的配置 |
| `source test <id> [--probe 番号]` | 一条命令验证凭据与解析 |
| `task list [--limit N]` | 最近的任务 |
| `task show <id>` / `task retry <id>` / `task cancel <id>` / `task delete <id>` | 任务详情、重跑、停止、删除 |
| `config get` | 读配置（**密钥脱敏**） |
| `config set --dmm-api-id … --dmm-affiliate-id …` | DMM 凭据 |
| `config set --llm-base-url … --llm-api-key … --llm-model …` | 任何 OpenAI 兼容端点 |
| `config set --tmdb-api-key …` | TMDB key（影视域唯一来源） |
| `config set --translate / --no-translate` | 刮削后自动翻译 |
| `config set --save-images / --no-save-images` | 图片是否复制一份到视频旁边（默认开） |
| `config set --suggest-aliases / --no-suggest-aliases` | 找建议时是否让模型补别名（默认开） |
| `config set --proxy auto\|http://…\|''` | 代理：`auto` 自动探测端口，空串跟随系统 |
| `config test-llm` | 真发一次模型请求验端点 |
| `config path` | 配置文件在哪 |
| `doctor` | 自检：数据目录、数据库、驱动、schema 版本、库与条目数 |
| `version` | 版本号 |
| `schema` | 机器可读的命令清单 |

### 退出码

`0` 成功 · `2` 用法错 · `3` 可重试 · `4` 需要人 · `5` 不存在 · `10` 内部错误

主信号是**退出码**，不是 stdout 的字符串。stdout 只放数据，日志走 stderr。

## 两个域

库只有两种，**建库时选，之后不可改**——它决定识别方式、来源、整理形状。

| | 影视（`video`） | 番号制（`av`） |
|---|---|---|
| 身份 | **TMDB id** | 文件名里的番号 |
| 来源 | TMDB | DMM / JavBus / JavDB |
| 识别 | 目录 = 一部剧，文件名解析季集号；电影 = 目录里没有任何集号 | 正则 + 类型判据 |
| 整理 | `剧名 (年)/Season 01/剧名 - S01E01.mkv` · `片名 (年)/片名 (年).mkv` | `{维度}/{番号}` |
| 认不出时 | 进「未识别」树，**留给人绑**（不猜） | 进「未识别」页，改文件名重扫 |

影视库里电影与剧集可以混着放——条目类型由 TMDB 身份决定，不需要提前分家。

**影视域不猜。** 文件名的写法千奇百怪，认错了会让整季集名全错，所以识别只认有限的几种写法，
其余一律留给人绑；TMDB 的搜索结果也永远由人挑（[ADR 0008](docs/ADR/0008-扩域-影视库.md)）。

**影视域读 NFO，但只认白名单**——`ParsedTvNfo` 类型上就没有 `playcount` / `watched` / `resume`
这些播放状态字段，实现层面不可能污染（[ADR 0011](docs/ADR/0011-影视读取NFO.md)）。

## 数据源

| 来源 | 状态 | 说明 |
|---|---|---|
| `tmdb` | **可用** | 影视域唯一来源，需免费 API key |
| `dmm` | **可用** | DMM/FANZA 官方 API，需 affiliate 凭据 |
| `javbus` | **可用** | 网页解析（真实页面验证过） |
| `javdb` | **可用** | 网页解析。注意它在 **Cloudflare 挑战**后面：机房 IP 大概率 403，换住宅节点可解；**无码条目需登录** |
| `fixture` | 可用 | 从目录读离线样本，用于开发与测试 |

```bash
kura config set --dmm-api-id … --dmm-affiliate-id …   # https://affiliate.dmm.com/api/
kura config set --tmdb-api-key …
kura source test dmm                                  # 一条命令验证凭据与解析
kura scrape ABC-123                                   # 默认路由: dmm → javbus → javdb
kura scrape ABC-123 --source javbus,javdb             # 双源逐字段择优
```

缺凭据时退出码是 **4（NEEDS_INPUT）**，不会静默返回空条目。

## 海报与翻译

```bash
kura resource fetch ABC-123   # 下载到本地缓存（带防盗链 Referer）
```

下载后**同时复制一份到视频旁边**：`<视频名>-poster.jpg` / `<视频名>-thumb.jpg`，换播放器/换机器都认。
不想要就 `kura config set --no-save-images`。库里有缓存图时，NFO 的 `<thumb>` 写的是相对文件名。

**翻什么**：只有标题（`title`）和简介（`plot`）。演员、片商、系列、标签、导演一律不翻。

**什么才翻**：含假名（平假名/片假名）的日文才翻。纯汉字的中文标题、英文标题原样不动——
少一道无意义的模型调用，也免得「标题被翻译腔改坏」。演员不翻是因为人名音译没有唯一答案。

```bash
kura config set --llm-base-url https://api.deepseek.com/v1 --llm-api-key sk-… --llm-model deepseek-chat
kura config set --translate          # 刮削后自动翻
kura translate --pending             # 补历史条目
```

任何 OpenAI 兼容端点都行（DeepSeek / 通义 / Ollama / LM Studio）。译文缓存独立在
`<数据目录>/translations.db`，删掉即重翻。

## 代理

- **留空**：跟随系统代理——Clash 开系统代理或 TUN 即可，无需配置。
- **`auto`**：启动时 TCP 探测 7890/7891/7897/1080/10808/20171，选第一个有人在听的；都没有才退回系统代理。
- **显式地址**：`http://127.0.0.1:7890`。手写 `127.0.0.1:7890`（不带 scheme）会自动补 `http://`，`socks://` 统一成 `socks5://`。
- 优先级：`KURA_PROXY` > 配置文件 > 系统代理/直连。

设置页有「**测试代理**」，一次报出三个值：配置的是什么、实际在用的是什么、哪些常见端口在监听。

两类错误要分清：`ERR_PROXY_CONNECTION_FAILED` 是「请求被送去代理但端口没人听」（代理软件没开）；
`HTTP 403` 是「请求到了站点、站点拒绝」（地区限制 / Cloudflare 风控 / 要登录），后者退出码 4 并附具体建议。

WSL 里指向宿主机 Clash 要用网关地址，`auto` 会自动探测。

> CLI **不读** Windows 系统代理（那是 Electron 的能力）。不设 `KURA_PROXY` 或 `config.proxy` 时会直连并超时。

## 界面

三个页签：**待办 / 条目 / 任务**。侧栏只有库列表和一个按状态推导的主按钮：

- 有待刮削 → `刮削 «库名» (N)`，否则有待翻译 → `翻译`，否则 → `扫描`
- 其余动作（强制扫描、修复索引路径、清理空目录、修正内容类型、换库根目录…）收在「更多」里，
  也都能用 <kbd>Ctrl K</kbd> 搜到
- 库行可以**拖动排序**，顺序记在库里
- 打开过的页面留在 tab 条上

**待办**是默认页，动作按天然顺序排，每行的数字是「现在还剩多少」，不是历史累计。
其中「可整理」「NFO 待回写」两行要读盘（遍历全库 + 读遍 nfo），算完存在数据库里——
进页面先显示上次的数字并标注「算于 X 分钟前」，后台再算新的。

**条目**的范围跟着左侧选中的库走：列表、计数、扫描、未识别都只算这个库。
「未刮削 N」只筛还能自动重试的那批；试满 3 次的单独算「需手动重试 M」。

**详情**面板按来源分别记录每个字段，鼠标悬停才显示来源与锁按钮。

界面在加载时给骨架屏、长任务给进度条，`prefers-reduced-motion` 下全部退化。

## 任务与日志

批量操作会留下一条任务记录（进度、失败数、中断状态），关掉软件后仍能查到并重试：

```bash
kura task list              # 最近的任务
kura task show 3            # 详情 + 日志文件路径
kura task retry 3           # 重新入队
```

日志在 `<数据目录>/logs/tasks/*.jsonl`（JSONL，已脱敏），GUI 的「任务」页也能看并点重试。

扫描和「修正内容类型」不进任务——前者只读磁盘、有自己的进度，后者是一次批量 SQL，秒级。

## 内容类型判错了怎么修

类型决定**刮削路由**（国产只走 javdb，有码走 dmm→javbus→javdb）和整理目录里的 `{content_type}`。
它按设计「建条目时落定、之后不可改」，但解析器有 bug 时历史数据必须能修：

```bash
kura item retype --detect            # 按当前解析器列出所有判错的条目（不动数据）
kura item retype --detect --apply    # 确认后真的改
kura item retype SSIS-915 censored   # 单条
```

界面里同一个功能有两处：详情面板的「类型」下拉（单条），「更多 → 修正内容类型」（批量，先弹清单确认）。

扫描时也会自动修——但**只动从没刮过网络的条目**（`field_sources` 为空）。已经刮到字段的留给人定，
因为换类型等于换来源线，开着整理时还会按新类型挪目录。

## 开发

前置：[Bun](https://bun.sh) ≥ 1.1、[pnpm](https://pnpm.io) ≥ 9。网络受限时加
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

```bash
# 造一批测试数据（假文件 + 离线样本），不碰真实站点
node scripts/make-demo-data.mjs --count 40 --out ./demo-data
node scripts/make-demo-data.mjs --numbers "SSIS-001,MIDV-001" --out ./demo-real   # 假文件 + 真站点

bun run cli --help               # 零 install 跑 CLI
pnpm install && pnpm dev         # 桌面端
bun test                         # 全部用例离线，不依赖网络
pnpm typecheck
bun run build:cli                # -> dist/kura
bun run build:cli:win            # -> dist/kura.exe
pnpm --filter @kura/desktop package:win         # Windows portable
pnpm --filter @kura/desktop package:installer   # NSIS 安装包（Linux 上需 wine）
```

打包细节（含无 sudo 时的 Windows 侧构建、离线缓存）见 [docs/dev/packaging.md](docs/dev/packaging.md)；
发版流程与产物核对见 [docs/dev/release.md](docs/dev/release.md)。

## 目录

```
packages/core      业务逻辑 + SQLite（唯一有状态的一层）
  domain/          纯函数：identify / aggregate / materialize / dimensions / episodes
  sources/         来源接口、路由、dmm / javbus / javdb / tmdb / fixture
  llm/             翻译客户端与缓存
  tasks/           scan / scrape / organize / nfo / translate / resources / todo
  db/              schema 迁移、行映射、演员索引、卷指纹
packages/cli       面向 agent 的 CLI（契约见 docs/dev/cli-contract.md）
apps/desktop       Electron 主进程 + Vue3 界面
docs/dev           给 agent 的架构与契约
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `KURA_DATA_DIR` | 覆盖数据目录（默认 `%APPDATA%\kura`） |
| `KURA_PROXY` | 覆盖代理配置 |
| `KURA_DEBUG` | 打印异常栈到 stderr |

## 许可证

[MIT](LICENSE)。

影视元数据来自 [TMDB](https://www.themoviedb.org/)（本产品使用 TMDB API，但未获 TMDB 认可或认证）。
番号制来源：DMM / JavBus / JavDB，见 [docs/dev/sources.md](docs/dev/sources.md)。
