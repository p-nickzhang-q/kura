# Kura

番号制本地影片库管理器。**Electron 桌面应用 + 面向 agent 的 CLI**,共享一份 TypeScript core 和一个 SQLite 文件。

- 没有服务端、没有常驻进程:打开软件才运行,关了就退出。
- CLI 是单文件二进制,冷启动 ~40ms,零依赖。
- GUI 与 CLI 不通过端口通信,只共享同一个库文件。

领域词汇见 [CONTEXT.md](CONTEXT.md),产品边界见 [ADR 0002](docs/ADR/0002-产品边界.md),技术选型见 [ADR 0001](docs/ADR/0001-栈选择.md)。

## 下载

| 产物 | 说明 |
|---|---|
| `Kura-x.y.z-setup.exe` | Windows 安装包(选目录、桌面/开始菜单快捷方式、卸载器) |
| `Kura-x.y.z-portable.exe` | 免安装,双击即用 |
| `kura-x.y.z-win-x64.exe` | 命令行工具,给人和 agent 用 |

> 均**未签名**,Windows 会提示"未知发布者",点「更多信息 → 仍要运行」。
> 卸载**不会删除** `%APPDATA%\kura`(媒体库索引与配置)。

## 三个动作

| 动作 | 命令 | 碰什么 |
|---|---|---|
| REFRESH 扫描 | `kura scan <库>` | 只读磁盘:登记文件、解析番号、建条目占位 |
| SCRAPE 刮削 | `kura scrape <番号>` | 只读网络:各源取字段、逐字段择优、落库 + 存快照 |
| ORGANIZE 整理 | `kura organize <库>` | 默认只出计划;`--apply` 才移动文件并写 NFO |

三个动作**互不触发**。没有"扫完自动刮""刮完自动整理"。

## 快速上手

```bash
kura library add 主库 ~/Videos
kura scan 主库
kura scrape ABC-123 --json
kura scrape --pending            # 批量: 逐条进度打到 stderr, Ctrl-C 可中断
kura organize 主库              # 只看计划
kura organize 主库 --apply      # 真的移动

kura file list --unparsed       # 扫到了但认不出番号的文件(不会进刮削)
```

## 整理维度

一个库选**一个**维度,决定第一层目录;模板负责其余层级。

| 预设 | 模板 |
|---|---|
| 按番号 / 按演员 / 按演员(全部) | `{number}` / `{actor}/{number}` / `{actors}/{number}` |
| 按片商 / 按厂牌 / 按系列 / 按类型 / 按年份 | `{studio}/{number}` … |

```bash
kura library set-template 主库 --dimension actor     # 按演员
kura library set-template 主库 --template '{actor}/{year}/{number}'
```

多值与路径的规则: `{actor}` 取第一演员,`{actors}` 全拼(`演员甲、演员乙`);`{title}` 用原文保证路径稳定,`{title_zh}` 才用译文。
目标已存在同名文件时**绝不覆盖**,计划里标 `skip`。

**旧成品库只索引(不整理)**: 允许扫描、搜索、刮削,但永不移动/改名/写 NFO。

```bash
kura library add 旧片库 /path/to/library --no-organize
kura library set-organize 旧片库 --no-organize
```

## 数据源

| 来源 | 状态 | 说明 |
|---|---|---|
| `dmm` | **可用** | DMM/FANZA 官方 API,需 affiliate 凭据 |
| `javbus` | **可用** | 网页解析(真实页面验证过) |
| `javdb` | **可用** | 网页解析;**无码条目需登录**,未登录报 NEEDS_INPUT |
| `fixture` | 可用 | 从目录读离线样本,用于开发与测试 |

```bash
kura config set --dmm-api-id ... --dmm-affiliate-id ...   # https://affiliate.dmm.com/api/
kura source test dmm                  # 一条命令验证凭据与解析
kura source test javbus
kura scrape ABC-123                   # 默认路由: dmm → javbus → javdb
kura scrape ABC-123 --source javbus,javdb   # 双源逐字段择优
```

