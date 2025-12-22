import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8081;
const MATCH_SERVICE_URL = process.env.MATCH_SERVICE_URL || "wss://cararena-production.up.railway.app";

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end("Relay Server Running");
});

const wss = new WebSocketServer({ server });

const instances = new Map();
const players = new Map();
const pendingHosts = [];
const pendingJoins = [];

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch(e) {
      console.error('[Relay] Send error:', e.message);
    }
  }
}

wss.on("connection", (ws) => {
  let clientType = null;
  let clientId = Math.random().toString(36).slice(2, 10);
  ws.isAlive = true;

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // MATCH SERVER MESSAGES
    if (msg.type === "instance_online") {
      clientType = 'instance';
      const port = msg.port || 8080;
      instances.set(port, { ws, port, load: 0, timestamp: Date.now() });
      console.log(`[Relay] Instance registered: port ${port}`);

      // Flush pending clients
      while (pendingHosts.length > 0) {
        const client = pendingHosts.shift();
        send(client, { type: 'assign_instance', wsUrl: MATCH_SERVICE_URL });
      }
      while (pendingJoins.length > 0) {
        const client = pendingJoins.shift();
        send(client, { type: 'assign_instance', wsUrl: MATCH_SERVICE_URL });
      }
      return;
    }

    if (msg.type === "instance_heartbeat") {
      const port = msg.port;
      const inst = instances.get(port);
      if (inst) {
        inst.timestamp = Date.now();
      }
      return;
    }

    // PLAYER MESSAGES
    if (msg.type === "player_connect") {
      clientType = 'player';
      const playerId = msg.playerId || clientId;
      players.set(playerId, { ws, id: playerId });
      console.log(`[Relay] Player connected: ${playerId}`);
      return;
    }

    if (msg.type === "create_game_room") {
      if (instances.size > 0) {
        send(ws, { type: 'assign_instance', wsUrl: MATCH_SERVICE_URL });
      } else {
        pendingHosts.push(ws);
        send(ws, { type: 'assign_pending' });
      }
      return;
    }

    if (msg.type === "join_game_room") {
      if (instances.size > 0) {
        send(ws, { type: 'assign_instance', wsUrl: MATCH_SERVICE_URL });
      } else {
        pendingJoins.push(ws);
        send(ws, { type: 'assign_pending' });
      }
      return;
    }
  });

  ws.on("close", () => {
    if (clientType === 'instance') {
      for (const [port, inst] of instances.entries()) {
        if (inst.ws === ws) {
          instances.delete(port);
          console.log(`[Relay] Instance disconnected: port ${port}`);
        }
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`[Relay] WS Error:`, err.message);
  });
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Cleanup stale instances
setInterval(() => {
  const now = Date.now();
  for (const [port, inst] of instances.entries()) {
    if (now - inst.timestamp > 120000) {
      instances.delete(port);
      console.log(`[Relay] Instance timeout: ${port}`);
    }
  }
}, 60000);

setInterval(() => {
  console.log(`[Relay] ${instances.size} instances, ${players.size} players`);
}, 30000);

server.listen(PORT, () => {
  console.log(`[Relay] Running on port ${PORT}`);
});
