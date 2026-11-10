import { statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import type { Db } from "./driver";
import type { Library } from "../domain/materialize";
import { AppError, EXIT } from "../exit";

/**
 * 库的身份 = 目录路径, 而移动硬盘的盘符是谁插上谁占的。
 *
 * 两块 USB 盘轮流套 `E:\视频` 的时候, 路径一模一样、内容全换 —— 光看路径分不出
 * "这是原来那块盘"还是"插错了"。所以建库时记下卷指纹, 每次扫描前对一次。
 *
 * 指纹取 `stat(根).dev`: Windows 上 libuv 填的就是卷序列号(实测 C: 的
 * `dev` 与 `Win32_LogicalDisk.VolumeSerialNumber` 完全一致), 取一次是微秒级,
 * 不需要 spawn `vol` / WMI。Linux 上 `dev` 是设备号, 重启后会变, 所以只在
 * Windows 启用 —— 误报"插错盘"比不报更糟。
 */
export function volumeFingerprint(
  root: string,
  deps: { stat?: typeof statSync; platform?: NodeJS.Platform } = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return null;
  const stat = deps.stat ?? statSync;
  try {
    return stat(root).dev.toString(16).toUpperCase();
  } catch {
    return null;
  }
}

/** 卷的所在盘符, 只为了报错时好读: `E:\视频` → `E:`。 */
function volumeRoot(root: string): string {
  const resolved = resolve(root);
  return dirname(resolved) === resolved ? resolved : resolved.slice(0, resolved.indexOf(sep, resolved.startsWith(sep) ? 1 : 0) + 1);
}

/**
 * 扫描/整理前的两道门。
 *
 * 1. **库根不存在** → 直接拒。以前靠"消失超过 30% 才拦"兜底, 但文件数少于 20 的库
 *    在那个规则下会被静默清空 —— 盘没插上就点扫描, 索引没了。
 * 2. **卷指纹不一致** → 插错盘了。这条才是"换了一块盘, 盘符还是 E:"的正面回答。
 */
export function assertLibraryMounted(
  library: Library,
  deps: { stat?: typeof statSync; platform?: NodeJS.Platform } = {},
): void {
  const stat = deps.stat ? tryStat(deps.stat, library.root) : statSyncSafe(library.root);
  if (!stat?.isDirectory()) {
    throw new AppError(`媒体库目录不存在: ${library.root}`, EXIT.NEEDS_INPUT, {
      libraryId: library.id,
      library: library.name,
      root: library.root,
      hint: "盘没插上或目录被改名了。插好盘再试; 目录换了地方就用 kura library relocate",
    });
  }

  if (!library.volumeId) return;
  const now = volumeFingerprint(library.root, deps);
  if (!now || now === library.volumeId) return;

  throw new AppError(
    `「${library.name}」绑的是另一块盘 (卷 ${library.volumeId}, 现在是 ${now}) —— 插错盘了`,
    EXIT.NEEDS_INPUT,
    {
      libraryId: library.id,
      library: library.name,
      root: library.root,
      expectedVolume: library.volumeId,
      actualVolume: now,
      hint:
        "拔掉换成建库时那块盘; 如果确实换盘了, 用 kura library relocate " +
        `${library.name} <新根目录> 把库搬到新位置`,
    },
  );
}

function tryStat(stat: typeof statSync, path: string): ReturnType<typeof statSync> | null {
  try {
    return stat(path);
  } catch {
    return null;
  }
}

function statSyncSafe(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * 老库(D v14 之前建的)没有卷指纹, 第一次扫描时顺手补记。
 *
 * 只在库根存在时补: 根不存在说明盘没插, 这时记下的指纹会是错的。
 */
export function bindVolume(db: Db, library: Library): Library {
  if (library.volumeId) return library;
  const fingerprint = volumeFingerprint(library.root);
  if (!fingerprint) return library;
  db.run("update libraries set volume_id = ? where id = ?", [fingerprint, library.id]);
  return { ...library, volumeId: fingerprint };
}

export interface RelocateReport {
  library: string;
  from: string;
  to: string;
  /** 索引里会跟着改的路径数。 */
  moved: number;
  /** 改完仍然不存在的路径数 —— 大于 0 说明新目录内容不全, 需要人确认。 */
  missing: number;
  missingSample: string[];
  /** 已经在新位置的文件数(不是这次改的, 但新根里确实有)。 */
  volumeId: string | null;
}

/**
 * 换盘/换目录: 把库根从一个绝对路径搬到另一个。
 *
 * 只改索引, 不碰磁盘。用途是移动硬盘换了盘符(E: → F:)、或者目录改了名 ——
 * 这时路径换了但相对结构一样, 索引跟着改前缀就能保住全部绑定关系,
 * 不用重新扫描 + 重新找建议 + 重新绑定。
 *
 * 前缀匹配在 JS 里做而不是 SQL `like`, 因为 Windows 大小写不敏感、
 * 而且 `E:\视频` 用 like 会连 `E:\视频2` 一起匹配。
 */
export function relocateLibrary(
  db: Db,
  library: Library,
  newRoot: string,
  opts: { apply?: boolean } = {},
): RelocateReport {
  const to = resolve(newRoot.replace(/[\\/]+$/, ""));
  const target = statSyncSafe(to);
  if (!target?.isDirectory()) {
    throw new AppError(`新目录不存在: ${to}`, EXIT.NOT_FOUND, {
      library: library.name,
      to,
      hint: "先把文件搬过去, 或者写对目录名; 这条命令只改索引, 不搬文件",
    });
  }

  for (const other of db.all<{ name: string; root: string }>("select name, root from libraries where id != ?", [library.id])) {
    if (overlapsPath(to, other.root)) {
      throw new AppError(`新目录与「${other.name}」(${other.root}) 重叠了, 两个库不能共用一个目录`, EXIT.USAGE, {
        to,
        conflictsWith: other.name,
        otherRoot: other.root,
      });
    }
  }

  const oldRoot = resolve(library.root.replace(/[\\/]+$/, ""));
  const rows = db.all<{ path: string }>("select path from media_files where library_id = ?", [library.id]);
  const moved: Array<{ from: string; to: string }> = [];
  for (const row of rows) {
    const relative = relativeTo(row.path, oldRoot);
    if (relative === null) continue;
    moved.push({ from: row.path, to: relative ? `${to}${sep}${relative}` : to });
  }

  const missing = moved.filter((item) => !statSyncSafe(item.to));
  const report: RelocateReport = {
    library: library.name,
    from: oldRoot,
    to,
    moved: moved.length,
    missing: missing.length,
    missingSample: missing.slice(0, 5).map((item) => item.to),
    volumeId: volumeFingerprint(to),
  };

  // 干跑时把结论算完就返回, 一条都不改。
  if (!opts.apply) return report;

  // 新根里一个文件都没有时拒绝 —— 十有八九是目录写错或盘还没拷完,
  // 这时候改索引等于把整个库指向空目录。
  if (moved.length > 0 && missing.length === moved.length) {
    throw new AppError(`新目录里一个文件都没有 (${moved.length} 条路径全对不上), 已中止`, EXIT.NEEDS_INPUT, {
      ...report,
      hint: "确认文件已经拷到新目录, 或者确认 newRoot 写对了",
    });
  }

  db.exec("begin");
  try {
    for (const item of moved) db.run("update media_files set path = ? where path = ?", [item.to, item.from]);
    db.run("update libraries set root = ?, volume_id = ? where id = ?", [to, report.volumeId, library.id]);
    db.exec("commit");
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
  return report;
}

/** `path` 是否在 `root` 之下, 在的话返回相对部分(空串表示就是根本身)。 */
function relativeTo(path: string, root: string): string | null {
  const left = process.platform === "win32" ? path.toLowerCase() : path;
  const right = process.platform === "win32" ? root.toLowerCase() : root;
  if (left === right) return "";
  if (!left.startsWith(`${right}${sep}`)) return null;
  return path.slice(root.length + 1);
}

function overlapsPath(a: string, b: string): boolean {
  const left = resolve(a).replace(/[\\/]+$/, "");
  const right = resolve(b).replace(/[\\/]+$/, "");
  const norm = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const l = norm(left);
  const r = norm(right);
  if (l === r) return true;
  return l.startsWith(`${r}${sep}`) || r.startsWith(`${l}${sep}`);
}

/** 给界面/CLI 用的一句话: 库根现在是什么盘。 */
export function describeVolume(library: Library): string | null {
  const now = volumeFingerprint(library.root);
  if (!now) return null;
  const name = basename(volumeRoot(library.root));
  return `${library.volumeId ?? "(未绑定)"}${name ? ` @ ${name}` : ""}`;
}
