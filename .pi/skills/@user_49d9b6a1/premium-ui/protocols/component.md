# Component Design Protocol

适用于单一组件：按钮、卡片、导航栏、输入框、表单、Modal、Toast、Tab、Chip、Avatar、列表等。

## 输出标准（缺一不可）
- **所有状态变体**：Default / Hover / Active / Focus(visible) / Disabled / Loading
- **Dark Mode 变体**（或明暗两版）
- **使用示例**（至少一个真实用法）
- **代码直接可用**，无额外依赖（除非用户指定框架）

## 组件清单（常用，读取 references/components.md 拿代码）
- 按钮：Filled > Filled Tonal > Outlined > Text > Icon（层级关系）
- 卡片：Elevated / Filled / Outlined 三种变体
- 输入框：Outlined（M3）/ Apple 风格两种
- 状态标签：Chip（信息/成功/警告/错误）

## 校验
单组件也要过：
```bash
python scripts/check_ui.py audit <component.html>
```
重点核对：触控 ≥44px、focus-visible 存在、间距为 4 的倍数。
