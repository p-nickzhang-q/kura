import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AppError,
  AUTO_PROXY,
  EXIT,
  createLibrary,
  renameLibrary,
  createDmmSource,
  defaultSources,
  downloadPoster,
  placeImagesBesideVideo,
  updateItem,
  retypeItem,
  detectRetypes,
  translateItem,
  DIMENSIONS,
  dimensionTemplate,
  updateLibraryOrganize,
  openTranslator,
  proxyCandidates,
  resolveProxy,
  probeTranslator,
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
  findResource,
  findSidecarImages,
  resourceDir,
  getItem,
  listItems,
  countItems,
  countPending,
  countExhausted,
  countPendingTranslation,
  translationStats,
  repairTranslations,
  translatePendingTask,
  listFiles,
  countFiles,
  listTasks,
  getTask,
  listLibraries,
  openRuntime,
  resolvePaths,
  organize,
  pendingKeys,
  scan,
  scrape,
  scrapePendingTask,
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
protocol.registerSchemesAsPrivileged([
  { scheme: "kura-res", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "kura-file", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let settings: Settings = { dmm: { apiId: "", affiliateId: "" }, proxy: "", llm: { baseUrl: "", apiKey: "", model: "" }, translate: false, saveImages: true };

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
/**
 * TCP 探测: 端口有人听就算可用。
 *
 * core 里的探测走 Bun 的 fetch(proxy), 在 Electron 里没有这个能力;
 * 而"代理软件有没有在跑"只取决于端口是否 listen, 所以直接用 net.connect。
 */
function probeProxyTarget(target: string, timeoutMs = 1200): Promise<boolean> {
  return new Promise((done) => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      done(false);
      return;
    }
    const socket = connect({ host: url.hostname, port: Number(url.port || 80) });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

let effectiveProxy: { mode: "system" | "fixed"; rules?: string } = { mode: "system" };

/**
 * 应用代理设置。
 *
 * `auto` 必须真的探测: GUI 以前把 auto 当成"用系统代理", 而系统代理注册表里
 * 常常躺着一条已经失效的记录, 结果请求全被送去一个没人听的端口
 * (net::ERR_PROXY_CONNECTION_FAILED), 界面上却看不出去哪儿改。
 */
async function applyProxy(): Promise<void> {
  const configured = resolveProxy(settings);
  try {
    if (configured && configured !== AUTO_PROXY) {
      effectiveProxy = { mode: "fixed", rules: configured };
    } else if (configured === AUTO_PROXY) {
      const reachable: string[] = [];
      for (const candidate of proxyCandidates(process.platform)) {
        if (await probeProxyTarget(candidate)) reachable.push(candidate);
      }
      effectiveProxy = reachable[0] ? { mode: "fixed", rules: reachable[0] } : { mode: "system" };
    } else {
      effectiveProxy = { mode: "system" };
    }
    await session.defaultSession.setProxy(
      effectiveProxy.mode === "fixed"
        ? { mode: "fixed_servers", proxyRules: effectiveProxy.rules }
        : { mode: "system" },
    );
    // 系统代理注册表可能是陈旧的: 让 Chromium 下次请求重新解析, 别继续用缓存里的死端口
    await session.defaultSession.closeAllConnections();
  } catch {
    // 代理设置失败不该挡住启动; 后续请求会走到系统代理。
  }
}

function createHttp(): HttpClient {
  return new HttpClient({ fetchImpl: browserFetch });
}

interface ItemListInput {
  limit?: number;
  offset?: number;
  type?: string;
  actor?: string;
  libraryId?: number;
  q?: string;
  studio?: string;
  label?: string;
  series?: string;
  director?: string;
  tag?: string;
  state?: "unscraped" | "scraped" | "exhausted";
  sort?: { field: "updated" | "number" | "title" | "release" | "studio" | "duration"; desc?: boolean };
}

/**
 * 条目封面 → 渲染进程能用的 URL。
 * 优先级: Kura 下载的缓存 → 视频旁边已有的图 (别的工具下的) → null (界面显示占位)。
 */
function coverUrlFor(
  rt: Runtime,
  item: { key: string; poster_urls?: string[]; cover_urls?: string[]; thumb_urls?: string[] },
): string | null {
  const urls = [...(item.poster_urls ?? []), ...(item.cover_urls ?? []), ...(item.thumb_urls ?? [])];
  for (const url of urls) {
    const found = findResource(rt, url);
    if (found) return `kura-res://local/${basename(found.path)}`;
  }

  const file = rt.db.get<{ path: string }>(
    "select path from media_files where number = ? order by path limit 1",
    [item.key],
  );
  if (file) {
    const sidecar = findSidecarImages(file.path).poster;
    if (sidecar) return `kura-file://local/${encodeURIComponent(sidecar)}`;
  }
  return null;
}

/** 翻译是可选后处理: 没开或没配置就返回 null, 刮削照常继续。 */
async function buildTranslator() {
  if (!translateEnabled(settings)) return null;
  return openTranslator(mustRuntime(), createHttp(), resolveLlm(settings));
}

/**
 * 自定义协议必须在 app ready **之后**注册: protocol.handle 内部会拿 defaultSession,
 * 在 ready 之前调用直接抛 "Session can only be received when app is ready"。
 * (registerSchemesAsPrivileged 相反, 必须在那之前 —— 见文件顶部。)
 */
function registerProtocols(): void {
  // 库目录里的现成图片 (不是 Kura 下载的): 只允许读库根目录下的图片文件。
  protocol.handle("kura-file", (request) => {
    const raw = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ""));
    const target = resolve(raw);
    const roots = listLibraries(mustRuntime().db).map((library) => resolve(library.root));
    const inside = roots.some((root) => target === root || target.startsWith(root + sep));
    const isImage = /\.(jpe?g|png|webp|gif)$/i.test(target);
    if (!inside || !isImage) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(target).href);
  });

  // Kura 自己下载的图片缓存: 渲染进程没有 file:// 权限, 也不该有。
  protocol.handle("kura-res", (request) => {
    const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ""));
    if (!/^[a-f0-9]{8,64}\.(jpg|jpeg|png|webp|gif)$/i.test(name)) {
      return new Response("bad resource name", { status: 400 });
    }
    return net.fetch(pathToFileURL(join(resourceDir(mustRuntime()), name)).href);
  });
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

