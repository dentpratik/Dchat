// Finding the server without anyone typing an IP address.
//
// The server listens on a UDP port. A client shouts "where is the server?" onto
// the office network and the server shouts back with its address. This also means
// a client recovers by itself if the router ever hands the server a new IP.
//
// Some networks block broadcast traffic, so nothing here is allowed to be the
// only way in - the setup screen is always available as a fallback.

const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 3001;
const ASK = 'CHITCHAT_WHERE_IS_SERVER';
const REPLY = 'CHITCHAT_SERVER_HERE';

// Every IPv4 address this computer has, ignoring loopback.
function localIPs() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const name in ifaces) {
        (ifaces[name] || []).forEach(iface => {
            if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
        });
    }
    return out;
}

// Per-interface broadcast addresses. Plenty of networks drop 255.255.255.255
// but pass a subnet broadcast like 192.168.1.255, so we try both.
function broadcastAddresses() {
    const addrs = ['255.255.255.255'];
    const ifaces = os.networkInterfaces();
    for (const name in ifaces) {
        (ifaces[name] || []).forEach(iface => {
            if (iface.family !== 'IPv4' || iface.internal || !iface.netmask) return;
            const ip = iface.address.split('.').map(Number);
            const mask = iface.netmask.split('.').map(Number);
            if (ip.length !== 4 || mask.length !== 4) return;
            const bcast = ip.map((octet, i) => (octet & mask[i]) | (~mask[i] & 255)).join('.');
            if (!addrs.includes(bcast)) addrs.push(bcast);
        });
    }
    return addrs;
}

// Run on the server. Answers anyone asking where the server is.
function startResponder(onReady) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('message', (msg, rinfo) => {
        if (msg.toString() !== ASK) return;
        sock.send(REPLY, rinfo.port, rinfo.address, () => {});
    });

    sock.on('error', (err) => {
        // Not fatal. Clients can still connect by IP if this port is unavailable.
        console.log('Discovery responder unavailable:', err.message);
        try { sock.close(); } catch (e) {}
    });

    sock.bind(DISCOVERY_PORT, () => {
        try { sock.setBroadcast(true); } catch (e) {}
        console.log('Discovery responder listening on UDP ' + DISCOVERY_PORT);
        if (onReady) onReady();
    });

    return sock;
}

// Run on a client. Resolves with the server's IP, or null if nobody answered.
function findServer(timeoutMs) {
    timeoutMs = timeoutMs || 2500;
    return new Promise(resolve => {
        let sock;
        try {
            sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        } catch (e) {
            return resolve(null);
        }

        let settled = false;
        const finish = (ip) => {
            if (settled) return;
            settled = true;
            try { sock.close(); } catch (e) {}
            resolve(ip);
        };

        sock.on('message', (msg, rinfo) => {
            if (msg.toString() === REPLY) finish(rinfo.address);
        });
        sock.on('error', () => finish(null));

        sock.bind(() => {
            try { sock.setBroadcast(true); } catch (e) {}
            const shout = () => {
                if (settled) return;
                broadcastAddresses().forEach(addr => {
                    try { sock.send(ASK, DISCOVERY_PORT, addr, () => {}); } catch (e) {}
                });
            };
            // Repeat a couple of times; the first packet can land while the
            // server is still starting up.
            shout();
            setTimeout(shout, 500);
            setTimeout(shout, 1200);
            setTimeout(() => finish(null), timeoutMs);
        });
    });
}

module.exports = { startResponder, findServer, localIPs, DISCOVERY_PORT };
