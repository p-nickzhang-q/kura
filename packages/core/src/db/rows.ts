import {
  isDomain,
  isLibraryDomain,
  type ContentType,
  type FieldKey,
  type FileInfo,
  type LibraryDomain,
  type Metadata,
} from "../domain/types";
import type { Library } from "../domain/materialize";
import { sanitizeActorNames } from "../domain/actors";
import { resolve, sep } from "node:path";
import type { Db } from "./driver";
import { volumeFingerprint } from "./volume";
import { AppError, EXIT } from "../exit";

export interface ItemRow {
  domain?: string | null;
  number: string;
  content_type: string;
  title: string | null;
  title_original: string | null;
  plot_original: string | null;
  plot: string | null;
  release_date: string | null;
  duration_min: number | null;
  studio: string | null;
  label: string | null;
  series: string | null;
  directors: string | null;
  actors: string | null;
  tags: string | null;
  poster_urls: string | null;
  cover_urls: string | null;
  thumb_urls: string | null;
  field_sources: string | null;
  pinned: string | null;
}

export interface MediaFileRow {
  path: string;
  /** 影视域的集号; av 域为 null。 */
  season?: number | null;
  episode?: number | null;
  library_id: number;
  number: string | null;
  size: number;
  mtime_ms: number;
  sha256: string | null;
  phase: string | null;
}

export function rowToMetadata(row: ItemRow): Metadata {
  return {
    key: row.number,
    number: row.number,
    contentType: row.content_type as ContentType,
    domain: isDomain(row.domain) ? row.domain : "av",
    title: row.title ?? undefined,
    titleOriginal: row.title_original ?? undefined,
    plotOriginal: row.plot_original ?? undefined,
    plot: row.plot ?? undefined,
    release_date: row.release_date ?? undefined,
    duration_min: row.duration_min ?? undefined,
    studio: row.studio ?? undefined,
    label: row.label ?? undefined,
    series: row.series ?? undefined,
    directors: parseJson<string[]>(row.directors),
    actors: parseJson<string[]>(row.actors),
    tags: parseJson<string[]>(row.tags),
    poster_urls: parseJson<string[]>(row.poster_urls),
    cover_urls: parseJson<string[]>(row.cover_urls),
    thumb_urls: parseJson<string[]>(row.thumb_urls),
    fieldSources: parseJson<Record<string, string>>(row.field_sources) ?? {},
  };
}

export function metadataColumns(metadata: Metadata): Record<string, unknown> {
  return {
    number: metadata.key,
    content_type: metadata.contentType,
    title: metadata.title ?? null,
    title_original: metadata.titleOriginal ?? null,
    plot_original: metadata.plotOriginal ?? null,
    plot: metadata.plot ?? null,
    release_date: metadata.release_date ?? null,
    duration_min: metadata.duration_min ?? null,
    studio: metadata.studio ?? null,
    label: metadata.label ?? null,
    series: metadata.series ?? null,
    directors: stringify(metadata.directors),
    // 占位文本 (未知演员 / N/A) 在入库前就丢掉 —— 它进索引后会变成一个点不出结果的假演员。
    actors: stringify(sanitizeActorNames(metadata.actors)),
    tags: stringify(metadata.tags),
    poster_urls: stringify(metadata.poster_urls),
    cover_urls: stringify(metadata.cover_urls),
    thumb_urls: stringify(metadata.thumb_urls),
    field_sources: stringify(metadata.fieldSources),
  };
}

export function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function stringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export function parsePhase(value: string | null): FileInfo {
  return (
    parseJson<FileInfo>(value) ?? {
      cd: null,
      part: null,
      hasSubtitle: false,
      mosaic: null,
      definition: null,
    }
  );
}

export interface LibraryRow {
  id: number;
  name: string;
  root: string;
  template: string;
  organize_enabled?: number;
  domain?: string | null;
  volume_id?: string | null;
}

