import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = parseInt(process.env.PORT, 10) || 8080;

// ---------- Helpers (früh definieren, bevor sie genutzt werden) ----------
function nowMs(){ return Date.now(); }

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

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

// ---------- Game config (server truth) ----------
const CFG = {
  carR: 16,
  ballR: 11,

  w: 960,
  h: 540,
  pad: 44,

  // Bewegung (Client-Einheiten: px/s)
  carAccel: 1750,
  carMaxV: 395,
  carDrag: 6.4,

  // NEU: Massen wie im Client
  carMass: 2.2,
  ballMass: 1.0,

  // Boost
  boostAccelMul: 2.1,
  boostMaxMul: 1.75,
  boostDrain: 50,
  boostRegen: 32,

  ballDrag: 0.95,
  wallBounce: 0.86,

  kick: 340,
  tickHz: 60,
  snapHz: 60,

  goalW: 22,
  goalH: 140
};

// ---------- Room state ----------
const rooms = new Map(); // code -> Room

// Liste erlaubter, nicht-feldbezogener Schlüssel (Server akzeptiert nur diese)
const ALLOWED_OVERRIDES = new Set([
  'carAccel','carMaxV','carDrag',
  'boostAccelMul','boostMaxMul','boostDrain','boostRegen',
  'ballDrag','wallBounce','kick'
]);

function makeRoomCfg(base, overrides){
  // Erzeuge eine Raum-spezifische CFG mit erlaubten Overrides
  const cfg = { ...base };
  if (overrides && typeof overrides === 'object'){
    for (const [k,v] of Object.entries(overrides)){
      if (ALLOWED_OVERRIDES.has(k) && typeof v === 'number'){
        cfg[k] = v;
      }
    }
  }
  return cfg;
}

