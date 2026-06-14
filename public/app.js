// Wordle Battle SPA

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");

// Persistent identity
const STORAGE = {
  pid: "wb_player_id",
  name: "wb_name",
};

function uid() {
  return "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
function getPlayerId() {
  let id = localStorage.getItem(STORAGE.pid);
  if (!id) { id = uid(); localStorage.setItem(STORAGE.pid, id); }
  return id;
}
function getName() { return localStorage.getItem(STORAGE.name) || ""; }
function setName(n) { localStorage.setItem(STORAGE.name, n); }

// State
const state = {
  view: "home", // home | create | join | lobby | game | end | profile
  pendingMode: "turn",
  pendingName: getName(),
  joinCode: new URL(location.href).searchParams.get("c") || "",
  game: null,
  current: "", // current guess in input
  ws: null,
  wsReady: false,
  toastTimer: null,
};

// WebSocket layer
function connect() {
  if (state.ws && state.ws.readyState <= 1) return state.ws;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  state.wsReady = false;
  ws.addEventListener("open", () => { state.wsReady = true; flushQueue(); });
  ws.addEventListener("close", () => {
    state.wsReady = false;
    toast("Disconnected — reconnecting…");
    setTimeout(() => { if (state.game) reconnect(); }, 1200);
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onMessage(msg);
  });
  return ws;
}
let outQueue = [];
function flushQueue() { while (outQueue.length && state.wsReady) state.ws.send(outQueue.shift()); }
function wsSend(obj) {
  const data = JSON.stringify(obj);
  if (state.wsReady) state.ws.send(data); else outQueue.push(data);
}
function reconnect() {
  if (!state.game) return;
  connect();
  wsSend({ type: "join", code: state.game.code, playerId: getPlayerId(), name: state.pendingName || getName() || "Player" });
}

function syncUrl() {
  const g = state.game;
  const inRoom = g && ["lobby","game","end"].includes(state.view);
  const url = new URL(location.href);
  if (inRoom) url.searchParams.set("c", g.code); else url.searchParams.delete("c");
  history.replaceState(null, "", url.pathname + (url.search ? url.search : "") + url.hash);
}

function maybeClearCurrent(prevState) {
  // If our own board grew on this update, the in-flight guess landed —
  // wipe the input buffer so the next row starts empty.
  const pid = getPlayerId();
  const prevLen = prevState?.players?.find(p => p.id === pid)?.board.length ?? 0;
  const newLen = state.game?.players?.find(p => p.id === pid)?.board.length ?? 0;
  if (newLen > prevLen) state.current = "";
}

function onMessage(msg) {
  const prev = state.game;
  switch (msg.type) {
    case "joined":
      state.game = msg.state;
      maybeClearCurrent(prev);
      // route by status
      if (msg.state.status === "lobby") state.view = "lobby";
      else if (msg.state.status === "active") state.view = "game";
      else state.view = "end";
      syncUrl();
      render();
      break;
    case "state":
      state.game = msg.state;
      maybeClearCurrent(prev);
      if (msg.state.status === "lobby") state.view = "lobby";
      else if (msg.state.status === "active" && state.view !== "end") state.view = "game";
      syncUrl();
      render();
      break;
    case "start":
      state.game = msg.state;
      state.current = "";
      state.view = "game";
      syncUrl();
      render();
      break;
    case "extend":
      if (state.game) state.game.maxRows = msg.maxRows;
      toast(`Extended to ${msg.maxRows} guesses!`);
      render(true);
      break;
    case "resigned":
      toast("A player resigned");
      break;
    case "game_end":
      state.game = msg.state;
      state.view = "end";
      syncUrl();
      render();
      break;
    case "error":
      toast(msg.message || "Error");
      state.submitting = false;
      shakeCurrentRow();
      break;
  }
}

// Toast
function toast(t) {
  const el = $("#toast");
  el.textContent = t;
  el.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

// Renderer
function render(animateLast = false) {
  const v = state.view;
  if (v === "home") renderHome();
  else if (v === "create") renderCreate();
  else if (v === "join") renderJoin();
  else if (v === "lobby") renderLobby();
  else if (v === "game") renderGame(animateLast);
  else if (v === "end") renderEnd();
  else if (v === "profile") renderProfile();
}

function brand(extra = "") {
  return `
    <div class="brand">
      <div class="brand-left">
        <div class="logo">W</div>
        <div>
          <div class="h1">Wordle Battle</div>
          <div class="sub">Race friends to the word.</div>
        </div>
      </div>
      <div>${extra}</div>
    </div>
  `;
}

function renderHome() {
  app.innerHTML = `
    ${brand(`<button class="icon-btn" id="profileBtn">Profile</button>`)}
    <div class="card stack">
      <div>
        <label>Your display name</label>
        <input id="name" type="text" placeholder="Your name" maxlength="24" value="${escapeAttr(state.pendingName)}" />
      </div>
      <div class="menu-grid">
        <button id="create">Create a Game</button>
        <button class="secondary" id="join">Join with Code</button>
      </div>
      <div class="muted center">No accounts. Your name stays on this device.</div>
    </div>
  `;
  $("#name").addEventListener("input", e => { state.pendingName = e.target.value; setName(e.target.value); });
  $("#create").onclick = () => { if (!requireName()) return; state.view = "create"; render(); };
  $("#join").onclick = () => { if (!requireName()) return; state.view = "join"; render(); };
  $("#profileBtn").onclick = () => { state.view = "profile"; render(); };

  if (state.joinCode) {
    state.view = "join";
    render();
  }
}

function requireName() {
  if (!state.pendingName || !state.pendingName.trim()) {
    toast("Pick a name first");
    $("#name")?.focus();
    return false;
  }
  setName(state.pendingName.trim());
  return true;
}

function renderCreate() {
  app.innerHTML = `
    ${brand(`<button class="icon-btn" id="back">← Back</button>`)}
    <div class="card stack">
      <div>
        <label>Choose a mode</label>
        <div class="modes">
          <div class="mode ${state.pendingMode==='turn'?'selected':''}" data-mode="turn">
            <h3>Turn-by-turn</h3>
            <p>Players alternate guesses. Strategy & sabotage.</p>
          </div>
          <div class="mode ${state.pendingMode==='sudden'?'selected':''}" data-mode="sudden">
            <h3>Sudden Death</h3>
            <p>First to guess wins. Pure speed.</p>
          </div>
        </div>
      </div>
      <button id="go">Create Game</button>
    </div>
  `;
  $("#back").onclick = () => { state.view = "home"; render(); };
  app.querySelectorAll(".mode").forEach(m => m.onclick = () => { state.pendingMode = m.dataset.mode; renderCreate(); });
  $("#go").onclick = () => {
    connect();
    wsSend({ type: "create", mode: state.pendingMode, name: state.pendingName, playerId: getPlayerId() });
  };
}

function renderJoin() {
  app.innerHTML = `
    ${brand(`<button class="icon-btn" id="back">← Back</button>`)}
    <div class="card stack">
      <div>
        <label>Game code</label>
        <input id="code" type="text" placeholder="4-digit code" maxlength="4" autocapitalize="characters" value="${escapeAttr(state.joinCode)}" />
      </div>
      <button id="go">Join Game</button>
    </div>
  `;
  $("#back").onclick = () => { state.view = "home"; render(); };
  const codeEl = $("#code");
  codeEl.addEventListener("input", e => { e.target.value = e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0,4); });
  codeEl.focus();
  $("#go").onclick = () => {
    const code = codeEl.value.trim().toUpperCase();
    if (code.length < 4) { toast("Enter the 4-character code"); return; }
    connect();
    wsSend({ type: "join", code, name: state.pendingName, playerId: getPlayerId() });
  };
  if (state.joinCode && state.joinCode.length === 4) {
    // Auto-attempt join
    connect();
    wsSend({ type: "join", code: state.joinCode.toUpperCase(), name: state.pendingName, playerId: getPlayerId() });
    state.joinCode = "";
  }
}

function renderLobby() {
  const g = state.game;
  const me = currentPlayer();
  const shareUrl = `${location.origin}/?c=${g.code}`;
  app.innerHTML = `
    ${brand(`<button class="icon-btn" id="leave">Leave</button>`)}
    <div class="card stack">
      <div class="row" style="justify-content:space-between;">
        <div>
          <div class="muted">Game code</div>
          <div class="code-pill">${g.code}</div>
        </div>
        <div class="gameMeta">
          <span class="badge">${g.mode==='turn'?'Turn-by-turn':'Sudden Death'}</span>
        </div>
      </div>
      <div class="share">
        <label>Invite</label>
        <div class="linkRow">
          <input id="shareUrl" type="text" readonly value="${escapeAttr(shareUrl)}" />
          <button class="icon-action" id="share" title="Share" aria-label="Share invite">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/>
            </svg>
          </button>
          <button class="icon-action" id="copy" title="Copy link" aria-label="Copy link">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>
            </svg>
          </button>
        </div>
      </div>
      <hr class="sep" />
      <div>
        <label>Your display name</label>
        <div class="linkRow">
          <input id="rename" type="text" value="${escapeAttr(me?.name || state.pendingName)}" maxlength="24" />
          <button class="secondary" id="setName">Save</button>
        </div>
      </div>
      <div>
        <label>Players (${g.players.length})</label>
        <div class="players">
          ${g.players.map(p => `
            <div class="player">
              <div class="dot ${p.connected?'on':''}"></div>
              <div class="grow"><strong>${escapeHTML(p.name)}</strong>${p.id===g.hostId?' <span class="tag">host</span>':''}${p.id===me?.id?' <span class="tag">you</span>':''}</div>
            </div>
          `).join("")}
        </div>
      </div>
      ${me?.id === g.hostId
        ? `<button id="start" ${g.players.length<2?'disabled':''}>${g.players.length<2?'Waiting for players…':'Start Game'}</button>`
        : `<div class="muted center">Waiting for host to start…</div>`
      }
    </div>
  `;
  $("#leave").onclick = () => { wsSend({ type: "leave_lobby" }); state.game = null; state.view = "home"; syncUrl(); render(); };
  $("#copy").onclick = async () => {
    try { await navigator.clipboard.writeText(shareUrl); toast("Link copied"); }
    catch { $("#shareUrl").select(); document.execCommand("copy"); toast("Link copied"); }
  };
  $("#share").onclick = async () => {
    const shareData = {
      title: "Wordle Battle",
      text: `Join my Wordle Battle — code ${g.code}`,
      url: shareUrl,
    };
    if (navigator.share) {
      try { await navigator.share(shareData); return; }
      catch (e) { if (e?.name === "AbortError") return; /* fall through to copy */ }
    }
    try { await navigator.clipboard.writeText(shareUrl); toast("Link copied"); }
    catch { $("#shareUrl").select(); document.execCommand("copy"); toast("Link copied"); }
  };
  $("#setName").onclick = () => {
    const v = $("#rename").value.trim().slice(0, 24);
    if (!v) return;
    setName(v); state.pendingName = v;
    wsSend({ type: "rename", name: v });
  };
  const startBtn = $("#start");
  if (startBtn) startBtn.onclick = () => wsSend({ type: "start" });
}

// Cached references to the current-input row's tiles, so per-keystroke
// updates can mutate the DOM directly without a full re-render.
let curTileEls = [];

function renderGame(animateLast = false) {
  const g = state.game;
  const me = currentPlayer();
  const activeOrder = g.players.filter(p => !p.resigned);
  const currentTurnId = g.mode === "turn" && activeOrder.length ? activeOrder[g.turnIndex % activeOrder.length]?.id : null;
  const myTurn = !me ? false :
    (g.mode === "sudden"
      ? (!me.won && !me.resigned && g.status === "active")
      : (currentTurnId === me.id && !me.won && !me.resigned && g.status === "active"));
  state.myTurn = myTurn;
  state.submitting = false;

  const others = g.players.filter(p => p.id !== me?.id);

  app.innerHTML = `
    ${brand(`<div class="row" style="gap:6px;">
      <button class="icon-btn" id="resign">Resign</button>
    </div>`)}
    <div class="banner">
      <div>
        <strong>${g.mode==='turn'?'Turn-by-turn':'Sudden Death'}</strong>
        <span class="muted"> · Code ${g.code}</span>
      </div>
      <div class="gameMeta">
        ${g.mode==='turn'
          ? `<span class="badge ${myTurn?'live':''}">${myTurn?'Your turn':`${escapeHTML(playerName(currentTurnId))}'s turn`}</span>`
          : `<span class="badge live">Race!</span>`}
        <span class="badge">${g.maxRows} rows</span>
      </div>
    </div>
    ${others.length ? `
      <div class="oppBar">
        ${others.map(p => oppCard(p, g, currentTurnId)).join("")}
      </div>` : ""
    }
    <div class="myWrap">
      ${myBoardCard(me, g)}
    </div>
    ${keyboardEl(me, g)}
  `;
  $("#resign").onclick = () => {
    if (!confirm("Resign this round?")) return;
    wsSend({ type: "resign" });
  };
  curTileEls = Array.from(document.querySelectorAll('.myBoard .tile[data-cur]'));
  paintCurrentRow(); // sync DOM to state.current
  wireKeyboard();
  document.removeEventListener("keydown", keyHandler);
  document.addEventListener("keydown", keyHandler);

  if (animateLast) animateExtendRows();
}

function myBoardCard(me, g) {
  if (!me) return "";
  const rows = [];
  for (let i = 0; i < g.maxRows; i++) {
    const entry = me.board[i];
    if (entry) {
      rows.push(entry.word.split("").map((ch, j) =>
        `<div class="tile ${entry.result[j]} flip" style="animation-delay:${j*80}ms">${ch}</div>`
      ).join(""));
    } else if (i === me.board.length && !me.won && !me.resigned && g.status === "active") {
      // Reserve current-input row — tiles get filled by paintCurrentRow().
      rows.push(Array.from({length:5}).map((_, j) =>
        `<div class="tile" data-cur="${j}"></div>`
      ).join(""));
    } else {
      rows.push(Array.from({length:5}).map(() => `<div class="tile"></div>`).join(""));
    }
  }
  const status = me.won ? "WON" : me.resigned ? "resigned" : null;
  return `
    <div class="boardCard myBoard me" data-pid="${me.id}">
      <div class="boardName">${escapeHTML(me.name)} (you)${status?` · ${status}`:""}</div>
      <div class="board" style="grid-template-rows:repeat(${g.maxRows}, var(--tile));">
        ${rows.join("")}
      </div>
    </div>
  `;
}

// Opponent strip — colored rows only, no letters. Preserves privacy and
// keeps the layout tight on mobile.
function oppCard(p, g, currentTurnId) {
  const isTurn = g.mode === "turn" && currentTurnId === p.id;
  const filledRows = p.board.map(entry =>
    `<div class="oppRow">${entry.result.map(r => `<span class="oppTile ${r} flip" style="animation-delay:0ms"></span>`).join("")}</div>`
  );
  const empty = Math.max(0, g.maxRows - p.board.length);
  const emptyRows = Array.from({length: empty}).map(() =>
    `<div class="oppRow">${Array.from({length:5}).map(() => `<span class="oppTile"></span>`).join("")}</div>`
  );
  const status = p.won ? "won" : p.resigned ? "out" : `${p.board.length}/${g.maxRows}`;
  return `
    <div class="opp ${isTurn?'turn':''}" data-pid="${p.id}">
      <div class="oppHead">
        <div class="dot ${p.connected?'on':''}"></div>
        <div class="oppName">${escapeHTML(p.name)}</div>
        <div class="oppStatus">${status}</div>
      </div>
      <div class="oppRows">
        ${filledRows.concat(emptyRows).join("")}
      </div>
    </div>
  `;
}

function paintCurrentRow() {
  if (!curTileEls.length) return;
  const cur = state.current.padEnd(5, " ").slice(0,5).split("");
  curTileEls.forEach((el, i) => {
    const ch = cur[i].trim();
    const had = el.textContent !== "";
    if (ch) {
      if (el.textContent !== ch) {
        el.textContent = ch;
        el.classList.add("filled");
        el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
      }
    } else if (had) {
      el.textContent = "";
      el.classList.remove("filled","pop");
    }
  });
}

function animateExtendRows() {
  // Subtle drop animation on every tile of the boards after row extension.
  const tiles = document.querySelectorAll(".boardCard .tile, .opp .oppTile");
  tiles.forEach(t => t.classList.add("row-extend"));
  setTimeout(() => tiles.forEach(t => t.classList.remove("row-extend")), 500);
}

function keyboardEl(me, g) {
  // Determine letter status from my board
  const status = {};
  const rank = { absent: 1, present: 2, correct: 3 };
  if (me) {
    for (const entry of me.board) {
      entry.word.split("").forEach((ch, i) => {
        const s = entry.result[i];
        if (!status[ch] || rank[s] > rank[status[ch]]) status[ch] = s;
      });
    }
  }
  const rows = [
    "qwertyuiop",
    "asdfghjkl",
  ];
  const locked = !state.myTurn;
  return `
    <div class="keyboard ${locked?'locked':''}" id="kb" aria-disabled="${locked}">
      ${rows.map(r => `<div class="kbRow">${r.split("").map(ch => keyBtn(ch, status[ch])).join("")}</div>`).join("")}
      <div class="kbRow">
        ${keyBtn("Enter", null, "wide")}
        ${"zxcvbnm".split("").map(ch => keyBtn(ch, status[ch])).join("")}
        ${keyBtn("Back", null, "wide")}
      </div>
    </div>
  `;
}

function keyBtn(label, st, cls = "") {
  const data = label.toLowerCase();
  return `<div class="key ${cls} ${st||""}" data-key="${data}">${label === "Back" ? "⌫" : label}</div>`;
}

function inputAllowed() {
  return state.view === "game" && state.myTurn && !state.submitting && state.game?.status === "active";
}

function pushLetter(ch) {
  if (!inputAllowed()) return;
  if (state.current.length >= 5) return;
  state.current += ch;
  paintCurrentRow();
}
function popLetter() {
  if (!inputAllowed()) return;
  if (!state.current.length) return;
  state.current = state.current.slice(0,-1);
  paintCurrentRow();
}

function wireKeyboard() {
  const kb = $("#kb"); if (!kb) return;
  kb.querySelectorAll(".key").forEach(k => {
    k.onclick = () => {
      const v = k.dataset.key;
      if (v === "enter") submitGuess();
      else if (v === "back") popLetter();
      else if (/^[a-z]$/.test(v)) pushLetter(v);
    };
  });
}

function keyHandler(e) {
  if (state.view !== "game") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === "Enter") { e.preventDefault(); submitGuess(); }
  else if (k === "Backspace") { e.preventDefault(); popLetter(); }
  else if (/^[a-zA-Z]$/.test(k)) { pushLetter(k.toLowerCase()); }
}

