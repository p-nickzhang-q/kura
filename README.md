# Kura

本地优先的媒体库工具。**Electron 桌面应用 + 面向 agent 的 CLI**,共享一份 TypeScript core 和一个 SQLite 文件。

- 没有服务端,没有常驻进程:打开软件才运行,关了就退出。
- CLI 是单文件二进制,冷启动 20–30ms,零依赖。
- GUI 与 CLI 不通过端口通信,只共享同一个库文件。

## 目录

```
packages/core      业务逻辑 + SQLite (唯一有状态的一层)
packages/cli       面向 agent 的 CLI (输出契约见 docs/dev/cli-contract.md)
apps/desktop       Electron 主进程 + Vue3 渲染进程
docs/ADR           技术选型记录
docs/dev           给 agent 的架构与契约 (先读这里)
```

## 快速开始

前置:[Bun](https://bun.sh) ≥ 1.1(跑 CLI / 构建主进程)、[pnpm](https://pnpm.io) ≥ 9(桌面端依赖)。

```bash
# CLI: 不需要 install
bun run cli doctor --json
bun run cli scan ~/Videos --dry-run --json

# 桌面端
pnpm install
pnpm dev

# 出包
bun run build:cli        # -> dist/kura
bun run build:cli:win    # -> dist/kura.exe (交叉编译)
pnpm build               # 渲染进程 + 主进程 + CLI
```

## CLI 速查

```bash
kura schema --json                 # 机器可读的命令清单 (agent 工具发现)
kura doctor --json                 # 自检: 数据目录 / schema / 条目数
kura scan <dir> --json             # 扫描入库 (幂等)
kura scan <dir> --dry-run --json   # 只报告, 不写库
kura scan <dir> --json --stream    # 额外输出 JSONL 事件
```

退出码:`0` 成功 · `2` 用法错 · `3` 可重试 · `4` 需要人 · `5` 不存在 · `10` 内部错误。

## 数据位置

`KURA_DATA_DIR` > 平台默认(`~/.local/share/kura` / `%APPDATA%\kura` / `~/Library/Application Support/kura`)。
库文件 `kura.db`(WAL 模式,允许 GUI 与 CLI 并发读写)。

## 现状

骨架阶段,`scan` 是示例任务,用来演示"GUI 与 CLI 共享同一份 core"的完整闭环。换成真实领域时:

1. 改 `packages/core/src/tasks/` 里的任务,在 `db/schema.ts` 追加迁移;
2. 在 `packages/cli/src/commands.ts` 的 `COMMANDS` 里加命令;
3. 在 `apps/desktop/electron/main.ts` 加对应 IPC,在 `App.vue` 里用。