function createRoom(maxPlayers = 2, overrides = null) {
  maxPlayers = clamp(Number(maxPlayers) || 2, 2, 4);
  const code = makeCode();
  const room = {
    code,
    createdAt: nowMs(),
    clients: new Set(),
    viewers: new Set(), // NEU: Zuschauer (ohne Player-Slot)
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
    countdownLastTick: 0,          // timestamp ms für das nächste decrement

    // Raum-spezifische cfg (nur nicht-Feld-Werte)
    cfg: makeRoomCfg({
      carAccel: CFG.carAccel,
      carMaxV: CFG.carMaxV,
      carDrag: CFG.carDrag,
      boostAccelMul: CFG.boostAccelMul,
      boostMaxMul: CFG.boostMaxMul,
      boostDrain: CFG.boostDrain,
      boostRegen: CFG.boostRegen,
      ballDrag: CFG.ballDrag,
      wallBounce: CFG.wallBounce,
      kick: CFG.kick
    }, overrides || null),

    tournament: {
      enabled: false,
      mode: null,       // 'group'|'league'|'ko'
      config: null,     // Originale Settings vom Host
      phase: null,      // 'Gruppenphase'|'Zwischenrunde'|'KO'
      groups: [],       // einfache Tabellen
      bracket: [],      // KO-Runden
      parallel: false   // optional: Platzhalter für mehrere Spiele gleichzeitig
    },
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

// collision: circle-circle (mass-based, wie Client)
function resolveCircle(aPos, aVel, aR, aMass, bPos, bVel, bR, bMass, restitution, kickScale){
  const nVec = bPos.clone().sub(aPos);
  const dist = nVec.len();
  const minDist = aR + bR;
  if (dist <= 0 || dist >= minDist) return false;

  const n = nVec.mul(1 / (dist || 1)); // normalisiert
  const penetration = minDist - dist;

  // positional correction (split by mass)
  const totalMass = aMass + bMass;
  const aMove = penetration * (bMass / totalMass);
  const bMove = penetration * (aMass / totalMass);
  aPos.add(n.clone().mul(-aMove));
  bPos.add(n.clone().mul( bMove));

  // relative velocity along normal
  const rv = bVel.clone().sub(aVel);
  const velAlongNormal = rv.dot(n);
  if (velAlongNormal > 0) return true; // separating

  const e = restitution; // 0.86 wie Client
  const jMag = -(1 + e) * velAlongNormal / (1 / aMass + 1 / bMass);
  const impulse = n.clone().mul(jMag);

  aVel.add(impulse.clone().mul(-1 / aMass));
  bVel.add(impulse.clone().mul( 1 / bMass));

  // Extra Kick (nur bei Car-Ball), wie beim Client: abhängig von Car-Speed
  const hardHit = Math.abs(velAlongNormal);
  if (kickScale && hardHit > 115){
    // bestimme "car" und skaliere kickImpulse mit carSpeed/carMaxV
    // Annahme: a ist Car, b ist Ball ODER umgekehrt
    const isABall = (Math.abs(aR - CFG.ballR) < 0.01);
    const carVel = isABall ? bVel : aVel;
    const extraKick = kickScale * (carVel.len() / CFG.carMaxV);
    bVel.add(n.clone().mul(extraKick)); // Kick auf den Ball entlang der Normalrichtung
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
  dt = clamp(dt, 0, 1/30);

  const RC = room.cfg;

  // cars from inputs (EXAKT wie Client)
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

    let accel = RC.carAccel;
    let maxV  = RC.carMaxV;

    const wantsBoost = !!inp.boost && hasMove && room.energy[i] > 0.1;
    if (wantsBoost){
      accel *= RC.boostAccelMul;
      maxV  *= RC.boostMaxMul;
      room.energy[i] = Math.max(0, room.energy[i] - RC.boostDrain * dt);
    } else {
      room.energy[i] = Math.min(100, room.energy[i] + RC.boostRegen * dt);
    }

    // WICHTIG: wie Client → norm() dann mul(accel * dt)
    if (a.len() > 0) a.norm().mul(accel * dt);

    car.v.add(a);

    // speed cap
    const sp = car.v.len();
    if (sp > maxV) car.v.mul(maxV / sp);

    // drag: EXAKT wie Client
    car.v.mul(Math.exp(-RC.carDrag * dt));

    // position update: EXAKT wie Client (ohne tickHz)
    car.p.add(car.v.clone().mul(dt));
  }

  // bounds enforcement (unverändert)
  for (let i=0;i<room.maxPlayers;i++){
    const car = room.car[i];
    const p = CFG.pad;
    const cy = CFG.h/2;
    const halfG = CFG.goalH/2;
    const inGoalMouth = Math.abs(car.p.y - cy) < halfG;
    const minX = inGoalMouth ? (p - CFG.goalW) : p;
    const maxX = inGoalMouth ? (CFG.w - (p - CFG.goalW)) : (CFG.w - p);
    car.p.x = clamp(car.p.x, minX, maxX);
    car.p.y = clamp(car.p.y, p, CFG.h - p);
  }

  // ball integration (exp drag + dt)
  const ball = room.ball;
  ball.v.mul(Math.exp(-RC.ballDrag * dt));
  ball.p.add(ball.v.clone().mul(dt));

  // walls with goal openings (wie Client, restitution = RC.wallBounce)
  const minX = CFG.pad + CFG.ballR;
  const maxX = CFG.w - CFG.pad - CFG.ballR;
  const minY = CFG.pad + CFG.ballR;
  const maxY = CFG.h - CFG.pad - CFG.ballR;

  if (ball.p.x < minX && (ball.p.y <(CFG.h/2) - (CFG.goalH/2) || ball.p.y >(CFG.h/2) + (CFG.goalH/2))){ ball.p.x = minX; ball.v.x *= -RC.wallBounce; }
  if (ball.p.x > maxX && (ball.p.y <(CFG.h/2) - (CFG.goalH/2) || ball.p.y >(CFG.h/2) + (CFG.goalH/2))){ ball.p.x = maxX; ball.v.x *= -RC.wallBounce; }
  if (ball.p.y < minY){ ball.p.y = minY; ball.v.y *= -RC.wallBounce; }
  if (ball.p.y > maxY){ ball.p.y = maxY; ball.v.y *= -RC.wallBounce; }

  // car-ball collisions (mass-based)
  for (let i=0;i<room.maxPlayers;i++){
    const car = room.car[i];
    resolveCircle(
      car.p, car.v, CFG.carR, CFG.carMass,
      ball.p, ball.v, CFG.ballR, CFG.ballMass,
      RC.wallBounce, RC.kick
    );
  }

  // car-car collisions (mass-based, keine extra kicks)
  for (let i=0;i<room.maxPlayers;i++){
    for (let j=i+1;j<room.maxPlayers;j++){
      resolveCircle(
        room.car[i].p, room.car[i].v, CFG.carR, CFG.carMass,
        room.car[j].p, room.car[j].v, CFG.carR, CFG.carMass,
        RC.wallBounce, 0
      );
    }
  }

  const scorer = goalCheck(room);
  if (scorer !== null){
    broadcastRoom(room, { type:"goal", scorer, score: room.score, t: nowMs() });
    room.started = false;
    room.countdownRemaining = 3;
    room.countdownLastTick = nowMs();
    broadcastRoom(room, { type:'countdown_start', remaining: 3 });

    // Wenn Tournament-Match: benachrichtige Relay
    if (room.tournamentInfo && room.tournamentInfo.relayConnected){
      relaySend({
        type: 'match_finished',
        tournamentId: room.tournamentInfo.id,
        matchId: room.tournamentInfo.matchId,
        score: room.score,
        sourcePort: PORT
      });
    }
  }
}

// ============================================================
// BINÄRES NACHRICHTENFORMAT - DOKUMENTATION
// ============================================================
//
// Alle binären Nachrichten beginnen mit einem 1-Byte Message-Type-Header.
//
// ┌─────────────────────────────────────────────────────────────┐
// │ MESSAGE TYPE IDs (1 Byte / Uint8)                           │
// ├─────────────────────────────────────────────────────────────┤
// │ 0x01 = STATE      (Server → Client, Game State Update)      │
// │ 0x02 = INPUT      (Client → Server, Player Input)           │
// │ 0x03 = GOAL       (Server → Client, Tor erzielt)            │
// │ 0x04 = COUNTDOWN  (Server → Client, Countdown Tick)         │
// │ 0x05 = START      (Server → Client, Match gestartet)        │
// ├─────────────────────────────────────────────────────────────┤
// │ JSON-Fallback: Nachrichten ohne binäres Format werden       │
// │ weiterhin als JSON gesendet (z.B. chat, room_created, etc.) │
// └─────────────────────────────────────────────────────────────┘
//
// ============================================================
// STATE MESSAGE (0x01) - Server → Client
// ============================================================
// Gesamtgröße: 1 + 4 + 2 + 2 + 2 + (maxPlayers * 18) + 12 + (maxPlayers * 2) + 1 + 1
// Für 2 Spieler: 1 + 4 + 2 + 2 + 2 + 36 + 12 + 4 + 1 + 1 = 65 Bytes
// Für 4 Spieler: 1 + 4 + 2 + 2 + 2 + 72 + 12 + 8 + 1 + 1 = 105 Bytes
//
// ┌────────┬────────┬─────────────────────────────────────────┐
// │ Offset │ Typ    │ Beschreibung                            │
// ├────────┼────────┼─────────────────────────────────────────┤
// │ 0      │ Uint8  │ Message Type (0x01)                     │
// │ 1      │ Uint32 │ Timestamp (ms, lower 32 bits)           │
// │ 5      │ Int16  │ Score Team 1 (Blau)                     │
// │ 7      │ Int16  │ Score Team 2 (Rot)                      │
// │ 9      │ Uint8  │ Player Count (maxPlayers)               │
// │ 10     │ Uint8  │ Flags: Bit0=started, Bit1=countdown>0   │
// ├────────┼────────┼─────────────────────────────────────────┤
// │        │        │ *** CAR DATA (pro Spieler, 18 Bytes) ***│
// │ 11+i*18│ Float32│ Car[i] Position X                       │
// │ 15+i*18│ Float32│ Car[i] Position Y                       │
// │ 19+i*18│ Float32│ Car[i] Velocity X                       │
// │ 23+i*18│ Float32│ Car[i] Velocity Y                       │
// │ 27+i*18│ Int16  │ Car[i] Energy (0-100, als Int16)        │
// ├────────┼────────┼─────────────────────────────────────────┤
// │        │        │ *** BALL DATA (12 Bytes) ***            │
// │ 11+n*18│ Float32│ Ball Position X                         │
// │ 15+n*18│ Float32│ Ball Position Y                         │
// │ 19+n*18│ Float32│ Ball Velocity X                         │
// │ 23+n*18│ Float32│ Ball Velocity Y                         │
// ├────────┼────────┼─────────────────────────────────────────┤
// │        │        │ *** Optional: Countdown (1 Byte) ***    │
// │ last   │ Uint8  │ Countdown Remaining (0-255 Sekunden)    │
// └────────┴────────┴─────────────────────────────────────────┘
//
// ============================================================
// INPUT MESSAGE (0x02) - Client → Server
// ============================================================
// Gesamtgröße: 6 Bytes
//
// ┌────────┬────────┬─────────────────────────────────────────┐
// │ Offset │ Typ    │ Beschreibung                            │
// ├────────┼────────┼─────────────────────────────────────────┤
// │ 0      │ Uint8  │ Message Type (0x02)                     │
// │ 1      │ Uint8  │ Input Flags:                            │
// │        │        │   Bit0 = up                             │
// │        │        │   Bit1 = down                           │
// │        │        │   Bit2 = left                           │
// │        │        │   Bit3 = right                          │
// │        │        │   Bit4 = boost                          │
// │ 2      │ Uint32 │ Sequence Number                         │
// └────────┴────────┴─────────────────────────────────────────┘
//
// ============================================================
// GOAL MESSAGE (0x03) - Server → Client
// ============================================================
// Gesamtgröße: 6 Bytes
//
// ┌────────┬────────┬─────────────────────────────────────────┐
// │ Offset │ Typ    │ Beschreibung                            │
// ├────────┼────────┼─────────────────────────────────────────┤
// │ 0      │ Uint8  │ Message Type (0x03)                     │
// │ 1      │ Uint8  │ Scorer Index (0=links, 1=rechts)        │
// │ 2      │ Int16  │ Score Team 1 (Blau)                     │
// │ 4      │ Int16  │ Score Team 2 (Rot)                      │
// └────────┴────────┴─────────────────────────────────────────┘
//
// ============================================================
// COUNTDOWN MESSAGE (0x04) - Server → Client
// ============================================================
// Gesamtgröße: 2 Bytes
//
// ┌────────┬────────┬─────────────────────────────────────────┐
// │ Offset │ Typ    │ Beschreibung                            │
// ├────────┼────────┼─────────────────────────────────────────┤
// │ 0      │ Uint8  │ Message Type (0x04)                     │
// │ 1      │ Uint8  │ Countdown Remaining (Sekunden)          │
// └────────┴────────┴─────────────────────────────────────────┘
//
// ============================================================

const MSG_TYPE = {
  STATE: 0x01,
  INPUT: 0x02,
  GOAL: 0x03,
  COUNTDOWN: 0x04,
  START: 0x05,
};

// Binäre State-Nachricht erstellen
function createBinaryState(room) {
  const playerCount = room.maxPlayers;
  // Header: 1 + 4 + 2 + 2 + 1 + 1 = 11 Bytes
  // Cars: playerCount * 18 Bytes
  // Ball: 16 Bytes (4 floats)
  // Countdown: 1 Byte
  const size = 11 + (playerCount * 18) + 16 + 1;
  const buffer = Buffer.alloc(size);
  let offset = 0;

  // Message Type
  buffer.writeUInt8(MSG_TYPE.STATE, offset); offset += 1;

  // Timestamp (lower 32 bits)
  buffer.writeUInt32LE(nowMs() & 0xFFFFFFFF, offset); offset += 4;

  // Scores als Int16 (short)
  buffer.writeInt16LE(room.score[0], offset); offset += 2;
  buffer.writeInt16LE(room.score[1], offset); offset += 2;

  // Player Count
  buffer.writeUInt8(playerCount, offset); offset += 1;

  // Flags: Bit0=started, Bit1=countdownActive
  let flags = 0;
  if (room.started) flags |= 0x01;
  if (room.countdownRemaining > 0) flags |= 0x02;
  buffer.writeUInt8(flags, offset); offset += 1;

  // Car Data (pro Spieler: 4+4+4+4+2 = 18 Bytes)
  for (let i = 0; i < playerCount; i++) {
    const car = room.car[i];
    buffer.writeFloatLE(car.p.x, offset); offset += 4;
    buffer.writeFloatLE(car.p.y, offset); offset += 4;
    buffer.writeFloatLE(car.v.x, offset); offset += 4;
    buffer.writeFloatLE(car.v.y, offset); offset += 4;
    // Energy als Int16 (0-100, passt locker)
    buffer.writeInt16LE(Math.round(room.energy[i]), offset); offset += 2;
  }

  // Ball Data (16 Bytes)
  buffer.writeFloatLE(room.ball.p.x, offset); offset += 4;
  buffer.writeFloatLE(room.ball.p.y, offset); offset += 4;
  buffer.writeFloatLE(room.ball.v.x, offset); offset += 4;
  buffer.writeFloatLE(room.ball.v.y, offset); offset += 4;

  // Countdown (1 Byte)
  buffer.writeUInt8(room.countdownRemaining, offset); offset += 1;

  return buffer;
}

// Binäre Goal-Nachricht erstellen
function createBinaryGoal(scorer, score) {
  const buffer = Buffer.alloc(6);
  buffer.writeUInt8(MSG_TYPE.GOAL, 0);
  buffer.writeUInt8(scorer, 1);
  buffer.writeInt16LE(score[0], 2);
  buffer.writeInt16LE(score[1], 4);
  return buffer;
}

// Binäre Countdown-Nachricht erstellen
function createBinaryCountdown(remaining) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt8(MSG_TYPE.COUNTDOWN, 0);
  buffer.writeUInt8(remaining, 1);
  return buffer;
}

// Binäre Input-Nachricht parsen
function parseBinaryInput(buffer) {
  if (buffer.length < 6) return null;
  const type = buffer.readUInt8(0);
  if (type !== MSG_TYPE.INPUT) return null;

  const flags = buffer.readUInt8(1);
  const seq = buffer.readUInt32LE(2);

  return {
    up: !!(flags & 0x01),
    down: !!(flags & 0x02),
    left: !!(flags & 0x04),
    right: !!(flags & 0x08),
    boost: !!(flags & 0x10),
    seq: seq
  };
}

// Binär senden (für State/Goal/Countdown)
function sendBinary(ws, buffer) {
  if (ws.readyState === 1) ws.send(buffer);
}

// Broadcast binär an alle Clients im Raum
function broadcastBinaryRoom(room, buffer) {
  for (const ws of room.clients) sendBinary(ws, buffer);
}

function snapshot(room){
  // HINWEIS: Diese Funktion wird jetzt nur noch für Debug/Fallback genutzt.
  // Das binäre Format wird direkt im Game Loop verwendet.
  return {
    type: "state",
    t: nowMs(),
    score: room.score,
    playerNames: room.playerNames,
    car: room.car.map(c => ({ x: c.p.x, y: c.p.y, vx: c.v.x, vy: c.v.y })),
    ball: { x: room.ball.p.x, y: room.ball.p.y, vx: room.ball.v.x, vy: room.ball.v.y },
    energy: room.energy,
    started: room.started,
    countdown: room.countdownRemaining,
  };
}

function broadcastRoom(room, obj){
  for (const ws of room.clients) send(ws, obj);
  // Relay-Event (nur Meta-Infos, kein Spam)
  if (obj && (obj.type === 'tournament_state' || obj.type === 'tournament_pause' || obj.type === 'tournament_resume' || obj.type === 'start')){
    relaySend({ type:'room_event', code: room.code, event: obj.type, ts: nowMs() });
  }
}

// ---------- Networking ----------
wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.playerIndex = null;
  ws.role = 'viewer';
  ws.isAlive = true;
  ws.binaryType = 'arraybuffer'; // Wichtig für binäre Nachrichten

  console.log(`[Match] New WebSocket connection`);

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw, isBinary) => {
    // Binäre Nachrichten verarbeiten
    if (isBinary || Buffer.isBuffer(raw)) {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buffer.length >= 1) {
        const msgType = buffer.readUInt8(0);

        // Binärer Input
        if (msgType === MSG_TYPE.INPUT) {
          const code = ws.roomCode;
          const idx = ws.playerIndex;
          if (!code) return;
          const room = rooms.get(code);
          if (!room) return;
          if (ws.role !== 'player') return;
          if (!room.started) return;

          const inp = parseBinaryInput(buffer);
          if (inp) {
            room.input[idx] = inp;
          }
          return;
        }
      }
      return;
    }

    // JSON-Nachrichten (Fallback)
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // FIX: Nur wichtige Messages loggen, NICHT input/ping/pong
    if (msg.type !== 'input' && msg.type !== 'ping' && msg.type !== 'pong') {
      console.log(`[Match] Message received:`, msg.type, msg);
    }

    if (msg.type === "ping"){
      const t = (typeof msg.t === 'number') ? msg.t : Date.now();
      send(ws, { type: "pong", t });
      return;
    }

    if (msg.type === "create_room"){
      console.log(`[Match] Creating room, maxPlayers: ${msg.maxPlayers}`);
      const maxP = clamp(msg.maxPlayers || 2, 2, 4);
      const room = createRoom(maxP, msg.settings || null);

      // Tournament Settings übernehmen, falls vorhanden
      if (msg.tournament && typeof msg.tournament === 'object'){
        room.tournament.enabled = true;
        room.tournament.mode = msg.tournament.mode || 'group';
        room.tournament.config = {
          splitType: msg.tournament.splitType || 'size',
          splitValue: clamp(Number(msg.tournament.splitValue) || 4, 2, 16),
          advanceCount: clamp(Number(msg.tournament.advanceCount) || 2, 1, 8),
          playoffCount: clamp(Number(msg.tournament.playoffCount) || 0, 0, 8),
          koPlayers: clamp(Number(msg.tournament.koPlayers) || 8, 2, 64)
        };
        room.tournament.phase = (room.tournament.mode === 'ko') ? 'KO' : 'Gruppenphase';
        // Initiale leere Struktur
        room.tournament.groups = [];
        room.tournament.bracket = [];
      }

      room.clients.add(ws);
      room.viewers.delete(ws);
      room.players[0] = ws;
      ws.role = 'player';
      room.playerNames[0] = (msg.playerName || 'Player').slice(0, 20);
      ws.roomCode = room.code;
      ws.playerIndex = 0;

      console.log(`[Match] Room created: ${room.code}, player 0: ${room.playerNames[0]}`);

      send(ws, {
        type:"room_created",
        code: room.code,
        playerIndex: 0,
        cfg: CFG,
        maxPlayers: room.maxPlayers,
        cfgPartial: {
          carAcc: room.cfg.carAccel,
          carMaxSpeed: room.cfg.carMaxV,
          carDrag: room.cfg.carDrag,
          boostAccMul: room.cfg.boostAccelMul,
          boostMaxMul: room.cfg.boostMaxMul,
          boostDrain: room.cfg.boostDrain,
          boostRegen: room.cfg.boostRegen,
          ballDrag: room.cfg.ballDrag,
          wallRestitution: room.cfg.wallBounce,
          kickImpulse: room.cfg.kick
        }
      });

      // Tournament-Config broadcasten
      if (room.tournament.enabled){
        broadcastRoom(room, { type: 'tournament_config', mode: room.tournament.mode, config: room.tournament.config, phase: room.tournament.phase });
        relaySend({ type:'tournament_config', code: room.code, config: room.tournament.config, mode: room.tournament.mode });
      }
      resetKickoff(room);
      tryStartCountdown(room);
      return;
    }

    if (msg.type === "join_room"){
      const code = String(msg.code || "").toUpperCase().trim();
      console.log(`[Match] Join request for room: ${code}`);

      const room = rooms.get(code);
      if (!room) {
        console.log(`[Match] Room not found: ${code}`);
        return send(ws, { type:"join_failed", reason:"Room not found" });
      }

      console.log(`[Match] Room found, current players:`, room.playerNames);

      room.clients.add(ws);

      let idx = null;
      for (let i=0;i<room.maxPlayers;i++){
        if (!room.players[i]) { idx = i; break; }
      }

      if (idx === null){
        console.log(`[Match] Room full, joining as viewer`);
        room.viewers.add(ws);
        ws.roomCode = code;
        ws.playerIndex = null;
        ws.role = 'viewer';
        send(ws, {
          type:"join_ok",
          code,
          playerIndex: null,
          cfg: CFG,
          maxPlayers: room.maxPlayers
        });
        broadcastRoom(room, { type:"player_joined", count: room.clients.size, playerNames: room.playerNames });
        return;
      }

      room.players[idx] = ws;
      room.viewers.delete(ws);
      room.playerNames[idx] = (msg.playerName || 'Player').slice(0, 20);
      ws.roomCode = code;
      ws.playerIndex = idx;
      ws.role = 'player';

      console.log(`[Match] Player ${idx} joined: ${room.playerNames[idx]}`);

      send(ws, {
        type:"join_ok",
        code,
        playerIndex: ws.playerIndex,
        cfg: CFG,
        maxPlayers: room.maxPlayers
      });

      // Tournament-Config direkt nach Join senden (falls aktiv)
      if (room.tournament.enabled){
        send(ws, {
          type: 'tournament_config',
          mode: room.tournament.mode,
          config: room.tournament.config,
          phase: room.tournament.phase
        });
        // optional: momentanen Stand (leer am Anfang)
        send(ws, {
          type: 'tournament_state',
          phase: room.tournament.phase,
          groups: room.tournament.groups,
          bracket: room.tournament.bracket
        });
      }

      broadcastRoom(room, { type:"player_joined", count: room.clients.size, playerNames: room.playerNames });
      tryStartCountdown(room);
      return;
    }

    if (msg.type === "input"){
      const code = ws.roomCode;
      const idx = ws.playerIndex;
      if (!code) return;
      const room = rooms.get(code);
      if (!room) return;
      // Zuschauer senden keine Inputs
      if (ws.role !== 'player') return;
      if (!room.started) return;

      const inp = msg.input || {};
      room.input[idx] = {
        up: !!inp.up, down: !!inp.down, left: !!inp.left, right: !!inp.right,
        boost: !!inp.boost,
        seq: (inp.seq|0)
      };
      return;
    }

    if (msg.type === "switch_team"){
      const code = ws.roomCode;
      const sideRequested = (msg.side === 'right' || msg.side === 'red') ? 'right' : 'left';
      if (!code) { send(ws, { type:'switch_failed', reason:'not_in_room' }); return; }
      const room = rooms.get(code);
      if (!room) { send(ws, { type:'switch_failed', reason:'room_not_found' }); return; }
      if (room.started) { send(ws, { type:'switch_failed', reason:'match_started' }); return; }

      // Kandidaten auf gewünschter Seite
      const candidates = [];
      for (let i=0;i<room.maxPlayers;i++){
        if ((i % 2 === 0 && sideRequested === 'left') || (i % 2 === 1 && sideRequested === 'right')) candidates.push(i);
      }
      let target = null;
      for (const c of candidates) if (!room.players[c]) { target = c; break; }
      if (target === null){ send(ws, { type:'switch_failed', reason:'no_slot' }); return; }

      // Wenn Zuschauer: direkt zuweisen
      if (ws.role === 'viewer'){
        room.players[target] = ws;
        room.viewers.delete(ws);
        ws.playerIndex = target;
        ws.role = 'player';
        // Namen aus Nachricht oder default setzen
        room.playerNames[target] = (msg.playerName || room.playerNames[target] || ('Player'+(target+1))).slice(0,20);
        send(ws, { type:'switch_ok', newIndex: target });
        broadcastRoom(room, { type:'player_joined', count: room.clients.size, playerNames: room.playerNames });
        tryStartCountdown(room);
        return;
      }

      // Wenn bereits Spieler: Seitenwechsel wie zuvor
      const oldIdx = ws.playerIndex;
      room.players[oldIdx] = null;
      const name = (room.playerNames[oldIdx] || '').slice(0,20);
      room.playerNames[oldIdx] = '';
      room.players[target] = ws;
      room.playerNames[target] = name || ('Player'+(target+1));
      ws.playerIndex = target;
      send(ws, { type:'switch_ok', newIndex: target });
      broadcastRoom(room, { type:'player_joined', count: room.clients.size, playerNames: room.playerNames });
      tryStartCountdown(room);
      return;
    }

    if (msg.type === "chat_message"){
      const code = ws.roomCode;
      if (!code) return;
      const room = rooms.get(code);
      if (!room) return;

      let nick = 'Player';
      if (ws.role === 'player' && ws.playerIndex !== null){
        nick = room.playerNames[ws.playerIndex] || 'Player';
      } else {
        nick = ((msg.nick && String(msg.nick).slice(0,20)) || 'Viewer') + ' (Viewer)';
      }
      const text = (msg.text || '').slice(0, 120).trim();
      if (!text) return;

      broadcastRoom(room, { type: 'chat_message', nick, text });
      return;
    }

    if (msg.type === "chat_command"){
      const code = ws.roomCode;
      if (!code) return;
      const room = rooms.get(code);
      if (!room) return;

      let nick = 'Player';
      if (ws.role === 'player' && ws.playerIndex !== null){
        nick = room.playerNames[ws.playerIndex] || 'Player';
      } else {
        nick = ((msg.nick && String(msg.nick).slice(0,20)) || 'Viewer') + ' (Viewer)';
      }
      const text = (msg.text || '').slice(0, 120).trim();
      if (!text) return;

      broadcastRoom(room, { type: 'chat_command', nick, text });
      return;
    }

  });

  ws.on("close", () => {
    console.log(`[Match] WebSocket closed, roomCode: ${ws.roomCode}, playerIndex: ${ws.playerIndex}`);
    const code = ws.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    room.clients.delete(ws);
    room.viewers.delete(ws);
    if (ws.playerIndex !== null && room.players[ws.playerIndex] === ws){
      room.players[ws.playerIndex] = null;
      room.playerNames[ws.playerIndex] = '';
    }
    broadcastRoom(room, { type:"player_left", count: room.clients.size, playerNames: room.playerNames });

    if (!room.started && room.countdownRemaining > 0){
      room.countdownRemaining = 0;
      broadcastRoom(room, { type:'countdown_cancelled' });
    }

    // Lösche Raum NICHT sofort – nur wenn wirklich alle weg sind (nach Timeout)
    // if (room.clients.size === 0) rooms.delete(code);
  });
});

