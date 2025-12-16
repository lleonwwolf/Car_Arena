import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
});

const wss = new WebSocketServer({ server });

// ---------- Helpers ----------
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function makeCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

class Vec {
  constructor(x=0,y=0){ this.x=x; this.y=y; }
  clone(){ return new Vec(this.x,this.y); }
  add(v){ this.x+=v.x; this.y+=v.y; return this; }
  sub(v){ this.x-=v.x; this.y-=v.y; return this; }
  mul(s){ this.x*=s; this.y*=s; return this; }
  len(){ return Math.hypot(this.x,this.y); }
  norm(){
    const L = this.len() || 1;
    this.x/=L; this.y/=L;
    return this;
  }
  dot(v){ return this.x*v.x + this.y*v.y; }
}

function nowMs(){ return Date.now(); }

// ---------- Game config (server truth) ----------
const CFG = {
  w: 960,
  h: 540,
  pad: 44,

  carR: 18,
  ballR: 16,

  carAccel: 0.62,
  carMaxV: 8.0,
  carDrag: 0.90,

  ballDrag: 0.985,
  wallBounce: 0.92,

  kick: 0.75, // impulse scale on car-ball collision
  tickHz: 60,
  snapHz: 20,

  goalW: 22,
  goalH: 140
};

// ---------- Room state ----------
const rooms = new Map(); // code -> Room

function createRoom() {
  const code = makeCode();
  const room = {
    code,
    createdAt: nowMs(),
    clients: new Set(),
    players: [null, null],          // ws for p0/p1
    input: [
      { up:false, down:false, left:false, right:false, boost:false, seq:0 },
      { up:false, down:false, left:false, right:false, boost:false, seq:0 }
    ],
    score: [0,0],

    // world
    car: [
      { p: new Vec(CFG.pad + 140, CFG.h/2), v: new Vec(0,0) },
      { p: new Vec(CFG.w - CFG.pad - 140, CFG.h/2), v: new Vec(0,0) }
    ],
    ball: { p: new Vec(CFG.w/2, CFG.h/2), v: new Vec(0,0) },

    lastTick: nowMs(),
    lastSnap: 0
  };
  rooms.set(code, room);
  return room;
}

function resetKickoff(room, scorerIdx=null){
  room.car[0].p = new Vec(CFG.pad + 140, CFG.h/2);
  room.car[1].p = new Vec(CFG.w - CFG.pad - 140, CFG.h/2);
  room.car[0].v = new Vec(0,0);
  room.car[1].v = new Vec(0,0);
  room.ball.p = new Vec(CFG.w/2, CFG.h/2);
  room.ball.v = new Vec(0,0);
}

// collision: circle-circle simple
function resolveCircle(aPos, aVel, aR, bPos, bVel, bR, kickScale){
  const d = bPos.clone().sub(aPos);
  let dist = d.len();
  const minD = aR + bR;
  if (dist <= 0 || dist >= minD) return false;

  const n = d.mul(1/(dist||1)); // normal from A->B
  const penetration = minD - dist;

  // push apart (half/half)
  aPos.add(n.clone().mul(-penetration*0.5));
  bPos.add(n.clone().mul( penetration*0.5));

  // relative velocity along normal
  const rel = bVel.clone().sub(aVel);
  const vn = rel.dot(n);

  // if moving together, apply impulse
  if (vn < 0){
    const impulse = (-vn) * (0.65 + kickScale);
    const j = n.clone().mul(impulse);
    aVel.add(j.clone().mul(-0.55));
    bVel.add(j.clone().mul( 1.00));
  }
  return true;
}

// goals: left goal at x=pad, right goal at x=w-pad
function goalCheck(room){
  const b = room.ball.p;
  const gxL = CFG.pad;
  const gxR = CFG.w - CFG.pad;
  const top = (CFG.h/2) - (CFG.goalH/2);
  const bot = (CFG.h/2) + (CFG.goalH/2);

  if (b.y > top && b.y < bot){
    if (b.x < gxL - CFG.goalW){
      room.score[1] += 1; // right player scored
      return 1;
    }
    if (b.x > gxR + CFG.goalW){
      room.score[0] += 1; // left player scored
      return 0;
    }
  }
  return null;
}

