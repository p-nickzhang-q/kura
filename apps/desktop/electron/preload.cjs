// contextIsolation 下唯一的桥。渲染进程拿不到 require / ipcRenderer 本体。
// 保持 CommonJS: Electron 的 preload 用 CJS 最稳妥 (ESM preload 需要额外条件)。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kura", {
  info: () => ipcRenderer.invoke("app:info"),
  pickDir: () => ipcRenderer.invoke("dialog:pick-dir"),
  scan: (root, dryRun) => ipcRenderer.invoke("scan:start", { root, dryRun }),
  /** 返回取消订阅函数, 供组件 onUnmounted 调用。 */
  onScanEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("scan:event", handler);
    return () => ipcRenderer.off("scan:event", handler);
  },
});
