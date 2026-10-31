# 端到端示例：需求 → 决策 → 成稿 → 校验

## 需求（用户原话）
> "做一个数据分析后台的概览页，科技感一点，要有数据卡片和图表。"

## 决策
- 用途 → **生成新 UI** → 读取 `protocols/generate.md`
- 产品类型 → **Web App / Dashboard**
- 品牌调性 → 科技感 → 色板选「深空科技」+ 字体组合 A（Space Grotesk / Inter / Noto Sans SC）

## 设计 DNA
- 色板：#6C63FF（主）/ #3ECFCF（辅）/ #FF6584（强调）/ #0D0D1A（底）
- 间距：8pt 网格；卡片 16px 圆角；按钮 44px
- 动效：卡片 hover 抬升 + spring；入场 stagger

## 成稿骨架（节选）
```css
:root {
  --primary:#6C63FF; --secondary:#3ECFCF; --accent:#FF6584;
  --bg:#0D0D1A; --surface:#151522;
  --space-6:24px; --space-8:32px;
}
.card { background:var(--surface); border-radius:16px; padding:var(--space-8);
  box-shadow:0 1px 2px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.08);
  transition:transform 200ms cubic-bezier(.34,1.56,.64,1), box-shadow 200ms ease; }
.card:hover { transform:translateY(-4px); box-shadow:0 12px 32px rgba(0,0,0,.45); }
```
```html
<div class="card">
  <div class="stat-value">+23.4%</div>
  <div class="stat-label">本月营收</div>
</div>
```

## 校验（交付前）
```bash
python scripts/check_ui.py audit dashboard.html
# ✅ audit 通过：0 项违规

python scripts/check_ui.py contrast #F2F2F7 #151522
# #F2F2F7 vs #151522   对比度 = 16.2:1   （正文 AA/AAA 均通过）
```

## 产出核对（对照交付清单）
- [x] 4 个交互状态 + focus-visible
- [x] Loading 骨架屏
- [x] Dark Mode 变体（本示例即深色）
- [x] 间距全部 4 的倍数，触控 ≥44px
- [x] check_ui.py 0 违规
