// Pure game-state helpers. Server uses these directly; tests exercise
// them without standing up the WS or DB layers.

const { score } = require("./words");

function isPlayerDone(p, g) {
  return p.resigned || p.won || p.board.length >= g.maxRows;
}

function eligiblePlayers(g) {
  return g.players.filter(p => !isPlayerDone(p, g));
}

// turnIndex is an absolute index into g.players. Returns the next
// non-done index after the current one (circular), or -1 if all done.
function nextTurnIndex(g) {
  const n = g.players.length;
  if (n === 0) return -1;
  for (let step = 1; step <= n; step++) {
    const i = (g.turnIndex + step) % n;
    if (!isPlayerDone(g.players[i], g)) return i;
  }
  return -1;
}

function currentTurnPlayerId(g) {
  if (g.mode !== "turn" || g.status !== "active") return null;
  const cur = g.players[g.turnIndex];
  if (cur && !isPlayerDone(cur, g)) return cur.id;
  const n = nextTurnIndex(g);
  return n >= 0 ? g.players[n].id : null;
}

function rankedWinners(g) {
  return g.players
    .filter(p => p.won)
    .slice()
    .sort((a, b) => {
      if (a.board.length !== b.board.length) return a.board.length - b.board.length;
      const at = a.board[a.board.length - 1]?.ts || 0;
      const bt = b.board[b.board.length - 1]?.ts || 0;
      return at - bt;
    });
}

function determineWinner(g) {
  const r = rankedWinners(g);
  return r.length ? r[0].id : null;
}

// Extend maxRows by 2 if every still-trying player has exhausted the
// current row count. Returns the new maxRows if extended, or null.
function checkAutoExtend(g) {
  const stillTrying = g.players.filter(p => !p.resigned && !p.won);
  if (!stillTrying.length) return null;
  if (stillTrying.every(p => p.board.length >= g.maxRows)) {
    g.maxRows += 2;
    return g.maxRows;
  }
  return null;
}

// Mutates g. Returns one of:
//   { ok: true, correct, extended, ended, winnerId }
//   { ok: false, error: "..." }
function applyGuess(g, playerId, word, opts = {}) {
  if (g.status !== "active") return { ok: false, error: "Game not active" };
  const player = g.players.find(p => p.id === playerId);
  if (!player) return { ok: false, error: "Unknown player" };
  if (player.won || player.resigned) return { ok: false, error: "Player not eligible" };
  if (g.mode === "turn" && currentTurnPlayerId(g) !== playerId) {
    return { ok: false, error: "Not your turn" };
  }
  if (typeof word !== "string" || word.length !== 5 || !/^[a-z]+$/.test(word)) {
    return { ok: false, error: "Must be 5 letters" };
  }
  const result = score(word, g.target);
  const ts = opts.ts ?? Date.now();
  player.board.push({ word, result, ts });
  const correct = result.every(r => r === "correct");
  if (correct) player.won = true;

  if (g.mode === "sudden") {
    if (correct) {
      g.status = "ended";
      g.winnerId = playerId;
      return { ok: true, correct, ended: true, winnerId: playerId };
    }
    const extended = checkAutoExtend(g) != null;
    return { ok: true, correct, extended, ended: false, winnerId: null };
  }

  // Turn mode — keep playing until no eligible player remains.
  const extended = checkAutoExtend(g) != null;
  const next = nextTurnIndex(g);
  if (next < 0) {
    g.status = "ended";
    g.winnerId = determineWinner(g);
    return { ok: true, correct, extended, ended: true, winnerId: g.winnerId };
  }
  g.turnIndex = next;
  return { ok: true, correct, extended, ended: false, winnerId: null };
}

function applyResign(g, playerId) {
  if (g.status !== "active") return { ok: false, error: "Game not active" };
  const player = g.players.find(p => p.id === playerId);
  if (!player) return { ok: false, error: "Unknown player" };
  if (player.resigned) return { ok: false, error: "Already resigned" };
  player.resigned = true;

  const eligible = eligiblePlayers(g);
  if (eligible.length === 0) {
    g.status = "ended";
    g.winnerId = determineWinner(g);
    return { ok: true, ended: true, winnerId: g.winnerId };
  }

  if (g.mode === "turn") {
    const cur = g.players[g.turnIndex];
    if (!cur || isPlayerDone(cur, g)) {
      const next = nextTurnIndex(g);
      if (next < 0) {
        g.status = "ended";
        g.winnerId = determineWinner(g);
        return { ok: true, ended: true, winnerId: g.winnerId };
      }
      g.turnIndex = next;
    }
  }
  return { ok: true, ended: false };
}

// Test helper — constructs a fresh game.
function makeGameState({ mode = "turn", target = "crane", players, maxRows = 6 }) {
  return {
    mode,
    status: "active",
    target,
    maxRows,
    turnIndex: 0,
    winnerId: null,
    players: players.map(p => ({
      id: p.id,
      name: p.name || p.id,
      board: [],
      won: false,
      resigned: false,
      ...p,
    })),
  };
}

module.exports = {
  isPlayerDone,
  eligiblePlayers,
  nextTurnIndex,
  currentTurnPlayerId,
  rankedWinners,
  determineWinner,
  checkAutoExtend,
  applyGuess,
  applyResign,
  makeGameState,
};
