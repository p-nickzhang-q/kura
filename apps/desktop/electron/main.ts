import { app, BrowserWindow, dialog, ipcMain, net, session, shell } from "electron";
import { basename, join } from "node:path";
import {
  AppError,
  EXIT,
  createLibrary,
  createDmmSource,
  defaultSources,
  downloadPoster,
  updateItem,
  DIMENSIONS,
  dimensionTemplate,
  updateLibraryOrganize,
  openTranslator,
  resolveLlm,
  translateEnabled,
  updateLibraryTemplate,
  HttpClient,
  type FetchInit,
  isDmmConfigured,
  maskSettings,
  resolveDmmEnv,
  saveSettings,
  settingsPath,
  type Settings,
  findLibrary,
  getItem,
  listItems,
  countItems,
  countPending,
  countExhausted,
  listFiles,
  countFiles,
  listTasks,
  retryTask,
  listLibraries,
  openRuntime,
  organize,
  pendingKeys,
  scan,
  scrape,
  scrapePending,
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
/** 当前长任务的取消句柄; 停止按钮通过它中断在途请求。 */
let currentAbort: AbortController | null = null;
/** 设置改了就地更新, 不重建 runtime; 网络层每次按当前值构造。 */
let settings: Settings = { dmm: { apiId: "", affiliateId: "" }, proxy: "", llm: { baseUrl: "", apiKey: "", model: "" }, translate: false };

/** Electron 主进程的 fetch: 跟随系统代理(Clash 开了系统代理/TUN 就直接生效)。 */
function browserFetch(url: string, init: FetchInit): Promise<Response> {
  return net.fetch(url, {
    headers: init.headers,
    signal: init.signal,
    method: init.method,
    body: init.body,
  } as RequestInit);
}

/**
 * 把配置里的代理应用到 Electron session。
 * 空值或 auto → 跟随系统代理(Clash 的系统代理/TUN 直接生效)。
 */
async function applyProxy(): Promise<void> {
  const proxy = settings.proxy.trim();
  try {
    if (proxy && proxy !== "auto") {
      await session.defaultSession.setProxy({ mode: "fixed_servers", proxyRules: proxy });
    } else {
      await session.defaultSession.setProxy({ mode: "system" });
    }
  } catch {
    // 代理设置失败不该挡住启动; 后续请求会走到系统代理。
  }
}

function createHttp(): HttpClient {
  return new HttpClient({ fetchImpl: browserFetch });
}

/** 翻译是可选后处理: 没开或没配置就返回 null, 刮削照常继续。 */
async function buildTranslator() {
  if (!translateEnabled(settings)) return null;
  return openTranslator(mustRuntime(), createHttp(), resolveLlm(settings));
}

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
async function exclusive<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (busy) throw new AppError(`已有任务在进行: ${busy}`, EXIT.RETRYABLE, { busy });
  busy = label;
  currentAbort = new AbortController();
  try {
    return await fn(currentAbort.signal);
  } finally {
    busy = null;
    currentAbort = null;
  }
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
      dmmConfigured: isDmmConfigured(resolveDmmEnv(settings)),
      llmConfigured: Boolean(resolveLlm(settings)),
      translate: translateEnabled(settings),
      dimensions: DIMENSIONS,
      sources: defaultSources({ http: createHttp(), dmm: resolveDmmEnv(settings) })
        .list()
        .map((source) => ({ id: source.id, label: source.label, status: source.status, missing: source.requirements() })),
    };
  });

  ipcMain.handle("library:list", () => listLibraries(mustRuntime().db));

  ipcMain.handle("library:add", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = result.filePaths[0];
    return createLibrary(mustRuntime().db, { name: basename(root), root });
  });

  ipcMain.handle("library:set-organize", (_event, input: { libraryId: number; enabled: boolean }) => {
    const library = mustLibrary(input.libraryId);
    updateLibraryOrganize(mustRuntime().db, library.id, input.enabled);
    return { ...library, organizeEnabled: input.enabled };
  });

  ipcMain.handle("library:set-template", (_event, input: { libraryId: number; dimension: string }) => {
    const library = mustLibrary(input.libraryId);
    const template = dimensionTemplate(input.dimension);
    if (!template) throw new AppError(`未知维度: ${input.dimension}`, EXIT.USAGE, { dimension: input.dimension });
    updateLibraryTemplate(mustRuntime().db, library.id, template);
    return { ...library, template };
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
    exclusive("刮削", async (signal) => {
      const rt = mustRuntime();
      const result = await scrapePending(rt, {
        registry: defaultSources({ http: createHttp(), dmm: resolveDmmEnv(settings) }),
        fixturesDir,
        sources: fixturesDir ? ["fixture"] : undefined,
        translator: await buildTranslator(),
        limit: input.limit ?? 20,
        signal,
        onProgress: (progress) => win?.webContents.send("scrape:progress", progress),
      });
      return result;
    }),
  );

  ipcMain.handle("scrape:cancel", () => {
    const cancelled = Boolean(currentAbort);
    currentAbort?.abort();
    return { cancelled };
  });

  ipcMain.handle(
    "item:list",
    (_event, input: { limit?: number; offset?: number; type?: string; actor?: string } = {}) => {
      const rt = mustRuntime();
      return {
        items: listItems(rt, {
          limit: input.limit ?? 100,
          offset: input.offset ?? 0,
          type: input.type,
          actor: input.actor,
        }),
        total: countItems(rt, { type: input.type, actor: input.actor }),
        pending: countPending(rt),
        exhausted: countExhausted(rt),
      };
    },
  );

  ipcMain.handle(
    "files:unparsed",
    (_event, input: { libraryId?: number; limit?: number; offset?: number } = {}) => {
      const rt = mustRuntime();
      return {
        files: listFiles(rt, {
          libraryId: input.libraryId,
          unparsedOnly: true,
          limit: input.limit ?? 100,
          offset: input.offset ?? 0,
        }),
        total: countFiles(rt, { libraryId: input.libraryId, unparsedOnly: true }),
      };
    },
  );

  ipcMain.handle("files:reveal", (_event, path: string) => {
    shell.showItemInFolder(path);
    return true;
  });

  ipcMain.handle("tasks:list", (_event, input: { limit?: number } = {}) =>
    listTasks(mustRuntime(), { limit: input.limit ?? 20 }),
  );

  ipcMain.handle("tasks:retry", (_event, input: { id: number }) => retryTask(mustRuntime(), input.id));

  ipcMain.handle("item:get", (_event, number: string) => getItem(mustRuntime(), number));

  ipcMain.handle("item:update", (_event, input: { key: string; pin?: string[]; unpin?: string[] }) =>
    updateItem(mustRuntime(), { key: input.key, pin: input.pin as never, unpin: input.unpin as never }),
  );

  ipcMain.handle("scrape:keys", (_event, input: { keys: string[] }) =>
    exclusive("刮削", async () => {
      const rt = mustRuntime();
      const registry = defaultSources({ http: createHttp(), dmm: resolveDmmEnv(settings) });
      const translator = await buildTranslator();
      const results: { key: string; ok: boolean; filled: number; error?: string }[] = [];

      for (const key of input.keys) {
        const item = getItem(rt, key);
        if (!item) {
          results.push({ key, ok: false, filled: 0, error: "条目不存在" });
          continue;
        }
        try {
          const report = await scrape(rt, {
            key: { value: item.key, number: item.number, contentType: item.contentType },
            registry,
            fixturesDir,
            sources: fixturesDir ? ["fixture"] : undefined,
            translator,
          });
          results.push({ key, ok: true, filled: report.filled.length });
        } catch (err) {
          results.push({ key, ok: false, filled: 0, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { count: results.length, results };
    }),
  );

  ipcMain.handle("resource:fetch", (_event, input: { key: string }) =>
    exclusive("下载海报", async () => {
      const rt = mustRuntime();
      const item = getItem(rt, input.key);
      if (!item) throw new AppError(`条目不存在: ${input.key}`, EXIT.NOT_FOUND);
      const result = await downloadPoster(rt, createHttp(), item);
      if (!result.poster) {
        throw new AppError(result.tried.length === 0 ? "该条目没有图片 URL" : "海报下载失败", EXIT.RETRYABLE);
      }
      return { key: input.key, path: result.poster.path, size: result.poster.size };
    }),
  );

  ipcMain.handle("config:get", () => ({
    path: settingsPath(mustRuntime().paths),
    settings: maskSettings(settings),
    dmmConfigured: isDmmConfigured(resolveDmmEnv(settings)),
    /** 环境变量优先; 提示用户实际生效的是哪一层。 */
    dmmFromEnv: Boolean(process.env.KURA_DMM_API_ID || process.env.KURA_DMM_AFFILIATE_ID),
  }));

  ipcMain.handle(
    "config:set",
    async (
      _event,
      patch: {
        apiId?: string;
        affiliateId?: string;
        proxy?: string;
        llmBaseUrl?: string;
        llmApiKey?: string;
        llmModel?: string;
        translate?: boolean;
      },
    ) => {
      const rt = mustRuntime();
      const dmm: { apiId?: string; affiliateId?: string } = {};
      if (patch.apiId !== undefined) dmm.apiId = patch.apiId;
      if (patch.affiliateId !== undefined) dmm.affiliateId = patch.affiliateId;
      const llm: { baseUrl?: string; apiKey?: string; model?: string } = {};
      if (patch.llmBaseUrl !== undefined) llm.baseUrl = patch.llmBaseUrl;
      if (patch.llmApiKey !== undefined) llm.apiKey = patch.llmApiKey;
      if (patch.llmModel !== undefined) llm.model = patch.llmModel;
      settings = saveSettings(rt.paths, { dmm, proxy: patch.proxy, llm, translate: patch.translate });
    await applyProxy();
    return {
      settings: maskSettings(settings),
      dmmConfigured: isDmmConfigured(resolveDmmEnv(settings)),
      llmConfigured: Boolean(resolveLlm(settings)),
      translate: translateEnabled(settings),
      dimensions: DIMENSIONS,
    };
  });

  ipcMain.handle("dmm:test", async (_event, probe?: string) => {
    const source = createDmmSource(createHttp(), resolveDmmEnv(settings));
    const missing = source.requirements();
    if (missing.length > 0) return { ok: false, status: "missing-config", missing };

    const code = (probe || "SSIS-001").toUpperCase();
    try {
      const fields = await source.fetch(
        { value: code, number: code, contentType: "censored" },
        { fixturesDir: null },
      );
      return {
        ok: Boolean(fields),
        status: fields ? "ok" : "empty",
        probe: code,
        fields: fields ? Object.keys(fields) : [],
      };
    } catch (err) {
      return { ok: false, status: "error", probe: code, error: err instanceof Error ? err.message : String(err) };
    }
  });

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
      settings = runtime.settings;
    } catch (err) {
      dialog.showErrorBox("无法初始化数据库", err instanceof Error ? err.message : String(err));
      app.exit(EXIT.INTERNAL);
      return;
    }
    await applyProxy();
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
