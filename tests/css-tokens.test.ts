import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 界面的 CSS 变量必须都有定义。
 *
 * 这条测试是被真 bug 逼出来的: `--panel-2` / `--panel-3` / `--line-strong`
 * 只有引用没有定义, `var()` 解析失败不会报错, 会静默退回继承值 —— 表现为
 * 选中行没底色、主按钮文字变成浅色压在蓝底上 (2.58:1)。typecheck 与
 * audit 脚本都看不见这种问题。
 */
const app = readFileSync(join(import.meta.dir, "..", "apps/desktop/src/App.vue"), "utf8");

const defined = new Set([...app.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!));
const used = new Set([...app.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));

describe("CSS 设计令牌", () => {
  test("每个 var(--x) 都在 :root 里定义过", () => {
    const missing = [...used].filter((name) => !defined.has(name)).sort();
    expect(missing).toEqual([]);
  });

  test("没有只定义不使用的死令牌", () => {
    const unused = [...defined].filter((name) => !used.has(name)).sort();
    expect(unused).toEqual([]);
  });
});
