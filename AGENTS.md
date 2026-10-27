# AGENTS.md

给 Coding Agent 的入口。**本文件不承载实现细节**,细节在 `docs/dev/`。

## 项目

Kura —— 本地优先的媒体库工具。Electron 桌面应用 + 面向 agent 的 CLI,共享一份 TypeScript core 和一个 SQLite 文件。**没有服务端,没有守护进程。**

## 先读什么

| 要做的事 | 先读 |
|---|---|
| 改 core / 加任务 | [docs/dev/architecture.md](docs/dev/architecture.md) |
| 改 CLI 参数或输出 | [docs/dev/cli-contract.md](docs/dev/cli-contract.md) |
| 换壳、换 runtime、合并进程 | [docs/ADR/0001-栈选择.md](docs/ADR/0001-栈选择.md) |

## 硬性约束

1. **渲染进程不得 import `@kura/core`**。它没有 Node 内建模块。加功能 = 加 IPC 方法。
2. **只有 `openRuntime()` 能建数据库连接**。下游函数接收 `Runtime` 参数,不读全局环境变量。
3. **只有 `packages/core/src/db/driver.ts` 知道 `bun:sqlite` 与 `node:sqlite` 的差异**。core 其余部分只用 `Db` 接口。
4. **CLI 的 stdout 只放数据**。日志一律 `out.log()`(stderr)。新增输出走 `out.result()`。
5. **命令声明只有 `COMMANDS` 一处**。解析、`--help`、`schema` 都从它派生,不要另写文档清单。
6. **写库必须在事务里**,且不长事务(见 architecture.md 的并发规则)。
7. **错误必须带退出码**。抛 `AppError(message, EXIT.XXX)`,不要在 CLI 层按字符串判断。

## 常用命令

```bash
bun run cli --help                    # 跑 CLI (零 install)
bun run cli doctor --json
pnpm install                          # 桌面端依赖 (electron/vue/vite)
pnpm dev                              # 构建主进程 + Vite + Electron
pnpm build                            # 渲染进程 + 主进程 + 单文件 CLI
bun run build:cli                     # 只出 CLI 二进制 -> dist/kura
bun run build:cli:win                 # Windows 交叉编译 -> dist/kura.exe
pnpm typecheck
```

`bun run cli -- schema --json` 是**机器可读**的命令清单,优先用它而不是猜参数。

## 代码风格

- TypeScript strict + `noUncheckedIndexedAccess`;不用 `enum`(用 `as const` 对象),不用参数属性。
- 注释写**为什么**,不写"这里设置 x 为 y"。业务代码里出现 `if (平台判断)` 就是分层漏了。
- 中文注释,与文档一致;标识符英文。

## 不要做

- 不要引第三方 CLI 框架(argparse/commander/yargs)。参数解析是有意手写的 ~80 行,因为 spec 要驱动 `schema` 输出。
- 不要为了"以后可能要服务端"提前引入 HTTP 服务、鉴权、任务队列。
- 不要在渲染进程开 `nodeIntegration`。
- 不要用 `readFile()` 读用户媒体文件;一律流式。

## 提交

- 一个提交只做一件事。提交信息用中文,格式 `<type>(<scope>): <说明>`,type ∈ feat/fix/refactor/docs/chore。
- 改了 CLI 对外行为 → 同一次提交里更新 `docs/dev/cli-contract.md`。
- 改了进程模型或技术选型 → 新写一份 ADR,不要改旧 ADR 的结论。
