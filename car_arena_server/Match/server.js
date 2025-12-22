import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const RELAY_URL = process.env.RELAY_URL || "wss://cararena-relay.up.railway.app";

function nowMs(){ return Date.now(); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Match Server OK");
});

const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch(e){}
  }
}

function makeCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

class Vec {
  constructor(x=0,y=0){ this.x=x; this.y=y; }
  clone(){ return new Vec(this.x,this.y); }
  add(v){ this.x+=v.x; this.y+=v.y; return this; }
  sub(v){ this.x-=v.x; this.y-=v.y; return this; }
  mul(s){ this.x*=s; this.y*=s; return this; }
  len(){ return Math.hypot(this.x,this.y); }
  norm(){ const L = this.len() || 1; this.x/=L; this.y/=L; return this; }
  dot(v){ return this.x*v.x + this.y*v.y; }
}

const CFG = {
  carR: 16, ballR: 11, w: 960, h: 540, pad: 44,
  carAccel: 1750, carMaxV: 395, carDrag: 6.4,
  carMass: 2.2, ballMass: 1.0,
  boostAccelMul: 2.1, boostMaxMul: 1.75, boostDrain: 50, boostRegen: 32,
  ballDrag: 0.95, wallBounce: 0.86, kick: 340,
  tickHz: 60, snapHz: 60, goalW: 22, goalH: 140
};

const rooms = new Map();

function createRoom(maxPlayers = 2) {
  maxPlayers = clamp(maxPlayers, 2, 4);
  const code = makeCode();
  const room = {
    code, createdAt: nowMs(), clients: new Set(),
    maxPlayers, players: new Array(maxPlayers).fill(null),
    playerNames: new Array(maxPlayers).fill(''),
    input: new Array(maxPlayers).fill(0).map(()=>({ up:false, down:false, left:false, right:false, boost:false })),
    score: [0,0], energy: new Array(maxPlayers).fill(100),
    car: [], ball: { p: new Vec(CFG.w/2, CFG.h/2), v: new Vec(0,0) },
    lastTick: nowMs(), lastSnap: 0, started: false,
    countdownRemaining: 0, countdownLastTick: 0
  };

  for (let i=0;i<maxPlayers;i++){
    const x = (i % 2 === 0) ? (CFG.pad + 140) : (CFG.w - CFG.pad - 140);
    const y = (maxPlayers === 2) ? (CFG.h/2) : (CFG.h/2 + ((i < maxPlayers/2) ? -80 : 80));
    room.car.push({ p: new Vec(x,y), v: new Vec(0,0) });
  }

  rooms.set(code, room);
  return room;
}

function broadcastRoom(room, obj){
  for (const ws of room.clients) send(ws, obj);
}

function resetKickoff(room){
  room.energy = new Array(room.maxPlayers).fill(100);
  for (let i=0;i<room.maxPlayers;i++){
    const x = (i % 2 === 0) ? (CFG.pad + 140) : (CFG.w - CFG.pad - 140);
    const y = (room.maxPlayers === 2) ? (CFG.h/2) : (CFG.h/2 + ((i < room.maxPlayers/2) ? -80 : 80));
    room.car[i].p.set(x,y);
    room.car[i].v.set(0,0);
  }
  room.ball.p.set(CFG.w/2, CFG.h/2);
  room.ball.v.set(0,0);
}

