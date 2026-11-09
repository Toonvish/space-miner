import {
  ASTEROID, DRILL, DRONE, ORE, PILOT_COLORS, SECTOR, SHIP, STATION, armPodPos, asteroidPosAt, asteroidVelAt,
} from "../shared/config";
import {
  AsteroidState, DRONE_STATUS, DroneState, MINER_STATUS, MinerState, OreState, PlayerState,
  type BoomMsg, type DroneStatus, type MinerStatus, type SectorState,
} from "../shared/schema";
import {
  MINER, MODULES, MODULE_ORDER, levelOf, maxLevel, minerCost, nextCost, stats, type ModuleId, type ShipStats,
} from "../shared/upgrades";
import type { PlayerSave, WorldSave } from "./persistence";

/** Hooks the room provides so the world can talk to clients without knowing about networking. */
export interface WorldEvents {
  boom(msg: BoomMsg): void;
  toast(sessionId: string, text: string): void;
  built(module: ModuleId, level: number, by: string): void;
}

interface OreRuntime { vx: number; vz: number; age: number }
interface MinerRuntime { age: number; aim: number }
interface DroneRuntime { timer: number; vx: number; vz: number; bay: number }

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const MINER_IDX = (s: MinerStatus) => MINER_STATUS.indexOf(s);
const DRONE_IDX = (s: DroneStatus) => DRONE_STATUS.indexOf(s);

/** Authoritative simulation of the shared sector. Mutates the synced Colyseus state. */
export class World {
  private seq = 1;
  private ore = new Map<string, OreRuntime>();
  private minerRt = new Map<string, MinerRuntime>();
  private droneRt = new Map<string, DroneRuntime>();
  stats: ShipStats;

  constructor(readonly state: SectorState, private events: WorldEvents) {
    this.stats = stats(state.station.levels);
  }

  get time() { return this.state.time; }
  private id(prefix: string) { return prefix + (this.seq++).toString(36); }

  // ------------------------------------------------------------------ persistence
  load(save: WorldSave) {
    const st = this.state.station;
    for (const id of MODULE_ORDER) {
      const v = Math.floor(Number(save.station.levels?.[id] ?? 0));
      st.levels.set(id, Math.max(0, Math.min(maxLevel(id), v)));
    }
    st.stored = Math.max(0, Number(save.station.stored) || 0) + Math.max(0, save.droneCargo || 0);
    st.minersBought = Math.max(0, Math.floor(save.station.minersBought || 0));
    for (const m of save.miners ?? []) {
      if (Number.isFinite(m.x) && Number.isFinite(m.z)) this.addMiner(m.x, m.z, m.owner ?? "?", m.stored, true);
    }
    this.refreshStats();
    while (this.state.asteroids.size < SECTOR.asteroidCount) this.spawnRandomAsteroid(true);
  }

  snapshot(players: Record<string, PlayerSave>): WorldSave {
    const levels: Record<string, number> = {};
    for (const id of MODULE_ORDER) levels[id] = levelOf(this.state.station.levels, id);
    let droneCargo = 0;
    this.state.drones.forEach((d) => (droneCargo += d.cargo));
    const miners: WorldSave["miners"] = [];
    this.state.miners.forEach((m) => miners.push({ x: m.x, z: m.z, stored: m.stored, owner: m.owner }));
    return {
      version: 1,
      station: { levels, stored: this.state.station.stored, minersBought: this.state.station.minersBought },
      miners, players, droneCargo,
    };
  }

  private refreshStats() {
    this.stats = stats(this.state.station.levels);
    const ports = this.state.station.ports;
    while (ports.length < this.stats.ports) ports.push("");
    let n = this.state.drones.size;
    while (n < this.stats.drones) this.addDrone(n++);
  }

  // ------------------------------------------------------------------ players
  /** Colour indices held by connected pilots (optionally ignoring one session). */
  private takenColors(except?: string): Set<number> {
    const taken = new Set<number>();
    this.state.players.forEach((p, sid) => { if (sid !== except) taken.add(p.color); });
    return taken;
  }

