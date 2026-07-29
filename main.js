const { app, BrowserWindow, Menu, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow;

const { getDataDir } = require('./paths.js');

function loadConfig() {
    const settingsPath = path.join(getDataDir(), 'settings.json');
    const defaults = { isServer: true, serverIP: 'localhost' };
    try {
        if (fs.existsSync(settingsPath)) {
            return Object.assign(defaults, JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
        }
    } catch (err) {
        dialog.showErrorBox('Bad settings.json', `Could not read settings, using defaults.\n\n${err.message}`);
    }
    fs.writeFileSync(settingsPath, JSON.stringify(defaults, null, 2));
    return defaults;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 740,
        height: 400,
        title: 'Chit-Chat',
        backgroundColor: '#e2e5e9',
        webPreferences: {
            // The UI is plain HTML served over HTTP and uses no Node APIs.
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    Menu.setApplicationMenu(null);

    // The menu bar is hidden, which also removes the usual reload shortcut.
    // Put it back so Cmd+R / Ctrl+R / F5 force a fresh copy of the page.
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        const isReload = input.key === 'F5' ||
            (input.key.toLowerCase() === 'r' && (input.control || input.meta));
        if (isReload) {
            mainWindow.webContents.reloadIgnoringCache();
            event.preventDefault();
        }
    });

    const config = loadConfig();

    if (config.isServer) {
        try {
            // server.js exports the http server so we can wait for the real
            // 'listening' event instead of guessing with a 1500ms timeout.
            const { server } = require('./server.js');
            const open = () => mainWindow.loadURL('http://localhost:3000/index.html');
            if (server.listening) open(); else server.once('listening', open);
            server.on('error', (err) => {
                const msg = err.code === 'EADDRINUSE'
                    ? 'Port 3000 is already in use. Another copy of Chit-Chat may already be running on this computer.'
                    : err.stack;
                dialog.showErrorBox('Server Error', msg);
            });
        } catch (error) {
            dialog.showErrorBox('Server Failed to Start', error.stack);
        }
    } else {
        mainWindow.loadURL(`http://${config.serverIP}:3000/index.html`);
        mainWindow.webContents.on('did-fail-load', () => {
            dialog.showErrorBox(
                'Cannot Reach Server',
                `Could not connect to ${config.serverIP}:3000.\n\n` +
                'Check that the server computer is on and that Windows Firewall allows Chit-Chat.'
            );
        });
    }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
