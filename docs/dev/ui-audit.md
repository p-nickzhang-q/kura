# UI 审查与整改记录

> 工具：`premium-ui` 技能（**装在用户级** `~/.pi/agent/skills/ui-design-system/`）的 audit 协议 + `scripts/check_ui.py` 硬校验。
>
> 技能**不再随仓库提交**。它装在本机用户目录，任何工作目录下启动 pi 都能用：
>
> | 事实 | 说明 |
> |---|---|
> | frontmatter `name: ui-design-system` | 命令是 `/skill:ui-design-system`，目录名 `premium-ui` 只是 skillhub 的 slug |
> | 装在哪 | `~/.pi/agent/skills/ui-design-system/`（用户级，免项目信任） |
> | 为什么不用仓库级 | 仓库级 `.pi/skills` 受**项目信任**保护，未授权时被静默跳过；且发现范围只认**精确 cwd**（子目录里启动也找不到） |
> | 换机器怎么办 | `skillhub --dir ~/.pi/agent/skills install premium-ui --namespace user_49d9b6a1` |
>
> 每次改界面后跑（脚本扫的是源文件，不是构建产物）：
>
> ```bash
> python3 ~/.pi/agent/skills/ui-design-system/scripts/check_ui.py audit apps/desktop/src/App.vue
> ```

## 已完成（0.4.4）

| 维度 | 问题 | 处理 |
|---|---|---|
| 组件状态 | `hover` / `active` / `disabled` / `focus-visible` **一个都没有** | 全部补齐：hover 改边框+底色、按下 `translateY(1px)`、禁用 0.42 透明、键盘焦点 2px accent 环 |
| 排版 | 10px ×3、11px ×5，低于 12px 可读下限 | 全部提到 12px |
| 间距 | 6px ×14、10px ×18 等非 4/8 网格值 | 19 处改为 8/12/16 |
| 圆角 | 4/6/8/10/999 五种混用 | 收敛为 `--radius-sm/md/lg/pill` |
| 色彩 | 校验器报 29 个散色 > 16 | 收敛为 13 个语义令牌 |
| 数字 | 表格数字会跳列宽 | `font-variant-numeric: tabular-nums` |
| 详情图片 | 图裸在空白里 | 改为有边界的"画框"：内边距 + 圆角 + 暗底 + 两层阴影；只给 `max-*`，小图不放大 |

校验结果：`check_ui.py audit` **0 项违规**。

## 已完成（0.6.2）

| 维度 | 问题 | 处理 |
|---|---|---|
| 可用性 | 表头不能排序（找"最近加的"/"按番号"只能靠翻页） | core `listItems` 加 `sort`（白名单字段 + 空值沉底），CLI `--sort/--desc`，界面点表头「升 → 降 → 取消」，带 `aria-sort` |
| 可用性 | 详情封面只能看 320px 宽的小图 | 点封面开遮罩大图（Esc / 点任意处 / × 关闭，`role=dialog` + 焦点自动移入，160ms 入场，`prefers-reduced-motion` 兜底） |
| 事故 | `item:list` 的 IPC 处理器逐字段抄参数，加 `state`（只看未刮削）时忘了同步 → **界面上的「未刮削」按钮点了没反应，76 条一条也筛不出来** | 补齐转发；新增 `tests/ipc-list-params.test.ts`：`ListItemOptions` 的每个字段都必须在处理器里出现，漏一个就红 |

## 已完成（0.6.1，按技能六维审查整改）