  addPlayer(sessionId: string, name: string, fallbackColor: number, save?: PlayerSave): PlayerState {
    const p = new PlayerState();
    p.name = name;
    // keep the pilot's previous colour if it is free, otherwise take the first free one
    const taken = this.takenColors();
    const n = PILOT_COLORS.length;
    const wanted = Number.isInteger(save?.color) ? save!.color! : fallbackColor % n;
    let color = wanted;
    for (let k = 0; k < n && taken.has(color); k++) color = (wanted + k + 1) % n;
    p.color = color;
    p.port = -1;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    p.cargo = Math.max(0, Math.min(Math.floor(num(save?.cargo)), this.stats.capacity));
    p.minerStock = Math.max(0, Math.min(Math.floor(num(save?.minerStock)), MINER.maxOwned));
    const sx = num(save?.x), sz = num(save?.z);
    if (Math.hypot(sx, sz) < SECTOR.radius) { p.x = sx; p.z = sz; }
    this.state.players.set(sessionId, p);
    return p;
  }

  removePlayer(sessionId: string): PlayerSave | null {
    const p = this.state.players.get(sessionId);
    if (!p) return null;
    this.freePort(`p:${sessionId}`);
    this.state.players.delete(sessionId);
    return { name: p.name, color: p.color, cargo: p.cargo, minerStock: p.minerStock, x: p.x, z: p.z };
  }

  setColor(sessionId: string, color: number) {
    const p = this.state.players.get(sessionId);
    if (!p || !Number.isInteger(color) || color < 0 || color >= PILOT_COLORS.length) return;
    if (this.takenColors(sessionId).has(color)) return this.events.toast(sessionId, "That colour is taken by another pilot");
    p.color = color;
  }

  /** Client-predicted movement; returns false if the jump is implausible (client gets snapped back). */
  applyMove(p: PlayerState, m: { x: number; z: number; h: number; vx: number; vz: number; th: number; b: boolean; d: boolean; tg: string }, dt: number): boolean {
    if (p.port >= 0) return true; // docked: position is owned by the server
    const vals = [m.x, m.z, m.h, m.vx, m.vz, m.th];
    if (!vals.every(Number.isFinite)) return false;
    const maxStep = SHIP.maxPlausibleSpeed * Math.max(dt, 0.05) + 3;
    if (Math.hypot(m.x - p.x, m.z - p.z) > maxStep) return false;
    const r = Math.hypot(m.x, m.z);
    const lim = SECTOR.radius + 20;
    p.x = r > lim ? (m.x / r) * lim : m.x;
    p.z = r > lim ? (m.z / r) * lim : m.z;
    p.h = m.h;
    p.vx = m.vx;
    p.vz = m.vz;
    p.throttle = Math.max(0, Math.min(1, m.th));
    p.boost = !!m.b;
    p.drilling = !!m.d;
    p.target = typeof m.tg === "string" && m.tg.length < 16 ? m.tg : "";
    return true;
  }

  // ------------------------------------------------------------------ docking ports
  portPos(k: number): { x: number; z: number } {
    return k === 0 ? { x: 0, z: 0 } : armPodPos(MODULES.ports.angle, k - 1);
  }

  private freePort(occupant: string) {
    const ports = this.state.station.ports;
    for (let i = 0; i < ports.length; i++) if (ports[i] === occupant) ports[i] = "";
  }

