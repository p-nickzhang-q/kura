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

```bash
# CLI
kura library add 主库 ~/Videos
kura scan 主库
kura scrape ABC-123 --json
kura organize 主库              # 只看计划
kura organize 主库 --apply      # 真的移动

# 开发
bun run cli --help               # 零 install 跑 CLI
pnpm install && pnpm dev         # 桌面端
bun run build:cli                # -> dist/kura
bun run build:cli:win            # -> dist/kura.exe (交叉编译)
bun test                         # 28 个用例, 全部离线
```

## 数据源现状

| 来源 | 状态 |
|---|---|
| `javdb` / `javbus` / `dmm` | 接口就绪,抓取待实现(`source list` 如实显示 todo) |
| `fixture` | 可用:从目录读离线样本,用于开发与测试 |

```bash
kura scrape ABC-123 --source fixture --fixtures ./fixtures
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