function submitGuess() {
  if (!inputAllowed()) {
    if (state.game?.mode === "turn" && !state.myTurn) toast("Wait for your turn");
    return;
  }
  if (state.current.length !== 5) { toast("5 letters"); shakeCurrentRow(); return; }
  const w = state.current;
  state.submitting = true;
  wsSend({ type: "guess", word: w });
  // Don't clear state.current until the server confirms or rejects, so a
  // dictionary API rejection lets the player edit their guess.
}

function shakeCurrentRow() {
  curTileEls.forEach(t => { t.classList.remove("shake"); void t.offsetWidth; t.classList.add("shake"); });
}

function renderEnd() {
  const g = state.game;
  const me = currentPlayer();
  const won = g.winnerId && g.winnerId === me?.id;
  const winner = g.players.find(p => p.id === g.winnerId);
  // Background remains current view (game). Overlay on top.
  renderGame();
  const overlay = document.createElement("div");
  overlay.className = "endOverlay";
  overlay.innerHTML = `
    <div class="endCard">
      <h2>${winner ? (won ? "You won! 🎉" : `${escapeHTML(winner.name)} wins`) : "Draw"}</h2>
      <div class="muted">The word was</div>
      <div class="target">${g.target || "—"}</div>
      <div class="btnRow">
        ${me?.id === g.hostId ? `<button id="rematch">Rematch</button>` : `<div class="muted">Waiting for host…</div>`}
        <button class="ghost" id="leaveEnd">Leave</button>
      </div>
    </div>
  `;
  app.appendChild(overlay);
  $("#rematch")?.addEventListener("click", () => { wsSend({ type: "rematch" }); });
  $("#leaveEnd").onclick = () => { state.game = null; state.view = "home"; syncUrl(); render(); };
}

