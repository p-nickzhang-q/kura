import type { ContentType, FieldKey, FileInfo, Metadata } from "../domain/types";
import type { Library } from "../domain/materialize";
import type { Db } from "./driver";
import { AppError, EXIT } from "../exit";

export interface ItemRow {
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
    actors: stringify(metadata.actors),
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
}

export function rowToLibrary(row: LibraryRow): Library {
  return {
    id: row.id,
    name: row.name,
    root: row.root,
    template: row.template,
    // 老库升上来时列可能存在但为 NULL, 统一按"允许整理"处理。
    organizeEnabled: row.organize_enabled !== 0,
  };
}

export function listLibraries(db: Db): Library[] {
  return db.all<LibraryRow>("select id, name, root, template, organize_enabled from libraries order by name").map(rowToLibrary);
}

export function findLibrary(db: Db, ref: string): Library | undefined {
  const byId = Number(ref);
  const row = Number.isInteger(byId)
    ? db.get<LibraryRow>("select id, name, root, template, organize_enabled from libraries where id = ?", [byId])
    : undefined;
  const found =
    row ??
    db.get<LibraryRow>("select id, name, root, template, organize_enabled from libraries where name = ?", [ref]);
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

export function createLibrary(
  db: Db,
  input: { name: string; root: string; template?: string; organizeEnabled?: boolean },
): Library {
  // 同一个目录建两个库毫无意义, 而且会让同一批文件被索引两遍。
  const existing = db.get<{ name: string }>("select name from libraries where root = ?", [input.root]);
  if (existing) {
    throw new AppError(`这个目录已经是媒体库「${existing.name}」了`, EXIT.USAGE, {
      root: input.root,
      library: existing.name,
    });
  }

  const name = uniqueLibraryName(db, input.name);

  db.run("insert into libraries (name, root, template, organize_enabled) values (?, ?, ?, ?)", [
    name,
    input.root,
    input.template ?? "{content_type}/{studio}/{number}",
    input.organizeEnabled === false ? 0 : 1,
  ]);
  const row = db.get<LibraryRow>(
    "select id, name, root, template, organize_enabled from libraries where name = ?",
    [name],
  )!;
  return rowToLibrary(row);
}

export function updateLibraryOrganize(db: Db, libraryId: number, enabled: boolean): void {
  db.run("update libraries set organize_enabled = ? where id = ?", [enabled ? 1 : 0, libraryId]);
}

export function updateLibraryTemplate(db: Db, libraryId: number, template: string): void {
  db.run("update libraries set template = ? where id = ?", [template, libraryId]);
}

export function pinnedFields(db: Db, number: string): FieldKey[] {
  const row = db.get<{ pinned: string | null }>("select pinned from items where number = ?", [number]);
  return (parseJson<FieldKey[]>(row?.pinned ?? null) ?? []) as FieldKey[];
}
