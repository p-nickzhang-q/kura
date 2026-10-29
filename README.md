# Kura

番号制本地影片库管理器。**Electron 桌面应用 + 面向 agent 的 CLI**,共享一份 TypeScript core 和一个 SQLite 文件。

- 没有服务端,没有常驻进程:打开软件才运行,关了就退出。
- CLI 是单文件二进制,冷启动 20–30ms,零依赖。
- GUI 与 CLI 不通过端口通信,只共享同一个库文件。

领域词汇见 [CONTEXT.md](CONTEXT.md),产品边界见 [ADR 0002](docs/ADR/0002-产品边界.md),技术选型见 [ADR 0001](docs/ADR/0001-栈选择.md)。

## 三个动作

| 动作 | 命令 | 碰什么 |
|---|---|---|
| REFRESH 扫描 | `kura scan <库>` | 只读磁盘:登记文件、解析番号、建条目占位 |
| SCRAPE 刮削 | `kura scrape <番号>` | 只读网络:各源取字段、逐字段择优、落库 + 存快照 |
| ORGANIZE 整理 | `kura organize <库>` | 默认只出计划;`--apply` 才移动文件并写 NFO |

三个动作**互不触发**。没有"扫完自动刮""刮完自动整理"。

## 快速开始

前置:[Bun](https://bun.sh) ≥ 1.1(CLI / 主进程构建)、[pnpm](https://pnpm.io) ≥ 9(桌面端依赖)。

网络受限时 `pnpm install` 会卡在 Electron 二进制下载, 加镜像:
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm install`(打包时再加
`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`)。

```bash
# CLI
kura library add 主库 ~/Videos
kura scan 主库
kura scrape ABC-123 --json
kura organize 主库              # 只看计划
kura organize 主库 --apply      # 真的移动

# 手改字段并锁定(重新刮削不覆盖)
kura item set ABC-123 --title "我改的标题" --plot "我改的简介"
kura item unlock ABC-123 title

# 开发
bun run cli --help               # 零 install 跑 CLI
pnpm install && pnpm dev         # 桌面端
bun run build:cli                # -> dist/kura
bun run build:cli:win            # -> dist/kura.exe (交叉编译)
bun test                         # 47 个用例, 全部离线

# 出 Windows 包
pnpm --filter @kura/desktop package:win   # -> apps/desktop/release/Kura-x.y.z-portable.exe
```

图标是脚本生成的占位图: `node scripts/make-icon.mjs`(手写 PNG/ICO 编码,零依赖)。

## 数据源现状

| 来源 | 状态 | 说明 |
|---|---|---|
| `dmm` | **可用** | DMM/FANZA 官方 API,需 affiliate 凭据 |
| `javbus` | **可用** | 网页解析(真实页面验证过),部分网络需代理 |
| `javdb` | **可用** | 网页解析(真实页面验证过);**无码条目需登录**,未登录会报 NEEDS_INPUT |
| `fixture` | 可用 | 从目录读离线样本,用于开发与测试 |

```bash
export KURA_DMM_API_ID=...            # https://affiliate.dmm.com/api/
export KURA_DMM_AFFILIATE_ID=...
kura source test dmm                  # 一条命令验证凭据与解析
kura source test javbus               # 真打站点, 报告取到哪些字段
kura source test javdb
kura scrape ABC-123                   # 默认路由: dmm → javbus → javdb
kura scrape ABC-123 --source javbus,javdb   # 双源逐字段择优
kura scrape ABC-123 --source fixture --fixtures ./fixtures
```

缺凭据时退出码是 **4(NEEDS_INPUT)**,不会静默返回空条目。

### 翻译（日 → 中）

只翻含假名的日文标题与简介；演员名不翻。译文覆盖显示值，原文另存，NFO 的 `originaltitle` 与目录名仍用日文。

```bash
kura config set --llm-base-url https://api.deepseek.com/v1 --llm-api-key sk-... --llm-model deepseek-chat
kura config set --translate          # 刮削后自动翻
kura translate --pending             # 补历史条目
kura translate ABC-123
```

任何 OpenAI 兼容端点都行（DeepSeek / 通义 / Ollama / LM Studio）。译文缓存独立在 `<数据目录>/translations.db`，删掉即重翻。

### 代理

`javdb` 与 DMM 网页版对部分地区封锁,`javbus` 需要完整浏览器 UA(已内置)。代理分两处:

- **GUI**: 跟随系统代理 —— Clash 开系统代理或 TUN 模式即可,无需配置。
- **CLI**: `kura config set --proxy auto`(推荐)或 `--proxy http://127.0.0.1:7890`。
- 优先级: `KURA_PROXY` 环境变量 > 配置文件 > 系统代理(GUI)/直连(CLI)。
- `auto` 在运行时探测 `127.0.0.1` 与 WSL 网关上的常见端口(7890/7891/7897/1080/10808/20171),
  命中即用并缓存; 探测总预算 6s。**这样 WSL 网关变化、Clash 换端口都不用改配置。**

WSL 里要指向宿主机上的 Clash,用网关地址而不是 `127.0.0.1`:

```bash
ip route show default | awk '{print $3}'      # 例如 172.19.16.1
kura config set --proxy http://172.19.16.1:7890
```

聚合、整理、NFO 都走同一份代码,补站点时只改 `packages/core/src/sources/builtin.ts`。

## 目录

```
packages/core      业务逻辑 + SQLite (唯一有状态的一层)
  domain/          纯函数: identify / aggregate / materialize
  sources/         来源接口、路由、fixture 源
  tasks/           scan / scrape / organize
packages/cli       面向 agent 的 CLI (契约见 docs/dev/cli-contract.md)
apps/desktop       Electron 主进程 + Vue3 三页界面
docs/dev           给 agent 的架构与契约
```

## 退出码

`0` 成功 · `2` 用法错 · `3` 可重试 · `4` 需要人 · `5` 不存在 · `10` 内部错误

`kura schema --json` 输出机器可读的命令清单,与参数解析共用同一份声明。
