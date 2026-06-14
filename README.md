# Wordle Battle

Real-time multiplayer Wordle. Race friends to the word, turn-by-turn or sudden death. No accounts — pick a name, share a 4-character code, and battle.

## Features

- **Two modes**
  - **Turn-by-turn** — players alternate guesses.
  - **Sudden Death** — first to solve wins.
- **Dynamic extension** — when everyone runs out of guesses, two extra rows are added with a drop-in animation.
- **Resign** at any time.
- **No accounts** — your display name and player ID live in localStorage. Editable any time.
- **Lobby + invites** — host creates a game, shares a 4-character code or an invite link.
- **Real-time** via WebSocket.
- **Profile stats** — persisted in SQLite as immutable guess entries; stats query computes avg guesses, win rate, etc.
- **Mobile-optimized** UI with on-screen keyboard, safe-area aware.
- **Minimalist UX** — dark, calm, no clutter.

## Quick start (local)

```sh
npm install
npm start
# open http://localhost:3000
```

## Docker

Build + run with compose:

```sh
docker compose up --build -d
# http://localhost:3000
```

Data (SQLite) persists in the `wordle-battle-data` volume.

## Deploy to Docker Hub

```sh
docker login              # as cougargriff
./deploy.sh               # pushes :latest and :<git-sha> (linux/amd64 + linux/arm64)
./deploy.sh v1.2.3        # also pushes :v1.2.3
```

Pull and run on any host:

```sh
docker compose pull && docker compose up -d
```

## Project layout

```
server.js          Express + ws + sqlite. Game rooms, WS protocol, REST stats.
words.js           Answer list, validation, scoring.
public/            SPA: index.html, app.js, style.css
Dockerfile         Production image (Node 20, builds better-sqlite3 from source)
docker-compose.yml Single-service compose with persistent volume
deploy.sh          Buildx multi-arch push to Docker Hub
```

## WebSocket protocol (brief)

Client → server: `create`, `join`, `rename`, `start`, `guess`, `resign`, `leave_lobby`, `rematch`.
Server → client: `joined`, `state`, `start`, `extend`, `resigned`, `game_end`, `error`.

All state changes broadcast a fresh `state` snapshot so reconnects re-sync immediately.

## License

MIT
