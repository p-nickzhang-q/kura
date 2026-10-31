# UI Generation Protocol

从零生成新界面。**按此顺序执行，不可跳步。**

## 执行顺序
1. **定义设计 DNA** — 确定调性、主色、字体组合（读取 `../references/color-systems.md` + `typography.md`）
2. **建立 CSS 变量体系** — 完整 token：色彩/间距/圆角/字阶/动效，统一在 `:root`
3. **搭建布局骨架** — Grid/Flex 响应式结构，Mobile First
4. **实现核心组件** — 从最重要的交互元素开始（按钮→卡片→表单）
5. **添加视觉质感** — 渐变、阴影、纹理、背景氛围
6. **注入微交互** — hover/active/focus/loading/stagger
7. **精调细节** — 间距、对齐、字重、行高、圆角一致性
8. **响应式适配** — clamp() 优先，断点仅作兜底

## 代码规范
- 必须包含 `<meta name="viewport">` + font `preconnect`
- CSS Variables 统一定义在 `:root`
- 组件用 BEM 或语义化命名
- 动画性能优先 `transform/opacity`
- 字体用 Google Fonts（Space Grotesk / Inter / Noto Sans SC 等），含系统回退

## 交付清单（缺一不可，逐项打勾）
- [ ] 完整可运行的 HTML/CSS 或 React 组件
- [ ] 4 个交互状态：Default / Hover / Active / Focus(visible)
- [ ] Loading 态（骨架屏或脉冲）
- [ ] 明暗适配或 Dark Mode 变体
- [ ] 所有间距为 4 的倍数，触控 ≥44px
- [ ] **已跑 `python scripts/check_ui.py audit`，0 违规**

## 交互状态
```css
.btn:active { transform: scale(0.97); }
.btn:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
```