async function renderProfile() {
  app.innerHTML = `
    ${brand(`<button class="icon-btn" id="back">← Back</button>`)}
    <div class="card stack">
      <div>
        <label>Display Name</label>
        <div class="linkRow">
          <input id="pname" type="text" value="${escapeAttr(state.pendingName)}" maxlength="24" />
          <button class="secondary" id="savename">Save</button>
        </div>
      </div>
      <hr class="sep" />
      <div id="statsBox" class="muted">Loading stats…</div>
    </div>
  `;
  $("#back").onclick = () => { state.view = "home"; render(); };
  $("#savename").onclick = () => {
    const v = $("#pname").value.trim().slice(0,24);
    if (!v) return;
    state.pendingName = v; setName(v); toast("Saved");
  };
  try {
    const r = await fetch(`/api/stats/${getPlayerId()}`);
    const data = await r.json();
    const s = data.stats || {};
    $("#statsBox").innerHTML = `
      <div class="statGrid">
        <div class="stat"><div class="v">${s.games_played || 0}</div><div class="l">Games</div></div>
        <div class="stat"><div class="v">${s.total_wins || 0}</div><div class="l">Wins</div></div>
        <div class="stat"><div class="v">${s.avg_guesses_to_win ? Number(s.avg_guesses_to_win).toFixed(2) : "—"}</div><div class="l">Avg guesses to win</div></div>
        <div class="stat"><div class="v">${s.total_guesses || 0}</div><div class="l">Total guesses</div></div>
      </div>
      <hr class="sep" />
      <div>
        <label>Recent games</label>
        ${(data.recent || []).length === 0 ? `<div class="muted">No games yet.</div>` :
          `<div class="players">${data.recent.map(r => `
            <div class="player">
              <div class="dot ${r.won?'on':''}"></div>
              <div class="grow"><strong>${escapeHTML(r.target)}</strong> · ${r.mode} · ${r.guess_count} guesses</div>
              <div class="muted">${new Date(r.ts).toLocaleDateString()}</div>
            </div>`).join("")}</div>`
        }
      </div>
    `;
  } catch {
    $("#statsBox").textContent = "Could not load stats.";
  }
}

// Helpers
function currentPlayer() {
  if (!state.game) return null;
  const pid = getPlayerId();
  return state.game.players.find(p => p.id === pid);
}
function playerName(id) {
  if (!state.game || !id) return "";
  return state.game.players.find(p => p.id === id)?.name || "";
}
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s) { return escapeHTML(s); }

// Boot
render();
