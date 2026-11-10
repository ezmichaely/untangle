const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("untangle", {
  call: (command) => ipcRenderer.invoke("worker:call", command),
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),
  onEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("worker:event", listener);
    return () => ipcRenderer.removeListener("worker:event", listener);
  },
});
