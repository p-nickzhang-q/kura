import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HttpClient } from "../net/http";
import type { RawFields } from "../domain/types";
import { createDmmSource, type DmmEnv } from "./dmm";
import { createJav321Source } from "./jav321";
import { createJavdbSource } from "./javdb";
import { createJavbusSource } from "./javbus";
import type { Source } from "./types";

/**
 * 离线来源: 从 `fixturesDir/<站点键>.json` 读一份 RawFields。
 *
 * 存在的理由不是"测试专用", 而是: 站点会挂、会改版、会被墙,
 * 而聚合与整理必须能在没有网络的情况下被验证。它也是新增站点的样板。
 */
export const fixtureSource: Source = {
  id: "fixture",
  label: "离线样本",
  status: "ready",
  contentTypes: "all",
  requirements: () => [],
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
 * 尚未实现的站点。**故意标 todo**: 未实现的抓取不参与运行,
 * `source list` 会如实显示, `scrape` 会跳过并报告。
 */
function unimplemented(id: string, label: string, contentTypes: Source["contentTypes"]): Source {
  return {
    id,
    label,
    status: "todo",
    contentTypes,
    requirements: () => [],
    async fetch() {
      throw new Error(`来源 ${id} 尚未实现`);
    },
  };
}

export interface SourceConfig {
  dmm: DmmEnv;
}

export function createSources(http: HttpClient, config: SourceConfig): Source[] {
  return [
    createDmmSource(http, config.dmm),
    createJavbusSource(http),
    createJavdbSource(http),
    createJav321Source(http),
    fixtureSource,
  ];
}
