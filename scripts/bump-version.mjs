// 发版前同步版本号: 4 个 package.json + CLI 里手写的 VERSION 常量。
// 用法: node scripts/bump-version.mjs 0.2.0
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("用法: node scripts/bump-version.mjs <x.y.z>");
  process.exit(2);
}

const manifests = [
  "package.json",
  "apps/desktop/package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
];

const touched = [];
for (const relative of manifests) {
  const path = join(root, relative);
  const before = readFileSync(path, "utf8");
  const after = before.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  if (after !== before) {
    writeFileSync(path, after);
    touched.push(relative);
  }
}

const versionFile = join(root, "packages/cli/src/version.ts");
const before = readFileSync(versionFile, "utf8");
const after = before.replace(/VERSION = "[^"]*"/, `VERSION = "${version}"`);
if (after !== before) {
  writeFileSync(versionFile, after);
  touched.push("packages/cli/src/version.ts");
}

console.log(touched.length > 0 ? `已更新到 ${version}:\n${touched.map((f) => `  ${f}`).join("\n")}` : `已经是 ${version}`);
