// 把抓下来的真实页面清洗成可提交的 fixture: 保留结构, 文本一律换占位符。
// 目的: 测试锁住的是"选择器是否正确", 不是"某个具体影片的内容"。
//
// 做法: 先按选择器把已知字段换成占位符, 再遍历所有文本节点 —— 不在白名单里的一律替换成"示例"。
// 白名单只包含解析器真正要读的文本(标签名、日期、时长、番号), 所以不会有内容漏进仓库。
//
// 用法: cd packages/core && bun scripts/sanitize-fixture.mjs <input.html> <output.html>
import { readFileSync, writeFileSync } from "node:fs";
import { load } from "cheerio";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("用法: bun scripts/sanitize-fixture.mjs <input.html> <output.html>");
  process.exit(2);
}

const $ = load(readFileSync(input, "utf8"));

// 详情页结构
$("h3").text("示例标题");
$("div.star-name a").each((index, el) => {
  $(el).text(`演员${index + 1}`);
});
$("span.genre label a, span.genre a").each((index, el) => {
  $(el).text(`标签${index + 1}`);
});
$('a[href*="/studio/"]').text("片商A");
$('a[href*="/label/"]').text("厂牌A");
$('a[href*="/director/"]').text("导演A");
$('a[href*="/series/"]').text("系列A");

$("span.header").each((_index, el) => {
  const label = $(el).text();
  if (label.includes("識別碼")) $(el).next("span").text("ABC-123");
  // 只用 after() 追加文本节点: 用 parent().text() 会把 <span class="header"> 本身删掉, 解析器就找不到标签了。
  if (label.includes("發行日期")) $(el).after(" 2024-01-02");
  if (label.includes("長度")) $(el).after(" 120 分鐘");
});

// JavDB 详情页
$("h2.title.is-4 strong.current-title").text("示例标题");
$("span.value a[href*='/actors/']").each((index, el) => {
  $(el).text(`演员${index + 1}`);
});
$("span.value a[href*='/tags']").each((index, el) => {
  $(el).text(`标签${index + 1}`);
});
$("span.value a[href*='/makers/']").text("片商A");
$("span.value a[href*='/labels/']").text("厂牌A");
$("span.value a[href*='/series/']").text("系列A");
$("span.value a[href*='/directors/']").text("导演A");
$("a[data-clipboard-text]").attr("data-clipboard-text", "ABC-123");
$("strong").each((_index, el) => {
  const label = $(el).text();
  const $value = $(el).next("span.value");
  if (!$value.length) return;
  if (label.includes("日期")) $value.text("2024-01-02");
  if (label.includes("時長")) $value.text("120 分鍾");
});
// 评分是文本节点(不是元素), 单独归一
$("span.score-stars").each((_index, el) => {
  const next = el.nextSibling;
  if (next && next.type === "text") next.data = " 4.43分";
});

// 搜索结果列表
$("a.box div.video-title strong").text("ABC-123");
$("a.movie-box div.photo-info date").each((_index, el) => {
  $(el).text("ABC-123");
});
$("a.movie-box div.photo-info span").each((_index, el) => {
  // 只在纯文本 span 上写占位符, 保留 <date> 等子元素
  if ($(el).children().length === 0) $(el).text("示例标题");
});

// 删掉不参与解析的东西
$("script, style, noscript, iframe").remove();
$("*").each((_index, el) => {
  for (const name of Object.keys(el.attribs ?? {})) {
    if (name.startsWith("on")) delete el.attribs[name];
  }
});

// 白名单之外的文本一律占位化
// 注意: 标签带冒号("識別碼:"), 所以用包含匹配而不是整串匹配;
// 用长度上限兜底, 避免"恰好包含这些词的长文本"漏过去。
const KEEP =
  /識別碼|發行日期|長度|製作商|發行商|導演|類型|番號|片商|發行|系列|類別|日期|時長|演員|評分|離線下載|熱搜|示例|演员\d|标签\d+|片商A|厂牌A|导演A|系列A|2024-01-02|120 分[鐘鍾]|ABC-123|\d+\.\d+分/;

function scrub(node) {
  if (node.type === "text") {
    const text = (node.data ?? "").trim();
    if (text.length > 0 && !(KEEP.test(text) && text.length <= 30)) node.data = "示例";
    return;
  }
  for (const child of node.children ?? []) scrub(child);
}
scrub($.root()[0]);

// 属性里也会带内容(title/alt/content), 一并占位化; href/src/class 保留不动。
for (const attr of ["title", "alt", "content", "aria-label"]) {
  $(`[${attr}]`).each((_index, el) => {
    $(el).attr(attr, "示例");
  });
}

writeFileSync(output, $.html());
console.log(`已写出 ${output}`);