  /** Nearest free port within `maxDist`, or -1. */
  private findPort(x: number, z: number, maxDist: number): number {
    const ports = this.state.station.ports;
    let best = -1;
    let bd = maxDist;
    for (let i = 0; i < ports.length; i++) {
      if (ports[i] !== "") continue;
      const pp = this.portPos(i);
      const d = Math.hypot(pp.x - x, pp.z - z);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  dock(sessionId: string) {
    const p = this.state.players.get(sessionId);
    if (!p || p.port >= 0) return;
    if (Math.hypot(p.vx, p.vz) > STATION.dockMaxSpeed) return this.events.toast(sessionId, "Slow down to dock");
    const k = this.findPort(p.x, p.z, STATION.dockRadius);
    if (k < 0) {
      const anyNear = this.state.station.ports.some((_, i) => {
        const pp = this.portPos(i);
        return Math.hypot(pp.x - p.x, pp.z - p.z) < STATION.dockRadius;
      });
      return this.events.toast(sessionId, anyNear ? "Port occupied — build more Docking Ports" : "Fly over a docking port");
    }
    this.state.station.ports[k] = `p:${sessionId}`;
    p.port = k;
    p.vx = p.vz = 0;
    p.drilling = false;
    p.target = "";
    const unloaded = p.cargo;
    this.state.station.stored += unloaded;
    p.cargo = 0;
    if (unloaded > 0) this.events.toast(sessionId, `Unloaded ${unloaded} ore`);
  }

  undock(sessionId: string) {
    const p = this.state.players.get(sessionId);
    if (!p || p.port < 0) return;
    this.freePort(`p:${sessionId}`);
    p.port = -1;
  }

  // ------------------------------------------------------------------ station economy
  build(sessionId: string, id: ModuleId) {
    const p = this.state.players.get(sessionId);
    const st = this.state.station;
    if (!p || p.port < 0 || !MODULES[id]) return;
    const cost = nextCost(st.levels, id);
    if (!Number.isFinite(cost)) return;
    if (st.stored < cost) return this.events.toast(sessionId, "Not enough ore in the station");
    st.stored -= cost;
    const lvl = levelOf(st.levels, id) + 1;
    st.levels.set(id, lvl);
    this.refreshStats();
    this.events.built(id, lvl, p.name);
  }

  buyMiner(sessionId: string) {
    const p = this.state.players.get(sessionId);
    const st = this.state.station;
    if (!p || p.port < 0) return;
    if (this.state.miners.size + this.totalCarriedMiners() >= MINER.maxOwned) {
      return this.events.toast(sessionId, "Miner fleet is at its limit");
    }
    const cost = minerCost(st.minersBought);
    if (st.stored < cost) return this.events.toast(sessionId, "Not enough ore in the station");
    st.stored -= cost;
    st.minersBought++;
    p.minerStock++;
    this.events.toast(sessionId, "Automatic miner loaded · press F in space to deploy");
  }

  private totalCarriedMiners() {
    let n = 0;
    this.state.players.forEach((p) => (n += p.minerStock));
    return n;
  }

  // ------------------------------------------------------------------ miners
  private addMiner(x: number, z: number, owner: string, stored = 0, settled = false) {
    const m = new MinerState();
    m.x = x;
    m.z = z;
    m.owner = owner;
    m.stored = Math.max(0, Math.min(MINER.capacity, stored));
    m.status = MINER_IDX("deploying");
    const id = this.id("m");
    this.state.miners.set(id, m);
    this.minerRt.set(id, { age: settled ? 10 : 0, aim: 0 });
    return id;
  }

  /** F key: collect from / pack up a nearby miner, or deploy a carried one. */
  minerAction(sessionId: string) {
    const p = this.state.players.get(sessionId);
    if (!p || p.port >= 0) return;
    let nearId = "";
    let nd = Infinity;
    this.state.miners.forEach((m, id) => {
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d < nd) { nd = d; nearId = id; }
    });
    const near = nearId ? this.state.miners.get(nearId)! : null;
    if (near && nd < MINER.collectRange) {
      if (near.stored >= 1) {
        const take = Math.min(Math.floor(near.stored), this.stats.capacity - p.cargo);
        if (take <= 0) return this.events.toast(sessionId, "Cargo hold full");
        near.stored -= take;
        p.cargo += take;
        return this.events.toast(sessionId, `Collected ${take} ore from miner`);
      }
      this.state.miners.delete(nearId);
      this.minerRt.delete(nearId);
      p.minerStock++;
      return this.events.toast(sessionId, "Miner packed up");
    }
    if (p.minerStock <= 0) return;
    if (Math.hypot(p.x, p.z) < STATION.socketRadius + 8) return this.events.toast(sessionId, "Too close to the station");
    if (near && nd < 6) return this.events.toast(sessionId, "Too close to another miner");
    p.minerStock--;
    this.addMiner(p.x, p.z, p.name);
    this.events.toast(sessionId, "Miner deployed");
  }

  // ------------------------------------------------------------------ drones
  private addDrone(bay: number) {
    const d = new DroneState();
    const pp = armPodPos(MODULES.drones.angle, bay);
    d.x = pp.x;
    d.z = pp.z;
    d.port = -1;
    d.status = DRONE_IDX("parked");
    const id = this.id("d");
    this.state.drones.set(id, d);
    this.droneRt.set(id, { timer: 0, vx: 0, vz: 0, bay });
  }

  /** Steer towards (tx, tz); returns the remaining distance. */
  private steer(d: DroneState, rt: DroneRuntime, tx: number, tz: number, dt: number, arrive = 4): number {
    const dx = tx - d.x;
    const dz = tz - d.z;
    const dist = Math.hypot(dx, dz);
    const want = DRONE.speed * Math.min(1, dist / arrive);
    const dvx = dist > 1e-3 ? (dx / dist) * want : 0;
    const dvz = dist > 1e-3 ? (dz / dist) * want : 0;
    const k = Math.min(1, (DRONE.accel / DRONE.speed) * dt * 3);
    rt.vx += (dvx - rt.vx) * k;
    rt.vz += (dvz - rt.vz) * k;
    d.x += rt.vx * dt;
    d.z += rt.vz * dt;
    d.speed = Math.hypot(rt.vx, rt.vz);
    if (d.speed > 0.5) {
      const want = Math.atan2(-rt.vx, -rt.vz); // heading convention: forward = (-sin h, -cos h)
      const diff = Math.atan2(Math.sin(want - d.h), Math.cos(want - d.h));
      d.h += Math.max(-DRONE.turnRate * dt, Math.min(DRONE.turnRate * dt, diff));
    }
    return dist;
  }

  private pickMinerForDrone(id: string): string {
    let best = "";
    let most = DRONE.minPickup - 1e-6;
    this.state.miners.forEach((m, mid) => {
      if (m.claimed !== "" && m.claimed !== id) return;
      if (m.stored > most) { most = m.stored; best = mid; }
    });
    return best;
  }

  private updateDrones(dt: number) {
    this.state.drones.forEach((d, id) => {
      const rt = this.droneRt.get(id)!;
      const status = DRONE_STATUS[d.status];
      const bay = armPodPos(MODULES.drones.angle, rt.bay);
      const set = (s: DroneStatus) => (d.status = DRONE_IDX(s));
      const release = () => {
        const m = this.state.miners.get(d.target);
        if (m && m.claimed === id) m.claimed = "";
      };

      switch (status) {
        case "parked": {
          this.steer(d, rt, bay.x, bay.z, dt, 2);
          const target = this.pickMinerForDrone(id);
          if (target) {
            this.state.miners.get(target)!.claimed = id;
            d.target = target;
            set("outbound");
          }
          break;
        }
        case "outbound": {
          const m = this.state.miners.get(d.target);
          if (!m) { d.target = ""; set("returning"); break; }
          if (this.steer(d, rt, m.x, m.z, dt) < 1.5) { rt.timer = DRONE.loadTime; set("loading"); }
          break;
        }
        case "loading": {
          const m = this.state.miners.get(d.target);
          if (m) this.steer(d, rt, m.x, m.z, dt);
          rt.timer -= dt;
          if (rt.timer <= 0 || !m) {
            if (m) {
              const take = Math.min(m.stored, DRONE.capacity - d.cargo);
              m.stored -= take;
              d.cargo += take;
            }
            release();
            d.target = "";
            set("returning");
          }
          break;
        }
        case "returning":
        case "waiting": {
          if (d.cargo < 0.5) {
            // nothing to deliver: head home to the bay
            d.cargo = 0;
            if (this.steer(d, rt, bay.x, bay.z, dt, 3) < 0.5) set("parked");
            break;
          }
          if (d.port < 0) {
            const distHome = Math.hypot(d.x, d.z);
            const k = distHome < 16 ? this.findPort(d.x, d.z, 40) : -1;
            if (k >= 0) {
              this.state.station.ports[k] = `d:${id}`;
              d.port = k;
              set("returning");
            } else if (distHome < 16) {
              // all ports busy: hold in a slow orbit until one frees up
              set("waiting");
              const a = Math.atan2(d.z, d.x) + 0.35;
              this.steer(d, rt, Math.cos(a) * 12, Math.sin(a) * 12, dt, 2);
            } else {
              this.steer(d, rt, 0, 0, dt);
            }
            break;
          }
          const pp = this.portPos(d.port);
          if (this.steer(d, rt, pp.x, pp.z, dt, 3) < 0.4) { rt.timer = DRONE.unloadTime; set("unloading"); }
          break;
        }
        case "unloading": {
          const pp = this.portPos(d.port);
          this.steer(d, rt, pp.x, pp.z, dt, 2);
          rt.timer -= dt;
          if (rt.timer <= 0) {
            this.state.station.stored += d.cargo;
            d.cargo = 0;
            this.freePort(`d:${id}`);
            d.port = -1;
            set("returning"); // -> heads to the bay, or straight out again from "parked"
          }
          break;
        }
      }
    });
  }

  // ------------------------------------------------------------------ asteroids
  private spawnAsteroid(x: number, z: number, r: number, vx: number, vz: number): string {
    const a = new AsteroidState();
    a.x0 = x; a.z0 = z; a.vx = vx; a.vz = vz; a.t0 = this.time;
    a.r = r;
    a.maxHp = a.hp = ASTEROID.hpPerArea * r * r;
    const id = this.id("a");
    this.state.asteroids.set(id, a);
    return id;
  }

  private spawnRandomAsteroid(initial = false) {
    for (let tries = 0; tries < 30; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.sqrt(rand((SECTOR.clearRadius + 8) ** 2, (SECTOR.radius - 10) ** 2));
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      const r = ASTEROID.minRadius + Math.random() ** 2.2 * (ASTEROID.maxRadius - ASTEROID.minRadius);
      let ok = true;
      if (!initial) {
        this.state.players.forEach((p) => { if (Math.hypot(p.x - x, p.z - z) < SECTOR.spawnAwayFromPlayers) ok = false; });
      }
      if (ok) {
        this.state.asteroids.forEach((o) => {
          const op = asteroidPosAt(o, this.time);
          if (Math.hypot(op.x - x, op.z - z) < o.r + r + 2) ok = false;
        });
      }
      if (!ok) continue;
      this.spawnAsteroid(x, z, r, rand(-0.6, 0.6), rand(-0.6, 0.6));
      return;
    }
  }

  private setMotion(a: AsteroidState, x: number, z: number, vx: number, vz: number) {
    a.x0 = x; a.z0 = z; a.vx = vx; a.vz = vz; a.t0 = this.time;
  }

  private damage(id: string, amount: number, by: { player?: string; miner?: string }) {
    const a = this.state.asteroids.get(id);
    if (!a) return;
    a.hp -= amount;
    if (a.hp > 0) return;

    const pos = asteroidPosAt(a, this.time);
    const vel = asteroidVelAt(a, this.time);
    this.state.asteroids.delete(id);
    this.events.boom({ x: pos.x, z: pos.z, r: a.r, vx: vel.vx, vz: vel.vz, by: by.player ?? by.miner ?? "" });

    if (a.r > ASTEROID.splitRadius) {
      const n = a.r > 3.2 ? 3 : 2;
      const base = Math.random() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const ang = base + (i / n) * Math.PI * 2;
        const dx = Math.cos(ang), dz = Math.sin(ang);
        const r = a.r * (n === 3 ? 0.5 : 0.6) * rand(0.9, 1.1);
        const sp = rand(1.5, 3);
        this.spawnAsteroid(pos.x + dx * a.r * 0.5, pos.z + dz * a.r * 0.5, r, vel.vx + dx * sp, vel.vz + dz * sp);
      }
    }
    const yieldOre = Math.ceil(a.r * 2);
    if (by.miner) {
      const m = this.state.miners.get(by.miner);
      if (m) m.stored = Math.min(MINER.capacity, m.stored + yieldOre);
    } else {
      for (let i = 0; i < yieldOre; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = rand(1.5, 4.5);
        const o = new OreState();
        o.x = pos.x + Math.cos(ang) * Math.random() * 0.8;
        o.z = pos.z + Math.sin(ang) * Math.random() * 0.8;
        const oid = this.id("o");
        this.state.ore.set(oid, o);
        this.ore.set(oid, { vx: vel.vx + Math.cos(ang) * sp, vz: vel.vz + Math.sin(ang) * sp, age: 0 });
      }
    }
  }

