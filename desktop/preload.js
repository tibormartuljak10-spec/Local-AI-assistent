const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  isDesktop: true,
  installOllamaAndModel: (modelName) => ipcRenderer.invoke("setup:install", modelName),
  openOllamaDownload: () => ipcRenderer.invoke("setup:open-download"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateStatus: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on("update:status", handler);
    return () => ipcRenderer.removeListener("update:status", handler);
  },
  onSetupProgress: (listener) => {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on("setup:progress", handler);
    return () => ipcRenderer.removeListener("setup:progress", handler);
  }
});