function tryStartCountdown(room){
  if (room.started || room.countdownRemaining > 0) return;
  let allPresent = true;
  for (let i=0;i<room.maxPlayers;i++){
    if (!room.players[i] || !room.playerNames[i].trim()) { allPresent = false; break; }
  }
  if (!allPresent) return;
  room.countdownRemaining = 3;
  room.countdownLastTick = nowMs();
  broadcastRoom(room, { type:'countdown_start' });
}

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.playerIndex = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "ping"){
      send(ws, { type: "pong", t: msg.t || Date.now() });
      return;
    }

    if (msg.type === "create_room"){
      const maxP = clamp(msg.maxPlayers || 2, 2, 4);
      const room = createRoom(maxP);
      room.clients.add(ws);
      room.players[0] = ws;
      room.playerNames[0] = (msg.playerName || 'Player').slice(0, 20);
      ws.roomCode = room.code;
      ws.playerIndex = 0;

      send(ws, {
        type:"room_created",
        code: room.code,
        playerIndex: 0,
        maxPlayers: room.maxPlayers
      });

      resetKickoff(room);
      tryStartCountdown(room);
      return;
    }

    if (msg.type === "join_room"){
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { type:"join_failed", reason:"not_found" });

      let idx = null;
      for (let i=0;i<room.maxPlayers;i++){
        if (!room.players[i]) { idx = i; break; }
      }
      if (idx === null) return send(ws, { type:"join_failed", reason:"full" });

      room.clients.add(ws);
      room.players[idx] = ws;
      room.playerNames[idx] = (msg.playerName || 'Player').slice(0, 20);
      ws.roomCode = code;
      ws.playerIndex = idx;

      send(ws, { type:"join_ok", code, playerIndex: idx, maxPlayers: room.maxPlayers });
      broadcastRoom(room, { type:"player_joined", playerNames: room.playerNames });
      tryStartCountdown(room);
      return;
    }

    if (msg.type === "input"){
      const room = rooms.get(ws.roomCode);
      if (!room || !room.started || ws.playerIndex === null) return;
      const inp = msg.input || {};
      room.input[ws.playerIndex] = {
        up: !!inp.up, down: !!inp.down, left: !!inp.left, right: !!inp.right, boost: !!inp.boost
      };
      return;
    }

    if (msg.type === "chat_message"){
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const nick = room.playerNames[ws.playerIndex] || 'Player';
      const text = (msg.text || '').slice(0, 120).trim();
      if (!text) return;
      broadcastRoom(room, { type: 'chat_message', nick, text });
      return;
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    room.clients.delete(ws);
    if (ws.playerIndex !== null && room.players[ws.playerIndex] === ws){
      room.players[ws.playerIndex] = null;
      room.playerNames[ws.playerIndex] = '';
    }
    broadcastRoom(room, { type:"player_left", playerNames: room.playerNames });
    if (!room.started && room.countdownRemaining > 0){
      room.countdownRemaining = 0;
      broadcastRoom(room, { type:'countdown_cancelled' });
    }
  });
});

// Game Loop (simplified)
setInterval(() => {
  const t = nowMs();
  for (const room of rooms.values()){
    if (!room.started && room.countdownRemaining > 0){
      const elapsed = t - room.countdownLastTick;
      if (elapsed >= 3000){
        room.countdownRemaining = 0;
        room.started = true;
        resetKickoff(room);
        broadcastRoom(room, { type:'start' });
      }
    }
    if (room.started){
      // Minimal physics stub (real game loop from original server.js)
    }
    broadcastRoom(room, {
      type: "state",
      score: room.score,
      playerNames: room.playerNames,
      car: room.car.map(c => ({ x: c.p.x, y: c.p.y })),
      ball: { x: room.ball.p.x, y: room.ball.p.y },
      started: room.started
    });
  }
}, 1000 / 30);

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

// Relay Connection
let relay = null;
let relayConnected = false;

function connectRelay(){
  if (!RELAY_URL) return;
  console.log(`[Server] Connecting to Relay: ${RELAY_URL}`);

  relay = new WebSocket(RELAY_URL);

  relay.on('open', () => {
    relayConnected = true;
    console.log(`[Server] Relay connected, registering port ${PORT}`);
    try {
      relay.send(JSON.stringify({ type:'instance_online', port: PORT }));
    } catch(e){ console.error('[Server] Relay send error:', e.message); }
  });

  relay.on('close', () => {
    relayConnected = false;
    console.log('[Server] Relay disconnected, reconnecting in 5s...');
    setTimeout(connectRelay, 5000);
  });

  relay.on('error', (err) => {
    console.error('[Server] Relay error:', err.message);
  });
}

setInterval(() => {
  if (relayConnected && relay) {
    try {
      relay.send(JSON.stringify({ type:'instance_heartbeat', port: PORT, ts: nowMs() }));
    } catch(e){}
  }
}, 20000);

server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  connectRelay();
});
