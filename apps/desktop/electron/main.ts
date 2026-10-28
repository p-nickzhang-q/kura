import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { basename, join } from "node:path";
import {
  AppError,
  EXIT,
  createLibrary,
  defaultSources,
  findLibrary,
  getItem,
  listItems,
  listLibraries,
  openRuntime,
  organize,
  pendingKeys,
  scan,
  scrape,
  type Library,
  type Runtime,
  type ScanEvent,
} from "@kura/core";

/**
 * 主进程 = 唯一持有数据库的进程。
 * 渲染进程没有 Node 权限, 只能通过 preload 暴露的方法说话 (contextIsolation)。
 *
 * "无守护进程"在这里的落地: window-all-closed 直接 close + quit,
 * 不存在后台常驻; CLI 是另一个独立进程, 与 GUI 只共享同一个 SQLite 文件。
 */
const isDev = !app.isPackaged;
const fixturesDir = process.env.KURA_FIXTURE_DIR ?? null;

let runtime: Runtime | null = null;
let win: BrowserWindow | null = null;
let busy: string | null = null;

function mustRuntime(): Runtime {
  if (!runtime) throw new AppError("运行时尚未就绪", EXIT.RETRYABLE);
  return runtime;
}

function mustLibrary(id: number): Library {
  const library = findLibrary(mustRuntime().db, String(id));
  if (!library) throw new AppError(`媒体库不存在: ${id}`, EXIT.NOT_FOUND, { id });
  return library;
}

/** 同一时刻只允许一个长任务: 扫描与整理并发只会互相拖慢, 进度条也没法用。 */
function exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (busy) throw new AppError(`已有任务在进行: ${busy}`, EXIT.RETRYABLE, { busy });
  busy = label;
  return fn().finally(() => {
    busy = null;
  });
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 600,
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
    const counts = rt.db.get<{ items: number; files: number; libraries: number }>(
      "select (select count(*) from items) as items, (select count(*) from media_files) as files, (select count(*) from libraries) as libraries",
    );
    return {
      version: app.getVersion(),
      dataDir: rt.paths.dataDir,
      dbRuntime: rt.dbInfo.runtime,
      schemaVersion: rt.schemaVersion,
      libraries: counts?.libraries ?? 0,
      items: counts?.items ?? 0,
      mediaFiles: counts?.files ?? 0,
      fixturesDir,
      sources: defaultSources().list().map((source) => ({ id: source.id, label: source.label, status: source.status })),
    };
  });

  ipcMain.handle("library:list", () => listLibraries(mustRuntime().db));

  ipcMain.handle("library:add", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = result.filePaths[0];
    return createLibrary(mustRuntime().db, { name: basename(root), root });
  });

  ipcMain.handle("scan:start", (_event, input: { libraryId: number }) =>
    exclusive("扫描", async () => {
      return scan(mustRuntime(), {
        library: mustLibrary(input.libraryId),
        onEvent: (event: ScanEvent) => win?.webContents.send("scan:event", event),
      });
    }),
  );

  ipcMain.handle("scrape:pending", (_event, input: { limit?: number }) =>
    exclusive("刮削", async () => {
      const rt = mustRuntime();
      const keys = pendingKeys(rt, input.limit ?? 20);
      const reports: { key: string; ok: boolean; filled: number; error?: string }[] = [];

      for (const key of keys) {
        try {
          const report = await scrape(rt, {
            key,
            registry: defaultSources(),
            fixturesDir,
            // 真实站点尚未实现; 有样本目录时走离线源, 否则如实报错。
            sources: fixturesDir ? ["fixture"] : undefined,
          });
          reports.push({ key: report.key, ok: true, filled: report.filled.length });
        } catch (err) {
          reports.push({ key: key.value, ok: false, filled: 0, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { count: reports.length, reports };
    }),
  );

  ipcMain.handle("item:list", (_event, input: { limit?: number } = {}) =>
    listItems(mustRuntime(), { limit: input.limit ?? 100 }),
  );

  ipcMain.handle("item:get", (_event, number: string) => getItem(mustRuntime(), number));

  ipcMain.handle("organize:preview", (_event, input: { libraryId: number }) =>
    organize(mustRuntime(), { library: mustLibrary(input.libraryId) }),
  );

  ipcMain.handle("organize:apply", (_event, input: { libraryId: number }) =>
    exclusive("整理", () => organize(mustRuntime(), { library: mustLibrary(input.libraryId), apply: true })),
  );
}

// 第二个实例聚焦已有窗口: 两个 GUI 同时写库虽然 WAL 扛得住, 但用户会困惑。
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
