import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawFields } from "../domain/types";
import type { Source } from "./types";

/**
 * 离线来源: 从 `fixturesDir/<站点键>.json` 读一份 RawFields。
 *
 * 存在的理由不是"测试专用", 而是: 站点实现会挂、会改版、会被墙,
 * 而聚合与整理必须能在没有网络的情况下被验证。它也是新增站点的样板。
 */
export const fixtureSource: Source = {
  id: "fixture",
  label: "离线样本",
  status: "ready",
  contentTypes: "all",
  async fetch(key, ctx) {
    if (!ctx.fixturesDir) return null;
    const file = join(ctx.fixturesDir, `${key.value.replace(/[:/\\]/g, "_")}.json`);
    try {
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw) as RawFields;
    } catch {
      return null;
    }
  },
};

/**
 * 三个真实站点。**故意标 todo**: 未实现的抓取代码不参与运行,
 * `source list` 会如实显示, `scrape` 会跳过并报告。
 * 补实现时只改这一个文件 + 各自的解析函数, 聚合与整理不用动。
 */
function unimplemented(id: string, label: string, contentTypes: Source["contentTypes"]): Source {
  return {
    id,
    label,
    status: "todo",
    contentTypes,
    async fetch() {
      throw new Error(`来源 ${id} 尚未实现`);
    },
  };
}

export const javdbSource = unimplemented("javdb", "JavDB", "all");
export const javbusSource = unimplemented("javbus", "JavBus", ["censored", "uncensored", "fc2", "amateur"]);
export const dmmSource = unimplemented("dmm", "DMM", ["censored", "anime"]);