| 维度 | 问题 | 处理 |
|---|---|---|
| 色彩系统 | `--panel-2` / `--panel-3` / `--line-strong` **只有引用没有定义**，`var()` 静默退回继承 → 主按钮文字 2.58:1、选中行无底色 | 补定义 + `--on-accent`（5.97:1）+ `--text-faint`（4.53:1）；新增 `tests/css-tokens.test.ts` 锁住「用到必须定义、定义必须有人用」 |
| 色彩系统 | 详情"字段来源"用线的颜色当文字色（**1.81:1**） | 换 `--text-faint`；并改成悬停该行才显示（常态 5 行重复同一个源是噪音） |
| 视觉层级 | 类型列 3881 条里 99% 同一个值却独占一列；标题列开头又重复番号 | 类型降级为番号旁的小徽标；标题用 `displayTitle()` 去掉前缀番号；`min-width: 240px` 保证标题优先 |
| 视觉层级 | 顶部 meta 混入 `v0.6.0 · node · schema v8` | 只留「条目 3,881 · 文件 4,021」，排障信息挪进设置页 |
| 视觉层级 | 侧栏库名与路径重复（`#整理完成` / `Z:\#整理完成`） | `showRoot()`：路径尾巴与库名相同时不显示 |
| 组件状态 | 零加载态；扫库时显示「这个库里还没有条目」（误导） | 骨架屏 + 2px 进度条 + `firstLoad` 区分"还没读出来"与"确实没有" |
| 无障碍 | `aria-*` 计数 0，图标按钮全靠 `title` | 补齐图标按钮可访问名，锁字段按钮带 `aria-pressed` |
| 无障碍 | 焦点环 2px | 3px + offset 2（含 `summary`） |
| 排版 | 中文正文 13px；字阶四层 | 正文 14px；收敛为 标题层(18/16) / 正文 14 / 标签 12 |
| 圆角 | 8/12/16 混用且按数字命名 | 按元件分档：`--radius-xs 8`（缩略图）/ `sm 12`（按钮输入）/ `md 16`（卡片）/ `lg 20`（面板） |
| 动效 | 无 | 骨架 shimmer、进度条补间、详情来源/锁图标淡入，全部走 `prefers-reduced-motion` 兜底 |

## 已完成（0.6.0）

| 维度 | 问题 | 处理 |
|---|---|---|
| 视觉中心 | 侧栏四个动作同权重，用户不知道该点哪个 | 按状态推导出**唯一主按钮**（有待刮削→「刮削待处理 (N)」；否则有待翻译→翻译；否则→扫描），其余收进「更多操作」`<details>`（原生可键盘操作，不用自造反差组件） |
| 字阶 | 12/13/14/18 四层且差别不明显 | 收敛为 `--fs-display 18 / --fs-section 15 / --fs-body 13 / --fs-label 12` 四个令牌，38 处硬编码字号全部替换；`h1` 加 `font-weight: 600` 与 `letter-spacing: -0.02em` |
| 空状态 | 一行灰字「没有条目。先扫描一个媒体库。」 | 按情况给下一步动作：没有库→「添加媒体库」；库空→「扫描 «库名»」；筛选后空→「清空筛选」。各带一句说明 |
| 列表挤压 | 打开详情面板后表格被压到两三个字宽、番号折行 | `table { min-width: 680px }` 让列表横向滚动；详情宽度 380→340px；标题两行截断改到单元格内层 `<span>`（把 `-webkit-box` 挂在 `td` 上会破坏行高） |
| 详情图片字段 | 三个图片字段直接摊开一长串 URL | 改为「已缓存 ✓」/「未缓存 · 下载」，点了就地下载并刷新 |
| 工具栏换行 | 一条塞不下时文字被压成竖排 | 拆成两行（筛选 / 翻页+批量动作），子项一律 `white-space: nowrap` + `flex-wrap: wrap` |

## 界面自查（不用人肉点）

渲染层有 GPU 问题时 `x11grab` 也会拿到黑图，所以走主进程的 `capturePage`：

```bash
cd apps/desktop && KURA_DATA_DIR=/tmp/库 KURA_SCREENSHOT=/tmp/ui.png KURA_SCREENSHOT_DELAY=3000 \
  ./node_modules/.bin/electron . --no-sandbox
```

钩子必须在 `loadFile` **之前**注册 —— `await loadFile` 返回时 `did-finish-load` 早已发过，之后再 `once` 永远不触发。

要点开详情/切标签再截图，用 CDP：

```bash
./node_modules/.bin/electron . --no-sandbox --remote-debugging-port=9333 &
# 然后 Page.captureScreenshot / Runtime.evaluate 点击
```

## 不跟的项（有理由，不是漏做）

### 1. display 字体 —— 不引

技能建议标题用 display 字体做对比。Electron 内置字体有限，引外部字体文件要多背几百 KB 且中文回退不可控。
**克制方案**：靠字重 + 字距 + 字阶拉开层级，已经够用。

### 1. 触控目标 44px —— 不跟

按钮实际高度 31–33px，低于 Apple HIG 的 44px（那个数字是给触屏的）。
这是桌面鼠标应用，32px 是 Windows/macOS 桌面工具的主流高度；跟 44px 会让侧栏和工具栏白白胖一圈。
**若将来支持触屏**：整体放大到 40px+ 并重排工具栏。

### 2. 动效

只有 `translateY(1px)` 与行 hover 120ms 过渡。技能要求"动效有意义"——但工具类应用里动效过多反而干扰。
**决定：保持接近静态，只在状态切换处给 120–200ms。**
