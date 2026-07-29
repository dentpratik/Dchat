// Single source of truth for where the app stores its files.
// NOTE: the folder stays named 'Dchat' on purpose. It is internal, nobody sees
// it, and renaming it would orphan every existing station list and setting.
// Both main.js and server.js use this, so they can never point at different folders.
const fs = require('fs');
const path = require('path');
const os = require('os');

function documentsRoot() {
    // process.versions.electron only exists when we are really running inside
    // Electron. Checking it first avoids loading the 'electron' npm shim, which
    // tries to download a binary if server.js is ever run under plain node.
    if (process.versions && process.versions.electron) {
        try {
            // Inside Electron this respects Windows folder redirection (e.g. OneDrive).
            const { app } = require('electron');
            if (app && typeof app.getPath === 'function') return app.getPath('documents');
        } catch (e) { /* fall through to the plain-node default */ }
    }
    return path.join(os.homedir(), 'Documents');
}

function getDataDir() {
    const dir = path.join(documentsRoot(), 'Dchat');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

module.exports = { getDataDir };
