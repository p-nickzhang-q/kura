---
name: ui-design-system
description: 大厂级、高级简约、品牌化 UI 的设计与生成。当用户需要从零生成新界面（落地页/Dashboard/移动端/B端/作品集）、优化现有 UI 或设计稿截图、设计单个组件（按钮/卡片/表单/导航/Tab/Modal/Toast）、或要求高质量 HTML/CSS/React 前端代码且在意视觉质量时，使用本技能。按用途分派三个协议：生成(generate)、审查(audit)、单组件(component)。
---

# UI Design System

大厂级、Pinterest 审美、高级简约的 UI 设计与生成。
参考 Google Material 3、Apple HIG、Microsoft Fluent、高赞 Dribbble/Pinterest。
> 优化版 fork，基于 skillhub `@user_865e3592/ui-new`，新增可执行校验层。

## 设计价值观
- **少即是多，但每一处都要有意图**
- 系统性思维：每个组件来自同一设计语言
- 情绪传达：界面有温度、有性格，不是功能机器
- 细节决定品质：阴影、圆角、间距都是语言

## 决策树（先判断，再行动）
1. 用户给设计稿/截图/现有代码要**优化** → 读取 `protocols/audit.md`，先审查再出改进版
2. 用户要从零**生成**界面 → 问清 ①产品定位 ②品牌调性 ③主色倾向 ④交付格式，读取 `protocols/generate.md`
3. 用户只要**单个组件** → 读取 `protocols/component.md`
4. 用户没说清楚 → 只问三件事：①什么产品 ②什么风格 ③HTML 还是 React

## 核心 Token 摘要（完整版见 references/）
- **间距**：4/8pt 网格 `16 / 24 / 32 / 48 / 64 / 96px`，所有间距必须是 4 的倍数
- **圆角**：组件 12px、卡片 16px、弹层 20-24px、标签胶囊 999px
- **触控**：按钮/可点元素 ≥44px 高（Apple HIG）；输入框 44-56px
- **阴影**：两层克制阴影；**禁止** `0 4px 8px rgba(0,0,0,0.5)` 这类单层廉价阴影
- **字体**：显示 Space Grotesk / Syne / Playfair Display；正文 Inter / Manrope；中文 Noto Sans SC / Noto Serif SC
- **字阶**：用 `clamp()`，不堆断点
- **动效**：`--ease-spring: cubic-bezier(0.34,1.56,0.64,1)`，200-400ms，优先 transform/opacity

## 质量红线
**必须具备：**
1. 每页只有一个视觉中心
2. 足够留白，不拥挤
3. 色彩自信但不杂乱（≤16 色）
4. 字体有品位，字重有对比
5. 圆角统一，不乱用
6. 阴影克制，一两层精准
7. 动效有意义，每个动画传达信息

**绝对避免：**
- 彩虹渐变按钮 / 全大写+粗体+红色"警告" / 图标文字对不齐
- 响应式断点堆叠（用 clamp 代替）
- 触控目标 <44px

## 强制校验（交付前必做）
产出 HTML/CSS 后，**必须**运行：
```bash
python scripts/check_ui.py audit <output.html>   # 扫描违规，修复后再交付
python scripts/check_ui.py contrast <fg> <bg>     # 核对 WCAG 对比度
```
校验未通过不得交付。

## 参考文件
- `references/color-systems.md` — 完整色板与对比度规则
- `references/typography.md` — 字体组合与字阶
- `references/components.md` — 组件代码库与状态变体
- `references/motion.md` — 动效曲线、时长、微交互清单
- `examples/dashboard-demo.md` — 端到端示例（需求→决策→成稿→校验）
