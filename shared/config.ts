/**
 * Gameplay constants shared by the client and the authoritative server.
 * Coordinates: the play plane is XZ (y up). The home station sits at the origin.
 */

export const NET = {
  port: 2567, // dev game-server port (prod serves client + server on PORT)
  tickMs: 50, // server simulation + patch rate (20 Hz)
  sendMs: 50, // client -> server ship updates (20 Hz)
  interpDelay: 0.12, // remote entities are rendered this many seconds in the past
};

export const SECTOR = {
  radius: 300, // soft boundary of the shared sector
  asteroidCount: 220,
  clearRadius: 34, // no asteroids around the station
  spawnAwayFromPlayers: 45, // respawned rocks never pop in next to someone
};

export const ASTEROID = {
  minRadius: 0.9,
  maxRadius: 4.5,
  splitRadius: 1.8, // bigger than this splits into fragments
  hpPerArea: 8, // hp = hpPerArea * r²
  drag: 0.05, // velocity decay per second (closed-form, see asteroidPosAt)
};

export const DRILL = {
  dps: 24, // base damage per second (Laser Lab multiplies it)
  rangeSlack: 2.5, // server tolerance when validating a client's drill target
};

export const ORE = {
  magnetPull: 40,
  collectRange: 1.1,
  lifetime: 40,
};

export const SHIP = {
  radius: 1.3,
  maxPlausibleSpeed: 40, // server rejects position jumps faster than this
};

export const STATION = {
  depth: -3, // below the flight plane; ships fly over it
  socketRadius: 3.9, // where the first module piece attaches
  moduleLength: 3.6, // one truss + pod piece
  podOffset: 2.5, // pod centre along a piece
  dockRadius: 5, // must be this close to a free port to dock
  dockMaxSpeed: 6,
};

export const DRONE = {
  speed: 13,
  accel: 18,
  turnRate: 4,
  capacity: 40, // ore per trip
  laserRange: 5, // standoff from the rock surface while mining
  unloadTime: 1.5,
};

/** Asteroid position at server time t (velocity decays exponentially, closed form). */
export function asteroidPosAt(
  a: { x0: number; z0: number; vx: number; vz: number; t0: number }, t: number,
): { x: number; z: number } {
  const dt = Math.max(0, t - a.t0);
  const k = (1 - Math.exp(-ASTEROID.drag * dt)) / ASTEROID.drag;
  return { x: a.x0 + a.vx * k, z: a.z0 + a.vz * k };
}

export function asteroidVelAt(a: { vx: number; vz: number; t0: number }, t: number) {
  const f = Math.exp(-ASTEROID.drag * Math.max(0, t - a.t0));
  return { vx: a.vx * f, vz: a.vz * f };
}

/** Deterministic 32-bit hash for cosmetic per-entity randomness (spin, variant, ...). */
export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Position of the n-th piece's pod along a station arm (station-local XZ, y ignored). */
export function armPodPos(angle: number, index: number): { x: number; z: number } {
  const r = STATION.socketRadius + index * STATION.moduleLength + STATION.podOffset;
  // Blender +X arm direction maps to (cos a, 0, -sin a) in three.js
  return { x: Math.cos(angle) * r, z: -Math.sin(angle) * r };
}

/**
 * Pilot highlight colours (ship trim, name tag, radar marker). Every connected pilot
 * holds a different one, so the room is capped at this many pilots.
 */
export const PILOT_COLORS = [
  { name: "Signal Orange", hex: "#ff7a1a" },
  { name: "Cobalt", hex: "#2f7bff" },
  { name: "Viridian", hex: "#22d17a" },
  { name: "Crimson", hex: "#e8243c" },
  { name: "Solar Yellow", hex: "#ffd21f" },
  { name: "Ion Cyan", hex: "#1fe0e8" },
  { name: "Violet", hex: "#9b4dff" },
  { name: "Magenta", hex: "#ff3fb4" },
  { name: "Lime", hex: "#a6f02a" },
  { name: "Arctic White", hex: "#e8eef5" },
  { name: "Copper", hex: "#c8743a" },
  { name: "Rose Gold", hex: "#f2a7a0" },
] as const;
