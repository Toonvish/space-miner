# Space Miner

Co-op top-down space mining in the browser. Three.js client, authoritative
[Colyseus](https://colyseus.io) game server, everything run with [Bun](https://bun.sh).

Mine asteroids with your laser drill, haul ore to the shared home station, build station
modules that upgrade every pilot's ship, deploy automatic miners that clear a circular work
zone, and later unlock autonomous mining drones that roam, mine and deliver ore on their own.

## Controls

| Key | Action |
| --- | --- |
| W / A / D / S | thrust / turn / brake |
| Shift | boost (limited tank) |
| Space or left mouse | mining laser (auto-aims in a forward cone) |
| E | dock at a free port / undock |
| F | deploy a miner · collect from a miner · pack up an empty miner |
| N | mute / unmute sound |
| O | options (sound volumes per channel) |
| Mouse wheel | zoom |
| Docked: 1–6, Enter, M, Tab | select module, construct, buy miner, switch tab (Modules · Miners · Drones · Ship) |

## Development

```sh
bun install
bun run dev        # game server on :2567 (auto-restart) + Vite client on :5173
```

Open http://localhost:5173. Open a second browser (or a private window) to play co-op
with yourself. The client connects to `ws://<host>:2567` in dev; override with
`?server=ws://other-host:2567`.

| Script | What it does |
| --- | --- |
| `bun run dev:server` / `dev:client` | run one half on its own |
| `bun run build` | typecheck client + server, build the client into `dist/` |
| `bun run start` | production server: serves `dist/` and the game on `PORT` (default 2567) |
| `bun run models [name]` | regenerate 3D models from `tools/blender/*.py` (needs Blender) |
| `bun run sounds` | regenerate the procedural sound effects into `public/sounds/` |

Server environment variables: `PORT`, `DATA_DIR` (world save, default `server-data/`),
`CLIENT_DIR` (default `dist/`), and `SPACE_MINER_CHEATS=1` (test-only `cheat` message —
never enable in production).

## Deployment

The `Dockerfile` builds the client and runs client + game server on one port (8080):

```sh
docker build -t space-miner .
docker run -d -p 8080:8080 -v space-miner-data:/data --name space-miner space-miner
```

- Put it behind any TLS-terminating reverse proxy (Caddy, nginx, Traefik) or a container
  host such as Fly.io or Railway. The client connects to the same origin, so `https://`
  automatically uses `wss://`. The proxy must allow WebSocket upgrades.
- The world (station, miners, players' cargo) is saved to `/data/world.json` every 10 s
  and when the last pilot leaves. Keep `/data` on a volume.
- One process hosts one shared sector (max 24 pilots). Don't run multiple replicas
  against the same save.
- `GET /health` returns `{"ok":true}` for health checks.

Identity is deliberately simple: each browser gets a random secret token (localStorage)
plus a chosen callsign. There are no passwords.

## Layout

```
shared/     config, upgrade tables and the synced Colyseus schema (client + server)
server/     Colyseus room, authoritative world simulation, JSON persistence
src/        Three.js client: views of server state, local ship flight, HUD, station terminal
tools/      Blender model scripts (+ shared bake pipeline) and the dev runner
public/     exported .glb models
```
