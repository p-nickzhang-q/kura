import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 界面能筛的每个字段, 主进程都必须真的转给 core。
 *
 * 这条测试是被真事故逼出来的: `item:list` 的处理器里把筛选条件一个个抄了一遍,
 * 加 `state`（只看未刮削）和 `sort`（表头排序）时忘了同步, 结果界面点了没反应 ——
 * 通道存在、类型都过、`ipc-channels.test.ts` 也发现不了, 因为它只查通道名。
 */
const root = join(import.meta.dir, "..");
const core = readFileSync(join(root, "packages/core/src/tasks/scrape.ts"), "utf8");
const main = readFileSync(join(root, "apps/desktop/electron/main.ts"), "utf8");

/** 从 ListItemOptions 接口里抠出可筛选的字段名。 */
function listItemFields(): string[] {
  const block = core.slice(core.indexOf("export interface ListItemOptions"));
  const body = block.slice(block.indexOf("{") + 1, block.indexOf("\n}"));
  return [...body.matchAll(/^\s{2}([a-z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]!);
}

describe("item:list 参数转发", () => {
  test("ListItemOptions 的每个字段都在主进程里转发了", () => {
    const fields = listItemFields();
    expect(fields.length).toBeGreaterThan(10);
    const handler = main.slice(main.indexOf('ipcMain.handle("item:list"'));
    const handlerBody = handler.slice(0, handler.indexOf("});"));
    const dropped = fields.filter((field) => !new RegExp(`\\b${field}: input\\.${field}\\b`).test(handlerBody));
    expect(dropped).toEqual([]);
  });
});