  private updateAsteroids() {
    const t = this.time;
    this.state.asteroids.forEach((a) => {
      const p = asteroidPosAt(a, t);
      const v = asteroidVelAt(a, t);
      const r = Math.hypot(p.x, p.z);
      if (r < 1e-3) return;
      const nx = p.x / r, nz = p.z / r;
      const radial = v.vx * nx + v.vz * nz;
      // bounce off the sector edge and the station's clear zone (rare events -> rare patches)
      if ((r > SECTOR.radius && radial > 0) || (r < SECTOR.clearRadius + a.r && radial < 0)) {
        this.setMotion(a, p.x, p.z, v.vx - 2 * radial * nx, v.vz - 2 * radial * nz);
      }
    });
    if (this.state.asteroids.size < SECTOR.asteroidCount && Math.random() < 0.2) this.spawnRandomAsteroid();
  }

  // ------------------------------------------------------------------ main tick
  tick(dt: number) {
    this.state.time += dt;
    const t = this.time;

    // docked ships sit on their port
    this.state.players.forEach((p) => {
      if (p.port >= 0) {
        const pp = this.portPos(p.port);
        p.x = pp.x; p.z = pp.z;
      }
    });

    // player drills (targets are validated against server positions)
    this.state.players.forEach((p, sid) => {
      if (!p.drilling || !p.target || p.port >= 0) return;
      const a = this.state.asteroids.get(p.target);
      if (!a) return;
      const ap = asteroidPosAt(a, t);
      if (Math.hypot(ap.x - p.x, ap.z - p.z) - a.r > this.stats.drillRange + DRILL.rangeSlack) return;
      this.damage(p.target, DRILL.dps * this.stats.drillMul * dt, { player: sid });
    });

    // miners
    this.state.miners.forEach((m, id) => {
      const rt = this.minerRt.get(id)!;
      rt.age += dt;
      const full = m.stored >= MINER.capacity;
      let target = m.target ? this.state.asteroids.get(m.target) : undefined;
      if (!target) m.target = "";
      if (full) m.target = "";
      if (!full && rt.age > 1.2 && !m.target) {
        let bd = Infinity;
        this.state.asteroids.forEach((a, aid) => {
          const ap = asteroidPosAt(a, t);
          const d = Math.hypot(ap.x - m.x, ap.z - m.z) - a.r;
          if (d < MINER.range && d < bd) { bd = d; m.target = aid; }
        });
        target = m.target ? this.state.asteroids.get(m.target) : undefined;
        rt.aim = 0;
      }
      m.status = MINER_IDX(rt.age < 1.2 ? "deploying" : full ? "full" : m.target ? "mining" : "idle");
      if (target && m.target) {
        rt.aim += dt;
        if (rt.aim > 0.6) this.damage(m.target, MINER.dps * dt, { miner: id }); // turret swings first
      }
    });

    this.updateDrones(dt);
    this.updateAsteroids();
    this.updateOre(dt);
  }

