// contextIsolation 下唯一的桥。渲染进程拿不到 require / ipcRenderer 本体。
// 保持 CommonJS: Electron 的 preload 用 CJS 最稳妥。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kura", {
  info: () => ipcRenderer.invoke("app:info"),
  libraries: () => ipcRenderer.invoke("library:list"),
  addLibrary: () => ipcRenderer.invoke("library:add"),
  scan: (libraryId, options = {}) => ipcRenderer.invoke("scan:start", { libraryId, force: options.force === true }),
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
  tasks: (limit) => ipcRenderer.invoke("tasks:list", { limit }),
  retryTask: (id) => ipcRenderer.invoke("tasks:retry", { id }),
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
