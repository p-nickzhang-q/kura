// 起一个「能看见真实媒体盘」的开发实例: 不跑 electron-builder, 只把新代码塞进
// 已经解包好的 Windows Electron 壳里。
//
// 为什么需要它: `pnpm dev` 起的是 Linux Electron(WSL), 看不到 `E:\视频`;
// 而每次都打包安装器太慢。这里复用 `--dir` 产物里的 Electron 本体, 只替换应用代码。
//
// 用法:
//   node scripts/run-win.mjs               # 构建 + 同步 + 启动
//   node scripts/run-win.mjs --no-launch   # 只构建 + 同步
//   KURA_RUN_DIR=/mnt/d/kura-run node scripts/run-win.mjs
//
// 必须一起同步的三个目录: dist(渲染进程) / dist-electron(主进程) / electron(preload.cjs)。
// 漏了 electron/ 就会出现「界面调的方法 undefined」—— 渲染进程与主进程之间没有类型约束,
// typecheck 也看不出来。
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const desktop = join(root, "apps", "desktop");
// 脚本跑在 WSL 里, 所以路径用 /mnt/d/... 的写法; 启动 exe 时再换成 Windows 路径。
const runDir = process.env.KURA_RUN_DIR?.trim() || "/mnt/d/kura-run";
const appDir = join(runDir, "resources", "app");

if (!existsSync(appDir)) {
  console.error(`找不到解包好的 Electron: ${appDir}`);
  console.error("先用 electron-builder --dir 打一次(或者把现成的 win-unpacked 复制过去)。");
  process.exit(1);
}

const build = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${cmd} 失败`);
    process.exit(result.status ?? 1);
  }
};

console.log("1/3 构建渲染进程…");
build("pnpm", ["exec", "vite", "build"], desktop);
console.log("2/3 构建主进程…");
build("bun", ["build", "./electron/main.ts", "--target=node", "--outfile", "dist-electron/main.mjs", "--external", "electron"], desktop);

console.log(`3/3 同步到 ${appDir}…`);
await rm(join(appDir, "dist"), { recursive: true, force: true });
await rm(join(appDir, "dist-electron"), { recursive: true, force: true });
await rm(join(appDir, "electron"), { recursive: true, force: true });
await mkdir(appDir, { recursive: true });
for (const dir of ["dist", "dist-electron", "electron"]) {
  await cp(join(desktop, dir), join(appDir, dir), { recursive: true });
}

// Electron 优先读 app.asar, 有它就不会用我们的 app/ 目录
await rm(join(runDir, "resources", "app.asar"), { force: true });

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(
  join(appDir, "package.json"),
  `${JSON.stringify({ name: "kura", productName: "Kura", version: `${pkg.version}-dev`, main: "dist-electron/main.mjs" }, null, 2)}\n`,
);

// 同步完立刻确认 preload 里有新方法, 免得又出现「window.kura.xxx is not a function」
const preload = await readFile(join(appDir, "electron", "preload.cjs"), "utf8");
console.log(`   preload: ${(preload.match(/ipcRenderer\.invoke\(/g) ?? []).length} 个通道`);

if (process.argv.includes("--no-launch")) process.exit(0);

const exe = join(runDir, "Kura.exe");
const windowsExe = spawnSync("wslpath", ["-w", exe], { encoding: "utf8" }).stdout?.trim() || exe;
console.log(`启动 ${windowsExe}`);
// detached + unref: 否则脚本会一直挂在这儿等 Electron 退出
const child = spawn("cmd.exe", ["/c", "start", "", windowsExe], { stdio: "ignore", detached: true });
child.unref();
