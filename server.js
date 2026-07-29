const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./paths.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Serve files from the unpacked folder when packaged, else from source ---
const unpacked = process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked') : null;
const staticPath = (unpacked && fs.existsSync(unpacked)) ? unpacked : __dirname;
// Never let a client cache the pages. Electron caches aggressively and will
// happily keep showing an old build of index.html after an update.
app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html')) res.set('Cache-Control', 'no-store');
    next();
});
app.use(express.static(staticPath));

// TEMPORARY TEST ROUTE
app.get('/test', (req, res) => {
    res.send(`<h1>Server is running!</h1><p>Static Path is: ${staticPath}</p><p>Path exists: ${fs.existsSync(staticPath)}</p>`);
});


// --- Use Documents folder for permanent data (shared with main.js) ---
const dataFile = path.join(getDataDir(), 'data.json');

let masterStations = [
    { id: 1, name: "Operatory 1" }, { id: 2, name: "Operatory 2" }, { id: 3, name: "Operatory 3" }, { id: 4, name: "Operatory 4" },
    { id: 5, name: "Operatory 5" }, { id: 6, name: "Operatory 6" }, { id: 7, name: "Operatory 7" }, { id: 8, name: "Operatory 8" },
    { id: 9, name: "Manager" }, { id: 10, name: "Front Desk 1" }, { id: 11, name: "Front Desk 2" }, { id: 12, name: "Lab" }
];

let masterDoctors = [
    { id: 1, name: "Dr. Smith", isWorking: true },
    { id: 2, name: "Dr. Jones", isWorking: false }
];

let masterCategories = [
    { id: 1, name: "Recall", color: "#3498db", sound: "None" },
    { id: 2, name: "Comp Exam", color: "#2ecc71", sound: "Chime" },
    { id: 3, name: "Anesthesia", color: "#e74c3c", sound: "Buzzer" },
    { id: 4, name: "X-Ray", color: "#9b59b6", sound: "Bell" },
    { id: 5, name: "Hygiene", color: "#f1c40f", sound: "Pop" },
    { id: 6, name: "Crown Prep", color: "#e67e22", sound: "None" }
];

// Who gets emergency-med expiry alerts, on top of whichever doctors are working.
let alertRecipients = ["Liz"];
const ALERT_DAYS = 30;

let masterSupplies = [];
let masterMeds = [];

let nextStationId = 13;
let nextDocId = 3;
let nextCatId = 7;
let nextSupplyId = 1;
let nextMedId = 1;
const CATEGORY_PALETTE = ['#3498db','#2ecc71','#e74c3c','#9b59b6','#f1c40f','#e67e22','#1abc9c','#34495e'];
let activeUsers = {};

function loadData() {
    if (fs.existsSync(dataFile)) {
        const savedData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        masterStations = savedData.stations || masterStations;
        masterDoctors = savedData.doctors || masterDoctors;
        masterCategories = savedData.categories || masterCategories;
        masterSupplies = savedData.supplies || masterSupplies;
        masterMeds = savedData.meds || masterMeds;
        if (Array.isArray(savedData.alertRecipients)) alertRecipients = savedData.alertRecipients;
        if (masterStations.length > 0) nextStationId = Math.max(...masterStations.map(s => s.id)) + 1;
        if (masterDoctors.length > 0) nextDocId = Math.max(...masterDoctors.map(d => d.id)) + 1;
        if (masterCategories.length > 0) nextCatId = Math.max(...masterCategories.map(c => c.id)) + 1;
        if (masterSupplies.length > 0) nextSupplyId = Math.max(...masterSupplies.map(s => s.id)) + 1;
        if (masterMeds.length > 0) nextMedId = Math.max(...masterMeds.map(m => m.id)) + 1;
        console.log('Loaded saved data from data.json');
    } else {
        console.log('No data.json found. Starting with defaults.');
    }
}

function saveData() {
    const data = {
        stations: masterStations,
        doctors: masterDoctors,
        categories: masterCategories,
        supplies: masterSupplies,
        meds: masterMeds,
        alertRecipients: alertRecipients
    };
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
}

loadData();

function syncData(targetSocket) {
    const payload = {
        stations: masterStations,
        doctors: masterDoctors,
        categories: masterCategories,
        supplies: masterSupplies,
        meds: masterMeds,
        alertRecipients: alertRecipients
    };
    if (targetSocket) {
        targetSocket.emit('syncData', payload);
    } else {
        io.emit('syncData', payload);
        saveData();
    }
}

// ---------------- EMERGENCY MED EXPIRY ALERTS ----------------
// Runs here on the server rather than in a browser window, so it works whether
// or not anyone has the Supplies screen open.

