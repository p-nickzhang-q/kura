// contextIsolation 下唯一的桥。渲染进程拿不到 require / ipcRenderer 本体。
// 保持 CommonJS: Electron 的 preload 用 CJS 最稳妥。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kura", {
  info: () => ipcRenderer.invoke("app:info"),
  libraries: () => ipcRenderer.invoke("library:list"),
  // 影视域的几条: 待绑定目录 / TMDB 搜索 / 绑定 / 集列表 / 单部刮削
  bindableDirs: (libraryId, paging) =>
    ipcRenderer.invoke("file:dirs", { ...(libraryId === undefined ? {} : { libraryId }), ...(paging ?? {}) }),
  tmdbSearch: (kind, query) => ipcRenderer.invoke("tmdb:search", { kind, query }),
  tmdbTest: (probeId) => ipcRenderer.invoke("tmdb:test", probeId),
  tmdbSuggest: (libraryId, kind) =>
    ipcRenderer.invoke("tmdb:suggest", { ...(libraryId === undefined ? {} : { libraryId }), ...(kind ? { kind } : {}) }),
  onSuggestProgress: (callback) => {
    const handler = (_event, update) => callback(update);
    ipcRenderer.on("suggest:progress", handler);
    return () => ipcRenderer.removeListener("suggest:progress", handler);
  },
  bindMany: (libraryId, items) => ipcRenderer.invoke("file:bind-many", { libraryId, items }),
  bindDir: (libraryId, dir, key, paths, season) =>
    ipcRenderer.invoke("file:bind", { libraryId, dir, key, ...(paths ? { paths } : {}), ...(season === undefined ? {} : { season }) }),
  itemDirs: (key) => ipcRenderer.invoke("item:dirs", { key }),
  spreadSeasons: (key, dir) => ipcRenderer.invoke("item:spread-seasons", { key, ...(dir ? { dir } : {}) }),
  setDirSeason: (libraryId, dir, season, key) =>
    ipcRenderer.invoke("file:set-season", { libraryId, dir, season, ...(key ? { key } : {}) }),
  itemEpisodes: (key) => ipcRenderer.invoke("item:episodes", { key }),
  rebindItem: (key, newKey) => ipcRenderer.invoke("item:rebind", { key, newKey }),
  unbindItem: (key) => ipcRenderer.invoke("item:unbind", { key }),
  scrapeShow: (key) => ipcRenderer.invoke("scrape:show", { key }),
  addLibrary: (domain) => ipcRenderer.invoke("library:add", domain ? { domain } : {}),
  scan: (libraryId, options = {}) => ipcRenderer.invoke("scan:start", { libraryId, force: options.force === true }),
  removeLibrary: (libraryId) => ipcRenderer.invoke("library:remove", { libraryId }),
  renameLibrary: (libraryId, name) => ipcRenderer.invoke("library:rename", { libraryId, name }),
  setLibraryTemplate: (libraryId, dimension) => ipcRenderer.invoke("library:set-template", { libraryId, dimension }),
  setLibraryOrganize: (libraryId, enabled) => ipcRenderer.invoke("library:set-organize", { libraryId, enabled }),
  scrapePending: (limit) => ipcRenderer.invoke("scrape:pending", { limit }),
  cancelScrape: () => ipcRenderer.invoke("scrape:cancel"),
  translatePending: (limit) => ipcRenderer.invoke("translate:pending", { limit }),
  translateItems: (keys) => ipcRenderer.invoke("translate:items", { keys }),
  cancelTranslate: () => ipcRenderer.invoke("translate:cancel"),
  onTranslateProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("translate:progress", listener);
    return () => ipcRenderer.off("translate:progress", listener);
  },
  items: (params) => ipcRenderer.invoke("item:list", params ?? {}),
  item: (number) => ipcRenderer.invoke("item:get", number),
  unparsedFiles: (params) => ipcRenderer.invoke("files:unparsed", params ?? {}),
  revealFile: (path) => ipcRenderer.invoke("files:reveal", path),
  proxyTest: () => ipcRenderer.invoke("proxy:test"),
  itemFiles: (key) => ipcRenderer.invoke("item:files", key),
  retypeItem: (key, contentType) => ipcRenderer.invoke("item:retype", { key, contentType }),
  retypeDetect: (apply = false) => ipcRenderer.invoke("item:retype-detect", { apply }),
  openDataDir: () => ipcRenderer.invoke("data:open"),
  syncNfo: (input) => ipcRenderer.invoke("nfo:sync", input),
  onNfoProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("nfo:progress", listener);
    return () => ipcRenderer.removeListener("nfo:progress", listener);
  },
  tasks: (limit) => ipcRenderer.invoke("tasks:list", { limit }),
  retryTask: (id, onlyFailed) => ipcRenderer.invoke("tasks:retry", { id, onlyFailed: onlyFailed === true }),
  taskFailures: (id, limit) => ipcRenderer.invoke("tasks:failures", { id, limit }),
  updateItem: (input) => ipcRenderer.invoke("item:update", input),
  scrapeKeys: (keys) => ipcRenderer.invoke("scrape:keys", { keys }),
  fetchPoster: (key) => ipcRenderer.invoke("resource:fetch", { key }),
  organizePreview: (libraryId) => ipcRenderer.invoke("organize:preview", { libraryId }),
  organizeApply: (libraryId) => ipcRenderer.invoke("organize:apply", { libraryId }),
  configGet: () => ipcRenderer.invoke("config:get"),
  configSet: (patch) => ipcRenderer.invoke("config:set", patch),
  testDmm: (probe) => ipcRenderer.invoke("dmm:test", probe),
  testLlm: () => ipcRenderer.invoke("llm:test"),
  /** 返回取消订阅函数, 供组件卸载时调用。 */
  onScrapeProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("scrape:progress", handler);
    return () => ipcRenderer.off("scrape:progress", handler);
  },
  onScanEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("scan:event", handler);
    return () => ipcRenderer.off("scan:event", handler);
  },
});
