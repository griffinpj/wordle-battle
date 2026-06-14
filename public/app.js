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

function onMessage(msg) {
  switch (msg.type) {
    case "joined":
      state.game = msg.state;
      // route by status
      if (msg.state.status === "lobby") state.view = "lobby";
      else if (msg.state.status === "active") state.view = "game";
      else state.view = "end";
      render();
      break;
    case "state":
      state.game = msg.state;
      if (msg.state.status === "lobby") state.view = "lobby";
      else if (msg.state.status === "active" && state.view !== "end") state.view = "game";
      render();
      break;
    case "start":
      state.game = msg.state;
      state.view = "game";
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
      render();
      break;
    case "error":
      toast(msg.message || "Error");
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
        <label>Share invite link</label>
        <div class="linkRow">
          <input id="shareUrl" type="text" readonly value="${escapeAttr(shareUrl)}" />
          <button class="secondary" id="copy">Copy</button>
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
  $("#leave").onclick = () => { wsSend({ type: "leave_lobby" }); state.game = null; state.view = "home"; render(); };
  $("#copy").onclick = async () => {
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

function renderGame(animateLast = false) {
  const g = state.game;
  const me = currentPlayer();
  const activeOrder = g.players.filter(p => !p.resigned);
  const currentTurnId = g.mode === "turn" && activeOrder.length ? activeOrder[g.turnIndex % activeOrder.length]?.id : null;
  const myTurn = g.mode === "sudden" ? true : currentTurnId === me?.id;

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
        ${g.mode==='turn' ? `<span class="badge ${myTurn?'live':''}">${myTurn?'Your turn':`${escapeHTML(playerName(currentTurnId))}'s turn`}</span>` : `<span class="badge live">Race!</span>`}
        <span class="badge">${g.maxRows} rows</span>
      </div>
    </div>
    <div class="game" id="boards">
      ${g.players.map(p => boardCard(p, g, me, currentTurnId)).join("")}
    </div>
    ${keyboardEl(me, g)}
  `;
  $("#resign").onclick = () => {
    if (!confirm("Resign this round?")) return;
    wsSend({ type: "resign" });
  };
  wireKeyboard();
  document.addEventListener("keydown", keyHandler);
  window.removeEventListener("beforeunload", unloadHandler);
  window.addEventListener("beforeunload", unloadHandler);

  if (animateLast) animateExtendRows();
}

function unloadHandler() { /* keep ws open via page lifecycle */ }

function boardCard(p, g, me, currentTurnId) {
  const isMe = p.id === me?.id;
  const isTurn = g.mode === "turn" && currentTurnId === p.id;
  const rows = [];
  for (let i = 0; i < g.maxRows; i++) {
    const entry = p.board[i];
    if (entry) {
      rows.push(`<div class="boardRow" style="display:contents;">${
        entry.word.split("").map((ch, j) => `<div class="tile ${entry.result[j]} flip" style="animation-delay:${j*80}ms">${ch}</div>`).join("")
      }</div>`);
    } else if (isMe && i === p.board.length && !p.won && !p.resigned && g.status === "active") {
      // Current input row
      const cur = state.current.padEnd(5, " ").slice(0,5);
      rows.push(cur.split("").map((ch, j) => `<div class="tile ${ch.trim()?'filled pop':''}" data-cur="${j}">${ch.trim()?ch:""}</div>`).join(""));
    } else {
      rows.push(Array.from({length:5}).map(() => `<div class="tile"></div>`).join(""));
    }
  }
  return `
    <div class="boardCard ${isMe?'me':''} ${isTurn?'turn':''}" data-pid="${p.id}">
      <div class="boardName">${escapeHTML(p.name)}${isMe?' (you)':''}${p.resigned?' · resigned':''}${p.won?' · WON':''}</div>
      <div class="board" style="grid-template-rows:repeat(${g.maxRows}, var(--tile));">
        ${rows.join("")}
      </div>
    </div>
  `;
}

function animateExtendRows() {
  // The newest rows already render; add a subtle row-extend marker via animation class is automatic.
  const tiles = document.querySelectorAll(".boardCard .tile");
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
    "ZENTER zxcvbnm BACK",
  ];
  return `
    <div class="keyboard" id="kb">
      ${rows.map((r, idx) => {
        if (idx < 2) {
          return `<div class="kbRow">${r.split("").map(ch => keyBtn(ch, status[ch])).join("")}</div>`;
        }
        return `<div class="kbRow">
          ${keyBtn("Enter", null, "wide")}
          ${"zxcvbnm".split("").map(ch => keyBtn(ch, status[ch])).join("")}
          ${keyBtn("Back", null, "wide")}
        </div>`;
      }).join("")}
    </div>
  `;
}

function keyBtn(label, st, cls = "") {
  const data = label.toLowerCase();
  return `<div class="key ${cls} ${st||""}" data-key="${data}">${label === "Back" ? "⌫" : label}</div>`;
}

function wireKeyboard() {
  const kb = $("#kb"); if (!kb) return;
  kb.querySelectorAll(".key").forEach(k => {
    k.onclick = () => {
      const v = k.dataset.key;
      if (v === "enter") submitGuess();
      else if (v === "back") { state.current = state.current.slice(0,-1); render(); }
      else if (/^[a-z]$/.test(v) && state.current.length < 5) { state.current += v; render(); }
    };
  });
}

function keyHandler(e) {
  if (state.view !== "game") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === "Enter") { e.preventDefault(); submitGuess(); }
  else if (k === "Backspace") { e.preventDefault(); state.current = state.current.slice(0,-1); render(); }
  else if (/^[a-zA-Z]$/.test(k) && state.current.length < 5) { state.current += k.toLowerCase(); render(); }
}

function submitGuess() {
  if (state.current.length !== 5) { toast("5 letters"); shakeCurrentRow(); return; }
  const w = state.current;
  state.current = "";
  wsSend({ type: "guess", word: w });
}

function shakeCurrentRow() {
  const me = currentPlayer();
  if (!me) return;
  const card = document.querySelector(`.boardCard[data-pid="${me.id}"]`);
  if (!card) return;
  const tiles = card.querySelectorAll(`.tile[data-cur]`);
  tiles.forEach(t => { t.classList.remove("shake"); void t.offsetWidth; t.classList.add("shake"); });
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
  $("#leaveEnd").onclick = () => { state.game = null; state.view = "home"; render(); };
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