export function rowToLibrary(row: LibraryRow): Library {
  return {
    id: row.id,
    name: row.name,
    root: row.root,
    template: row.template,
    // 老库升上来时列可能存在但为 NULL, 统一按"允许整理"处理。
    organizeEnabled: row.organize_enabled !== 0,
    // v9 之前建的库没有 domain 列, 一律是番号制; v11 把 movie/tv 并成 video
    domain: isLibraryDomain(row.domain) ? row.domain : "av",
    // v14 之前建的库没有卷指纹, 下次扫描时补记(见 db/volume.ts)
    volumeId: row.volume_id ?? null,
  };
}

export function listLibraries(db: Db): Library[] {
  return db.all<LibraryRow>("select id, name, root, template, organize_enabled, domain, volume_id from libraries order by name").map(rowToLibrary);
}

export function findLibrary(db: Db, ref: string): Library | undefined {
  const byId = Number(ref);
  const row = Number.isInteger(byId)
    ? db.get<LibraryRow>("select id, name, root, template, organize_enabled, domain, volume_id from libraries where id = ?", [byId])
    : undefined;
  const found =
    row ??
    db.get<LibraryRow>("select id, name, root, template, organize_enabled, domain, volume_id from libraries where name = ?", [ref]);
  return found ? rowToLibrary(found) : undefined;
}

/**
 * 库名撞名时自动加序号: `Download` → `Download (2)`。
 *
 * 界面里的库名来自目录名 (basename), 而 `D:\Download\a\Download` 与 `E:\Download`
 * 必然撞名 —— 这是常态, 不该让用户看到 SQLite 的错误原文。
 */
