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

function snapshot(room){
  // back to full precision for smooth gameplay
  // WICHTIG: cfgPartial NICHT mehr senden – nur beim Start
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
  ws.role = 'viewer'; // default Rolle bis Slot zugewiesen
  ws.isAlive = true;

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "ping"){
      // Antworte sofort – Client misst Roundtrip
      const t = (typeof msg.t === 'number') ? msg.t : Date.now();
      send(ws, { type: "pong", t });
      return;
    }

    if (msg.type === "create_room"){
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
      const room = rooms.get(code);
      if (!room) return send(ws, { type:"join_failed", reason:"Room not found" });

      room.clients.add(ws);

      // Weisen wir wenn möglich einen freien Player-Slot zu, sonst als Viewer aufnehmen
      let idx = null;
      for (let i=0;i<room.maxPlayers;i++){
        if (!room.players[i]) { idx = i; break; }
      }

      if (idx === null){
        // Raum voll: als Viewer joinen
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
        // kein Countdown hier (Zuschauer zählen nicht)
        return;
      }

      // Spieler-Slot vergeben
      room.players[idx] = ws;
      room.viewers.delete(ws);
      room.playerNames[idx] = (msg.playerName || 'Player').slice(0, 20);
      ws.roomCode = code;
      ws.playerIndex = idx;
      ws.role = 'player';

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
        // Zuschauer: grau und mit Suffix kennzeichnen
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
  // Countdown starten: Server sendet einmalig die Nachricht
  room.countdownRemaining = 3;
  room.countdownLastTick = nowMs();
  // Sende nur EINMAL countdown_start – Client zählt dann lokal runter
  broadcastRoom(room, { type:'countdown_start', remaining: 3 });
}

// ---------- Optional: Inter-Instance Relay (für parallele Matches) ----------
const RELAY_URL = process.env.RELAY_URL || "wss://cararena-relay.up.railway.app/" || "wss://localhost:8081/";
let relay = null;
let relayConnected = false;
let relayReconnectTimer = null;

function relaySend(obj){
  try { if (relay && relayConnected) relay.send(JSON.stringify(obj)); } catch {}
}

async function setupRelay(){
  if (!RELAY_URL) return;
  console.log(`[Server] Connecting to Relay: ${RELAY_URL}`);
  relay = new (await import('ws')).WebSocket(RELAY_URL);

  relay.on('open', () => {
     relayConnected = true;
     console.log(`[Server] Connected to Relay, registering on port ${PORT}`);
     relaySend({ type:'instance_online', port: PORT });
     setTimeout(() => {
       relaySend({ type:'instance_ready', port: PORT, ts: nowMs() });
       console.log(`[Server] Sent instance_ready on port ${PORT}`);
     }, 100);

    if (relayReconnectTimer) {
      clearTimeout(relayReconnectTimer);
      relayReconnectTimer = null;
    }
  });

  relay.on('close', () => {
    console.log('[Server] Relay connection closed, attempting reconnect in 5s...');
    relayConnected = false;
    if (!relayReconnectTimer) {
      relayReconnectTimer = setTimeout(() => {
        console.log('[Server] Attempting Relay reconnect...');
        setupRelay();
      }, 5000);
    }
  });

  relay.on('error', (err) => {
    console.error('[Server] Relay error:', err.message);
    relayConnected = false;
  });

  relay.on('message', (ev) => {
     let msg; try{ msg = JSON.parse(ev.data); }catch{ return; }

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
       console.log(`[Server] Tournament match assigned: ${matchId} in room ${room.code}`);
       relaySend({ type:'match_assigned_ok', matchId, code: room.code, port: PORT });
     }
  });
}

// Setup Relay sofort beim Start – NICHT blockieren, läuft im Hintergrund
setupRelay().catch(e => {
  console.warn('[Server] Initial Relay setup error:', e.message);
  // Retry-Loop läuft über den close-Handler
});

// Server → Relay Heartbeat (Instanz bleibt „online")
setInterval(() => {
  if (relayConnected) {
    relaySend({ type:'instance_heartbeat', port: PORT, ts: nowMs() });
  }
}, 20000);

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
    // handle countdown timing (server-side) – nur zur Kontrolle
    if (!room.started && room.countdownRemaining > 0){
      const elapsed = t - room.countdownLastTick;
      if (elapsed >= 3000){
        room.countdownRemaining = 0;
        room.started = true;
        resetKickoff(room);
        // Sende Start-Signal MIT cfgPartial (einmalig zum Spielbeginn)
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
      }
    }

    // only tick physics when match started
    if (room.started){
      stepRoom(room, dt);
    }

    const snapEvery = 1000 / CFG.snapHz;
    if (t - room.lastSnap >= snapEvery){
      room.lastSnap = t;
      broadcastRoom(room, snapshot(room)); // snapshot ohne cfgPartial
    }

    // Tournament Pause Handling
    if (room.tournament && room.tournament.enabled && room.tournamentPauseUntil){
      if (t >= room.tournamentPauseUntil){
        room.tournamentPauseUntil = 0;
        broadcastRoom(room, { type:'tournament_resume' });
      }
    }
  }
}, 1000 / CFG.tickHz);

server.listen(PORT, () => {
  console.log("Server on", PORT);
});

// NEU: Cleanup alte/leere Räume (alle 2 Min)
setInterval(() => {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 Minuten Raum-Alter

  for (const [code, room] of rooms.entries()) {
    // Lösche nur, wenn Raum alt UND leer
    if (room.clients.size === 0 && (now - room.createdAt) > maxAge) {
      console.log(`[Server] Cleaning up old empty room: ${code}`);
      rooms.delete(code);
    }
  }
}, 120000);

