const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const { getDataDir } = require('./paths.js');
const discovery = require('./discovery.js');

let mainWindow = null;
let setupWindow = null;
let tray = null;
let currentConfig = null;
let quitting = false;

const settingsPath = () => path.join(getDataDir(), 'settings.json');

// A 32px icon built in rather than shipped as a file, so it can't go missing
// from a build or get stripped by the packager.
const TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAuUlEQVR4nO2X3RVAMAyFI8c4rMAKTMoKrMA+POUcf6mSSPrgPmrlfkmqWgBnZdxAUTWLptE89pdep4faxncgaGl+5YHcgBUEhiZaCAFssyeRZxoV8FQeO3EausfBy7qVA7wxPr4bAnFvQRBAkn1snLQr8AP8AO4AMTtZjJLeiG63YqJ3+xdsg3EQklaJWyBdJyIAjUX6GkDrC0EA/tLwpTl5Pq6AVuakXeZWp+NtxZEbsDAHSOBy6q4VnQg9IdPAzBgAAAAASUVORK5CYII=';

// ---------------------------------------------------------------- settings

function loadConfig() {
    try {
        if (fs.existsSync(settingsPath())) {
            const cfg = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
            // Anything with a usable mode counts as configured. This keeps
            // installs that predate the setup screen working untouched.
            if (typeof cfg.isServer === 'boolean') return cfg;
        }
    } catch (err) {
        console.log('Could not read settings.json:', err.message);
    }
    return null;
}

function saveConfig(cfg) {
    fs.writeFileSync(settingsPath(), JSON.stringify(cfg, null, 2));
    currentConfig = cfg;
}

// ------------------------------------------------------------ setup screen

function createSetupWindow() {
    if (setupWindow) { setupWindow.focus(); return; }

    setupWindow = new BrowserWindow({
        width: 520,
        height: 560,
        title: 'Chit-Chat Setup',
        backgroundColor: '#e2e5e9',
        resizable: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    setupWindow.loadFile(path.join(__dirname, 'setup.html'));
    setupWindow.on('closed', () => {
        setupWindow = null;
        // Closing setup without choosing anything means there's nothing to run.
        if (!mainWindow && !currentConfig) app.quit();
    });
}

ipcMain.handle('setup:discover', async () => {
    return await discovery.findServer(2500);
});

ipcMain.handle('setup:localIPs', async () => discovery.localIPs());

ipcMain.handle('setup:save', async (event, cfg) => {
    saveConfig({ isServer: !!cfg.isServer, serverIP: cfg.serverIP || 'localhost' });
    if (setupWindow) { setupWindow.close(); setupWindow = null; }
    if (mainWindow) { mainWindow.destroy(); mainWindow = null; }
    launch();
    return true;
});

// -------------------------------------------------------------- main window

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 740,
        height: 400,
        title: 'Chit-Chat',
        backgroundColor: '#e2e5e9',
        icon: nativeImage.createFromDataURL(TRAY_ICON),
        webPreferences: {
            preload: path.join(__dirname, 'notify-preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    Menu.setApplicationMenu(null);

    // The menu bar is hidden, which also removes the usual reload shortcut.
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        const isReload = input.key === 'F5' ||
            (input.key.toLowerCase() === 'r' && (input.control || input.meta));
        if (isReload) {
            mainWindow.webContents.reloadIgnoringCache();
            event.preventDefault();
        }
    });

    // On the server machine, closing the window must not take the whole office
    // down with it. Hide to the tray instead; quitting is a deliberate act.
    mainWindow.on('close', (event) => {
        if (quitting || !currentConfig || !currentConfig.isServer) return;
        event.preventDefault();
        mainWindow.hide();
        if (tray && process.platform === 'win32' && !mainWindow.hasShownTrayHint) {
            mainWindow.hasShownTrayHint = true;
            try {
                tray.displayBalloon({
                    title: 'Chit-Chat is still running',
                    content: 'The office board stays available. Right-click the tray icon to quit properly.'
                });
            } catch (e) {}
        }
    });

    mainWindow.on('focus', () => {
        try { mainWindow.flashFrame(false); } catch (e) {}
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
    if (tray) return;
    try {
        tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON));
    } catch (e) {
        console.log('Tray unavailable:', e.message);
        return;
    }
    tray.setToolTip('Chit-Chat');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Chit-Chat', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { type: 'separator' },
        { label: 'Change server settings...', click: () => createSetupWindow() },
        { type: 'separator' },
        {
            label: 'Quit Chit-Chat',
            click: () => {
                if (currentConfig && currentConfig.isServer) {
                    const choice = dialog.showMessageBoxSync({
                        type: 'warning',
                        buttons: ['Cancel', 'Quit anyway'],
                        defaultId: 0,
                        cancelId: 0,
                        title: 'This is the server',
                        message: 'Quitting will disconnect every other computer in the office.',
                        detail: 'Only do this at the end of the day, or if you have been asked to.'
                    });
                    if (choice !== 1) return;
                }
                quitting = true;
                app.quit();
            }
        }
    ]));
    tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// --------------------------------------------------------- notifications

ipcMain.on('notify:attention', (event, opts) => {
    if (!mainWindow) return;
    opts = opts || {};

    // Already looking at it? Then there is nothing to attract.
    if (mainWindow.isFocused() && mainWindow.isVisible()) return;

    if (opts.popup) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        // Briefly on top, otherwise Windows often refuses to raise a window
        // that the user didn't interact with themselves.
        mainWindow.setAlwaysOnTop(true);
        mainWindow.focus();
        mainWindow.setAlwaysOnTop(false);
    }

    if (opts.flash) {
        try { mainWindow.flashFrame(true); } catch (e) {}
    }
});

// ------------------------------------------------------------------ startup

function launch() {
    createMainWindow();
    createTray();

    if (currentConfig.isServer) {
        try {
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
        connectToServer(currentConfig.serverIP);
    }
}

function connectToServer(ip) {
    mainWindow.loadURL(`http://${ip}:3000/index.html`);

    mainWindow.webContents.once('did-fail-load', async () => {
        // The saved address may be stale - routers reassign addresses. Look for
        // the server again before bothering anyone with an error.
        const found = await discovery.findServer(3000);

        if (found && found !== ip) {
            saveConfig({ isServer: false, serverIP: found });
            connectToServer(found);
            return;
        }

        const choice = dialog.showMessageBoxSync({
            type: 'error',
            buttons: ['Try again', 'Change settings'],
            defaultId: 0,
            title: 'Cannot Reach Server',
            message: `Could not connect to ${ip}.`,
            detail: 'Check that the server computer is switched on, that Chit-Chat is running on it, and that Windows Firewall is allowing it.'
        });

        if (choice === 0) connectToServer(ip);
        else createSetupWindow();
    });
}

async function start() {
    currentConfig = loadConfig();

    if (currentConfig) {
        launch();
        return;
    }

    // First run on this computer. The setup screen searches for a server
    // itself, so most machines are one click away from being finished.
    createSetupWindow();
}

app.whenReady().then(start);

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
    // A server hidden in the tray has no windows but must keep running.
    if (currentConfig && currentConfig.isServer) return;
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (mainWindow) mainWindow.show();
    else if (currentConfig) launch();
});
