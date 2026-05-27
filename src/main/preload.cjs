const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quotaWidget", {
  getState: () => ipcRenderer.invoke("quota:get-state"),
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("quota:state-changed", listener);
    return () => ipcRenderer.removeListener("quota:state-changed", listener);
  },
});
