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
