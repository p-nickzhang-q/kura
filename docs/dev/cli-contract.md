# CLI 契约(面向 agent)

> 改这个文件等于改 API。实现入口 `packages/cli/src/{main,args,output,commands}.ts`。

## 三条铁律

1. **stdout 是机器通道**。JSON 模式下每次执行写一行完整 JSON,成功与失败都在这里。
2. **stderr 是人通道**。日志、进度、诊断;agent 可以整段丢弃。
3. **退出码是主信号**。先看退出码,再看 `error.code`,不要靠匹配错误文本。

## 输出信封

成功:

```json
{"ok":true,"command":"scan","data":{"root":"/media","dryRun":false,"counts":{"added":12,"updated":0,"unchanged":340,"removed":1},"durationMs":88}}
```

失败:

```json
{"ok":false,"command":"scan","error":{"code":"NOT_FOUND","message":"不是目录: /nope","retryable":false,"details":{"root":"/nope"}}}
```

- `detail` 里只放**结构化**信息(路径、参数名),不放人类散文。
- 未预期异常也走这个信封,栈只在 `KURA_DEBUG=1` 时进 stderr。

## 退出码

| 码 | 名称 | 含义 | agent 该做什么 |
|---|---|---|---|
| 0 | OK | 成功 | 读 `data` |
| 2 | USAGE | 参数错、未知命令 | **修正参数后重试**,别原样重试 |
| 3 | RETRYABLE | 数据库被占用、网络抖动 | **原样重试**(可退避) |
| 4 | NEEDS_INPUT | 缺凭据、需人确认 | **停下来问人**,禁止重试 |
| 5 | NOT_FOUND | 目标不存在 | 换参数,不要重试 |
| 10 | INTERNAL | bug | 报告,不要重试 |

`error.retryable` 是退出码 3 的布尔镜像,便于只读 JSON 的调用方。

## 模式选择

- 非 TTY(agent 管道调用)**自动进入 JSON 模式**,不需要显式 `--json`。
- `--stream`:JSON 模式额外输出 JSONL 事件(每行一个对象),最后一行仍是结果信封。默认不输出事件,避免 agent 要过滤多行。
- `--json` 在 TTY 下强制 JSON。

## 工具发现

```bash
kura schema --json
```

返回命令清单、每个参数的 `name/type/required/default/description`、退出码表、相关环境变量。

**这份输出与参数解析共用同一份 `COMMANDS` 声明**,所以不会出现"文档说有 `--dry-run`、实际不认"的情况。新增参数只改 `COMMANDS`。

## 幂等与安全

- 写操作必须幂等:同一输入重复执行,第二次应报告 `unchanged` 而不是重复写入。
- 可能破坏数据的操作提供 `--dry-run`,并且**默认值写在 `COMMANDS` 里**,不靠文档口头约定。
- 当前无交互命令。将来加确认时:`--yes` 跳过;没有 TTY 且没有 `--yes` → 退出码 4,不要阻塞等 stdin。

## agent 调用示例

```bash
# 先探能力
kura schema --json

# 建库 → 扫描(只读磁盘) → 刮削(只读网络) → 整理(默认 dry-run)
kura library add 主库 ~/Videos --json
kura scan 主库 --json
kura scrape ABC-123 --json
kura organize 主库 --json          # 只出计划
kura organize 主库 --apply --json  # 真的移动

# 找活干: 只看还没元数据的条目, 按标题排序
kura item list --state unscraped --json
kura item list --sort title --desc --limit 20 --json

# 内容类型判错了(解析器 bug 留下的历史数据): 先看清单, 再决定要不要改
kura item retype --detect --json            # 只列, 不动数据
kura item retype --detect --apply --json    # 真的改
kura item retype SSIS-915 censored --json   # 单条

# 手改字段并锁定: 锁定的字段重新刮削不覆盖
kura item set ABC-123 --title "我改的标题" --json
kura item lock ABC-123 title,plot --json
kura item unlock ABC-123 title --json

# 验证某个来源是否真的能用(缺凭据会如实报 missing-config)
kura source test dmm --json

# 自检(数据目录、schema 版本、库/条目/文件数)
kura doctor --json
```

`scan` 有一道**删除安全阀**: 一次扫描要移除的已登记文件超过 30%(且已知文件 ≥20 个)时中止,
退出码 `4`, `details` 里给 `known` / `wouldRemove` / `sample`。这是为了防止"盘只挂了一半就扫"
把索引清空 —— 那种情况下按库筛选的条目列表会突然变空, 下次扫描又"自己恢复", 最难排查。
确认目录完整后重试; 确实要删这么多就加 `--force`。

`item list` 的筛选与排序(都可组合):
`--q` 关键词(番号/标题/原名/片商/厂牌/系列/演员/标签/导演)、`--type`、
`--actor` `--studio` `--label` `--series` `--director` `--tag` `--library`、
`--state unscraped|scraped|exhausted`(unscraped = 标题为空**或**只被 NFO 种过、从没联网刮过)、
`--sort number|title|release|studio|duration|updated`(默认 updated)+ `--desc`。
排序字段走**白名单**, 未知字段是退出码 2; 文本列的空值永远排最后。

**长时间批量任务**: `scrape --pending` 会逐条把进度写到 **stderr**(`[3/200] ABC-123 ✓ 11 字段`),
stdout 仍只有最后那一个结果信封。Ctrl-C 会中断在途请求并提前收尾, 结果里 `cancelled: true`、`count` 为已完成条数,
退出码仍是 `0`(主动停止不是错误)。需要机器可读的逐条进度时加 `--stream`(JSONL 事件)。

`scrape` 的失败语义:
- 有任一来源拿到数据 → 正常返回, 失败的来源进 `failures`(不中断);
- **一条都没拿到** → 不落空条目: 缺凭据给 `4`, 网络/站点给 `3`, 确实没有这条给 `5`。

三个动作**互不触发**。agent 要跑完整流程, 就按上面顺序调三次 —— 不要指望 `scan` 顺手刮削。

## 环境变量

| 变量 | 作用 |
|---|---|
| `KURA_DATA_DIR` | 覆盖数据目录(测试与多库场景) |
| `KURA_DEBUG` | 异常栈打到 stderr |
| `KURA_PROXY` | HTTP 代理, 覆盖配置文件里的 proxy |

## 何时会失效

- **输出字段改名** → 已经是对外契约,需要同步升 `version` 并在 `schema` 里标注。当前阶段(0.x)直接改,但要同步文档。
- **加交互式确认** → 必须同时实现 `--yes` 与"无 TTY 直接退出 4",否则 agent 会挂死。
- **加长任务** → 必须提供 `--stream` 事件 + 终态信封,不要让 agent 靠超时判断失败。