// Local calendar date as YYYY-MM-DD. Deliberately not toISOString(), which uses
// UTC and would roll over to tomorrow during the evening in US time zones.
function localDateStr(d) {
    const dt = d || new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Whole days from today until an expiry date. Parsed piece by piece because
// new Date('2026-09-15') is read as UTC midnight and lands a day early.
function daysUntilExpiry(dateStr) {
    const parts = String(dateStr || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    const expiry = new Date(parts[0], parts[1] - 1, parts[2]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((expiry - today) / 86400000);
}

function getAlertTargets() {
    const working = masterDoctors.filter(d => d.isWorking).map(d => d.name);
    return [...new Set([...working, ...alertRecipients])].filter(n => n && n.trim());
}

// Alerts raised today, kept so somebody who switches their computer on at 9am
// still receives the 8am alert instead of it vanishing into an empty room.
let pendingAlerts = [];
let pendingAlertsDate = localDateStr();

function deliverAlert(entry) {
    for (const socketId in activeUsers) {
        const name = activeUsers[socketId];
        if (!entry.msg.target.includes(name)) continue;
        if (entry.deliveredTo.includes(name)) continue;
        const sock = io.sockets.sockets.get(socketId);
        if (sock) {
            sock.emit('receiveMessage', entry.msg);
            entry.deliveredTo.push(name);
        }
    }
}

function checkMedExpiry() {
    const today = localDateStr();
    if (pendingAlertsDate !== today) {
        pendingAlerts = [];
        pendingAlertsDate = today;
    }

    const targets = getAlertTargets();
    if (targets.length === 0) return;

    let raised = false;

    masterMeds.forEach(med => {
        if (med.received) return;
        const days = daysUntilExpiry(med.expiryDate);
        if (days === null || days > ALERT_DAYS) return;
        if (med.lastAlertDate === today) return;   // one alert per med per day

        med.lastAlertDate = today;
        raised = true;

        const content = days < 0
            ? `EXPIRED: ${med.name} expired on ${med.expiryDate} (${Math.abs(days)} days ago). Replace it.`
            : `EXPIRING SOON: ${med.name} expires ${med.expiryDate} (${days} day${days === 1 ? '' : 's'} left).` +
              (med.ordered ? ' Already marked as ordered.' : ' Please reorder.');

        const entry = {
            msg: {
                id: Date.now() + Math.random(),
                type: 'private',
                from: 'Med Alert',
                target: targets,
                content: content,
                time: new Date().toLocaleTimeString()
            },
            deliveredTo: []
        };
        pendingAlerts.push(entry);
        deliverAlert(entry);
        console.log(`Med alert raised: ${med.name} -> ${targets.join(', ')}`);
    });

    if (raised) saveData();
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    syncData(socket);

    socket.on('sendMessage', (msg) => { socket.broadcast.emit('receiveMessage', msg); });
    socket.on('sendEmergency', (emergencyData) => { socket.broadcast.emit('receiveEmergency', emergencyData); });
    socket.on('updateStatus', (data) => { socket.broadcast.emit('statusUpdated', data); });

    socket.on('registerName', (name) => {
        const isTaken = Object.values(activeUsers).includes(name);
        if (isTaken) {
            socket.emit('nameTaken', name);
        } else {
            activeUsers[socket.id] = name;
            // Hand over anything raised earlier today that this person hasn't seen.
            pendingAlerts.forEach(deliverAlert);
        }
    });

    socket.on('addStation', (name) => {
        masterStations.push({ id: nextStationId++, name: name });
        syncData();
    });

    socket.on('deleteStation', (id) => {
        masterStations = masterStations.filter(s => s.id !== id);
        syncData();
    });

    socket.on('updateStationName', (data) => {
        const station = masterStations.find(s => s.id === data.id);
        if (station) {
            station.name = data.name;
            syncData();
        }
    });

    socket.on('updateStationOrder', (orderedIds) => {
        masterStations.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
        syncData();
    });

    socket.on('addDoctor', (name) => {
        masterDoctors.push({ id: nextDocId++, name: name, isWorking: true });
        syncData();
    });

    socket.on('deleteDoctor', (id) => {
        masterDoctors = masterDoctors.filter(d => d.id !== id);
        syncData();
    });

    socket.on('toggleDoctor', (id) => {
        const doc = masterDoctors.find(d => d.id === id);
        if (doc) doc.isWorking = !doc.isWorking;
        syncData();
    });

    socket.on('addCategory', (name) => {
        const clean = String(name || '').trim();
        if (!clean) return;
        masterCategories.push({
            id: nextCatId++,
            name: clean,
            color: CATEGORY_PALETTE[masterCategories.length % CATEGORY_PALETTE.length],
            sound: 'None'
        });
        syncData();
    });

    socket.on('deleteCategory', (id) => {
        masterCategories = masterCategories.filter(c => c.id !== id);
        syncData();
    });

    socket.on('updateCategory', (data) => {
        const cat = masterCategories.find(c => c.id === data.id);
        if (!cat) return;
        if (typeof data.name === 'string' && data.name.trim()) cat.name = data.name.trim();
        if (typeof data.color === 'string') cat.color = data.color;
        if (typeof data.sound === 'string') cat.sound = data.sound;
        syncData();
    });

    // ---------- SUPPLIES ----------

    socket.on('addSupply', (name) => {
        const clean = String(name || '').trim();
        if (!clean) return;
        // Don't create a second entry for the same material.
        if (masterSupplies.some(s => s.name.toLowerCase() === clean.toLowerCase())) return;
        masterSupplies.push({ id: nextSupplyId++, name: clean, status: 'green' });
        syncData();
    });

    socket.on('setSupplyStatus', (data) => {
        if (!['green', 'yellow', 'red'].includes(data.status)) return;
        const item = masterSupplies.find(s => s.id === data.id);
        if (!item) return;
        item.status = data.status;
        syncData();
    });

    socket.on('deleteSupply', (id) => {
        masterSupplies = masterSupplies.filter(s => s.id !== id);
        syncData();
    });

    socket.on('clearSupplyList', () => {
        masterSupplies.forEach(item => { item.status = 'green'; });
        syncData();
    });

    // ---------- EMERGENCY MEDS ----------

    socket.on('addAlertRecipient', (name) => {
        const clean = String(name || '').trim();
        if (!clean) return;
        if (alertRecipients.some(r => r.toLowerCase() === clean.toLowerCase())) return;
        alertRecipients.push(clean);
        syncData();
    });

    socket.on('removeAlertRecipient', (name) => {
        alertRecipients = alertRecipients.filter(r => r !== name);
        syncData();
    });

    socket.on('addMed', (data) => {
        const name = String(data && data.name || '').trim();
        const expiryDate = String(data && data.expiryDate || '').trim();
        if (!name || !expiryDate) return;
        masterMeds.push({
            id: nextMedId++,
            name: name,
            expiryDate: expiryDate,
            ordered: false,
            received: false,
            lastAlertDate: null
        });
        syncData();
        checkMedExpiry();
    });

    socket.on('updateMed', (data) => {
        const med = masterMeds.find(m => m.id === data.id);
        if (!med) return;
        if (typeof data.name === 'string' && data.name.trim()) med.name = data.name.trim();
        if (typeof data.expiryDate === 'string' && data.expiryDate) med.expiryDate = data.expiryDate;
        // A changed date means the old received/alert state no longer applies.
        med.received = false;
        med.lastAlertDate = null;
        syncData();
        checkMedExpiry();
    });

    socket.on('toggleMedOrdered', (id) => {
        const med = masterMeds.find(m => m.id === id);
        if (!med) return;
        med.ordered = !med.ordered;
        syncData();
    });

    socket.on('markMedReceived', (id) => {
        const med = masterMeds.find(m => m.id === id);
        if (!med) return;
        med.received = true;
        med.ordered = false;
        med.lastAlertDate = null;
        syncData();
    });

    socket.on('deleteMed', (id) => {
        masterMeds = masterMeds.filter(m => m.id !== id);
        syncData();
    });

    // One-time move of a computer's old private list onto the server.
    // Only accepted while the shared list is still empty, so two computers
    // can't both import and create duplicates.
    socket.on('importSupplies', (list) => {
        if (masterSupplies.length > 0 || !Array.isArray(list)) return;
        list.forEach(item => {
            const name = String(item && item.name || '').trim();
            if (!name) return;
            masterSupplies.push({
                id: nextSupplyId++,
                name: name,
                status: ['green', 'yellow', 'red'].includes(item.status) ? item.status : 'green'
            });
        });
        console.log(`Imported ${masterSupplies.length} supplies from a client.`);
        syncData();
    });

    socket.on('importMeds', (list) => {
        if (masterMeds.length > 0 || !Array.isArray(list)) return;
        list.forEach(item => {
            const name = String(item && item.name || '').trim();
            const expiryDate = String(item && item.expiryDate || '').trim();
            if (!name || !expiryDate) return;
            masterMeds.push({
                id: nextMedId++,
                name: name,
                expiryDate: expiryDate,
                ordered: !!item.ordered,
                received: !!item.received,
                lastAlertDate: null
            });
        });
        console.log(`Imported ${masterMeds.length} meds from a client.`);
        syncData();
    });

    socket.on('disconnect', () => {
        console.log('A user disconnected:', socket.id);
        delete activeUsers[socket.id];
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Chit-Chat server is running on port ${PORT}. Serving files from: ${staticPath}`);
});

// Check at startup, then hourly. Hourly rather than once a day so the office
// still gets the alert if the server PC was switched off at the scheduled time.
checkMedExpiry();
setInterval(checkMedExpiry, 60 * 60 * 1000);

module.exports = { server, app, io };
