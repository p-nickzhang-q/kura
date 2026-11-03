/**
 * 演员名的"同一个人"判定。
 *
 * 只做可解释的规范化, 不做别名合并:
 *  - NFKC: 半角片假名 ｱｷﾗ → アキラ, 全角数字/字母 → 半角
 *  - 去掉所有空白: "吉沢 明歩" 与 "吉沢明歩" 是同一个人
 *  - 小写: 罗马字 "Yua Mikami" 与 "yua mikami" 是同一个人
 *
 * 不做的 (有意): 繁简/异体字归并。"吉沢明歩" 与 "吉澤明歩" 在 JIS 层面就是两个名字,
 * 自动归并要靠别名表, 而别名是判断题 —— 等真实数据暴露问题再建表, 别现在凭想象建。
 */
export function normalizeActorName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/**
 * 占位文本不是演员。
 *
 * 来源页面与别的刮削器写出的 nfo 里常见 `<name>未知演员</name>`、`N/A`、`---` 这类占位:
 * 它们不是人名, 进索引后会变成一个能点、点了什么都没有的假演员 (真机库里 30 条这样)。
 * 判定放在最靠近入库的地方, 让"占位符进不了库"成为一条规则而不是各处的 if。
 */
const PLACEHOLDER_ACTORS = new Set([
  "未知演员",
  "未知女优",
  "未知女優",
  "未知",
  "不明",
  "不详",
  "不詳",
  "佚名",
  "无名",
  "無名",
  "无",
  "無",
  "n/a",
  "n.a.",
  "na",
  "none",
  "null",
  "nil",
  "unknown",
  "tbd",
  "-",
  "--",
  "---",
  "—",
  "——",
  "?",
  "??",
  "???",
]);

export function isPlaceholderActor(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_ACTORS.has(trimmed.toLowerCase()) || PLACEHOLDER_ACTORS.has(trimmed);
}

/** 过滤占位符与空串, 顺带去空白。入库前统一走这里。 */
export function sanitizeActorNames(names: readonly string[] | undefined | null): string[] {
  if (!names) return [];
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (isPlaceholderActor(name)) continue;
    if (out.includes(name)) continue;
    out.push(name);
  }
  return out;
}