// ---------- Relay ----------
const RELAY_URL = process.env.RELAY_URL || "wss://cararena-relay.up.railway.app/";
let relay = null;
let relayConnected = false;
let relayReconnectTimer = null;
let relayHeartbeatTimer = null;  // NEU: Heartbeat Timer

function relaySend(obj){
  try { if (relay && relayConnected) relay.send(JSON.stringify(obj)); } catch(e){ console.error('[Server] relaySend error:', e.message); }
}

function setupRelay(){
  if (!RELAY_URL) return;
  console.log(`[Match] Connecting to Relay: ${RELAY_URL}`);

  try {
    relay = new WebSocket(RELAY_URL);
  } catch (e) {
    console.error(`[Match] Failed to create WebSocket to Relay:`, e.message);
    scheduleRelayReconnect();
    return;
  }

  relay.on('open', () => {
    relayConnected = true;
    console.log(`[Match] Connected to Relay successfully!`);
    console.log(`[Match] Registering instance on port ${PORT} (type: ${typeof PORT})`);
    
    // Sofort registrieren
    relaySend({ type:'instance_online', port: Number(PORT) });

    // Nach kurzer Verzögerung "ready" senden
    setTimeout(() => {
      if (relayConnected) {
        relaySend({ type:'instance_ready', port: Number(PORT), ts: nowMs() });
        console.log(`[Match] Sent instance_ready to Relay`);
      }
    }, 200);

    // NEU: Heartbeat alle 20 Sekunden senden, damit Relay weiß dass wir leben
    if (relayHeartbeatTimer) clearInterval(relayHeartbeatTimer);
    relayHeartbeatTimer = setInterval(() => {
      if (relayConnected) {
        relaySend({ type:'instance_heartbeat', port: Number(PORT), ts: nowMs(), rooms: rooms.size });
      }
    }, 20000);

    if (relayReconnectTimer) {
      clearTimeout(relayReconnectTimer);
      relayReconnectTimer = null;
    }
  });

  relay.on('close', (code, reason) => {
    console.log(`[Match] Relay connection closed (code: ${code}, reason: ${reason || 'none'})`);
    relayConnected = false;
    if (relayHeartbeatTimer) {
      clearInterval(relayHeartbeatTimer);
      relayHeartbeatTimer = null;
    }
    scheduleRelayReconnect();
  });

  relay.on('error', (err) => {
    console.error('[Match] Relay WebSocket error:', err.message);
    // Nicht hier reconnecten - 'close' wird danach gefeuert
  });

  relay.on('message', (raw) => {
    let msg; 
    try{ 
      const data = (typeof raw === 'string') ? raw : raw.toString();
      msg = JSON.parse(data); 
    }catch{ return; }

    console.log(`[Match] Relay message received:`, msg.type);

    if (msg.type === 'tournament_match_assign'){
      const tournId = msg.tournamentId;
      const matchId = msg.matchId;
      const maxP = clamp(msg.maxPlayers || 2, 2, 4);
      const room = createRoom(maxP, msg.settings || null);

      room.tournamentInfo = {
        id: tournId,
        matchId: matchId,
        relayConnected: true
      };

      if (Array.isArray(msg.playerNames)){
        for (let i=0;i<Math.min(msg.playerNames.length, room.maxPlayers); i++){
          room.playerNames[i] = String(msg.playerNames[i] || '').slice(0,20);
        }
      }

      if (msg.tournament && typeof msg.tournament === 'object'){
        room.tournament.enabled = true;
        room.tournament.mode = msg.tournament.mode;
        room.tournament.config = msg.tournament.config;
        room.tournament.phase = msg.tournament.phase;
      }

      resetKickoff(room);
      console.log(`[Match] Tournament match assigned: ${matchId} in room ${room.code}`);
      relaySend({ type:'match_assigned_ok', matchId, code: room.code, port: PORT });
    }
  });
}