缺凭据时退出码是 **4(NEEDS_INPUT)**,不会静默返回空条目。

## 海报

```bash
kura resource fetch ABC-123   # 下载到本地缓存(带防盗链 Referer)
```

整理时若有缓存海报,会复制为 `<视频名>-poster.jpg`,并在 NFO 写相对 `<thumb>`。

## 翻译(日 → 中)

只翻含假名的日文标题与简介;演员名不翻。译文覆盖显示值,原文另存,NFO 的 `originaltitle` 与目录名仍用日文。

```bash
kura config set --llm-base-url https://api.deepseek.com/v1 --llm-api-key sk-... --llm-model deepseek-chat
kura config set --translate          # 刮削后自动翻
kura translate --pending             # 补历史条目
```

任何 OpenAI 兼容端点都行(DeepSeek / 通义 / Ollama / LM Studio)。译文缓存独立在 `<数据目录>/translations.db`,删掉即重翻。

## 任务与日志

批量操作会留下一条任务记录（进度、失败数、中断状态），关掉软件后仍能查到并重试：

```bash
kura task list              # 最近的任务
kura task show 3            # 详情 + 日志文件路径
kura task retry 3           # 重新入队（用 scrape --pending 继续）
```

日志在 `<数据目录>/logs/tasks/*.jsonl`（JSONL，已脱敏），GUI 的「任务」页也能看并点重试。

## 手动改字段与锁定

```bash
kura item set ABC-123 --title "我改的标题" --plot "我改的简介"   # 默认自动锁定
kura item lock ABC-123 title,plot
kura item unlock ABC-123 title
```

锁定的字段重新刮削不会被覆盖。

## 代理

- **GUI**: 跟随系统代理 —— Clash 开系统代理或 TUN 即可,无需配置。
- **CLI**: `kura config set --proxy auto`(推荐,运行时探测 7890/7897/1080…)或显式 URL。
- 优先级: `KURA_PROXY` > 配置文件 > 系统代理/直连。

WSL 里指向宿主机 Clash 要用网关地址,`auto` 会自动探测。

## 开发

前置: [Bun](https://bun.sh) ≥ 1.1、[pnpm](https://pnpm.io) ≥ 9。网络受限时加
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

```bash
# 造一批测试数据(假文件 + 离线样本), 不碰真实站点
node scripts/make-demo-data.mjs --count 40 --out ./demo-data
node scripts/make-demo-data.mjs --numbers "SSIS-001,MIDV-001" --out ./demo-real   # 假文件 + 真站点

bun run cli --help               # 零 install 跑 CLI
pnpm install && pnpm dev         # 桌面端
bun test                         # 111 个用例, 全部离线
bun run build:cli                # -> dist/kura
bun run build:cli:win            # -> dist/kura.exe
pnpm --filter @kura/desktop package:installer   # NSIS 安装包 (Linux 上需 wine)
pnpm --filter @kura/desktop package:win         # portable (无需 wine)
```

打包细节(含无 sudo 时的 Windows 侧构建、离线缓存)见 [docs/dev/packaging.md](docs/dev/packaging.md);
发版流程与产物核对见 [docs/dev/release.md](docs/dev/release.md)。

## 目录

```
packages/core      业务逻辑 + SQLite (唯一有状态的一层)
  domain/          纯函数: identify / aggregate / materialize / dimensions
  sources/         来源接口、路由、javbus / javdb / dmm API、fixture
  llm/             翻译客户端与缓存
  tasks/           scan / scrape / organize / translate / resources
packages/cli       面向 agent 的 CLI (契约见 docs/dev/cli-contract.md)
apps/desktop       Electron 主进程 + Vue3 界面
docs/dev           给 agent 的架构与契约
```

## 退出码

`0` 成功 · `2` 用法错 · `3` 可重试 · `4` 需要人 · `5` 不存在 · `10` 内部错误

`kura schema --json` 输出机器可读的命令清单,与参数解析共用同一份声明。
