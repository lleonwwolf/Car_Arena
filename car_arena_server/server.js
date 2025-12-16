import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

/**
 * Single-instance server:
 * - Serves static files from ./public (index.html)
 * - Runs authoritative physics + rooms via WebSocket on same host/port
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 8080;

// ---------- HTTP (static) ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // Tiny health endpoint (useful for Railway/Render)
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");
      return;
    }

    let rel = url.pathname === "/" ? "/index.html" : url.pathname;

    // Prevent path traversal
    rel = path.posix.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = path.join(PUBLIC_DIR, rel);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
  } catch {
    res.writeHead(400);
    res.end("Bad request");
  }
});

// ---------- WS (authoritative game) ----------
// Disable permessage-deflate to reduce CPU spikes for frequent small packets.
const wss = new WebSocketServer({ server, perMessageDeflate: false });

// ---------- Helpers ----------
function sendStr(ws, str) {
  if (ws.readyState === 1) ws.send(str);
}
function send(ws, obj) {
  sendStr(ws, JSON.stringify(obj));
}
function broadcast(set, obj) {
  const str = JSON.stringify(obj); // stringify once
  for (const ws of set) sendStr(ws, str);
}

function makeCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

class Vec {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  add(v) { this.x += v.x; this.y += v.y; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; return this; }
  mul(s) { this.x *= s; this.y *= s; return this; }
  len() { return Math.hypot(this.x, this.y); }
  norm() {
    const L = this.len() || 1;
    this.x /= L; this.y /= L;
    return this;
  }
  dot(v) { return this.x * v.x + this.y * v.y; }
  clone() { return new Vec(this.x, this.y); }
}

// ---------- Game config (must match client canvas / feel) ----------
const CFG = {
  w: 960,
  h: 540,
  pad: 44,

  // Goal mouth is a vertical opening in the left/right wall
  goalMouthH: 140,     // opening height
  goalDepth: 22,       // how far the ball can travel behind the goal line

  carR: 16,
  ballR: 14,

  tickHz: 60,
  snapHz: 20,

  // Movement (server authoritative)
  carAcc: 1750,        // px/s^2
  carMaxV: 430,        // px/s
  carDrag: 4.0,        // higher = more damping

  // Boost
  boostAcc: 3200,      // extra px/s^2
  boostDrain: 1.6,     // energy per second
  boostRegen: 0.85,    // energy per second
  boostMinToUse: 0.02,

  // Ball
  ballDrag: 0.55,      // damping per second (applied with exp)
  wallBounce: 0.92,
  kick: 1.05,          // car-ball collision impulse scale
};

// ---------- Room state ----------
const rooms = new Map(); // code -> room

function createRoom() {
  const code = makeCode();
  const room = {
    code,
    clients: new Set(),
    players: [null, null], // ws
    input: [
      { up: false, down: false, left: false, right: false, boost: false, seq: 0 },
      { up: false, down: false, left: false, right: false, boost: false, seq: 0 },
    ],
    score: [0, 0],
    car: [
      { p: new Vec(CFG.pad + 140, CFG.h / 2), v: new Vec(0, 0), boostE: 1.0 },
      { p: new Vec(CFG.w - CFG.pad - 140, CFG.h / 2), v: new Vec(0, 0), boostE: 1.0 },
    ],
    ball: { p: new Vec(CFG.w / 2, CFG.h / 2), v: new Vec(0, 0) },

    // fixed-step timing
    acc: 0,
    lastMs: Date.now(),
    lastSnapMs: 0,
  };
  rooms.set(code, room);
  resetKickoff(room);
  return room;
}

function resetKickoff(room) {
  room.car[0].p.x = CFG.pad + 140; room.car[0].p.y = CFG.h / 2;
  room.car[1].p.x = CFG.w - CFG.pad - 140; room.car[1].p.y = CFG.h / 2;
  room.car[0].v.x = 0; room.car[0].v.y = 0;
  room.car[1].v.x = 0; room.car[1].v.y = 0;
  room.ball.p.x = CFG.w / 2; room.ball.p.y = CFG.h / 2;
  room.ball.v.x = 0; room.ball.v.y = 0;
}

function resolveCircle(aPos, aVel, aR, bPos, bVel, bR, kickScale) {
  const dx = bPos.x - aPos.x;
  const dy = bPos.y - aPos.y;
  const dist = Math.hypot(dx, dy);
  const minD = aR + bR;
  if (!(dist > 0 && dist < minD)) return false;

  const nx = dx / dist;
  const ny = dy / dist;
  const penetration = minD - dist;

  // push apart
  aPos.x -= nx * penetration * 0.5;
  aPos.y -= ny * penetration * 0.5;
  bPos.x += nx * penetration * 0.5;
  bPos.y += ny * penetration * 0.5;

  // relative velocity along normal
  const rvx = bVel.x - aVel.x;
  const rvy = bVel.y - aVel.y;
  const vn = rvx * nx + rvy * ny;

  if (vn < 0) {
    const impulse = (-vn) * (0.65 + kickScale);
    const jx = nx * impulse;
    const jy = ny * impulse;

    aVel.x -= jx * 0.55;
    aVel.y -= jy * 0.55;

    bVel.x += jx;
    bVel.y += jy;
  }
  return true;
}

function goalCheck(room) {
  const b = room.ball.p;
  const top = (CFG.h / 2) - (CFG.goalMouthH / 2);
  const bot = (CFG.h / 2) + (CFG.goalMouthH / 2);

  if (b.y > top && b.y < bot) {
    if (b.x < (CFG.pad - CFG.goalDepth)) return 1;              // right player scored
    if (b.x > (CFG.w - CFG.pad + CFG.goalDepth)) return 0;      // left player scored
  }
  return null;
}

function stepRoom(room, dt) {
  // dt in seconds (fixed)
  const top = (CFG.h / 2) - (CFG.goalMouthH / 2);
  const bot = (CFG.h / 2) + (CFG.goalMouthH / 2);

  // --- cars ---
  for (let i = 0; i < 2; i++) {
    const car = room.car[i];
    const inp = room.input[i];

    // movement direction
    let ax = 0, ay = 0;
    if (inp.left) ax -= 1;
    if (inp.right) ax += 1;
    if (inp.up) ay -= 1;
    if (inp.down) ay += 1;

    let dirLen = Math.hypot(ax, ay);
    if (dirLen > 0) {
      ax /= dirLen; ay /= dirLen;
      car.v.x += ax * CFG.carAcc * dt;
      car.v.y += ay * CFG.carAcc * dt;
    }

    // boost energy update
    if (inp.boost && car.boostE > CFG.boostMinToUse) {
      // boost direction: prefer input dir; fallback to velocity dir
      let bx = ax, by = ay;
      if (bx === 0 && by === 0) {
        const sp = Math.hypot(car.v.x, car.v.y);
        if (sp > 1e-3) { bx = car.v.x / sp; by = car.v.y / sp; }
      }
      if (!(bx === 0 && by === 0)) {
        car.v.x += bx * CFG.boostAcc * dt;
        car.v.y += by * CFG.boostAcc * dt;
        car.boostE = Math.max(0, car.boostE - CFG.boostDrain * dt);
      }
    } else {
      car.boostE = Math.min(1, car.boostE + CFG.boostRegen * dt);
    }

    // clamp speed
    const sp = Math.hypot(car.v.x, car.v.y);
    if (sp > CFG.carMaxV) {
      const s = CFG.carMaxV / (sp || 1);
      car.v.x *= s; car.v.y *= s;
    }

    // exponential drag (stable across frame rate)
    const drag = Math.exp(-CFG.carDrag * dt);
    car.v.x *= drag; car.v.y *= drag;

    // integrate
    car.p.x += car.v.x * dt;
    car.p.y += car.v.y * dt;

    // walls (cars stay in field; you can later allow goal entry if you want)
    car.p.x = clamp(car.p.x, CFG.pad + CFG.carR, CFG.w - CFG.pad - CFG.carR);
    car.p.y = clamp(car.p.y, CFG.pad + CFG.carR, CFG.h - CFG.pad - CFG.carR);
  }

  // --- ball ---
  const ball = room.ball;

  // exponential drag
  const bdrag = Math.exp(-CFG.ballDrag * dt);
  ball.v.x *= bdrag; ball.v.y *= bdrag;

  ball.p.x += ball.v.x * dt;
  ball.p.y += ball.v.y * dt;

  // top/bottom bounce
  const minY = CFG.pad + CFG.ballR;
  const maxY = CFG.h - CFG.pad - CFG.ballR;
  if (ball.p.y < minY) { ball.p.y = minY; ball.v.y *= -CFG.wallBounce; }
  if (ball.p.y > maxY) { ball.p.y = maxY; ball.v.y *= -CFG.wallBounce; }

  // left/right bounce with goal opening + goal back wall
  const inMouth = (ball.p.y > top && ball.p.y < bot);

  const fieldMinX = CFG.pad + CFG.ballR;
  const fieldMaxX = CFG.w - CFG.pad - CFG.ballR;

  if (!inMouth) {
    if (ball.p.x < fieldMinX) { ball.p.x = fieldMinX; ball.v.x *= -CFG.wallBounce; }
    if (ball.p.x > fieldMaxX) { ball.p.x = fieldMaxX; ball.v.x *= -CFG.wallBounce; }
  } else {
    const backL = (CFG.pad - CFG.goalDepth) + CFG.ballR;
    const backR = (CFG.w - CFG.pad + CFG.goalDepth) - CFG.ballR;
    if (ball.p.x < backL) { ball.p.x = backL; ball.v.x *= -CFG.wallBounce; }
    if (ball.p.x > backR) { ball.p.x = backR; ball.v.x *= -CFG.wallBounce; }
  }

  // collisions
  for (let i = 0; i < 2; i++) {
    const car = room.car[i];
    resolveCircle(car.p, car.v, CFG.carR, ball.p, ball.v, CFG.ballR, CFG.kick);
  }
  resolveCircle(room.car[0].p, room.car[0].v, CFG.carR, room.car[1].p, room.car[1].v, CFG.carR, 0.15);

  // goal?
  const scorer = goalCheck(room);
  if (scorer !== null) {
    room.score[scorer] += 1;
    broadcast(room.clients, { type: "goal", scorer, score: room.score, t: Date.now() });
    resetKickoff(room);
  }
}

function snapshot(room) {
  return {
    type: "state",
    t: Date.now(),
    score: room.score,
    car: room.car.map(c => ({ x: c.p.x, y: c.p.y, vx: c.v.x, vy: c.v.y, be: c.boostE })),
    ball: { x: room.ball.p.x, y: room.ball.p.y, vx: room.ball.v.x, vy: room.ball.v.y },
    cfg: null,
  };
}

// ---------- Networking ----------
wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.playerIndex = null;
  ws.isAlive = true;

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "create_room") {
      const room = createRoom();
      room.clients.add(ws);
      room.players[0] = ws;
      ws.roomCode = room.code;
      ws.playerIndex = 0;

      send(ws, { type: "room_created", code: room.code, playerIndex: 0, cfg: CFG });
      broadcast(room.clients, { type: "player_joined", count: room.clients.size });
      return;
    }

    if (msg.type === "join_room") {
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: "join_failed", reason: "Room not found" });

      const idx = room.players[0] ? (room.players[1] ? null : 1) : 0;
      if (idx === null) return send(ws, { type: "join_failed", reason: "Room full" });

      room.clients.add(ws);
      room.players[idx] = ws;
      ws.roomCode = code;
      ws.playerIndex = idx;

      send(ws, { type: "join_ok", code, playerIndex: idx, cfg: CFG });
      broadcast(room.clients, { type: "player_joined", count: room.clients.size });
      return;
    }

    if (msg.type === "input") {
      const code = ws.roomCode;
      const idx = ws.playerIndex;
      if (!code || idx === null) return;
      const room = rooms.get(code);
      if (!room) return;

      const inp = msg.input || {};
      room.input[idx] = {
        up: !!inp.up, down: !!inp.down, left: !!inp.left, right: !!inp.right,
        boost: !!inp.boost,
        seq: (inp.seq | 0),
      };
      return;
    }
  });

  ws.on("close", () => {
    const code = ws.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    room.clients.delete(ws);
    if (ws.playerIndex !== null && room.players[ws.playerIndex] === ws) {
      room.players[ws.playerIndex] = null;
    }
    broadcast(room.clients, { type: "player_left", count: room.clients.size });

    if (room.clients.size === 0) rooms.delete(code);
  });
});

// heartbeat
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

// ---------- Fixed-step loop (reduces jitter) ----------
const FIXED_DT = 1 / CFG.tickHz;
const MAX_ACC = 0.25;

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const frameDt = (now - room.lastMs) / 1000;
    room.lastMs = now;

    room.acc = Math.min(MAX_ACC, room.acc + frameDt);

    while (room.acc >= FIXED_DT) {
      stepRoom(room, FIXED_DT);
      room.acc -= FIXED_DT;
    }

    const snapEvery = 1000 / CFG.snapHz;
    if (now - room.lastSnapMs >= snapEvery) {
      room.lastSnapMs = now;
      broadcast(room.clients, snapshot(room));
    }
  }
}, 1000 / CFG.tickHz);

server.listen(PORT, () => {
  console.log("HTTP+WS server listening on", PORT);
});
