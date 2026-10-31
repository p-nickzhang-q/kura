# 动效与交互参考

## 动效曲线（Apple Spring + Material Motion）
```css
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);      /* 弹性，用于 hover/按压 */
--ease-standard: cubic-bezier(0.2, 0, 0, 1);           /* 标准转场 */
--ease-emphasized: cubic-bezier(0.2, 0, 0, 1);
--ease-decelerate: cubic-bezier(0, 0, 0.2, 1);         /* 入场：快入慢出 */
--ease-accelerate: cubic-bezier(0.3, 0, 1, 1);         /* 离场：慢入快出 */
```

## 时长规范
```css
--duration-short1: 50ms;  --duration-short2: 100ms;  --duration-short3: 150ms;
--duration-short4: 200ms;   /* 微交互 */
--duration-medium1: 250ms; --duration-medium2: 300ms; /* 标准转场 */
--duration-long1: 350ms;  --duration-long2: 400ms;    /* 复杂动画 */
--duration-extra-long: 600ms; /* 页面级切换 */
```

## 必须实现的微交互
1. **Hover**：背景色变化 + 轻微位移（translateY(-1~-2px)）
2. **Active**：轻压 `scale(0.97)`
3. **Focus**：清晰焦点环（`focus-visible`，无障碍必须）
4. **Loading**：骨架屏或脉冲动画
5. **页面加载**：元素交错淡入（stagger delay）

## 性能纪律
- 动画只动 `transform` / `opacity`，禁动 `width/height/top/left`
- 大量卡片 hover 用 `will-change: transform`
- 动效都有意义：每个动画都在传达信息，不炫技

## 示例：stagger 入场
```css
.reveal { opacity: 0; transform: translateY(16px); animation: rise 400ms var(--ease-decelerate) forwards; }
.reveal:nth-child(1) { animation-delay: .05s; }
.reveal:nth-child(2) { animation-delay: .12s; }
.reveal:nth-child(3) { animation-delay: .19s; }
@keyframes rise { to { opacity: 1; transform: translateY(0); } }
```
