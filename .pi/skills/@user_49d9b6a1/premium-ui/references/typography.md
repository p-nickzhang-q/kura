# 排版系统参考

## 字体组合（优先有个性的组合）

| 选项 | Display（大标题） | Body（正文） |
|---|---|---|
| A 科技感 | Space Grotesk / DM Sans | Inter / system-ui |
| B 人文优雅 | Playfair Display / Cormorant | Source Serif 4 / Georgia |
| C 现代极简 | Syne / Outfit | Manrope / sans-serif |
| D 中文友好 | Noto Serif SC | Noto Sans SC |

中文字体加载：`Noto Sans SC`（正文）+ `Noto Serif SC`（标题文艺感）。

## Type Scale（clamp() 响应式）

```css
--type-display-large: clamp(40px, 5vw, 57px);   line-height: 1.12;
--type-display-medium: clamp(32px, 4vw, 45px);  line-height: 1.16;
--type-headline-large: clamp(24px, 3vw, 32px);  line-height: 1.25;
--type-headline-medium: clamp(20px, 2.5vw, 28px); line-height: 1.29;
--type-title-large: 22px;   line-height: 1.27;
--type-title-medium: 16px;  line-height: 1.5;
--type-body-large: 16px;    line-height: 1.5;
--type-body-medium: 14px;   line-height: 1.43;
--type-label-large: 14px;   line-height: 1.43;
--type-label-small: 11px;   line-height: 1.45;
```

## 排版纪律
- **字阶 ≤3 层**（大标题/正文/标签），层级靠字重和字号，不只靠颜色
- 大标题字距 `letter-spacing: -0.02em`；正文正常；全大写标签 `0.15-0.22em`
- 中文：正文 14-16px 行高 1.5-1.6；标题紧凑 1.2 以下
- **字号 <12px 禁止**（可读性），标签最小 11-12px
- 字体数量 ≤2 个 family（一显示一体）

## 数字排版（金融/数据场景必须）
- **数字不跟衬线标题字体**（如 Playfair 的数字花哨、和正文不一致）——单独配几何无衬线数字字体
- 数字专用 font stack：`--font-num: 'Space Grotesk', 'Manrope', sans-serif;`（衬线给文字，无衬线给数字）
- 所有数字加 `font-variant-numeric: tabular-nums;`（等宽数字，对齐表格/大数字更利落）
- 大数字 `letter-spacing: -0.01em`；带 万/亿/％ 等中文单位时，单位由 CJK 回退字体渲染（无碍）
- 反例：`.stat-value { font-family: serif-display }` 会把 4/2/8 等数字渲染得花哨且不齐 → 数字一律走 `--font-num`
