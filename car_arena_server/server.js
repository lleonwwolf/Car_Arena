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

  carR: 18,
  ballR: 16,

  w: 960,
  h: 540,
  pad: 44,

  carAccel: 0.62,
  carMaxV: 8.0,
  carDrag: 0.90,

  // boost
  boostAccelMul: 1.75,
  boostMaxMul: 1.35,
  boostDrain: 65,   // energy per second
  boostRegen: 38,   // energy per second

  ballDrag: 0.985,
  wallBounce: 0.92,

  kick: 0.75, // impulse scale on car-ball collision
  tickHz: 60,
  snapHz: 60,

  goalW: 22,
  goalH: 140
};

// ---------- Room state ----------
const rooms = new Map(); // code -> Room

function createRoom(maxPlayers = 2) {
  maxPlayers = clamp(Number(maxPlayers) || 2, 2, 4);
  const code = makeCode();
  const room = {
    code,
    createdAt: nowMs(),
    clients: new Set(),
    maxPlayers,
    players: new Array(maxPlayers).fill(null),
    playerNames: new Array(maxPlayers).fill(''),
    input: new Array(maxPlayers).fill(0).map(()=>({ up:false, down:false, left:false, right:false, boost:false, seq:0 })),
    score: [0,0],
    energy: new Array(maxPlayers).fill(100),
    // world: create car positions spread left/right
    car: [],
    ball: { p: new Vec(CFG.w/2, CFG.h/2), v: new Vec(0,0) },
    lastTick: nowMs(),
    lastSnap: 0,

    // neue Lobby/Match Felder
    started: false,               // true wenn Spiel läuft
    countdownRemaining: 0,        // seconds left (int), 0 = no countdown
    countdownLastTick: 0          // timestamp ms für das nächste decrement
  };

  // Abwechselnd links/rechts: 0,2 links; 1,3 rechts
  for (let i=0;i<maxPlayers;i++){
    const side = (i % 2 === 0) ? 'left' : 'right';
    const x = (side === 'left') ? (CFG.pad + 140) : (CFG.w - CFG.pad - 140);
    // Bei 1v1: beide mittig. Bei 2v2: oben/unten Offset
    const y = (maxPlayers === 2) ? (CFG.h/2) : (CFG.h/2 + ((i < maxPlayers/2) ? -80 : 80));
    room.car.push({ p: new Vec(x,y), v: new Vec(0,0) });
  }

  rooms.set(code, room);
  return room;
}