function scheduleRelayReconnect() {
  if (relayReconnectTimer) return; // Bereits geplant
  console.log('[Match] Scheduling Relay reconnect in 5s...');
  relayReconnectTimer = setTimeout(() => {
    relayReconnectTimer = null;
    console.log('[Match] Attempting Relay reconnect...');
    setupRelay();
  }, 5000);
}

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
  
  // FIX: Countdown mit korrektem Timestamp starten
  room.countdownRemaining = 3;
  room.countdownLastTick = nowMs();
  
  // Sende countdown_start mit aktuellem Timestamp
  broadcastRoom(room, { 
    type:'countdown_start', 
    remaining: 3,
    startedAt: room.countdownLastTick  // Client kann damit synchronisieren
  });
  
  console.log(`[Match] Countdown started for room ${room.code}`);
}

// Game Loop - BINÄRE STATE-NACHRICHTEN
let last = nowMs();
setInterval(() => {
  const t = nowMs();
  const dt = (t - last) / 1000;
  last = t;

  for (const room of rooms.values()){
    // FIX: Countdown-Logik vereinfachen
    if (!room.started && room.countdownRemaining > 0){
      const elapsed = t - room.countdownLastTick;
      
      // Alle 1 Sekunde decrementieren
      if (elapsed >= 1000){
        room.countdownRemaining--;
        room.countdownLastTick = t;
        
        if (room.countdownRemaining <= 0){
          room.started = true;
          resetKickoff(room);
          broadcastRoom(room, {
            type:'start',
            cfgPartial: {
              carAcc: room.cfg.carAccel,
              carMaxSpeed: room.cfg.carMaxV,
              carDrag: room.cfg.carDrag,
              boostAccMul: room.cfg.boostAccelMul,
              boostMaxMul: room.cfg.boostMaxMul,
              boostDrain: room.cfg.boostDrain,
              boostRegen: room.cfg.boostRegen,
              ballDrag: room.cfg.ballDrag,
              wallRestitution: room.cfg.wallBounce,
              kickImpulse: room.cfg.kick
            }
          });
          console.log(`[Match] Match started in room ${room.code}`);
        } else {
          // BINÄR: Countdown-Tick senden
          broadcastBinaryRoom(room, createBinaryCountdown(room.countdownRemaining));
        }
      }
    }

    if (room.started){
      stepRoom(room, dt);
    }

    const snapEvery = 1000 / CFG.snapHz;
    if (t - room.lastSnap >= snapEvery){
      room.lastSnap = t;
      // BINÄR: State-Nachricht senden (statt JSON)
      broadcastBinaryRoom(room, createBinaryState(room));
    }

    if (room.tournament && room.tournament.enabled && room.tournamentPauseUntil){
      if (t >= room.tournamentPauseUntil){
        room.tournamentPauseUntil = 0;
        broadcastRoom(room, { type:'tournament_resume' });
      }
    }
  }
}, 1000 / CFG.tickHz);

// NEU: Cleanup alte/leere Räume (alle 2 Min)
setInterval(() => {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 Minuten Raum-Alter

  for (const [code, room] of rooms.entries()) {
    // Lösche nur, wenn Raum alt UND leer
    if (room.clients.size === 0 && (now - room.createdAt) > maxAge) {
      console.log(`[Match] Cleaning up old empty room: ${code}`);
      rooms.delete(code);
    }
  }
}, 120000);

// NEU: netDisconnect() Fallback für Client (nicht hier, aber sicherstellen dass Relay diese Calls handlet)

// Am Ende der Datei: Relay-Verbindung starten
setupRelay();

server.listen(PORT, () => {
  console.log(`[Match] Server listening on port ${PORT}`);
  console.log(`[Match] Will connect to Relay at: ${RELAY_URL}`);
});

