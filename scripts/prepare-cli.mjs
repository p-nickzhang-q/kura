#!/usr/bin/env node
/**
 * 把构建好的 CLI 拷贝到 electron-builder 能取到的位置。
 *
 * `extraFiles` 的 `from` 是相对 `apps/desktop` 的, 而 CLI 的产物在仓库根的 `dist/`
 * —— 中间必须有一次拷贝。这一步放在打包之前, 不放进 electron-builder 的钩子:
 * 钩子跑在构建上下文里, 拿不到仓库根的相对路径。
 *
 * 产物 110MB, 所以 `apps/desktop/build/cli/` 在 .gitignore 里。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
// 交叉编译在 Linux 上也产出 kura.exe, 所以先找 .exe 再退回去 —— 这里要的是
// "Windows 用的那个", 不是"当前平台用的那个"。
const candidates = [join(root, "dist", "kura.exe"), join(root, "dist", "kura")];
const source = candidates.find((path) => existsSync(path));
const target = join(root, "apps", "desktop", "build", "cli", "kura.exe");

if (!source) {
  console.error(`找不到 CLI 产物, 试过: ${candidates.join(", ")}`);
  console.error("先跑 `bun run build:cli:win`。");
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
const size = statSync(target).size;
console.log(`CLI -> ${target} (${(size / 1048576).toFixed(1)} MB)`);