  private updateOre(dt: number) {
    const remove: string[] = [];
    this.state.ore.forEach((o, id) => {
      const rt = this.ore.get(id);
      if (!rt) { remove.push(id); return; }
      rt.age += dt;
      if (rt.age > ORE.lifetime) { remove.push(id); return; }
      // nearest flying ship with free cargo pulls the crystal in
      let best: PlayerState | null = null;
      let bd = this.stats.pickupRange;
      this.state.players.forEach((p) => {
        if (p.port >= 0 || p.cargo >= this.stats.capacity) return;
        const d = Math.hypot(p.x - o.x, p.z - o.z);
        if (d < bd) { bd = d; best = p; }
      });
      const ship = best as PlayerState | null;
      if (ship && bd < ORE.collectRange) {
        ship.cargo++;
        remove.push(id);
        return;
      }
      if (ship && rt.age > 0.4) {
        const pull = (ORE.magnetPull / (bd + 0.5)) * dt;
        rt.vx += ((ship.x - o.x) / bd) * pull;
        rt.vz += ((ship.z - o.z) / bd) * pull;
        rt.vx *= Math.exp(-2.5 * dt);
        rt.vz *= Math.exp(-2.5 * dt);
      } else {
        rt.vx *= Math.exp(-1.2 * dt);
        rt.vz *= Math.exp(-1.2 * dt);
      }
      if (Math.abs(rt.vx) + Math.abs(rt.vz) > 0.02) { // resting crystals produce no patches
        o.x += rt.vx * dt;
        o.z += rt.vz * dt;
      }
    });
    for (const id of remove) { this.state.ore.delete(id); this.ore.delete(id); }
  }
}
