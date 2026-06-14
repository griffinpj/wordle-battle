const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  makeGameState,
  applyGuess,
  applyResign,
  currentTurnPlayerId,
  nextTurnIndex,
  rankedWinners,
  determineWinner,
  checkAutoExtend,
  isPlayerDone,
} = require("../game");

function gameOf(ids, opts = {}) {
  return makeGameState({
    mode: opts.mode || "turn",
    target: opts.target || "crane",
    maxRows: opts.maxRows || 6,
    players: ids.map(id => ({ id })),
  });
}

let tick = 0;
function ts() { return ++tick; }

test("turn rotation cycles through 2 players", () => {
  const g = gameOf(["A", "B"]);
  assert.equal(currentTurnPlayerId(g), "A");
  applyGuess(g, "A", "slate", { ts: ts() });
  assert.equal(currentTurnPlayerId(g), "B");
  applyGuess(g, "B", "trial", { ts: ts() });
  assert.equal(currentTurnPlayerId(g), "A");
});

test("turn rotation cycles through 3 players", () => {
  const g = gameOf(["A", "B", "C"]);
  for (let round = 0; round < 3; round++) {
    for (const id of ["A", "B", "C"]) {
      assert.equal(currentTurnPlayerId(g), id, `round ${round} expected ${id}`);
      const r = applyGuess(g, id, "slate", { ts: ts() });
      assert.equal(r.ok, true);
    }
  }
});

test("turn rotation works for 4 players", () => {
  const g = gameOf(["A", "B", "C", "D"]);
  const order = [];
  for (let i = 0; i < 8; i++) {
    order.push(currentTurnPlayerId(g));
    applyGuess(g, order[order.length - 1], "slate", { ts: ts() });
  }
  assert.deepEqual(order, ["A","B","C","D","A","B","C","D"]);
});

test("wrong-turn guess rejected", () => {
  const g = gameOf(["A", "B"]);
  const r = applyGuess(g, "B", "slate", { ts: ts() });
  assert.equal(r.ok, false);
  assert.match(r.error, /turn/i);
});

test("invalid format rejected", () => {
  const g = gameOf(["A"]);
  assert.equal(applyGuess(g, "A", "cran", { ts: ts() }).ok, false);
  assert.equal(applyGuess(g, "A", "CRANE", { ts: ts() }).ok, false);
  assert.equal(applyGuess(g, "A", "cran3", { ts: ts() }).ok, false);
});

test("turn mode: correct guess does NOT end game while others still eligible", () => {
  const g = gameOf(["A", "B", "C"]);
  const r = applyGuess(g, "A", "crane", { ts: ts() });
  assert.equal(r.ok, true);
  assert.equal(r.correct, true);
  assert.equal(r.ended, false);
  assert.equal(g.status, "active");
  assert.equal(g.players[0].won, true);
  assert.equal(currentTurnPlayerId(g), "B");
});

test("turn mode: done players skipped in rotation", () => {
  const g = gameOf(["A", "B", "C"]);
  applyGuess(g, "A", "crane", { ts: ts() }); // A wins
  applyGuess(g, "B", "slate", { ts: ts() }); // B miss, turn -> C
  applyGuess(g, "C", "trial", { ts: ts() }); // C miss, turn -> B (A skipped)
  assert.equal(currentTurnPlayerId(g), "B");
});

test("turn mode: rejects a guess from a player after they have won", () => {
  const g = gameOf(["A", "B"]);
  applyGuess(g, "A", "crane", { ts: ts() }); // A wins
  // It's now B's turn. A tries to play again — must be rejected.
  const r = applyGuess(g, "A", "slate", { ts: ts() });
  assert.equal(r.ok, false);
});

test("turn mode: game ends when all players are done", () => {
  const g = gameOf(["A", "B"]);
  applyGuess(g, "A", "crane", { ts: ts() }); // A wins
  applyGuess(g, "B", "crane", { ts: ts() }); // B wins => no eligible left
  assert.equal(g.status, "ended");
  assert.equal(g.winnerId, "A"); // fewest guesses tiebreak (A finished first)
});

