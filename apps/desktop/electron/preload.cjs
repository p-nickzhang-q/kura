// contextIsolation 下唯一的桥。渲染进程拿不到 require / ipcRenderer 本体。
// 保持 CommonJS: Electron 的 preload 用 CJS 最稳妥。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kura", {
  info: () => ipcRenderer.invoke("app:info"),
  libraries: () => ipcRenderer.invoke("library:list"),
  addLibrary: () => ipcRenderer.invoke("library:add"),
  scan: (libraryId) => ipcRenderer.invoke("scan:start", { libraryId }),
  setLibraryTemplate: (libraryId, dimension) => ipcRenderer.invoke("library:set-template", { libraryId, dimension }),
  scrapePending: (limit) => ipcRenderer.invoke("scrape:pending", { limit }),
  items: (limit) => ipcRenderer.invoke("item:list", { limit }),
  item: (number) => ipcRenderer.invoke("item:get", number),
  updateItem: (input) => ipcRenderer.invoke("item:update", input),
  scrapeKeys: (keys) => ipcRenderer.invoke("scrape:keys", { keys }),
  fetchPoster: (key) => ipcRenderer.invoke("resource:fetch", { key }),
  organizePreview: (libraryId) => ipcRenderer.invoke("organize:preview", { libraryId }),
  organizeApply: (libraryId) => ipcRenderer.invoke("organize:apply", { libraryId }),
  configGet: () => ipcRenderer.invoke("config:get"),
  configSet: (patch) => ipcRenderer.invoke("config:set", patch),
  testDmm: (probe) => ipcRenderer.invoke("dmm:test", probe),
  /** 返回取消订阅函数, 供组件卸载时调用。 */
  onScanEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("scan:event", handler);
    return () => ipcRenderer.off("scan:event", handler);
  },
});