function resetKickoff(room, scorerIdx=null){
  room.energy = new Array(room.maxPlayers).fill(100);
  // Abwechselnd links/rechts: 0,2 links; 1,3 rechts
  for (let i=0;i<room.maxPlayers;i++){
    const side = (i % 2 === 0) ? 'left' : 'right';
    const x = (side === 'left') ? (CFG.pad + 140) : (CFG.w - CFG.pad - 140);
    // Bei 1v1: beide mittig. Bei 2v2: oben/unten Offset
    const y = (room.maxPlayers === 2) ? (CFG.h/2) : (CFG.h/2 + ((i < room.maxPlayers/2) ? -80 : 80));
    room.car[i].p = new Vec(x,y);
    room.car[i].v = new Vec(0,0);
  }
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

  // cars from inputs (variable count)
  for (let i=0;i<room.maxPlayers;i++){
    const car = room.car[i];
    const inp = room.input[i] || { up:false, down:false, left:false, right:false, boost:false };

    let ax = 0, ay = 0;
    if (inp.left)  ax -= 1;
    if (inp.right) ax += 1;
    if (inp.up)    ay -= 1;
    if (inp.down)  ay += 1;

    const a = new Vec(ax, ay);
    const hasMove = (ax !== 0 || ay !== 0);

    let accel = CFG.carAccel;
    let maxV  = CFG.carMaxV;

    const wantsBoost = !!inp.boost && hasMove && room.energy[i] > 0.1;
    if (wantsBoost){
      accel *= CFG.boostAccelMul;
      maxV  *= CFG.boostMaxMul;
      room.energy[i] = Math.max(0, room.energy[i] - CFG.boostDrain * dt);
    } else {
      room.energy[i] = Math.min(100, room.energy[i] + CFG.boostRegen * dt);
    }

    if (a.len() > 0) a.norm().mul(accel);

    car.v.add(a);

    const sp = car.v.len();
    if (sp > maxV) car.v.mul(maxV / sp);
    car.v.mul(CFG.carDrag);
    car.p.add(car.v.clone().mul(dt * CFG.tickHz));
  }

  // --- enforce car bounds per-room so players can't drive outside the field on the server ---
  // Mirror client logic: allow cars to enter the goal mouth but not pass the field bounds.
  // Use same minX/maxX computation as client (no extra car-radius offset) so client/server stay consistent.
  for (let i=0;i<room.maxPlayers;i++){
    const car = room.car[i];
    const p = CFG.pad;
    const cy = CFG.h/2;
    const halfG = CFG.goalH/2;
    const inGoalMouth = Math.abs(car.p.y - cy) < halfG;
    // same as client: if in goal mouth allow deeper x (pad - goalDepth), else pad
    const minX = inGoalMouth ? (p - CFG.goalW) : p;
    const maxX = inGoalMouth ? (CFG.w - (p - CFG.goalW)) : (CFG.w - p);
    // clamp centers exactly like client (client clamps center to minX..maxX)
    car.p.x = clamp(car.p.x, minX, maxX);
    car.p.y = clamp(car.p.y, p, CFG.h - p);
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

  if (ball.p.x < minX && (ball.p.y <(CFG.h/2) - (CFG.goalH/2) || ball.p.y >(CFG.h/2) + (CFG.goalH/2))){ ball.p.x = minX; ball.v.x *= -CFG.wallBounce; }
  if (ball.p.x > maxX && (ball.p.y <(CFG.h/2) - (CFG.goalH/2) || ball.p.y >(CFG.h/2) + (CFG.goalH/2))){ ball.p.x = maxX; ball.v.x *= -CFG.wallBounce; }
  if (ball.p.y < minY){ ball.p.y = minY; ball.v.y *= -CFG.wallBounce; }
  if (ball.p.y > maxY){ ball.p.y = maxY; ball.v.y *= -CFG.wallBounce; }

  // car-ball collisions for all cars
  for (let i=0;i<room.maxPlayers;i++){
    const car = room.car[i];
    resolveCircle(
      car.p, car.v, CFG.carR,
      ball.p, ball.v, CFG.ballR,
      CFG.kick
    );
  }

  // car-car collisions (all pairs)
  for (let i=0;i<room.maxPlayers;i++){
    for (let j=i+1;j<room.maxPlayers;j++){
      resolveCircle(
        room.car[i].p, room.car[i].v, CFG.carR,
        room.car[j].p, room.car[j].v, CFG.carR,
        0.15
      );
    }
  }

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
    playerNames: room.playerNames,
    car: room.car.map(c => ({ x:c.p.x, y:c.p.y, vx:c.v.x, vy:c.v.y })),
    ball: { x:room.ball.p.x, y:room.ball.p.y, vx:room.ball.v.x, vy:room.ball.v.y },
    energy: room.energy,
    started: room.started,
    countdown: room.countdownRemaining
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
      const maxP = clamp(msg.maxPlayers || 2, 2, 4);
      const room = createRoom(maxP);
      room.clients.add(ws);
      room.players[0] = ws; // creator becomes p0
      room.playerNames[0] = (msg.playerName || 'Player').slice(0, 20);
      ws.roomCode = room.code;
      ws.playerIndex = 0;

      send(ws, { type:"room_created", code: room.code, playerIndex: 0, cfg: CFG, maxPlayers: room.maxPlayers });
      resetKickoff(room);
      // try to start if already full (rare for host-only create)
      tryStartCountdown(room);
      return;
    }

    if (msg.type === "join_room"){
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { type:"join_failed", reason:"Room not found" });

      room.clients.add(ws);
      // assign free slot among room.maxPlayers
      let idx = null;
      for (let i=0;i<room.maxPlayers;i++){
        if (!room.players[i]) { idx = i; break; }
      }
      if (idx === null) return send(ws, { type:"join_failed", reason:"Room full" });

      room.players[idx] = ws;
      room.playerNames[idx] = (msg.playerName || 'Player').slice(0, 20);
      ws.roomCode = code;
      ws.playerIndex = idx;

      send(ws, { type:"join_ok", code, playerIndex: idx, cfg: CFG, maxPlayers: room.maxPlayers });
      broadcastRoom(room, { type:"player_joined", count: room.clients.size, playerNames: room.playerNames });
      // wenn Lobby jetzt voll und alle Namen gesetzt -> start countdown
      tryStartCountdown(room);
      return;
    }

    if (msg.type === "input"){
      const code = ws.roomCode;
      const idx = ws.playerIndex;
      if (!code || idx === null) return;
      const room = rooms.get(code);
      if (!room) return;

      // Ignoriere Inputs solange Spiel nicht gestartet ist
      if (!room.started) return;

      const inp = msg.input || {};
      // sanitize
      room.input[idx] = {
        up: !!inp.up, down: !!inp.down, left: !!inp.left, right: !!inp.right,
        boost: !!inp.boost,
        seq: (inp.seq|0)
      };
      return;
    }

    if (msg.type === "switch_team"){
      const code = ws.roomCode;
      const idx = ws.playerIndex;
      const sideRequested = (msg.side === 'right' || msg.side === 'red') ? 'right' : 'left';
      if (!code || idx === null) {
        send(ws, { type:'switch_failed', reason:'not_in_room' });
        return;
      }
      const room = rooms.get(code);
      if (!room) { send(ws, { type:'switch_failed', reason:'room_not_found' }); return; }
      if (room.started) { send(ws, { type:'switch_failed', reason:'match_started' }); return; }

      // compute candidate indices for desired side
      const candidates = [];
      for (let i=0;i<room.maxPlayers;i++){
        if ((i % 2 === 0 && sideRequested === 'left') || (i % 2 === 1 && sideRequested === 'right')) candidates.push(i);
      }
      // find empty candidate
      let target = null;
      for (const c of candidates) if (!room.players[c]) { target = c; break; }

      if (target === null){
        // no empty slot on that side
        send(ws, { type:'switch_failed', reason:'no_slot' });
        return;
      }

      // perform move: vacate old slot, assign new
      const oldIdx = ws.playerIndex;
      room.players[oldIdx] = null;
      // move name if present
      const name = (room.playerNames[oldIdx] || '').slice(0,20);
      room.playerNames[oldIdx] = '';
      room.players[target] = ws;
      room.playerNames[target] = name || ('Player'+(target+1));
      ws.playerIndex = target;

      // inform client of new index
      send(ws, { type:'switch_ok', newIndex: target });

      // broadcast updated occupancy/names
      broadcastRoom(room, { type:'player_joined', count: room.clients.size, playerNames: room.playerNames });

      // try start countdown if now full
      tryStartCountdown(room);
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
      // clear slot and name
      room.players[ws.playerIndex] = null;
      room.playerNames[ws.playerIndex] = '';
    }

    broadcastRoom(room, { type:"player_left", count: room.clients.size, playerNames: room.playerNames });

    // cancel countdown / stop the match if players leave before start
    if (!room.started && room.countdownRemaining > 0){
      room.countdownRemaining = 0;
      broadcastRoom(room, { type:'countdown_cancelled' });
    }

    // cleanup empty
    if (room.clients.size === 0) rooms.delete(code);
  });
});

