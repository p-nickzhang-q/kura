# 色彩系统参考

参考 Google Material You Tonal Palette 结构。

## Tonal Palette 结构
- **Primary** — 品牌主色，关键操作/焦点元素
- **Secondary** — 辅助色，标签/图标/次要按钮
- **Tertiary / Accent** — 对比强调色
- **Neutral** — 灰阶体系，背景/表面/文字层级
- **Error** — 错误/警告状态色

## 高级色板（可直接使用）

| 风格 | Primary | Secondary | Accent | Surface |
|---|---|---|---|---|
| 极简白 | #1A1A2E | #16213E | #E94560 | #F8F9FA |
| 深空科技 | #6C63FF | #3ECFCF | #FF6584 | #0D0D1A |
| 自然有机 | #2D6A4F | #95D5B2 | #F4A261 | #FEFDF8 |
| 奢华金融 | #1C1C28 | #8B7355 | #C9A84C | #F5F3EF |
| 现代橙红 | #FF4B2B | #FF416C | #FFA07A | #1A1A1A |
| 苹果式灰 | #007AFF | #34C759 | #FF9500 | #F2F2F7 |
| 薰衣草紫 | #7B61FF | #B693FD | #4DC9D9 | #FAFAFF |
| 珊瑚暖调 | #FF6B6B | #FFE66D | #4ECDC4 | #FFFAF0 |

## 对比度规则（硬性）
用 `python ../scripts/check_ui.py contrast <fg> <bg>` 校验。
- 正文文字：WCAG AA **4.5:1**，大号文字/AAA 目标 **7:1**
- UI 组件/图标：至少 **3:1**
- 常见坑：浅色 Primary 上放白字（对比度不足）→ 改用深色 Primary 或加深字色

## 文字层级色（在同色板上保证对比）
- 主文字：Neutral 最浅（如 #F2F2F7 on dark / #1A1A2E on light）
- 次文字：Neutral 中档（如 #A2A2BC / #5A5A6E）
- 弱文字/占位：#6F6F8A 级

## 用量纪律
- 全页 **≤16 种颜色**（含透明派生）
- 主色覆盖率控制：一个页面主色用于焦点，不铺满
- 渐变只用于强调（图标/标题/CTA），不用于大面积背景铺色