/**
 * 重跑一条历史任务。
 *
 * 这里必须真的跑起来: 没有守护进程, 没有人在消费 `queued` 行 —— 早先的实现
 * 只建了一行 queued, 界面说"已重新入队", 实际上什么都不会发生。
 */
async function rerunTask(id: number): Promise<{ taskId: number; type: string }> {
  const rt = mustRuntime();
  const task = getTask(rt, id);
  if (!task) throw new AppError(`任务不存在: ${id}`, EXIT.NOT_FOUND, { id });
  if (task.status === "running" || task.status === "queued") {
    throw new AppError(`任务 #${id} 还没结束 (${task.status})`, EXIT.RETRYABLE, { id, status: task.status });
  }
  const payload = (task.payload ?? {}) as { limit?: number; includeFailed?: boolean };

  if (task.type === "scrape.pending") {
    return exclusive("重跑刮削", async (signal) => {
      const { task: fresh } = await scrapePendingTask(
        rt,
        {
          registry: defaultSources({ http: createHttp(), dmm: resolveDmmEnv(settings) }),
          fixturesDir,
          sources: fixturesDir ? ["fixture"] : undefined,
          translator: await buildTranslator(),
          limit: payload.limit ?? 20,
          includeFailed: payload.includeFailed === true,
          signal,
          onProgress: (progress) => win?.webContents.send("scrape:progress", progress),
        },
        signal,
      );
      return { taskId: fresh.id, type: fresh.type };
    });
  }

  if (task.type === "translate.pending") {
    return exclusive("重跑翻译", async (signal) => {
      const translator = await buildTranslator();
      if (!translator) {
        throw new AppError("未配置 LLM 或未开启翻译", EXIT.NEEDS_INPUT, {
          hint: "到「设置」填 LLM 地址/Key/模型, 并打开翻译开关",
        });
      }
      const { task: fresh } = await translatePendingTask(
        rt,
        {
          translator,
          limit: payload.limit ?? 1000,
          signal,
          onProgress: (progress) => win?.webContents.send("translate:progress", progress),
        },
        signal,
      );
      return { taskId: fresh.id, type: fresh.type };
    });
  }

  throw new AppError(`这个任务不支持重跑: ${task.type}`, EXIT.USAGE, { type: task.type });
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

  // 仅供开发自查: 截图后退出 (KURA_SCREENSHOT=/path/to.png)。
  // 必须在 load 之前挂, 否则 await loadFile 返回时事件已经过去了。
  if (process.env.KURA_SCREENSHOT) {
    win.webContents.once("did-finish-load", async () => {
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.KURA_SCREENSHOT_DELAY ?? 2500)));
      try {
        const image = await win!.webContents.capturePage();
        await writeFile(process.env.KURA_SCREENSHOT!, image.toPNG());
        console.log("screenshot:", process.env.KURA_SCREENSHOT);
      } catch (err) {
        console.error("screenshot failed:", err);
      }
      app.exit(0);
    });
  }

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
      pendingTranslation: translateEnabled(settings) ? countPendingTranslation(rt) : 0,
      translation: translateEnabled(settings) ? translationStats(rt) : null,
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

  ipcMain.handle("library:rename", (_event, input: { libraryId: number; name: string }) => {
    mustLibrary(input.libraryId);
    return renameLibrary(mustRuntime().db, input.libraryId, input.name);
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

  ipcMain.handle("scan:start", (_event, input: { libraryId: number; force?: boolean }) =>
    exclusive("扫描", async () => {
      return scan(mustRuntime(), {
        library: mustLibrary(input.libraryId),
        force: input.force === true,
        onEvent: (event: ScanEvent) => win?.webContents.send("scan:event", event),
      });
    }),
  );

  ipcMain.handle("scrape:pending", (_event, input: { limit?: number }) =>
    exclusive("刮削", async (signal) => {
      const rt = mustRuntime();
      // 走 *Task 版本: 它会在 tasks 表里留一行, 「任务」页才不是空的。
      const { task, result } = await scrapePendingTask(
        rt,
        {
          registry: defaultSources({ http: createHttp(), dmm: resolveDmmEnv(settings) }),
          fixturesDir,
          sources: fixturesDir ? ["fixture"] : undefined,
          translator: await buildTranslator(),
          limit: input.limit ?? 20,
          signal,
          onProgress: (progress) => win?.webContents.send("scrape:progress", progress),
        },
        signal,
      );
      return result ?? { total: 0, reports: [], cancelled: true, taskId: task.id };
    }),
  );

  ipcMain.handle("llm:test", async () => {
    const config = resolveLlm(settings);
    if (!config) {
      throw new AppError("未配置 LLM", EXIT.NEEDS_INPUT, { hint: "先填地址、Key、模型并保存" });
    }
    // 代理走 Electron 的 session (系统代理或固定服务器), 这里不再自己解析
    const http = new HttpClient({ fetchImpl: browserFetch });
    const sample = await probeTranslator(http, config);
    return { ok: true, model: config.model, endpoint: config.baseUrl, sample };
  });

  ipcMain.handle("translate:pending", (_event, input: { limit?: number } = {}) =>
    exclusive("翻译", async (signal) => {
      const rt = mustRuntime();
      const translator = await buildTranslator();
      if (!translator) {
        throw new AppError("未配置 LLM 或未开启翻译", EXIT.NEEDS_INPUT, {
          hint: "到「设置」填 LLM 地址/Key/模型, 并打开翻译开关",
        });
      }
      // 先白嫖一次本地缓存: 早期版本把 title_original 冲掉的条目可以零成本恢复
      const repaired = repairTranslations(rt, translator);
      const { task, result } = await translatePendingTask(
        rt,
        {
          translator,
          limit: input.limit ?? 1000,
          signal,
          onProgress: (progress) => win?.webContents.send("translate:progress", progress),
        },
        signal,
      );
      return {
        ...(result ?? { count: 0, cancelled: true, reports: [], translated: 0, failed: 0, skipped: 0, taskId: task.id }),
        repaired: repaired.repaired,
      };
    }),
  );

  ipcMain.handle("translate:items", (_event, input: { keys?: unknown }) =>
    exclusive("翻译", async () => {
      const rt = mustRuntime();
      const translator = await buildTranslator();
      if (!translator) throw new AppError("未配置 LLM 或未开启翻译", EXIT.NEEDS_INPUT);

      const keys = Array.isArray(input?.keys) ? input.keys.filter((key): key is string => typeof key === "string") : [];
      const reports = [];
      let translated = 0;
      let failed = 0;
      let skipped = 0;
      for (const key of keys) {
        try {
          const report = await translateItem(rt, key, translator);
          if (report.translated.length > 0) translated++;
          else skipped++;
          reports.push({ ...report, key });
        } catch (err) {
          failed++;
          reports.push({ key, translated: [], error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { count: reports.length, cancelled: false, reports, translated, failed, skipped };
    }),
  );

  ipcMain.handle("translate:cancel", () => {
    currentAbort?.abort();
    return { cancelled: Boolean(currentAbort) };
  });

  ipcMain.handle("scrape:cancel", () => {
    const cancelled = Boolean(currentAbort);
    currentAbort?.abort();
    return { cancelled };
  });

  ipcMain.handle("item:list", (_event, input: ItemListInput = {}) => {
    const rt = mustRuntime();
    // 逐字段转发, 少写一个界面上的筛选就静默失效 (漏过 state 与 sort)。
    const filters = {
      type: input.type,
      actor: input.actor,
      libraryId: input.libraryId,
      q: input.q,
      studio: input.studio,
      label: input.label,
      series: input.series,
      director: input.director,
      tag: input.tag,
      state: input.state,
      sort: input.sort,
    };
    const items = listItems(rt, { ...filters, limit: input.limit ?? 100, offset: input.offset ?? 0 });
    return {
      // 封面是本地缓存的文件, 走自定义协议给渲染进程读 (不给它 file:// 权限)
      items: items.map((item) => ({ ...item, coverUrl: coverUrlFor(rt, item) })),
      total: countItems(rt, filters),
      // 计数与列表同口径: 选了库就只算这个库, 否则"待刮削 N"会把别的库算进来
      pending: countPending(rt, { libraryId: input.libraryId }),
      exhausted: countExhausted(rt, { libraryId: input.libraryId }),
    };
  });

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

  ipcMain.handle("data:open", async () => {
    const dir = mustRuntime().paths.dataDir;
    const error = await shell.openPath(dir);
    if (error) throw new AppError(`打不开数据目录: ${error}`, EXIT.RETRYABLE, { dir });
    return { dir };
  });

  // 详情面板"打开位置"要用: 这个番号在磁盘上的文件。
  ipcMain.handle("item:files", (_event, key: string) => {
    const rt = mustRuntime();
    return rt.db
      .all<{ path: string; size: number }>("select path, size from media_files where number = ? order by path", [key])
      .map((row) => ({ path: row.path, size: row.size }));
  });

  /**
   * 手动改内容类型。类型决定刮削路由与 {content_type} 目录模板, 所以只给
   * 人在详情面板里显式改; 自动改只发生在 scan 对"从没刮过网络"的条目。
   */
  /** 批量: 按当前解析器找出判错的条目; apply 才真的改。 */
  ipcMain.handle("item:retype-detect", (_event, input: { apply?: boolean } = {}) => {
    const changes = detectRetypes(mustRuntime(), { apply: input.apply === true });
    return { applied: input.apply === true, changes };
  });

  ipcMain.handle("item:retype", (_event, input: { key: string; contentType: string }) => {
    const rt = mustRuntime();
    const result = retypeItem(rt, input.key, input.contentType);
    return { ...result, item: getItem(rt, input.key) };
  });

  ipcMain.handle("files:reveal", (_event, path: string) => {
    shell.showItemInFolder(path);
    return true;
  });

  ipcMain.handle("tasks:list", (_event, input: { limit?: number } = {}) =>
    listTasks(mustRuntime(), { limit: input.limit ?? 20 }),
  );

  ipcMain.handle("tasks:retry", (_event, input: { id: number }) => rerunTask(input.id));

  ipcMain.handle("item:get", (_event, number: string) => {
    const rt = mustRuntime();
    const item = getItem(rt, number);
    // 详情面板要显示图, 与列表用同一套解析 (缓存 → 视频旁现成图)
    return item ? { ...item, coverUrl: coverUrlFor(rt, item) } : null;
  });

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
      if (!result.poster && !result.thumb) {
        throw new AppError(result.tried.length === 0 ? "该条目没有图片 URL" : "图片下载失败", EXIT.RETRYABLE);
      }
      const file = (resource: { path: string; size: number } | null) =>
        resource ? { path: resource.path, size: resource.size } : null;
      // 顺手把图放到视频旁边: 只在设置里没关掉时做, 只读盘上失败也不影响缓存。
      const placed =
        settings.saveImages !== false
          ? await placeImagesBesideVideo(rt, item, { poster: result.poster, thumb: result.thumb })
          : { saved: [], skipped: [], errors: [] };
      return {
        key: input.key,
        poster: file(result.poster),
        thumb: file(result.thumb),
        saved: placed.saved.length,
        saveErrors: placed.errors,
      };
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
      pendingTranslation: translateEnabled(settings) ? countPendingTranslation(rt) : 0,
      translation: translateEnabled(settings) ? translationStats(rt) : null,
      dimensions: DIMENSIONS,
    };
  });

  /**
   * 代理自查: 报出"配置的是什么"和"实际在用的是什么", 以及端口通不通。
   * 代理类故障的排查全靠这一步, 否则用户只会看到 net::ERR_PROXY_CONNECTION_FAILED。
   */
  ipcMain.handle("proxy:test", async () => {
    const configured = resolveProxy(settings) ?? "";
    const targets = await Promise.all(
      proxyCandidates(process.platform).map(async (candidate) => ({
        candidate,
        reachable: await probeProxyTarget(candidate, 700),
      })),
    );
    return {
      configured,
      effective: effectiveProxy.mode === "fixed" ? effectiveProxy.rules : "(Windows 系统代理 / 直连)",
      reachable: targets.filter((entry) => entry.reachable).map((entry) => entry.candidate),
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
      // 启动失败要落盘: 弹窗会被手快关掉, 但日志不会
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      try {
        const { logDir, dataDir } = resolvePaths();
        await mkdir(logDir, { recursive: true });
        await writeFile(join(logDir, "startup.log"), `[${new Date().toISOString()}] dataDir=${dataDir}\n${message}\n\n`, {
          flag: "a",
          encoding: "utf8",
        });
      } catch {
        // 写日志再失败就只能靠弹窗了
      }
      dialog.showErrorBox("无法初始化数据库", err instanceof Error ? err.message : String(err));
      app.exit(EXIT.INTERNAL);
      return;
    }
    await applyProxy();
    registerProtocols();
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
