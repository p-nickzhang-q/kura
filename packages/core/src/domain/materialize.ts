import { copyFile, mkdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { CONTENT_TYPE_LABEL, type FileInfo, type Metadata } from "./types";

export interface Library {
  id: number;
  name: string;
  root: string;
  /** 相对目录模板, 占位符见 renderTemplate。 */
  template: string;
}

export type PlanAction = "move" | "write-nfo" | "copy-image" | "skip";

export interface PlanEntry {
  action: PlanAction;
  from?: string;
  to?: string;
  /** 写 NFO 时内联内容, 让 Plan 自包含、可序列化、可给人看。 */
  content?: string;
  reason?: string;
}

export interface Plan {
  libraryId: number;
  libraryRoot: string;
  entries: PlanEntry[];
  summary: { move: number; writeNfo: number; copyImage: number; skip: number };
}

export interface PlanInput {
  path: string;
  metadata: Metadata;
  phase: FileInfo;
  /** 已缓存的本地海报; 没有就不产生 copy-image 条目。 */
  posterPath?: string;
}

const ILLEGAL = /[\\/:*?"<>|]/g;

/** 占位符替换 + 文件名消毒。空值渲染成空串, 由调用方决定是否兜底。 */
export function renderTemplate(template: string, metadata: Metadata, phase?: FileInfo): string {
  const values: Record<string, string> = {
    number: metadata.number ?? metadata.key,
    title: metadata.title ?? "",
    studio: metadata.studio ?? "",
    label: metadata.label ?? "",
    series: metadata.series ?? "",
    release_date: metadata.release_date ?? "",
    year: (metadata.release_date ?? "").slice(0, 4),
    content_type: CONTENT_TYPE_LABEL[metadata.contentType] ?? metadata.contentType,
    actor: metadata.actors?.[0] ?? "",
    // Amane 的做法: {actor} 取第一, {actors} 全拼。多值不再另造一套语义。
    actors: (metadata.actors ?? []).join("、"),
    cd: phase?.cd ? String(phase.cd) : "",
  };

  return template
    .replace(/\{(\w+)\}/g, (_, key: string) => sanitize(values[key] ?? ""))
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join(sep);
}

function sanitize(value: string): string {
  return value
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120);
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Emby / Jellyfin / Kodi 通用的 movie nfo。 */
export function buildNfo(metadata: Metadata, thumbFile?: string): string {
  const lines: string[] = ['<?xml version="1.0" encoding="utf-8" standalone="yes"?>', "<movie>"];

  const field = (tag: string, value: string | undefined | null): void => {
    if (value && value.trim()) lines.push(`  <${tag}>${escapeXml(value.trim())}</${tag}>`);
  };

  field("title", metadata.title);
  field("originaltitle", metadata.number ?? metadata.key);
  // 相对文件名: NFO 与视频同目录, 这样整个库搬走也不用改。
  field("thumb", thumbFile);
  if (metadata.plot) lines.push(`  <plot>${escapeXml(metadata.plot.trim())}</plot>`);
  field("premiered", metadata.release_date);
  if (metadata.duration_min) lines.push(`  <runtime>${metadata.duration_min}</runtime>`);
  field("studio", metadata.studio);
  field("label", metadata.label);
  field("num", metadata.number ?? metadata.key);
  lines.push(`  <genre>${escapeXml(CONTENT_TYPE_LABEL[metadata.contentType] ?? metadata.contentType)}</genre>`);

  for (const tag of metadata.tags ?? []) field("tag", tag);
  for (const director of metadata.directors ?? []) field("director", director);
  if (metadata.series) lines.push("  <set>", `    <name>${escapeXml(metadata.series)}</name>`, "  </set>");
  for (const actor of metadata.actors ?? []) {
    lines.push("  <actor>", `    <name>${escapeXml(actor)}</name>`, "  </actor>");
  }
  lines.push(`  <uniqueid type="kura" default="true">${escapeXml(metadata.key)}</uniqueid>`);
  lines.push("</movie>");
  return `${lines.join("\n")}\n`;
}

export type TargetState = "free" | "same" | "occupied" | "unknown";

/**
 * 目标位置能否落盘。对应 Amane `organize/file.py::target_state`:
 *  - free      没有东西, 可以搬
 *  - same      目标就是源本身(含硬链/软链), 视为已就位
 *  - occupied  目标被别的文件占用, **绝不覆盖**
 *  - unknown   读不出状态, 不当作被占用, 也不搬
 */
export async function targetState(source: string, target: string): Promise<TargetState> {
  try {
    const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target).catch(() => null)]);
    if (!targetStat) return "free";
    // ino 为 0 的文件系统(部分 Windows 场景)退化为真实路径比较。
    if (sourceStat.ino !== 0 && targetStat.ino !== 0) {
      return sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino ? "same" : "occupied";
    }
    const [sourceReal, targetReal] = await Promise.all([realpath(source), realpath(target)]);
    return sourceReal === targetReal ? "same" : "occupied";
  } catch {
    return "unknown";
  }
}

