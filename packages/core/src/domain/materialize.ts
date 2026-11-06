import { readdir, rmdir } from "node:fs/promises";
import { copyFile, mkdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { CONTENT_TYPE_LABEL, type FileInfo, type LibraryDomain, type Metadata } from "./types";

export interface Library {
  id: number;
  name: string;
  root: string;
  /** 库的域: av(番号制) / video(影视)。建库时落定, 不可改 —— 它决定识别方式、来源与模板。 */
  domain: LibraryDomain;
  /** 相对目录模板, 占位符见 renderTemplate。 */
  template: string;
  /** false = 只索引, 不允许移动/改名/写 NFO。默认视为允许。 */
  organizeEnabled?: boolean;
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
  /** 已缓存的本地海报 (竖版); 没有就不产生 copy-image 条目。 */
  posterPath?: string;
  /** 已缓存的本地缩略图 (横版); 没有就退回用海报那张。 */
  thumbPath?: string;
}

const ILLEGAL = /[\\/:*?"<>|]/g;

/** 占位符替换 + 文件名消毒。空值渲染成空串, 由调用方决定是否兜底。 */
export function renderTemplate(template: string, metadata: Metadata, phase?: FileInfo): string {
  const values: Record<string, string> = {
    number: metadata.number ?? metadata.key,
    // 目录名用原文: 翻译是可选的展示层, 不能让已整理好的路径因为"翻了个标题"而改名。
    title: metadata.titleOriginal ?? metadata.title ?? "",
    title_zh: metadata.titleOriginal ? (metadata.title ?? "") : "",
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
    .replace(/\{(\w+)\}/g, (_, key: string) => sanitizeName(values[key] ?? ""))
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join(sep);
}

/** 文件名/目录名消毒。导出给影视域的整理复用 —— 两处规则必须一样。 */
export function sanitizeName(value: string): string {
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
  field("originaltitle", metadata.titleOriginal ?? metadata.number ?? metadata.key);
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

    // 图片按 Emby/Kodi 的命名约定: 竖版 `<视频名>-poster.<ext>`, 横版 `<视频名>-thumb.<ext>`。
    let thumbFile: string | undefined;
    if (input.posterPath) {
      const extension = extname(input.posterPath) || ".jpg";
      const posterName = `${baseName}-poster${extension}`;
      entries.push({ action: "copy-image", from: input.posterPath, to: resolve(join(root, directory, posterName)) });
      summary.copyImage++;
      thumbFile = posterName;
    }

    // 缩略图单独一张; 和海报是同一个文件时不再复制第二次。
    if (input.thumbPath && input.thumbPath !== input.posterPath) {
      const extension = extname(input.thumbPath) || ".jpg";
      const thumbName = `${baseName}-thumb${extension}`;
      entries.push({ action: "copy-image", from: input.thumbPath, to: resolve(join(root, directory, thumbName)) });
      summary.copyImage++;
      thumbFile = thumbName;
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
        // 图片已经在目标位置 (整理过的库再跑一遍): 不复制, 否则等于自己覆盖自己
        if (resolve(entry.from) !== resolve(entry.to)) await copyFile(entry.from, entry.to);
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

export interface PruneResult {
  /** 真的删掉的空目录 (由深到浅)。 */
  removed: string[];
  /** 删掉的 Kura 自己生成的文件 (旧目录里剩下的海报 / tvshow.nfo / 集 nfo)。 */
  removedFiles: string[];
  /** 还有别人的东西, 所以没删的目录, 附上前几个文件名 —— 让人知道该不该自己清。 */
  leftover: { dir: string; files: string[] }[];
}

/** Kura 自己写进目录的图片名。老目录里只剩这些时, 删掉它们不算动用户的东西。 */
const KURA_IMAGE_NAMES = new Set(["poster.jpg", "poster.png", "fanart.jpg", "fanart.png", "thumb.jpg", "thumb.png", "folder.jpg"]);

/**
 * 整理之后清掉被搬空的源目录。
 *
 * 分两步, 顺序很重要:
 *  1. 先删**Kura 自己生成的残留** —— 剧目录里的 `poster.jpg` / `fanart.jpg`、
 *     已经搬走的影片的 `<视频名>.nfo` / `<视频名>-poster.jpg`。
 *     (用户先「下载图片」再「整理」, 图就留在老目录里, 目录永远不空 —— 真事故。)
 *  2. 再 `rmdir`。非空就说明还有用户的文件(字幕、认不出集号的片子), 留着并报出来。
 *
 * 绝不碰: 字幕、别的 nfo、认不出集号的文件、子目录。整理只负责搬影片, 不替人删东西。
 */
export async function pruneEmptyDirs(
  roots: string[],
  moved: { dir: string; bases: string[] }[],
): Promise<PruneResult> {
  const result: PruneResult = { removed: [], removedFiles: [], leftover: [] };
  const normalizedRoots = roots.map((root) => resolve(root));
  const inside = (path: string): boolean =>
    normalizedRoots.some((root) => path.startsWith(`${root}${sep}`) && path !== root);

  const basesByDir = new Map<string, Set<string>>();
  for (const item of moved) {
    const dir = resolve(item.dir);
    const set = basesByDir.get(dir) ?? new Set<string>();
    for (const base of item.bases) set.add(base.toLowerCase());
    basesByDir.set(dir, set);
  }

  // 由深到浅: 先清最里层, 清了才有机会清掉父目录
  const queue = new Set<string>();
  for (const item of moved) {
    let current = resolve(item.dir);
    while (inside(current)) {
      queue.add(current);
      current = dirname(current);
    }
  }
  const ordered = [...queue].sort((a, b) => b.split(sep).length - a.split(sep).length);

  for (const dir of ordered) {
    const bases = basesByDir.get(dir) ?? new Set<string>();
    // 第一步: 清掉 Kura 生成的残留
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // 已经不在了(被父目录带走)
    }
    for (const name of entries) {
      if (!isKuraArtifact(name, bases)) continue;
      try {
        await unlink(join(dir, name));
        result.removedFiles.push(join(dir, name));
      } catch {
        // 删不掉就算了, 下面 rmdir 会失败并把它列进 leftover
      }
    }

    // 第二步: 目录空了才删
    try {
      await rmdir(dir);
      result.removed.push(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      try {
        const files = await readdir(dir);
        result.leftover.push({ dir, files: files.slice(0, 5) });
      } catch {
        result.leftover.push({ dir, files: [] });
      }
    }
  }
  return result;
}

/**
 * 这个文件是不是 Kura 为了**已经搬走的影片**写的?
 *
 * 只看名字, 不看内容 —— 判据越窄越好: `poster.jpg` 这类固定名, 或者
 * `base.nfo` / `base-poster.jpg` / `base-thumb.jpg` 且 base 正是刚搬走的那几个。
 */
export function isKuraArtifact(
  name: string,
  movedBases: Set<string> = new Set(),
  options: { orphanNfo?: boolean } = {},
): boolean {
  const lower = name.toLowerCase();
  if (KURA_IMAGE_NAMES.has(lower)) return true;
  if (lower === "tvshow.nfo") return true;
  const match = /^(.*?)(-poster|-thumb)?\.(nfo|jpg|jpeg|png|webp)$/.exec(lower);
  if (!match) return false;
  const base = match[1]!;
  if (movedBases.has(base)) return true;
  // `orphanNfo`: 这个目录里**一个影片都没有**时, 任何 .nfo 都是断了线的元数据
  // (它的影片已经搬走/删掉了)。`cleanup` 用这个口径, 整理时不用 —— 整理只认刚搬走的那几个。
  return options.orphanNfo === true && match[3] === "nfo" && !base.startsWith("-");
}