// ---------- Lobby start helper ----------
function tryStartCountdown(room){
  if (room.started) return;
  if (room.countdownRemaining > 0) return;
  // prüfen, ob alle player slots besetzt und Namen gesetzt sind
  let allPresent = true;
  for (let i=0;i<room.maxPlayers;i++){
    if (!room.players[i]) { allPresent = false; break; }
    if (!room.playerNames[i] || room.playerNames[i].trim() === '') { allPresent = false; break; }
  }
  if (!allPresent) return;
  room.countdownRemaining = 3;
  room.countdownLastTick = nowMs();
  broadcastRoom(room, { type:'countdown', remaining: room.countdownRemaining });
}

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
    // handle countdown timing (server-side)
    if (!room.started && room.countdownRemaining > 0){
      const elapsed = t - room.countdownLastTick;
      if (elapsed >= 1000){
        // reduce by number of full seconds
        const steps = Math.floor(elapsed / 1000);
        room.countdownRemaining = Math.max(0, room.countdownRemaining - steps);
        room.countdownLastTick += steps * 1000;
        // broadcast update
        broadcastRoom(room, { type:'countdown', remaining: room.countdownRemaining });
        if (room.countdownRemaining === 0){
          // start match
          room.started = true;
          resetKickoff(room); // place cars/ball for kickoff
          // inform clients
          broadcastRoom(room, { type:'start' });
        }
      }
    }

    // only tick physics when match started
    if (room.started){
      stepRoom(room, dt);
    }

    const snapEvery = 1000 / CFG.snapHz;
    if (t - room.lastSnap >= snapEvery){
      room.lastSnap = t;
      broadcastRoom(room, snapshot(room));
    }
  }
}, 1000 / CFG.tickHz);

server.listen(PORT, () => console.log("Server on", PORT));
