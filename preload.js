// The setup screen runs with contextIsolation on, so it can't touch Node
// directly. This exposes exactly three things and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
    discover: () => ipcRenderer.invoke('setup:discover'),
    localIPs: () => ipcRenderer.invoke('setup:localIPs'),
    save: (cfg) => ipcRenderer.invoke('setup:save', cfg)
});
