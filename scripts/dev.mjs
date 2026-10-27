// 一条命令起开发环境: 构建主进程 -> 起 Vite -> 等端口就绪 -> 起 Electron。
// 刻意不引入 concurrently / npm-run-all: 这类胶水不值得多一个依赖。
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps", "desktop");
const devUrl = "http://localhost:5173";

const build = spawnSync(
  "bun",
  [
    "build",
    "./electron/main.ts",
    "--target=node",
    "--outfile",
    "dist-electron/main.mjs",
    "--external",
    "electron",
  ],
  { cwd: desktop, stdio: "inherit" },
);
if (build.status !== 0) {
  console.error("主进程构建失败; 需要 bun >= 1.1");
  process.exit(build.status ?? 1);
}

const vite = spawn("pnpm", ["exec", "vite"], { cwd: desktop, stdio: ["ignore", "pipe", "pipe"] });
let electron = null;
let launched = false;

const handleChunk = (chunk) => {
  const text = String(chunk);
  process.stdout.write(text);
  if (!launched && /localhost:5173/.test(text)) {
    launched = true;
    electron = spawn("pnpm", ["exec", "electron", "."], {
      cwd: desktop,
      stdio: "inherit",
      env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
    });
    electron.on("exit", (code) => {
      shutdown();
      process.exit(code ?? 0);
    });
  }
};

vite.stdout.on("data", handleChunk);
vite.stderr.on("data", (chunk) => process.stderr.write(chunk));

function shutdown() {
  electron?.kill();
  vite.kill();
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
vite.on("exit", (code) => {
  if (!launched) process.exit(code ?? 0);
});