function uniqueLibraryName(db: Db, base: string): string {
  const taken = new Set(db.all<{ name: string }>("select name from libraries").map((row) => row.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * 每个域有自己的默认整理模板。
 *
 * `av` 的 `{content_type}/{studio}/{number}` 对影视毫无意义(影视没有 content_type),
 * 照抄会生成一堆叫 "censored" 的目录。
 */
export function defaultTemplateFor(domain: LibraryDomain): string {
  // 影视库的模板到 v2(organize)才真正用上; 到时要按条目类型分支(剧多一层 Season)
  return domain === "video" ? "{series}" : "{content_type}/{studio}/{number}";
}

/**
 * 两个目录是否重叠(相等, 或一个在另一个里面)。
 *
 * 用 `resolve` 归一化再比前缀: 用户输入常带尾斜杠、`..`、大小写差异,
 * 直接字符串比会让 `D:\lib` 与 `D:\lib\` 看起来毫无关系。
 */
function overlaps(a: string, b: string): boolean {
  const left = resolveForCompare(a);
  const right = resolveForCompare(b);
  if (left === right) return true;
  return left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

function resolveForCompare(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, "");
  // Windows 盘符不区分大小写
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function createLibrary(
  db: Db,
  input: { name: string; root: string; template?: string; organizeEnabled?: boolean; domain?: LibraryDomain },
): Library {
  // 同一个目录建两个库毫无意义, 而且会让同一批文件被索引两遍。
  const existing = db.get<{ name: string }>("select name from libraries where root = ?", [input.root]);
  if (existing) {
    throw new AppError(`这个目录已经是媒体库「${existing.name}」了`, EXIT.USAGE, {
      root: input.root,
      library: existing.name,
    });
  }

  // 跨域的目录重叠必须拒(ADR 0008 决策 2): 两个域的整理模板互相冲突, 重叠会互相搬家。
  // 同域重叠只警告不拦 —— 老用户可能真有父子目录两个番号库, 不该因为升级就建不了库。
  const domain = input.domain ?? "av";
  for (const other of listLibraries(db)) {
    if (other.domain === domain) continue;
    if (!overlaps(input.root, other.root)) continue;
    throw new AppError(
      `目录与「${other.name}」(${other.domain} 域)重叠, 同一个目录不能同时属于两个域`,
      EXIT.USAGE,
      { root: input.root, conflictsWith: other.name, otherRoot: other.root, otherDomain: other.domain },
    );
  }

  const name = uniqueLibraryName(db, input.name);

  db.run("insert into libraries (name, root, template, organize_enabled, domain) values (?, ?, ?, ?, ?)", [
    name,
    input.root,
    input.template ?? defaultTemplateFor(input.domain ?? "av"),
    input.organizeEnabled === false ? 0 : 1,
    input.domain ?? "av",
  ]);
  const row = db.get<LibraryRow>(
    "select id, name, root, template, organize_enabled, domain, volume_id from libraries where name = ?",
    [name],
  )!;
  return rowToLibrary(row);
}

/** 改名: 显式给的名字撞名时报错, 不自动加序号 —— 人已经明确指定了, 静默改名字更奇怪。 */
export interface DeleteLibraryResult {
  library: Library;
  /** 从索引里删掉的文件数 (磁盘上一个都没动)。 */
  removedFiles: number;
  /** 删完没有任何文件指向的条目数 —— 条目本身**不删**, 只是不再出现在这个库里。 */
  orphanItems: number;
}

/**
 * 删库: **只删索引, 不动磁盘**。
 *
 * `media_files` 随库级联删除, 但 `items` 保留 —— 条目是跨库的(同一部片可能在两个库里
 * 都有文件), 删库不该顺手把元数据抹了。删完没人指向的条目依然能被刮削/手动补文件。
 */
export function deleteLibrary(db: Db, libraryId: number): DeleteLibraryResult {
  const row = db.get<LibraryRow>(
    "select id, name, root, template, organize_enabled, domain, volume_id from libraries where id = ?",
    [libraryId],
  );
  if (!row) throw new AppError(`媒体库不存在: ${libraryId}`, EXIT.NOT_FOUND, { libraryId });
  const library = rowToLibrary(row);

  const removedFiles = db.get<{ n: number }>("select count(*) as n from media_files where library_id = ?", [libraryId])?.n ?? 0;
  db.exec("begin");
  try {
    db.run("delete from libraries where id = ?", [libraryId]);
    db.exec("commit");
  } catch (err) {
    db.exec("rollback");
    throw err;
  }

  // 全局(跨库)没有任何文件指向的条目数 —— 只报数, 不删
  const orphanItems =
    db.get<{ n: number }>(
      "select count(*) as n from items i where not exists (select 1 from media_files mf where mf.number = i.number)",
    )?.n ?? 0;

  return { library, removedFiles, orphanItems };
}

export function renameLibrary(db: Db, libraryId: number, name: string): Library {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError("库名不能为空", EXIT.USAGE);

  const clash = db.get<{ name: string }>("select name from libraries where name = ? and id <> ?", [trimmed, libraryId]);
  if (clash) {
    throw new AppError(`已经有叫「${trimmed}」的库了, 换个名字`, EXIT.USAGE, { name: trimmed });
  }

  db.run("update libraries set name = ? where id = ?", [trimmed, libraryId]);
  const row = db.get<LibraryRow>(
    "select id, name, root, template, organize_enabled, domain, volume_id from libraries where id = ?",
    [libraryId],
  )!;
  return rowToLibrary(row);
}

export function updateLibraryOrganize(db: Db, libraryId: number, enabled: boolean): void {
  db.run("update libraries set organize_enabled = ? where id = ?", [enabled ? 1 : 0, libraryId]);
}

export function updateLibraryTemplate(db: Db, libraryId: number, template: string): void {
  // 影视库**不看模板**: 整理按条目类型走固定形状(剧两层 + Season、电影一层)。
  // 允许写进去只会让人以为"这个维度生效了", 而实际什么都没变。
  const row = db.get<{ domain: string }>("select domain from libraries where id = ?", [libraryId]);
  if (row?.domain === "video") {
    throw new AppError("影视库按条目类型固定形状整理, 没有维度可选", EXIT.USAGE, {
      libraryId,
      hint: "剧: 剧名 (年份)/Season 01/SxxEyy; 电影: 片名 (年份)/片名.ext",
    });
  }
  db.run("update libraries set template = ? where id = ?", [template, libraryId]);
}

export function pinnedFields(db: Db, number: string): FieldKey[] {
  const row = db.get<{ pinned: string | null }>("select pinned from items where number = ?", [number]);
  return (parseJson<FieldKey[]>(row?.pinned ?? null) ?? []) as FieldKey[];
}
