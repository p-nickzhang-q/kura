# 组件代码参考

## 卡片（Material 3 三种变体）
```css
.card-elevated {
  background: var(--surface);
  border-radius: 16px;
  box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.08);
  transition: box-shadow 200ms ease, transform 200ms ease;
}
.card-elevated:hover {
  box-shadow: 0 4px 8px rgba(0,0,0,.08), 0 12px 32px rgba(0,0,0,.12);
  transform: translateY(-2px);
}
.card-filled { background: var(--surface-variant); border-radius: 16px; border: none; }
.card-outlined { background: var(--surface); border-radius: 16px; border: 1px solid var(--outline); }
```

## 按钮（Apple + Material 融合，含状态）
```css
.btn {
  height: 44px;                 /* ≥44px 触控 */
  padding: 0 24px;
  border-radius: 12px;          /* Apple 圆角 */
  font-weight: 600; font-size: 15px; letter-spacing: -0.01em;
  border: none; cursor: pointer;
  transition: transform 150ms ease, box-shadow 200ms ease, background 200ms ease;
}
.btn-primary { background: var(--primary); color: var(--on-primary);
  box-shadow: 0 1px 2px rgba(0,0,0,.2), 0 8px 24px color-mix(in srgb, var(--primary) 30%, transparent); }
.btn:active { transform: scale(0.97); }
.btn:focus-visible { outline: 3px solid var(--secondary); outline-offset: 2px; }
.btn:disabled { opacity: .4; pointer-events: none; }
/* 层级: Filled > Filled Tonal > Outlined > Text > Icon */
.btn-tonal { background: color-mix(in srgb, var(--primary) 12%, transparent); color: var(--primary); }
.btn-outlined { background: transparent; border: 1px solid var(--outline); color: var(--text); }
```

## 输入框（两种风格）
```css
/* M3 Outlined */
.input-outlined {
  height: 56px; border: 1.5px solid var(--outline); border-radius: 4px; padding: 0 16px;
  transition: border-color 200ms;
}
.input-outlined:focus { border-color: var(--primary); border-width: 2px; outline: none; }

/* Apple 风格 */
.input-apple {
  height: 44px; background: rgba(120,120,128,.12); border: none; border-radius: 10px; padding: 0 16px;
}
```

## 状态标签 Chip
```css
.chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px;
  border-radius: 999px; font-size: 12px; font-weight: 600; }
.chip-success { background: rgba(52,199,89,.12); color: #34C759; }
.chip-warn    { background: rgba(255,149,0,.12); color: #FF9500; }
.chip-error   { background: rgba(255,69,58,.12); color: #FF453A; }
```

## 圆角体系
- 按钮/输入：12px；卡片：16px；弹层/面板：20-24px；标签：999px
- 统一用变量：`--radius-*`
