import { Client, type Room } from "@colyseus/sdk";
import { NET } from "../shared/config";
import { SectorState, type MoveMsg } from "../shared/schema";

const TOKEN_KEY = "space-miner-token";
const NAME_KEY = "space-miner-name";

/** Stable anonymous identity: a random secret token kept in this browser. */
export function identity(): { token: string; name: string } {
  let token = "";
  let name = "";
  try {
    token = localStorage.getItem(TOKEN_KEY) ?? "";
    name = localStorage.getItem(NAME_KEY) ?? "";
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
      token = crypto.randomUUID().replace(/-/g, "");
      localStorage.setItem(TOKEN_KEY, token);
    }
  } catch {
    token = crypto.randomUUID().replace(/-/g, "");
  }
  return { token, name };
}

export function rememberName(name: string) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
}

/** Game server address: same origin in production, :2567 next to the Vite dev server. */
function endpoint(): string {
  const override = new URLSearchParams(location.search).get("server");
  if (override) return override;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  if (import.meta.env.DEV) return `${proto}://${location.hostname}:${NET.port}`;
  return `${proto}://${location.host}`;
}

export class Net {
  private lastServerTime = 0;
  private lastLocal = 0;
  private sendAcc = 0;

  private constructor(readonly room: Room<any, SectorState>) {
    room.onStateChange((s) => {
      this.lastServerTime = s.time;
      this.lastLocal = performance.now();
    });
  }

  static async connect(name: string, token: string): Promise<Net> {
    const client = new Client(endpoint());
    const room = await client.joinOrCreate("sector", { name, token }, SectorState);
    const net = new Net(room as Room<any, SectorState>);
    // wait for the first full state
    await new Promise<void>((resolve) => {
      if (room.state?.players?.get(room.sessionId)) return resolve();
      const check = () => {
        if (room.state.players.get(room.sessionId)) { room.onStateChange.remove(check); resolve(); }
      };
      room.onStateChange(check);
    });
    return net;
  }

  get state(): SectorState { return this.room.state; }
  get sessionId(): string { return this.room.sessionId; }
  get me() { return this.room.state.players.get(this.room.sessionId); }

  /** Estimated current server time (seconds), advancing smoothly between patches. */
  serverTime(): number {
    return this.lastServerTime + (performance.now() - this.lastLocal) / 1000;
  }

  /** Throttled ship update (NET.sendMs). */
  sendMove(dt: number, m: MoveMsg) {
    this.sendAcc += dt * 1000;
    if (this.sendAcc < NET.sendMs) return;
    this.sendAcc = 0;
    this.room.send("move", m);
  }

  send(type: string, payload?: unknown) {
    this.room.send(type, payload);
  }

  on<T>(type: string, cb: (msg: T) => void) {
    this.room.onMessage(type, cb as (m: unknown) => void);
  }
}
