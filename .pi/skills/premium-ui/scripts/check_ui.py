#!/usr/bin/env python3
"""
check_ui.py — UI Design System 硬校验（纯 stdlib，无依赖）

用法:
  python check_ui.py contrast <fg> <bg>    # WCAG 对比度 AA/AAA 判定
  python check_ui.py audit <file.html>     # 扫描 HTML/CSS 违规清单
  python check_ui.py --version
"""
import re
import sys

# Windows 控制台编码兜底，避免中文输出乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------- 对比度
def hex_to_rgb(h: str):
    h = h.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6 or any(c not in "0123456789abcdefABCDEF" for c in h):
        raise ValueError(f"无效 hex: #{h}")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def rel_luminance(rgb):
    def f(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (f(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(fg: str, bg: str) -> float:
    l1, l2 = rel_luminance(hex_to_rgb(fg)), rel_luminance(hex_to_rgb(bg))
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def cmd_contrast(fg: str, bg: str):
    try:
        r = contrast_ratio(fg, bg)
    except ValueError as e:
        print(f"错误: {e}")
        sys.exit(1)
    ok = lambda x: "通过 ✓" if x else "不通过 ✗"
    print(f"{fg} vs {bg}   对比度 = {r:.2f}:1")
    print(f"  WCAG AA 正文 (4.5:1): {ok(r >= 4.5)}")
    print(f"  WCAG AA 大号文字/AAA (7:1): {ok(r >= 7.0)}")
    print(f"  WCAG AA UI组件/图标 (3:1): {ok(r >= 3.0)}")


# ---------------------------------------------------------------- audit
GRID = 4  # 4/8pt 网格，间距必须是 4 的倍数
HEX_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b")
CHEAP_SHADOW = re.compile(
    r"box-shadow\s*:\s*[^;}]*?rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.5\s*\)",
    re.IGNORECASE,
)
PX = re.compile(r"(\d+)\s*px")
# 间距只扫描这些属性，避免把字号/圆角误报为网格违规
SPACING_PROP = re.compile(
    r"(?:margin|padding|gap|inset|top|right|bottom|left)\s*:\s*([^;}]+)",
    re.IGNORECASE,
)
FONT_SIZE = re.compile(r"font-size\s*:\s*(\d+)\s*px", re.IGNORECASE)
# 触控目标：简单交互选择器（不含子选择器）块内的 height，或 <a>/<button> 的内联 height
TOUCH_CSS = re.compile(
    r"([^{} ]*?(?:btn|button|input|select|tab|link|cta|menu)[^{} ]*?)\s*\{[^}]*?height\s*:\s*(\d+)px",
    re.IGNORECASE,
)
TOUCH_INLINE = re.compile(r'<(?:a|button)[^>]*style="[^"]*height:\s*(\d+)px', re.IGNORECASE)


def audit(path: str):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        print(f"无法读取 {path}: {e}")
        sys.exit(1)

    issues = []

    # 1. 廉价阴影
    for m in CHEAP_SHADOW.finditer(text):
        issues.append(f"廉价阴影: 「{m.group(0).strip()[:50]}…」 应改两层克制阴影")

    # 2. 间距是否 4pt 网格（只查间距属性，不查字号/圆角）
    off = sorted({
        int(v)
        for m in SPACING_PROP.finditer(text)
        for v in PX.findall(m.group(1))
        if int(v) % GRID != 0 and int(v) >= 4
    })
    if off:
        issues.append(f"间距偏离 {GRID}pt 网格: {off}（如 10px/14px 改 8/16px）")

    # 3. 触控目标 < 44px（只查交互元素）
    small = sorted({
        int(h)
        for h in [m.group(2) for m in TOUCH_CSS.finditer(text)]
        + [m.group(1) for m in TOUCH_INLINE.finditer(text)]
        if 12 <= int(h) < 44
    })
    if small:
        issues.append(f"触控高度 <44px: {small}（Apple HIG 要求 ≥44px）")

    # 4. 字号 < 12px
    tiny = sorted({int(v) for v in FONT_SIZE.findall(text) if int(v) < 12})
    if tiny:
        issues.append(f"字号 <12px: {tiny}（可读性风险）")

    # 5. 颜色数量 > 16
    colors = {c.upper() for c in HEX_RE.findall(text)}
    if len(colors) > 16:
        issues.append(f"颜色数量 {len(colors)} > 16，色彩失控")

    # 6. 无障碍焦点态缺失
    if "focus-visible" not in text and "focus" not in text.lower():
        issues.append("未检测到 focus 焦点样式（无障碍必须）")

    if not issues:
        print("✅ audit 通过：0 项违规")
        return 0
    print(f"⚠️  发现 {len(issues)} 项违规:")
    for i, it in enumerate(issues, 1):
        print(f"  {i}. {it}")
    return 1


# ---------------------------------------------------------------- main
def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if args[0] == "--version":
        print("check_ui.py 1.0.0")
        return 0
    if args[0] == "contrast":
        if len(args) < 3:
            print("用法: check_ui.py contrast <fg> <bg>")
            return 1
        cmd_contrast(args[1], args[2])
        return 0
    if args[0] == "audit":
        if len(args) < 2:
            print("用法: check_ui.py audit <file>")
            return 1
        return audit(args[1])
    print(f"未知命令: {args[0]}")
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
