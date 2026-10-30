// 生成一套模拟数据, 用于本地开发与压测(不联网、不含真实内容)。
//
// 两种模式:
//   a) 离线模式: 连 fixture 样本一起生成, 可完全断网跑批
//   b) 真实模式(--numbers 或 --numbers-file): 只造假文件, 番号用你给的, 用来打真实站点
//
// 产出:
//   <out>/library/           假视频文件(1KB)
//   <out>/fixtures/<番号>.json  仅离线模式; 真实模式不写(否则会抢在真实源前面)
//
// 用法:
//   node scripts/make-demo-data.mjs --count 40 --out ./demo-data
//   node scripts/make-demo-data.mjs --numbers "SSIS-001,MIDV-123,FC2-PPV-1234567" --out ./demo-real
//   KURA_DATA_DIR=/tmp/kura-demo ./dist/kura library add 演示库 <out>/library
//   KURA_DATA_DIR=/tmp/kura-demo ./dist/kura scan 演示库
//   KURA_DATA_DIR=/tmp/kura-demo ./dist/kura scrape --pending --source fixture --fixtures <out>/fixtures
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const count = Number(readArg("count", "40"));
const out = readArg("out", "demo-data");
const numbersInline = readArg("numbers", "");
const numbersFile = readArg("numbers-file", "");

// 真实模式: 只造文件, 不造 fixture —— 刮削要打真实站点
const explicitNumbers = numbersInline
  ? numbersInline.split(",").map((value) => value.trim()).filter(Boolean)
  : numbersFile
    ? readFileSync(numbersFile, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
    : [];

if (explicitNumbers.length === 0 && (!Number.isFinite(count) || count <= 0)) {
  console.error("--count 需要正整数");
  process.exit(2);
}

const libraryDir = join(out, "library");
const fixturesDir = join(out, "fixtures");
mkdirSync(libraryDir, { recursive: true });
mkdirSync(fixturesDir, { recursive: true });

const STUDIOS = ["片商A", "片商B", "片商C", "片商D"];
const LABELS = ["厂牌甲", "厂牌乙", "厂牌丙"];
const SERIES = ["系列一", "系列二", "系列三"];
const TAGS = ["标签一", "标签二", "标签三", "标签四", "标签五"];
const ACTORS = ["サンプル女優1", "サンプル女優2", "サンプル女優3", "サンプル女優4", "サンプル女優5"];
const SUFFIX = ["", "-C", "-U", "-CD1", "-4K"];

const pad = (value, width) => String(value).padStart(width, "0");
const pick = (list, seed) => list[seed % list.length];

/** 三种能识别出番号的形态, 轮流产出; 加少量认不出的, 用于"未识别"入口。 */
function makeNumber(index) {
  const kind = index % 5;
  if (kind === 0) return { number: `${pick(["ABC", "SSIS", "MIDV", "IPX"], index)}-${pad(index + 1, 3)}` };
  if (kind === 1) return { number: `${pick(["SNIS", "MIDE", "JUQ"], index)}-${pad(index + 1, 3)}` };
  if (kind === 2) return { number: `${pad(100000 + index, 6)}-${pad((index % 999) + 1, 3)}` }; // 无码
  if (kind === 3) return { number: `FC2-PPV-${1000000 + index}` };
  return { number: `${pick(["GEN", "NHDTA", "HND"], index)}-${pad(index + 1, 3)}` };
}

const created = [];
const mode = explicitNumbers.length > 0 ? "real" : "offline";
const total = mode === "real" ? explicitNumbers.length : count;

for (let index = 0; index < total; index++) {
  const number = mode === "real" ? explicitNumbers[index] : makeNumber(index).number;
  const suffix = pick(SUFFIX, index);
  const extension = index % 7 === 0 ? ".mp4" : ".mkv";

  writeFileSync(join(libraryDir, `${number}${suffix}${extension}`), Buffer.alloc(1024, 0x61));
  if (mode === "real") {
    created.push(number);
    continue; // 真实模式不写 fixture
  }

  const actorCount = (index % 3) + 1;
  const actors = Array.from({ length: actorCount }, (_, offset) => pick(ACTORS, index + offset));
  const tagCount = (index % 4) + 1;
  const tags = Array.from({ length: tagCount }, (_, offset) => pick(TAGS, index * 3 + offset));
  const date = `202${1 + (index % 4)}-${pad((index % 12) + 1, 2)}-${pad((index % 28) + 1, 2)}`;

  // 标题带假名 → 可以验证"只翻日文"; 简介同理。
  const fixture = {
    title: `サンプル タイトル ${index + 1}`,
    plot: `これはサンプルの説明文です。作品番号 ${number} のテスト用データ。`,
    release_date: date,
    duration_min: 90 + (index % 60),
    studio: pick(STUDIOS, index),
    label: pick(LABELS, index),
    series: index % 3 === 0 ? pick(SERIES, index) : undefined,
    directors: index % 4 === 0 ? [`サンプル監督${(index % 3) + 1}`] : [],
    actors,
    tags,
    poster_urls: [],
    cover_urls: [],
    thumb_urls: [],
  };

  writeFileSync(join(fixturesDir, `${number}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  created.push(number);
}

// 认不出番号的文件: 验证"未识别 (N)"入口与 organize 的跳过逻辑
for (let index = 0; index < Math.max(2, Math.round(count / 10)); index++) {
  writeFileSync(join(libraryDir, `没有番号的文件 ${index + 1}.mp4`), Buffer.alloc(512, 0x62));
  writeFileSync(join(libraryDir, `2024-0${(index % 9) + 1}-01 家庭录像 ${index + 1}.mkv`), Buffer.alloc(512, 0x63));
}

writeFileSync(
  join(out, "README.txt"),
  [
    "模拟数据, 供本地开发使用。全部内容为占位符, 不含真实作品信息。",
    "",
    `库目录 : ${libraryDir}`,
    `样本目录: ${fixturesDir}`,
    `可识别条目: ${created.length}`,
    "",
    "用法:",
    `  export KURA_DATA_DIR=/tmp/kura-demo`,
    `  kura library add 演示库 ${libraryDir}`,
    `  kura scan 演示库`,
    `  kura scrape --pending --source fixture --fixtures ${fixturesDir}`,
    "",
  ].join("\n"),
);

console.log(`已生成 ${created.length} 条可识别 + ${Math.max(2, Math.round(count / 10)) * 2} 个未识别文件`);
console.log(`  库目录  ${libraryDir}`);
console.log(`  样本目录 ${fixturesDir}`);
