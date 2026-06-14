const http = require("http");
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const Database = require("better-sqlite3");
const { customAlphabet } = require("nanoid");
const { randomAnswer, validateGuess, isFormatOk, score } = require("./words");
const {
  isPlayerDone,
  eligiblePlayers,
  nextTurnIndex,
  currentTurnPlayerId,
  rankedWinners,
  determineWinner,
  checkAutoExtend: checkAutoExtendPure,
} = require("./game");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
require("fs").mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "wordle-battle.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS guesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    player_name TEXT NOT NULL,
    game_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    word TEXT NOT NULL,
    target TEXT NOT NULL,
    correct INTEGER NOT NULL,
    guess_num INTEGER NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    mode TEXT NOT NULL,
    target TEXT NOT NULL,
    winner_id TEXT,
    started_at INTEGER,
    ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_guesses_player ON guesses(player_id);
  CREATE INDEX IF NOT EXISTS idx_guesses_game ON guesses(game_id);
`);

const insertGuess = db.prepare(`
  INSERT INTO guesses(player_id, player_name, game_id, mode, word, target, correct, guess_num, ts)
  VALUES (?,?,?,?,?,?,?,?,?)
`);
const insertGame = db.prepare(`
  INSERT OR REPLACE INTO games(id, code, mode, target, winner_id, started_at, ended_at)
  VALUES (?,?,?,?,?,?,?)
`);
const updateGameEnd = db.prepare(`
  UPDATE games SET winner_id=?, ended_at=? WHERE id=?
`);

const statsForPlayer = db.prepare(`
  SELECT
    COUNT(DISTINCT game_id) AS games_played,
    SUM(CASE WHEN correct=1 THEN 1 ELSE 0 END) AS total_wins,
    AVG(CASE WHEN correct=1 THEN guess_num ELSE NULL END) AS avg_guesses_to_win,
    COUNT(*) AS total_guesses
  FROM guesses WHERE player_id=?
`);
const recentGamesForPlayer = db.prepare(`
  SELECT game_id, mode, target, MAX(correct) AS won, COUNT(*) AS guess_count, MAX(ts) AS ts
  FROM guesses WHERE player_id=? GROUP BY game_id ORDER BY ts DESC LIMIT 20
