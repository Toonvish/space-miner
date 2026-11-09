import { Room, type Client } from "@colyseus/core";
import { NET, PILOT_COLORS, hash } from "../shared/config";
import { SectorState, type MoveMsg } from "../shared/schema";
import { MODULES, type ModuleId } from "../shared/upgrades";
import { loadWorld, saveWorld, type PlayerSave } from "./persistence";
import { World } from "./world";

interface JoinOptions { name?: string; token?: string }

const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** One shared co-op sector. Every player joins the same room ("sector"). */
export class SectorRoom extends Room<{ state: SectorState }> {
  maxClients = PILOT_COLORS.length; // every pilot has a unique colour
  state = new SectorState();
  private world!: World;
  private players: Record<string, PlayerSave> = {}; // saved players by token
  private tokens = new Map<string, string>(); // sessionId -> token
  private lastMove = new Map<string, number>(); // sessionId -> server time of last accepted move

  async onCreate() {
    const save = await loadWorld();
    this.players = save.players ?? {};
    this.world = new World(this.state, {
      boom: (msg) => this.broadcast("boom", msg),
      toast: (sid, text) => {
        const c = this.clients.find((cl) => cl.sessionId === sid);
        if (c) c.send("toast", { text });
      },
      built: (module, level, by) => this.broadcast("built", { module, level, by }),
    });
    this.world.load(save);

    this.setPatchRate(NET.tickMs);
    this.setSimulationInterval((dtMs) => this.world.tick(Math.min(dtMs, 200) / 1000), NET.tickMs);
    this.clock.setInterval(() => this.persist(), 10_000);

    this.onMessage("move", (client, m: MoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof m !== "object" || m === null) return;
      const last = this.lastMove.get(client.sessionId) ?? this.state.time;
      if (this.world.applyMove(p, m, this.state.time - last)) {
        this.lastMove.set(client.sessionId, this.state.time);
      } else {
        client.send("snap", { x: p.x, z: p.z, vx: p.vx, vz: p.vz });
      }
    });
    this.onMessage("dock", (c) => this.world.dock(c.sessionId));
    this.onMessage("undock", (c) => this.world.undock(c.sessionId));
    this.onMessage("build", (c, m: { module?: string }) => {
      if (typeof m?.module === "string" && m.module in MODULES) this.world.build(c.sessionId, m.module as ModuleId);
    });
    this.onMessage("buyMiner", (c) => this.world.buyMiner(c.sessionId));
    this.onMessage("minerAction", (c) => this.world.minerAction(c.sessionId));
    this.onMessage("setColor", (c, m: { color?: number }) => this.world.setColor(c.sessionId, Number(m?.color)));

    // test helper, never enabled unless the server is started with SPACE_MINER_CHEATS=1
    if (process.env.SPACE_MINER_CHEATS === "1") {
      this.onMessage("cheat", (c, m: { ore?: number; minerStock?: number }) => {
        this.state.station.stored += Number(m?.ore) || 0;
        const p = this.state.players.get(c.sessionId);
        if (p) p.minerStock += Number(m?.minerStock) || 0;
      });
    }
  }

  onJoin(client: Client, options: JoinOptions) {
    const token = typeof options?.token === "string" && TOKEN_RE.test(options.token) ? options.token : client.sessionId;
    const name = (typeof options?.name === "string" ? options.name : "")
      .replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 16) || "Pilot";

    // the same pilot logging in again replaces the old session
    for (const [sid, tok] of this.tokens) {
      if (tok === token) {
        this.savePlayer(sid);
        this.clients.find((c) => c.sessionId === sid)?.leave();
        this.tokens.delete(sid);
      }
    }
    this.tokens.set(client.sessionId, token);
    const saved = this.players[token];
    this.world.addPlayer(client.sessionId, name, hash(token), saved);
    this.lastMove.set(client.sessionId, this.state.time);
    console.log(`[room] ${name} joined (${this.clients.length} online)`);
  }

  onLeave(client: Client) {
    this.savePlayer(client.sessionId);
    this.tokens.delete(client.sessionId);
    this.lastMove.delete(client.sessionId);
    this.persist();
  }

  private savePlayer(sessionId: string) {
    const token = this.tokens.get(sessionId);
    const rec = this.world.removePlayer(sessionId);
    if (token && rec) this.players[token] = rec;
  }

  private persist() {
    // include currently connected players without removing them
    const players = { ...this.players };
    for (const [sid, token] of this.tokens) {
      const p = this.state.players.get(sid);
      if (p) players[token] = { name: p.name, color: p.color, cargo: p.cargo, minerStock: p.minerStock, x: p.x, z: p.z };
    }
    return saveWorld(this.world.snapshot(players));
  }

  async onDispose() {
    await this.persist();
  }
}