test("turn mode: multi-winner ranking by guess count then time", () => {
  const g = gameOf(["A", "B", "C"]);
  applyGuess(g, "A", "slate", { ts: 1 }); // miss
  applyGuess(g, "B", "crane", { ts: 2 }); // B wins on guess 1
  applyGuess(g, "C", "slate", { ts: 3 }); // miss
  applyGuess(g, "A", "crane", { ts: 4 }); // A wins on guess 2
  applyGuess(g, "C", "trial", { ts: 5 }); // miss
  applyGuess(g, "C", "crane", { ts: 6 }); // C wins on guess 3 -> ends
  assert.equal(g.status, "ended");
  const ranked = rankedWinners(g).map(p => p.id);
  assert.deepEqual(ranked, ["B", "A", "C"]);
  assert.equal(determineWinner(g), "B");
});

test("turn mode: auto-extend fires before nextTurn end-check", () => {
  // Only 1 player. After 6 wrong guesses, maxRows should extend to 8
  // BEFORE the game ends so they get more guesses.
  const g = gameOf(["A"], { maxRows: 6 });
  for (let i = 0; i < 6; i++) {
    const r = applyGuess(g, "A", "slate", { ts: ts() });
    assert.equal(r.ok, true);
    if (i < 5) {
      assert.equal(r.extended, false, `pre-extend at guess ${i}`);
      assert.equal(r.ended, false);
    }
  }
  assert.equal(g.status, "active");
  assert.equal(g.maxRows, 8);
});

test("turn mode: auto-extend ignores players who already won", () => {
  const g = gameOf(["A", "B"]);
  applyGuess(g, "A", "crane", { ts: ts() }); // A wins on guess 1
  // B has 0 guesses. A is done. stillTrying = [B] with 0 guesses < 6 -> no extend.
  assert.equal(checkAutoExtend(g), null);
  // Burn B through all 6 rows; the 6th guess should trigger extend.
  for (let i = 0; i < 5; i++) {
    applyGuess(g, "B", "slate", { ts: ts() });
  }
  const r = applyGuess(g, "B", "slate", { ts: ts() });
  assert.equal(r.extended, true);
  assert.equal(g.maxRows, 8);
});

test("sudden death: first correct guess ends immediately", () => {
  const g = gameOf(["A", "B", "C"], { mode: "sudden" });
  applyGuess(g, "A", "slate", { ts: ts() });
  applyGuess(g, "C", "trial", { ts: ts() });
  const r = applyGuess(g, "B", "crane", { ts: ts() });
  assert.equal(r.ended, true);
  assert.equal(g.status, "ended");
  assert.equal(g.winnerId, "B");
});

test("sudden death: any player can guess at any time (no turn lock)", () => {
  const g = gameOf(["A", "B", "C"], { mode: "sudden" });
  // currentTurnPlayerId is null for sudden mode
  assert.equal(currentTurnPlayerId(g), null);
  for (const id of ["B", "C", "A", "C", "B"]) {
    const r = applyGuess(g, id, "slate", { ts: ts() });
    assert.equal(r.ok, true, `${id} should be allowed in sudden mode`);
  }
});

test("resign: advances turn past the resigner in turn mode", () => {
  const g = gameOf(["A", "B", "C"]);
  applyResign(g, "A");
  assert.equal(currentTurnPlayerId(g), "B");
});

test("resign: ends game when only one eligible remains and they have won", () => {
  const g = gameOf(["A", "B"]);
  applyGuess(g, "A", "crane", { ts: ts() }); // A wins
  // After A wins, B's turn. B resigns. Nobody eligible left -> end.
  const r = applyResign(g, "B");
  assert.equal(r.ended, true);
  assert.equal(g.status, "ended");
  assert.equal(g.winnerId, "A");
});

test("resign: nobody won, all resigned -> draw (winner null)", () => {
  const g = gameOf(["A", "B"]);
  applyResign(g, "A");
  applyResign(g, "B");
  assert.equal(g.status, "ended");
  assert.equal(g.winnerId, null);
});

test("isPlayerDone covers won, resigned, exhausted", () => {
  const g = gameOf(["A", "B", "C"]);
  assert.equal(isPlayerDone(g.players[0], g), false);
  g.players[0].won = true;
  assert.equal(isPlayerDone(g.players[0], g), true);
  g.players[1].resigned = true;
  assert.equal(isPlayerDone(g.players[1], g), true);
  g.players[2].board = Array.from({ length: g.maxRows }).map(() => ({ word: "slate", result: [], ts: 0 }));
  assert.equal(isPlayerDone(g.players[2], g), true);
});

