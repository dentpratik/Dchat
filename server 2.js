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

let nextStationId = 13;
let nextDocId = 3;
let nextCatId = 7;
const CATEGORY_PALETTE = ['#3498db','#2ecc71','#e74c3c','#9b59b6','#f1c40f','#e67e22','#1abc9c','#34495e'];
let activeUsers = {};

function loadData() {
    if (fs.existsSync(dataFile)) {
        const savedData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        masterStations = savedData.stations || masterStations;
        masterDoctors = savedData.doctors || masterDoctors;
        masterCategories = savedData.categories || masterCategories;
        if (masterStations.length > 0) nextStationId = Math.max(...masterStations.map(s => s.id)) + 1;
        if (masterDoctors.length > 0) nextDocId = Math.max(...masterDoctors.map(d => d.id)) + 1;
        if (masterCategories.length > 0) nextCatId = Math.max(...masterCategories.map(c => c.id)) + 1;
        console.log('Loaded saved data from data.json');
    } else {
        console.log('No data.json found. Starting with defaults.');
    }
}

function saveData() {
    const data = { stations: masterStations, doctors: masterDoctors, categories: masterCategories };
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
}

loadData();

function syncData(targetSocket) {
    const payload = { stations: masterStations, doctors: masterDoctors, categories: masterCategories };
    if (targetSocket) {
        targetSocket.emit('syncData', payload);
    } else {
        io.emit('syncData', payload);
        saveData();
    }
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

    socket.on('disconnect', () => {
        console.log('A user disconnected:', socket.id);
        delete activeUsers[socket.id];
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Dchat server is running on port ${PORT}. Serving files from: ${staticPath}`);
});

module.exports = { server, app, io };
