import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { AppError, EXIT, openRuntime, scan, type Runtime, type ScanEvent } from "@kura/core";

/**
 * 主进程 = 唯一持有数据库的进程。
 * 渲染进程没有 Node 权限, 只能通过 preload 暴露的三个方法说话 (contextIsolation)。
 *
 * "无守护进程"在这里的落地: window-all-closed 直接 close + quit,
 * 不存在后台常驻; CLI 是另一个独立进程, 与 GUI 只共享同一个 SQLite 文件。
 */
const isDev = !app.isPackaged;

let runtime: Runtime | null = null;
let win: BrowserWindow | null = null;
let scanning = false;

function mustRuntime(): Runtime {
  if (!runtime) throw new AppError("运行时尚未就绪", EXIT.RETRYABLE);
  return runtime;
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: "#0f1115",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(app.getAppPath(), "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win?.show());

  // 渲染进程不应能打开外链窗口或导航到别处。
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (!devUrl || !url.startsWith(devUrl)) event.preventDefault();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(join(app.getAppPath(), "dist", "index.html"));
  }
  win.on("closed", () => {
    win = null;
  });
}

function registerIpc(): void {
  ipcMain.handle("app:info", () => {
    const rt = mustRuntime();
    const items = rt.db.get<{ c: number }>("select count(*) as c from items");
    return {
      version: app.getVersion(),
      dataDir: rt.paths.dataDir,
      dbFile: rt.paths.dbFile,
      dbRuntime: rt.dbInfo.runtime,
      schemaVersion: rt.schemaVersion,
      itemCount: items?.c ?? 0,
      electron: process.versions.electron,
      node: process.versions.node,
    };
  });

  ipcMain.handle("dialog:pick-dir", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("scan:start", async (_event, input: { root: string; dryRun: boolean }) => {
    // 单飞: 两个扫描并发写同一批文件只会互相拖慢, 而且进度条没法用。
    if (scanning) throw new AppError("已有扫描在进行", EXIT.RETRYABLE);
    scanning = true;
    try {
      return await scan(mustRuntime(), {
        root: input.root,
        dryRun: input.dryRun,
        onEvent: (event: ScanEvent) => win?.webContents.send("scan:event", event),
      });
    } finally {
      scanning = false;
    }
  });
}

// 第二个实例直接聚焦已有窗口: 两个 GUI 同时写库虽然 WAL 扛得住, 但用户会困惑。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    try {
      runtime = await openRuntime();
    } catch (err) {
      // 打不开库就没有任何可用功能, 直接告诉人并退出, 不要留一个空窗口。
      dialog.showErrorBox("无法初始化数据库", err instanceof Error ? err.message : String(err));
      app.exit(EXIT.INTERNAL);
      return;
    }
    registerIpc();
    await createWindow();
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });

  // 关窗即退出: 这是"只在打开软件时运行"的硬约束, macOS 也不驻留 Dock。
  app.on("window-all-closed", () => {
    runtime?.close();
    runtime = null;
    app.quit();
  });

  app.on("before-quit", () => {
    runtime?.close();
    runtime = null;
  });
}
