import http from "http";
import { WebSocketServer } from "ws";
import https from "https";

const PORT = process.env.PORT || 8081;
// Öffentliche WS-URL der Match-Instanz (Railway-Domain des Match-Services)
const MATCH_WS_URL = process.env.MATCH_WS_URL || "wss://cararena-match.up.railway.app";

// Provider-Webhook (z. B. zum Aufwecken/Starten der Instanz)
// Trage hier deine Wake-URL ein (https://...):
const PROVIDER_WAKE_URL = process.env.PROVIDER_WAKE_URL || "https://cararena-production.up.railway.app"; // z. B. Railway/Render/CloudRun Trigger

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Relay OK");
});

const wss = new WebSocketServer({ server });

// ---------- Relay State ----------
const instances = new Map(); // port -> { ws, online, timestamp, load, port }
const tournaments = new Map(); // tournamentId -> { config, groups, bracket, instances, phase, created }
const playerClients = new Map(); // playerId -> { ws, currentMatch, tournament }

// NEU: Pending-Queues für wartende Clients (wenn keine Instanz online ist)
const pendingCreates = []; // { ws, payload: { maxPlayers, playerName, settings } }
const pendingJoins = [];   // { ws, payload: { code, playerName } }

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  for (const inst of instances.values()) send(inst.ws, obj);
}
function broadcastToPlayers(obj) {
  for (const player of playerClients.values()) send(player.ws, obj);
}

// Hilfsfunktion: weise wartende Clients einer Instanz zu
function flushPendingToInstance(port){
  if (!port) return;
  const wsUrl = MATCH_WS_URL; // feste öffentliche URL zur Match-Instanz
  
  console.log(`[Relay] Flushing ${pendingCreates.length} creates and ${pendingJoins.length} joins to port ${port}`);
  
  while (pendingCreates.length){
    const req = pendingCreates.shift();
    send(req.ws, { type:'assign_instance', port, wsUrl, kind:'host' });
    console.log(`[Relay] Assigned create request to ${port}`);
  }
  while (pendingJoins.length){
    const req = pendingJoins.shift();
    send(req.ws, { type:'assign_instance', port, wsUrl, kind:'join' });
    console.log(`[Relay] Assigned join request to ${port}`);
  }
}

// ---------- Tournament Management ----------
function createTournament(config) {
  const tournId = Math.random().toString(36).slice(2, 10).toUpperCase();
  const tourn = {
    id: tournId,
    mode: config.mode, // 'group'|'league'|'ko'
    config: config,
    phase: (config.mode === 'ko') ? 'KO' : 'Gruppenphase',
    groups: [],
    bracket: [],
    players: [], // [ { id, name, team, points, gd } ]
    instances: new Set(), // Instanzen die an diesem Tournament beteiligt sind
    matches: [], // [ { id, p1, p2, score, status, instancePort } ]
    createdAt: Date.now(),
    started: false
  };

  tournaments.set(tournId, tourn);
  console.log(`[Relay] Tournament created: ${tournId} (mode: ${config.mode})`);
  return tourn;
}

function assignMatchToInstance(match, tourn) {
  const availableInstances = Array.from(instances.values())
    .filter(inst => inst.online)
    .sort((a, b) => a.load - b.load);

  if (availableInstances.length === 0) {
    console.error(`[Relay] Keine verfügbare Instanz für Match ${match.id}`);
    return null;
  }

  const targetInstance = availableInstances[0];
  targetInstance.load++;
  tourn.instances.add(targetInstance.port);

  // Sende Match-Zuweisung zur Instanz
  send(targetInstance.ws, {
    type: 'tournament_match_assign',
    tournamentId: tourn.id,
    matchId: match.id,
    maxPlayers: 2,
    settings: tourn.config.settings || null,
    playerNames: [match.p1.name, match.p2.name],
    tournament: {
      mode: tourn.mode,
      phase: tourn.phase,
      config: tourn.config
    }
  });

  match.instancePort = targetInstance.port;
  console.log(`[Relay] Match ${match.id} assigned to port ${targetInstance.port}`);
  return targetInstance;
}

// Wake-Request an Provider (HTTP GET/POST – hier GET als Beispiel)
function triggerWakeProvider(){
  return new Promise((resolve) => {
    if (!PROVIDER_WAKE_URL) return resolve(false);
    const client = PROVIDER_WAKE_URL.startsWith('https') ? https : http;
    const req = client.get(PROVIDER_WAKE_URL, (res) => {
      res.on('data', ()=>{});
      res.on('end', ()=>{ resolve(true); });
    });
    req.on('error', ()=> resolve(false));
    req.end();
  });
}

