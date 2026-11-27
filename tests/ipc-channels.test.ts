import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * preload 暴露的每个通道, 主进程都必须有对应 handler。
 *
 * 这条测试是被真事故逼出来的: 一次整块替换把 item:list / item:get / item:update /
 * files:unparsed 四个 handler 一起删掉了, 而 typecheck 与单元测试全绿 —— 只有真的点界面
 * 才会发现。渲染进程与主进程之间没有类型约束, 所以用文件扫描兜住。
 */
const root = join(import.meta.dir, "..");
const preload = readFileSync(join(root, "apps/desktop/electron/preload.cjs"), "utf8");
const main = readFileSync(join(root, "apps/desktop/electron/main.ts"), "utf8");

function channels(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]!).sort();
}

/**
 * 主进程注册通道的两种写法都要认。
 *
 * `registerIpc()` 里为了量慢 IPC 耗时, 统一改走一个本地 `handle()` 包装 (见 main.ts
 * 的 logSlowIpc); 包装自己调的是 `ipcMain.handle`。只匹配其中一种就会把另一批通道
 * 当成"没注册"。
 */
const HANDLE_PATTERN = /^\s*(?:ipcMain\.)?handle\(\s*"([^"]+)"/gm;

describe("IPC 通道契约", () => {
  test("preload 调用的每个通道都在主进程注册了", () => {
    const invoked = channels(preload, /ipcRenderer\.invoke\("([^"]+)"/g);
    const handled = new Set(channels(main, HANDLE_PATTERN));
    expect(invoked.length).toBeGreaterThan(10);
    expect(invoked.filter((channel) => !handled.has(channel))).toEqual([]);
  });

  test("主进程没有登记了却没人调用的死通道", () => {
    const invoked = new Set(channels(preload, /ipcRenderer\.invoke\("([^"]+)"/g));
    const handled = channels(main, HANDLE_PATTERN);
    expect(handled.filter((channel) => !invoked.has(channel))).toEqual([]);
  });

  test("推送类通道(preload 订阅 / 主进程发送)成对出现", () => {
    const listened = channels(preload, /ipcRenderer\.on\("([^"]+)"/g);
    const sent = channels(main, /webContents\.send\("([^"]+)"/g);
    // 同一通道可以在多处发送(例如「重跑」也推进度), 所以比的是集合而不是出现次数。
    expect([...new Set(listened)]).toEqual([...new Set(sent)]);
  });
});
