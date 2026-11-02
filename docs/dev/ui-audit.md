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
