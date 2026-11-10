const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("untangle", {
  call: (command) => ipcRenderer.invoke("worker:call", command),
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),
});
