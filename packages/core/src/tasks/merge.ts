import type { Runtime } from "../runtime";
import { AppError, EXIT } from "../exit";

/**
 * 把条目 A 的文件并进条目 B, 然后删掉 A。
 *
 * 真实场景: 同一部片被拆成了两个条目 —— 一个是 TMDB 身份, 一个是你当时认不出身份
 * 手动加的本地条目(`local:xxx`)。两个条目各占一个文件(比如 `绿巨人-cd2` 和 `-cd3`),
 * 于是整理时互相判"目标已存在", 谁也搬不动。合并之后才是一条完整的片。
 *
 * 只做电影:
 *  - 电影 = 一个文件, 合并只是改归属, 没有副作用
 *  - 剧集要重排季集(两边可能都有 S01E01), 那是"剧集合并"这件独立的事, v1 不做
 */
export interface MergeResult {
  from: string;
  into: string;
  /** 挪过去的文件数。 */
  moved: number;
  /** from 条目被删掉了(它已经没有文件)。 */
  removed: boolean;
}

export function mergeItems(rt: Runtime, input: { from: string; into: string }): MergeResult {
  const from = input.from.trim();
  const into = input.into.trim();
  if (!from || !into) throw new AppError("用法: 合并 <from> --into <to>", EXIT.USAGE);
  if (from.toLowerCase() === into.toLowerCase()) {
    throw new AppError("两个身份是同一个", EXIT.USAGE, { from, into });
  }

  const lookup = (key: string): { domain: string | null; content_type: string } | undefined =>
    rt.db.get<{ domain: string | null; content_type: string }>(
      "select domain, content_type from items where lower(number) = lower(?)",
      [key],
    );
  const source = lookup(from);
  const target = lookup(into);
  if (!source) throw new AppError(`条目不存在: ${from}`, EXIT.NOT_FOUND, { key: from });
  if (!target) throw new AppError(`条目不存在: ${into}`, EXIT.NOT_FOUND, { key: into });

  if (source.domain !== "movie" || target.domain !== "movie") {
    throw new AppError("只能合并电影条目", EXIT.USAGE, {
      from: { key: from, domain: source.domain },
      into: { key: into, domain: target.domain },
      hint: "剧集合并要重排季集(两边可能都有 S01E01), v1 不做; 那种情况请手动解绑再绑",
    });
  }

  const files = rt.db.all<{ path: string }>("select path from media_files where number = ?", [from]);

  rt.db.exec("begin");
  try {
    for (const file of files) rt.db.run("update media_files set number = ? where path = ?", [into, file.path]);
    // from 的集级数据(如果有)一并清掉: 它已经不该存在了
    rt.db.run("delete from episodes where number = ?", [from]);
    rt.db.run("delete from items where number = ?", [from]);
    rt.db.run("update items set updated_at = unixepoch() where number = ?", [into]);
    rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }

  return { from, into, moved: files.length, removed: true };
}