`);

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.get("/api/stats/:playerId", (req, res) => {
  const s = statsForPlayer.get(req.params.playerId) || {};
  const recent = recentGamesForPlayer.all(req.params.playerId);
  res.json({ stats: s, recent });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const code4 = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);
const gameId16 = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

// In-memory game state
const games = new Map(); // code -> game
const codeByGameId = new Map();

function makeGame({ hostId, hostName, mode }) {
  const code = code4();
  const id = gameId16();
  const game = {
    id,
    code,
    mode, // "turn" | "sudden"
    hostId,
    players: [], // {id, name, ws, board:[], won:false, resigned:false}
    status: "lobby", // lobby | active | ended
    target: null,
    turnIndex: 0,
    maxRows: 6,
    winnerId: null,
    createdAt: Date.now(),
  };
  games.set(code, game);
  codeByGameId.set(id, code);
  return game;
}

function publicStateFor(game, viewerId) {
  const turnPlayerId = currentTurnPlayerId(game);
  return {
    id: game.id,
    code: game.code,
    mode: game.mode,
    status: game.status,
    hostId: game.hostId,
    turnIndex: game.turnIndex,
    turnPlayerId,
    maxRows: game.maxRows,
    winnerId: game.winnerId,
    // Ranking surface — useful even mid-game (to show who has solved it
    // already in turn mode). Only includes players who have won so far.
    winners: rankedWinners(game).map(p => ({
      id: p.id,
      name: p.name,
      guesses: p.board.length,
    })),
    target: game.status === "ended" ? game.target : null,
    players: game.players.map(p => {
      const reveal = p.id === viewerId || game.status === "ended";
      const board = reveal
        ? p.board
        : p.board.map(g => ({ result: g.result, ts: g.ts }));
      return {
        id: p.id,
        name: p.name,
        board,
        guessCount: p.board.length,
        won: p.won,
        resigned: p.resigned,
        connected: !!(p.ws && p.ws.readyState === 1),
      };
    }),
  };
}

function broadcast(game, msg) {
  const data = JSON.stringify(msg);
  for (const p of game.players) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

function broadcastState(game, type = "state", extra = {}) {
  for (const p of game.players) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    p.ws.send(JSON.stringify({ type, ...extra, state: publicStateFor(game, p.id) }));
  }
}

function sendState(game) { broadcastState(game, "state"); }

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function findGameByCode(code) {
  if (!code) return null;
  return games.get(code.toUpperCase()) || null;
}

function activePlayers(game) {
  return game.players.filter(p => !p.resigned);
}

function endGame(game, winnerId) {
  game.status = "ended";
  game.winnerId = winnerId;
  updateGameEnd.run(winnerId, Date.now(), game.id);
  broadcastState(game, "game_end", { winnerId, target: game.target });
}

function checkAutoExtend(game) {
  const newMax = checkAutoExtendPure(game);
  if (newMax != null) {
    broadcast(game, { type: "extend", maxRows: newMax });
  }
}

async function handleGuess(game, player, word) {
  if (game.status !== "active") return send(player.ws, { type: "error", message: "Game not active" });
  if (player.won || player.resigned) return;
  word = String(word || "").toLowerCase().trim();
  if (!isFormatOk(word)) return send(player.ws, { type: "error", message: "Must be 5 letters" });
  if (game.mode === "turn") {
    if (currentTurnPlayerId(game) !== player.id) return send(player.ws, { type: "error", message: "Not your turn" });
  }
  if (player.validating) return; // prevent double-submit while async lookup is pending
  player.validating = true;
  let valid = false;
  try { valid = await validateGuess(word); } finally { player.validating = false; }
  if (!valid) return send(player.ws, { type: "error", message: "Not a recognized word" });
  // Re-check active state — game could have ended while awaiting the API.
  if (game.status !== "active" || player.won || player.resigned) return;
  if (game.mode === "turn") {
    if (currentTurnPlayerId(game) !== player.id) return send(player.ws, { type: "error", message: "Turn changed" });
  }

  const result = score(word, game.target);
  const guessNum = player.board.length + 1;
  player.board.push({ word, result, ts: Date.now() });
  const correct = result.every(r => r === "correct");
  insertGuess.run(player.id, player.name, game.id, game.mode, word, game.target, correct ? 1 : 0, guessNum, Date.now());

  if (correct) player.won = true;

  if (game.mode === "sudden") {
    // Sudden death: first correct ends it immediately.
    if (correct) { sendState(game); return endGame(game, player.id); }
    checkAutoExtend(game);
    sendState(game);
    return;
  }

  // Turn mode: even on a correct guess, let the rest of the active
  // players finish their turn(s). Game only ends when no one is eligible
  // (all done — won, resigned, or exhausted maxRows).
  //
  // Auto-extend MUST run before we look for the next turn, otherwise the
  // last player to exhaust rows ends the game even though we'd have
  // added more rows for the still-trying players.
  checkAutoExtend(game);
  const next = nextTurnIndex(game);
  if (next < 0) {
    sendState(game);
    return endGame(game, determineWinner(game));
  }
  game.turnIndex = next;
  sendState(game);
}

function handleResign(game, player) {
  if (game.status !== "active") return;
  player.resigned = true;
  broadcast(game, { type: "resigned", playerId: player.id });

  // If no one can still guess, finalize the game with the best winner so far
  // (or null if nobody ever solved it).
  const eligible = eligiblePlayers(game);
  if (eligible.length === 0) {
    return endGame(game, determineWinner(game));
  }

  if (game.mode === "turn") {
    const cur = game.players[game.turnIndex];
    if (!cur || isPlayerDone(cur, game)) {
      const next = nextTurnIndex(game);
      if (next < 0) return endGame(game, determineWinner(game));
      game.turnIndex = next;
    }
  }
  sendState(game);
}

function startGame(game) {
  if (game.status !== "lobby") return;
  if (game.players.length < 1) return;
  game.target = randomAnswer();
  game.status = "active";
  game.turnIndex = 0;
  insertGame.run(game.id, game.code, game.mode, game.target, null, Date.now(), null);
  broadcastState(game, "start");
}

wss.on("connection", (ws) => {
  ws.playerId = null;
  ws.gameCode = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = msg.type;

    if (t === "create") {
      const mode = msg.mode === "sudden" ? "sudden" : "turn";
      const name = String(msg.name || "Host").slice(0, 24);
      const playerId = String(msg.playerId || "").slice(0, 64) || gameId16();
      const game = makeGame({ hostId: playerId, hostName: name, mode });
      const player = { id: playerId, name, ws, board: [], won: false, resigned: false };
      game.players.push(player);
      ws.playerId = playerId;
      ws.gameCode = game.code;
      send(ws, { type: "joined", playerId, gameCode: game.code, state: publicStateFor(game, playerId) });
      return;
    }

    if (t === "join") {
      const code = String(msg.code || "").toUpperCase();
      const game = findGameByCode(code);
      if (!game) return send(ws, { type: "error", message: "Game not found" });
      const playerId = String(msg.playerId || "").slice(0, 64) || gameId16();
      const name = String(msg.name || "Player").slice(0, 24);
      let player = game.players.find(p => p.id === playerId);
      if (player) {
        // Reconnect with the same playerId — bind new socket, refresh name.
        // This is what lets a refresh during an active game re-attach.
        player.ws = ws;
        player.name = name;
      } else {
        if (game.status !== "lobby") return send(ws, { type: "error", message: "Game already in progress" });
        if (game.players.length >= 8) return send(ws, { type: "error", message: "Game full" });
        player = { id: playerId, name, ws, board: [], won: false, resigned: false };
        game.players.push(player);
      }
      ws.playerId = playerId;
      ws.gameCode = code;
      send(ws, { type: "joined", playerId, gameCode: code, state: publicStateFor(game, playerId) });
      sendState(game);
      return;
    }

    if (t === "rename") {
      const game = findGameByCode(ws.gameCode);
      if (!game) return;
      const p = game.players.find(x => x.id === ws.playerId);
      if (!p) return;
      p.name = String(msg.name || p.name).slice(0, 24);
      sendState(game);
      return;
    }

    if (t === "start") {
      const game = findGameByCode(ws.gameCode);
      if (!game) return;
      if (game.hostId !== ws.playerId) return send(ws, { type: "error", message: "Only host can start" });
      startGame(game);
      return;
    }

    if (t === "guess") {
      const game = findGameByCode(ws.gameCode);
      if (!game) return;
      const p = game.players.find(x => x.id === ws.playerId);
      if (!p) return;
      handleGuess(game, p, msg.word).catch(err => {
        console.error("guess error", err);
        send(ws, { type: "error", message: "Server error validating guess" });
      });
      return;
    }

    if (t === "resign") {
      const game = findGameByCode(ws.gameCode);
      if (!game) return;
      const p = game.players.find(x => x.id === ws.playerId);
      if (!p) return;
      handleResign(game, p);
      return;
    }

    if (t === "leave_lobby") {
      const game = findGameByCode(ws.gameCode);
      if (!game || game.status !== "lobby") return;
      game.players = game.players.filter(p => p.id !== ws.playerId);
      if (game.players.length === 0) {
        games.delete(game.code);
        codeByGameId.delete(game.id);
      } else if (game.hostId === ws.playerId) {
        game.hostId = game.players[0].id;
      }
      ws.gameCode = null;
      sendState(game);
      return;
    }

    if (t === "rematch") {
      const game = findGameByCode(ws.gameCode);
      if (!game || game.status !== "ended") return;
      if (game.hostId !== ws.playerId) return;
      game.status = "lobby";
      game.target = null;
      game.winnerId = null;
      game.turnIndex = 0;
      game.maxRows = 6;
      for (const p of game.players) { p.board = []; p.won = false; p.resigned = false; }
      sendState(game);
      return;
    }
  });

  ws.on("close", () => {
    const game = findGameByCode(ws.gameCode);
    if (!game) return;
    const p = game.players.find(x => x.id === ws.playerId);
    if (p) p.ws = null;
    // If everyone disconnected and lobby, GC after 5min
    setTimeout(() => {
      if (!games.has(game.code)) return;
      const anyConnected = game.players.some(pp => pp.ws && pp.ws.readyState === 1);
      if (!anyConnected && game.status !== "active") {
        games.delete(game.code);
        codeByGameId.delete(game.id);
      }
    }, 5 * 60 * 1000);
    sendState(game);
  });
});

server.listen(PORT, () => {
  console.log(`Wordle Battle listening on :${PORT}`);
});