function stepRoom(room, dt){
  dt = clamp(dt, 0, 1/30); // safety

  // cars from inputs
  for (let i=0;i<2;i++){
    const car = room.car[i];
    const inp = room.input[i];

    let ax = 0, ay = 0;
    if (inp.left)  ax -= 1;
    if (inp.right) ax += 1;
    if (inp.up)    ay -= 1;
    if (inp.down)  ay += 1;

    const a = new Vec(ax, ay);
    if (a.len() > 0) a.norm().mul(CFG.carAccel);

    car.v.add(a);

    // clamp speed
    const sp = car.v.len();
    if (sp > CFG.carMaxV) car.v.mul(CFG.carMaxV / sp);

    // drag
    car.v.mul(CFG.carDrag);

    // integrate
    car.p.add(car.v.clone().mul(dt * CFG.tickHz));

    // walls
    car.p.x = clamp(car.p.x, CFG.pad + CFG.carR, CFG.w - CFG.pad - CFG.carR);
    car.p.y = clamp(car.p.y, CFG.pad + CFG.carR, CFG.h - CFG.pad - CFG.carR);
  }

  // ball
  const ball = room.ball;
  ball.v.mul(CFG.ballDrag);
  ball.p.add(ball.v.clone().mul(dt * CFG.tickHz));

  // wall bounce (ball)
  const minX = CFG.pad + CFG.ballR;
  const maxX = CFG.w - CFG.pad - CFG.ballR;
  const minY = CFG.pad + CFG.ballR;
  const maxY = CFG.h - CFG.pad - CFG.ballR;

  if (ball.p.x < minX){ ball.p.x = minX; ball.v.x *= -CFG.wallBounce; }
  if (ball.p.x > maxX){ ball.p.x = maxX; ball.v.x *= -CFG.wallBounce; }
  if (ball.p.y < minY){ ball.p.y = minY; ball.v.y *= -CFG.wallBounce; }
  if (ball.p.y > maxY){ ball.p.y = maxY; ball.v.y *= -CFG.wallBounce; }

  // car-ball collisions
  for (let i=0;i<2;i++){
    const car = room.car[i];
    resolveCircle(
      car.p, car.v, CFG.carR,
      ball.p, ball.v, CFG.ballR,
      CFG.kick
    );
  }

  // car-car collision (optional but nice)
  resolveCircle(
    room.car[0].p, room.car[0].v, CFG.carR,
    room.car[1].p, room.car[1].v, CFG.carR,
    0.15
  );

  const scorer = goalCheck(room);
  if (scorer !== null){
    // send goal event + reset
    broadcastRoom(room, { type:"goal", scorer, score: room.score, t: nowMs() });
    resetKickoff(room, scorer);
  }
}

function snapshot(room){
  return {
    type: "state",
    t: nowMs(),
    score: room.score,
    car: room.car.map(c => ({ x:c.p.x, y:c.p.y, vx:c.v.x, vy:c.v.y })),
    ball: { x:room.ball.p.x, y:room.ball.p.y, vx:room.ball.v.x, vy:room.ball.v.y }
  };
}

function broadcastRoom(room, obj){
  for (const ws of room.clients) send(ws, obj);
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

    if (msg.type === "create_room"){
      const room = createRoom();
      room.clients.add(ws);
      room.players[0] = ws; // creator becomes p0
      ws.roomCode = room.code;
      ws.playerIndex = 0;

      send(ws, { type:"room_created", code: room.code, playerIndex: 0, cfg: CFG });
      resetKickoff(room);
      return;
    }

    if (msg.type === "join_room"){
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { type:"join_failed", reason:"Room not found" });

      room.clients.add(ws);
      // assign free slot
      const idx = room.players[0] ? (room.players[1] ? null : 1) : 0;
      if (idx === null) return send(ws, { type:"join_failed", reason:"Room full" });

      room.players[idx] = ws;
      ws.roomCode = code;
      ws.playerIndex = idx;

      send(ws, { type:"join_ok", code, playerIndex: idx, cfg: CFG });
      broadcastRoom(room, { type:"player_joined", count: room.clients.size });
      return;
    }

    if (msg.type === "input"){
      const code = ws.roomCode;
      const idx = ws.playerIndex;
      if (!code || idx === null) return;
      const room = rooms.get(code);
      if (!room) return;

      const inp = msg.input || {};
      // sanitize
      room.input[idx] = {
        up: !!inp.up, down: !!inp.down, left: !!inp.left, right: !!inp.right,
        boost: !!inp.boost,
        seq: (inp.seq|0)
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
    if (ws.playerIndex !== null && room.players[ws.playerIndex] === ws){
      room.players[ws.playerIndex] = null;
    }

    broadcastRoom(room, { type:"player_left", count: room.clients.size });

    // cleanup empty
    if (room.clients.size === 0) rooms.delete(code);
  });
});

// heartbeat
setInterval(() => {
  for (const ws of wss.clients){
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

// game loop: tick all rooms
let last = nowMs();
setInterval(() => {
  const t = nowMs();
  const dt = (t - last) / 1000;
  last = t;

  for (const room of rooms.values()){
    stepRoom(room, dt);

    const snapEvery = 1000 / CFG.snapHz;
    if (t - room.lastSnap >= snapEvery){
      room.lastSnap = t;
      broadcastRoom(room, snapshot(room));
    }
  }
}, 1000 / CFG.tickHz);

server.listen(PORT, () => console.log("Server on", PORT));