// Warte auf eine „instance_ready“-Meldung einer Instanz
function waitForInstanceReady(wsClient, desiredPort=null){
  // Einfach: sobald irgendeine Instanz „ready“ meldet (oder gewünschte), zuweisen
  const handler = (ws, msg) => {
    if (msg.type === 'instance_ready'){
      const port = msg.port;
      if (desiredPort && port !== desiredPort) return;
      // Zuweisung: sende Ziel-Port/URL an Player-Client
      send(wsClient, { type:'assign_instance', port, wsUrl: `ws://${wsClient._host || 'localhost'}:${port}/` });
      return true;
    }
    return false;
  };
  return handler;
}

// Hilfsfunktion: wähle aktive Instanz nach Last
function pickActiveInstance(){
  const arr = Array.from(instances.values()).filter(inst => inst.online);
  arr.sort((a,b) => a.load - b.load);
  return arr.length ? arr[0] : null;
}

// ---------- WebSocket Relay ----------
wss.on("connection", (ws, req) => {
  const clientId = Math.random().toString(36).slice(2, 10);
  let instancePort = null;
  let playerId = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  console.log(`[Relay] New connection from ${req.socket.remoteAddress}, clientId: ${clientId}`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    console.log(`[Relay] Message from ${clientId}:`, msg.type, msg);

    // ====== INSTANZ-MESSAGES ======
    if (msg.type === "instance_online") {
      instancePort = msg.port || 8080;
      ws._host = req?.headers?.host || 'localhost';
      instances.set(instancePort, {
        ws,
        online: true,
        timestamp: Date.now(),
        load: 0,
        port: instancePort,
        host: ws._host
      });
      console.log(`[Relay] Instance registered: port ${instancePort}, total instances: ${instances.size}`);

      // WICHTIG: Sofort pending clients zuweisen
      flushPendingToInstance(instancePort);
      return;
    }

    if (msg.type === "instance_ready"){
      const port = msg.port || instancePort;
      const inst = instances.get(port);
      if (inst){
        inst.online = true;
        inst.timestamp = Date.now();
        instances.set(port, inst);
        console.log(`[Relay] Instance ready: port ${port}`);
        
        // Nochmal pending clients zuweisen
        flushPendingToInstance(port);
      }
      return;
    }

    // NEU: Heartbeat von Match-Instanz – Zeitstempel aktualisieren, Timeout verhindern
    if (msg.type === "instance_heartbeat") {
      const port = msg.port;
      const inst = instances.get(port);
      if (inst) {
        inst.timestamp = Date.now();
        inst.online = true;
        instances.set(port, inst);
        // optional: Load bleibt unberührt
        // console.log(`[Relay] Heartbeat from instance ${port}`);
      }
      return;
    }

    if (msg.type === "match_finished") {
      // Instanz teilt mit: Match ist vorbei, Ergebnis: msg.matchId, msg.score
      const tournId = msg.tournamentId;
      const tourn = tournaments.get(tournId);
      if (!tourn) return;

      const match = tourn.matches.find(m => m.id === msg.matchId);
      if (match) {
        match.score = msg.score;
        match.status = 'finished';
        const inst = instances.get(msg.sourcePort);
        if (inst) inst.load = Math.max(0, inst.load - 1);

        // Aktualisiere Gruppenpunkte / KO-Baum
        broadcastToPlayers({
          type: 'tournament_match_result',
          tournamentId: tournId,
          matchId: match.id,
          score: msg.score
        });
      }
      return;
    }

    if (msg.type === "instance_offline") {
      console.log(`[Relay] Instance offline: port ${instancePort}`);
      instances.delete(instancePort);
      return;
    }

    // ====== PLAYER/CLIENT MESSAGES ======
    if (msg.type === "player_connect") {
      playerId = msg.playerId || clientId;
      ws._host = req?.headers?.host || 'localhost';
      playerClients.set(playerId, { ws, currentMatch: null, tournament: null });
      console.log(`[Relay] Player connected: ${playerId}, total players: ${playerClients.size}`);
      send(ws, { type: "relay_welcome", clientId, role: "player" });
      return;
    }

    if (msg.type === "tournament_create") {
      // Spieler möchte ein Tournament starten
      const config = msg.config || {};
      const tourn = createTournament(config);

      // Starte Gruppenphasen oder KO automatisch
      if (tourn.mode === 'group' || tourn.mode === 'league') {
        // z.B. erste Gruppenphase starten
        tourn.phase = 'Gruppenphase';
        // Matches für Gruppe 1 erstellen
        const match1 = {
          id: `${tourn.id}-g1-m1`,
          p1: { name: 'Player 1', id: '1' },
          p2: { name: 'Player 2', id: '2' },
          score: null,
          status: 'pending',
          instancePort: null
        };
        tourn.matches.push(match1);
        assignMatchToInstance(match1, tourn);
      }

      broadcastToPlayers({
        type: 'tournament_created',
        tournamentId: tourn.id,
        mode: tourn.mode,
        phase: tourn.phase
      });
      return;
    }

    if (msg.type === "tournament_join") {
      const tournId = msg.tournamentId;
      const tourn = tournaments.get(tournId);
      if (!tourn) { send(ws, { type: 'error', reason: 'tournament_not_found' }); return; }

      const player = {
        id: playerId,
        name: msg.playerName || 'Player',
        team: null,
        points: 0,
        gd: 0
      };
      tourn.players.push(player);

      if (playerClients.has(playerId)) {
        playerClients.get(playerId).tournament = tournId;
      }

      send(ws, {
        type: 'tournament_joined',
        tournamentId: tournId,
        mode: tourn.mode,
        phase: tourn.phase,
        players: tourn.players.length
      });

      broadcastToPlayers({
        type: 'tournament_player_joined',
        tournamentId: tournId,
        playerName: player.name,
        totalPlayers: tourn.players.length
      });
      return;
    }

    // NEU: Client sendet Create/Join Request an Relay
    if (msg.type === 'create_game_room'){
      console.log(`[Relay] create_game_room request from ${clientId}, maxPlayers: ${msg.maxPlayers}`);
      console.log(`[Relay] Available instances:`, Array.from(instances.keys()));

      const pick = pickActiveInstance();
      if (pick){
        console.log(`[Relay] Assigning to instance port ${pick.port}, wsUrl: ${MATCH_WS_URL}`);
        send(ws, { type:'assign_instance', port: pick.port, wsUrl: MATCH_WS_URL, kind:'host' });
        return;
      }

      console.log(`[Relay] No instances available, adding to pending queue`);
      send(ws, { type:'assign_pending' });
      pendingCreates.push({ ws, payload: { maxPlayers: msg.maxPlayers, playerName: msg.playerName, settings: msg.settings }});
      triggerWakeProvider().then((ok) => {
        console.log(`[Relay] Wake provider triggered: ${ok}`);
      });
      return;
    }

    if (msg.type === 'join_game_room'){
      console.log(`[Relay] join_game_room request from ${clientId}, code: ${msg.code}`);
      console.log(`[Relay] Available instances:`, Array.from(instances.keys()));

      const pick = pickActiveInstance();
      if (pick){
        console.log(`[Relay] Assigning to instance port ${pick.port}, wsUrl: ${MATCH_WS_URL}`);
        send(ws, { type:'assign_instance', port: pick.port, wsUrl: MATCH_WS_URL, kind:'join' });
        return;
      }

      console.log(`[Relay] No instances available, adding to pending queue`);
      send(ws, { type:'assign_pending' });
      pendingJoins.push({ ws, payload: { code: msg.code, playerName: msg.playerName }});
      triggerWakeProvider().then((ok) => {
        console.log(`[Relay] Wake provider triggered: ${ok}`);
      });
      return;
    }

    if (msg.type === "tournament_start") {
      const tournId = msg.tournamentId;
      const tourn = tournaments.get(tournId);
      if (!tourn) return;

      tourn.started = true;
      tourn.phase = 'Gruppenphase';

      // Erstelle erste Runde von Matches basierend auf mode
      if (tourn.mode === 'group') {
        // z.B. Swiss-System oder Gruppen
        // Hier vereinfacht: einfach Player 1 vs 2, 3 vs 4, etc.
        for (let i = 0; i < tourn.players.length - 1; i += 2) {
          const match = {
            id: `${tournId}-r1-m${i/2}`,
            p1: tourn.players[i],
            p2: tourn.players[i + 1],
            score: null,
            status: 'pending',
            instancePort: null
          };
          tourn.matches.push(match);
          assignMatchToInstance(match, tourn);
        }
      } else if (tourn.mode === 'ko') {
        // KO-Baum direkt
        // ...
      }

      broadcastToPlayers({
        type: 'tournament_started',
        tournamentId: tournId,
        phase: tourn.phase
      });
      return;
    }
  });

  ws.on("close", () => {
    console.log(`[Relay] Connection closed: clientId ${clientId}, instancePort: ${instancePort}, playerId: ${playerId}`);
    if (instancePort) {
      instances.delete(instancePort);
    }
    if (playerId) {
      playerClients.delete(playerId);
    }
  });

  ws.on("error", (err) => {
    console.error(`[Relay] Connection error:`, err.message);
  });
});

// Heartbeat für WebSocket-Verbindungen
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      console.log('[Relay] Terminating dead connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Heartbeat / Status-Logs
setInterval(() => {
  const now = Date.now();
  const timeout = 300000; // 5 Minuten Timeout für Instanzen
  for (const [port, inst] of instances.entries()) {
    if (now - inst.timestamp > timeout) {
      console.log(`[Relay] Instance timeout: port ${port}`);
      instances.delete(port);
    }
  }
}, 20000);

setInterval(() => {
  console.log(`[Relay] Status: ${instances.size} instances (${Array.from(instances.keys()).join(', ') || 'none'}), ${playerClients.size} players, ${tournaments.size} tournaments`);
  console.log(`[Relay] Pending: ${pendingCreates.length} creates, ${pendingJoins.length} joins`);
}, 30000); // Alle 30 Sekunden

server.listen(PORT, () => {
  console.log(`[Relay] Server listening on port ${PORT}`);
});