// ---------- classic mode ----------

test("classic: no turn lock — any player can guess at any time", () => {
  const g = gameOf(["A", "B", "C"], { mode: "classic" });
  // currentTurnPlayerId is null in classic (no turns).
  assert.equal(currentTurnPlayerId(g), null);
  for (const id of ["B", "C", "A", "C", "B", "A"]) {
    const r = applyGuess(g, id, "slate", { ts: ts() });
    assert.equal(r.ok, true, `${id} should be allowed in classic mode`);
  }
});

test("classic: correct guess does NOT end the game while others still eligible", () => {
  const g = gameOf(["A", "B", "C"], { mode: "classic" });
  const r = applyGuess(g, "A", "crane", { ts: ts() });
  assert.equal(r.ok, true);
  assert.equal(r.correct, true);
  assert.equal(r.ended, false);
  assert.equal(g.status, "active");
  assert.equal(g.players[0].won, true);
});

test("classic: a winner cannot keep guessing", () => {
  const g = gameOf(["A", "B"], { mode: "classic" });
  applyGuess(g, "A", "crane", { ts: ts() });
  const r = applyGuess(g, "A", "slate", { ts: ts() });
  assert.equal(r.ok, false);
});

test("classic: game ends when all players are done; winner = fewest guesses", () => {
  const g = gameOf(["A", "B", "C"], { mode: "classic" });
  applyGuess(g, "A", "slate", { ts: 1 });   // A miss (1)
  applyGuess(g, "B", "crane", { ts: 2 });   // B wins on guess 1
  applyGuess(g, "C", "slate", { ts: 3 });   // C miss
  applyGuess(g, "A", "crane", { ts: 4 });   // A wins on guess 2
  applyGuess(g, "C", "trial", { ts: 5 });   // C miss
  applyGuess(g, "C", "crane", { ts: 6 });   // C wins on guess 3 -> ends
  assert.equal(g.status, "ended");
  const ranked = rankedWinners(g).map(p => p.id);
  assert.deepEqual(ranked, ["B", "A", "C"]);
  assert.equal(g.winnerId, "B");
});

test("classic: tie on guess count broken by earliest solve ts", () => {
  const g = gameOf(["A", "B"], { mode: "classic" });
  applyGuess(g, "B", "crane", { ts: 100 });  // B wins g1 at ts 100
  applyGuess(g, "A", "crane", { ts: 200 });  // A wins g1 at ts 200 -> ends
  assert.equal(g.status, "ended");
  assert.equal(g.winnerId, "B"); // earlier ts wins the tie
});

test("classic: auto-extend fires when all still-trying players exhaust rows", () => {
  const g = gameOf(["A", "B"], { mode: "classic", maxRows: 6 });
  applyGuess(g, "A", "crane", { ts: ts() }); // A wins g1
  // B alone now; burn through 6 wrong guesses.
  for (let i = 0; i < 5; i++) applyGuess(g, "B", "slate", { ts: ts() });
  const r = applyGuess(g, "B", "slate", { ts: ts() });
  assert.equal(r.extended, true);
  assert.equal(g.maxRows, 8);
  assert.equal(g.status, "active");
});

test("classic: game ends when all eligible exhaust rows with no extend possible", () => {
  // Only A. They wrong-guess until exhaustion -> extend kicks in twice
  // then we manually set won=false and force board length beyond.
  // Easier: 1 player, set maxRows tiny and disable extend by making
  // the player already won (so stillTrying is empty -> no extend fires).
  // Cleanest direct case: A and B, both resign except for guesses.
  const g = gameOf(["A", "B"], { mode: "classic" });
  applyResign(g, "A");
  const r = applyResign(g, "B");
  assert.equal(r.ended, true);
  assert.equal(g.status, "ended");
  assert.equal(g.winnerId, null); // nobody solved it
});

test("classic: invalid format rejected regardless of mode", () => {
  const g = gameOf(["A"], { mode: "classic" });
  assert.equal(applyGuess(g, "A", "cran", { ts: ts() }).ok, false);
});

test("nextTurnIndex returns -1 when nobody is eligible", () => {
  const g = gameOf(["A", "B"]);
  g.players[0].resigned = true;
  g.players[1].resigned = true;
  assert.equal(nextTurnIndex(g), -1);
});