/**
 * 生成整理计划: 算目标路径、查目标占用、拼 NFO 内容。只读磁盘, 不写。
 * 目标一律限制在库根内 —— 模板被改坏时宁可 skip, 也不能把文件搬出库。
 */
export async function buildPlan(library: Library, inputs: PlanInput[]): Promise<Plan> {
  const root = resolve(library.root);
  const entries: PlanEntry[] = [];
  const summary = { move: 0, writeNfo: 0, copyImage: 0, skip: 0 };

  for (const input of inputs) {
    const directory = renderTemplate(library.template, input.metadata, input.phase);
    const extension = extname(input.path);
    const baseName = input.phase.cd ? `${input.metadata.number ?? input.metadata.key}-cd${input.phase.cd}` : (input.metadata.number ?? input.metadata.key);
    const target = resolve(join(root, directory, `${baseName}${extension}`));

    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      entries.push({ action: "skip", from: input.path, to: target, reason: "目标在库根之外" });
      summary.skip++;
      continue;
    }
    const state = await targetState(input.path, target);
    if (state === "free") {
      entries.push({ action: "move", from: input.path, to: target });
      summary.move++;
    } else {
      const reason =
        state === "same" ? "已在目标位置" : state === "occupied" ? "目标已存在同名文件, 不覆盖" : "无法判断目标状态";
      entries.push({ action: "skip", from: input.path, to: target, reason });
      summary.skip++;
    }

    // 海报按 Emby/Kodi 的命名约定放成 `<视频名>-poster.<ext>`。
    let thumbFile: string | undefined;
    if (input.posterPath) {
      const extension = extname(input.posterPath) || ".jpg";
      const posterName = `${baseName}-poster${extension}`;
      entries.push({ action: "copy-image", from: input.posterPath, to: resolve(join(root, directory, posterName)) });
      summary.copyImage++;
      thumbFile = posterName;
    }

    entries.push({
      action: "write-nfo",
      to: target.replace(/\.[^.]+$/, ".nfo"),
      content: buildNfo(input.metadata, thumbFile),
    });
    summary.writeNfo++;
  }

  return { libraryId: library.id, libraryRoot: root, entries, summary };
}

export interface ApplyResult {
  entry: PlanEntry;
  ok: boolean;
  error?: string;
}

/** 只有这里会动用户的磁盘。默认不调用它 —— Plan 默认 dry-run。 */
export async function applyPlan(plan: Plan): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  const roots = new Set<string>();

  for (const entry of plan.entries) {
    try {
      if (entry.action === "skip") {
        results.push({ entry, ok: true });
        continue;
      }
      if (!entry.to) throw new Error("计划缺少目标路径");

      const directory = dirname(entry.to);
      if (!roots.has(directory)) {
        await mkdir(directory, { recursive: true });
        roots.add(directory);
      }

      if (entry.action === "write-nfo") {
        await writeFile(entry.to, entry.content ?? "", "utf8");
      } else if (entry.action === "copy-image" && entry.from) {
        await copyFile(entry.from, entry.to);
      } else if (entry.action === "move" && entry.from) {
        await moveFile(entry.from, entry.to);
      }
      results.push({ entry, ok: true });
    } catch (err) {
      results.push({ entry, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** 跨设备时 rename 会 EXDEV, 退化为 copy + unlink。 */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyFile(from, to);
    await unlink(from);
  }
}
