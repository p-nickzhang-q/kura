# AGENTS.md

给 Coding Agent 的入口。**本文件不承载实现细节**,细节在 `CONTEXT.md` 与 `docs/`。

## 项目

Kura —— 番号制本地影片库管理器。Electron 桌面应用 + 面向 agent 的 CLI,共享一份 TypeScript core 和一个 SQLite 文件。**没有服务端,没有守护进程。**

三个动作:`scan`(只读磁盘) → `scrape`(只读网络) → `organize`(默认 dry-run,`--apply` 才动磁盘)。**互不触发。**

## 先读什么

| 要做的事 | 先读 |
|---|---|
| 改词、加概念、写用户文案 | [CONTEXT.md](CONTEXT.md) |
| 改 core / 加任务 | [docs/dev/architecture.md](docs/dev/architecture.md) |
| 改 CLI 参数或输出 | [docs/dev/cli-contract.md](docs/dev/cli-contract.md) |
| 产品边界 / 为什么不做某功能 | [docs/ADR/0002](docs/ADR/0002-产品边界.md) |
| 换壳 / 换 runtime / 合并进程 | [docs/ADR/0001](docs/ADR/0001-栈选择.md) |

## 硬性约束

1. **渲染进程不得 import `@kura/core`**。加功能 = 加 IPC 方法。
2. **只有 `openRuntime()` 能建数据库连接**。下游函数接收 `Runtime`,不读全局环境变量。
3. **只有 `packages/core/src/db/driver.ts` 知道 `bun:sqlite` 与 `node:sqlite` 的差异**。
4. **CLI 的 stdout 只放数据**。日志走 `out.log()`(stderr)。
5. **命令声明只有 `COMMANDS` 一处**。解析、`--help`、`schema` 都从它派生。
6. **`domain/` 是纯函数**:不读文件、不开连接、不读环境变量。这样它才能被穷举测试。
7. **内容类型只在建条目时落定**,之后不可改(它决定刮削路由)。
8. **ORGANIZE 默认 dry-run**。任何让 organize 默认执行改动的改动都要先推翻 ADR 0002。
9. **不做 `watch` 命令**。常驻监控与"只在执行时运行"冲突;GUI 打开期间才监听。
10. **错误必须带退出码**。抛 `AppError(message, EXIT.XXX)`,不要按字符串判断。

## 常用命令

```bash
bun run cli --help
bun run cli schema --json          # 机器可读的命令清单, 优先用它而不是猜参数
bun test                           # 全部用例离线, 不依赖网络
pnpm typecheck
pnpm dev                           # 主进程 + Vite + Electron
bun run build:cli                  # 单文件 CLI
```

## 代码风格

- TypeScript strict + `noUncheckedIndexedAccess`;不用 `enum`(用 `as const`),不用参数属性。
- 注释写**为什么**。业务代码里出现 `if (平台判断)` 就是分层漏了。
- 中文注释,标识符英文。

## 不要做

- 不要引第三方 CLI 框架(commander/yargs)。参数解析是手写的 ~80 行,因为 spec 要驱动 `schema` 输出。
- 不要为了"以后可能要服务端"提前引入 HTTP 服务、鉴权、任务队列。
- 不要在渲染进程开 `nodeIntegration`。
- 不要用 `readFile()` 读用户媒体文件(大文件);索引与 hash 一律流式。
- 不要把未实现的站点标成 `ready`。`source list` 必须说实话。

## 提交

- 一个提交只做一件事。提交信息用中文,格式 `<type>(<scope>): <说明>`,type ∈ feat/fix/refactor/docs/chore。
- 改了 CLI 对外行为 → 同一次提交里更新 `docs/dev/cli-contract.md`。
- 改了进程模型或技术选型 → 新写 ADR,不要改旧 ADR 的结论。
