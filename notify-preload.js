// Attached to the main board window. Lets the page ask the app to get
// someone's attention, without giving the page any other access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chitchat', {
    notify: (opts) => ipcRenderer.send('notify:attention', opts || {})
});
