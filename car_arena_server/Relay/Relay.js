import http from "http";
import { WebSocketServer } from "ws";
import https from "https";

const PORT = process.env.PORT || 8081;
// Provider-Webhook (z. B. zum Aufwecken/Starten der Instanz)
// Trage hier deine Wake-URL ein (https://...):
const PROVIDER_WAKE_URL = process.env.PROVIDER_WAKE_URL || "https://cararena-production.up.railway.app"; // z. B. Railway/Render/CloudRun Trigger

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Relay OK");
});

const wss = new WebSocketServer({ server });

// ---------- Relay State ----------
const instances = new Map(); // port -> { ws, online, timestamp, load }
const tournaments = new Map(); // tournamentId -> { config, groups, bracket, instances, phase, created }
const playerClients = new Map(); // playerId -> { ws, currentMatch, tournament }

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  for (const inst of instances.values()) {
    send(inst.ws, obj);
  }
}

function broadcastToPlayers(obj) {
  for (const player of playerClients.values()) {
    send(player.ws, obj);
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
  const arr = Array.from(instances.entries()).map(([port, inst]) => ({ port, inst }));
  arr.sort((a,b) => a.inst.load - b.inst.load);
  const actives = arr.filter(x => x.inst.online);
  return actives.length ? actives[0] : null;
}

// ---------- WebSocket Relay ----------
wss.on("connection", (ws) => {
  const clientId = Math.random().toString(36).slice(2, 10);
  let instancePort = null;
  let playerId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ====== INSTANZ-MESSAGES ======
    if (msg.type === "instance_online") {
      instancePort = msg.port || 8080;
      instances.set(instancePort, {
        ws,
        online: true,
        timestamp: Date.now(),
        load: 0
      });
      console.log(`[Relay] Instance online: port ${instancePort}`);
      send(ws, { type: "relay_welcome", clientId, role: "instance" });
      broadcastToPlayers({ type: "instance_status", port: instancePort, status: "online" });
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
      broadcastToPlayers({ type: "instance_status", port: instancePort, status: "offline" });
      return;
    }

    // ====== PLAYER/CLIENT MESSAGES ======
    if (msg.type === "player_connect") {
      playerId = msg.playerId || clientId;
      playerClients.set(playerId, {
        ws,
        currentMatch: null,
        tournament: null
      });
      console.log(`[Relay] Player connected: ${playerId}`);
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
      // Wähle aktive Instanz, sonst wecke Provider
      const pick = pickActiveInstance();
      if (pick){
        // Sofort zuweisen
        send(ws, { type:'assign_instance', port: pick.port, wsUrl: `ws://${ws._host || 'localhost'}:${pick.port}/` });
        return;
      }
      // Keine Instanzen online → wecken
      send(ws, { type:'assign_pending' });
      triggerWakeProvider().then((ok)=>{
        if (!ok) return;
        // Warte auf „instance_ready“
        const readyHandler = waitForInstanceReady(ws, null);
        // Temporär: hänge globalen Listener an alle Instanz-WS
        // In diesem einfachen Relay-Setup checken wir bei jeder neuen instance_ready Nachricht
        // und senden dann assign_instance an den wartenden Client (ws)
        wss.on('connection', ()=>{}); // noop: Platzhalter für event scopes
        // Wir intercepten onmessage oben; hier verlassen wir uns darauf, dass eine Instanz „instance_ready“ sendet
        // und der oben definierte Handler greift via dieser Nachricht (siehe if (msg.type === "instance_ready"))
      });
      return;
    }

    if (msg.type === 'join_game_room'){
      const pick = pickActiveInstance();
      if (pick){
        send(ws, { type:'assign_instance', port: pick.port, wsUrl: `ws://${ws._host || 'localhost'}:${pick.port}/` });
        return;
      }
      send(ws, { type:'assign_pending' });
      triggerWakeProvider().then(()=>{/* analog wie oben */});
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
    if (instancePort) {
      console.log(`[Relay] Instance disconnected: port ${instancePort}`);
      instances.delete(instancePort);
      broadcastToPlayers({ type: "instance_status", port: instancePort, status: "offline" });
    }
    if (playerId) {
      console.log(`[Relay] Player disconnected: ${playerId}`);
      playerClients.delete(playerId);
    }
  });

  ws.on("error", (err) => {
    console.error(`[Relay] Connection error:`, err.message);
  });
});

// Heartbeat
setInterval(() => {
  const now = Date.now();
  const timeout = 30000;

  for (const [port, inst] of instances.entries()) {
    if (now - inst.timestamp > timeout) {
      console.log(`[Relay] Instance timeout: port ${port}`);
      instances.delete(port);
      broadcastToPlayers({ type: "instance_status", port, status: "timeout" });
    }
  }
}, 10000);

// Status-Logs
setInterval(() => {
  console.log(`[Relay] Status: ${instances.size} instances, ${playerClients.size} players, ${tournaments.size} tournaments`);
}, 60000);

server.listen(PORT, () => {
  console.log(`[Relay] Server listening on port ${PORT}`);
});
