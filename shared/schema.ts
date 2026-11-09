import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * Synchronised sector state (server -> clients, delta-encoded by Colyseus).
 * Keep it lean: anything that can be derived on the client (asteroid drift, spin,
 * turret aim, effects) is not synced.
 */

export const PlayerState = schema({
  name: t.string().default(""),
  color: t.uint8().default(0), // index into PILOT_COLORS, unique per connected pilot
  x: t.float32().default(0),
  z: t.float32().default(0),
  h: t.float32().default(0), // heading (radians)
  vx: t.float32().default(0),
  vz: t.float32().default(0),
  throttle: t.float32().default(0),
  boost: t.boolean().default(false),
  drilling: t.boolean().default(false),
  target: t.string().default(""), // asteroid id being drilled ("" = none)
  cargo: t.uint16().default(0),
  minerStock: t.uint8().default(0),
  port: t.int8().default(-1), // docking port index, -1 = flying
}, "PlayerState");
export type PlayerState = SchemaType<typeof PlayerState>;

export const AsteroidState = schema({
  // motion is extrapolated on clients from (x0, z0, vx, vz, t0); see asteroidPosAt()
  x0: t.float32().default(0),
  z0: t.float32().default(0),
  vx: t.float32().default(0),
  vz: t.float32().default(0),
  t0: t.float64().default(0),
  r: t.float32().default(0),
  hp: t.float32().default(0),
  maxHp: t.float32().default(0),
}, "AsteroidState");
export type AsteroidState = SchemaType<typeof AsteroidState>;

export const OreState = schema({
  x: t.float32().default(0),
  z: t.float32().default(0),
}, "OreState");
export type OreState = SchemaType<typeof OreState>;

export const MINER_STATUS = ["deploying", "mining", "idle", "full", "moving"] as const;
export type MinerStatus = (typeof MINER_STATUS)[number];

export const MinerState = schema({
  x: t.float32().default(0), // current (hovering) position
  z: t.float32().default(0),
  ax: t.float32().default(0), // anchor: centre of the circular work zone
  az: t.float32().default(0),
  stored: t.float32().default(0),
  status: t.uint8().default(0), // index into MINER_STATUS
  target: t.string().default(""), // asteroid id
  owner: t.string().default(""), // name of the player who deployed it
}, "MinerState");
export type MinerState = SchemaType<typeof MinerState>;

export const DRONE_STATUS = ["parked", "outbound", "mining", "returning", "waiting", "unloading"] as const;
export type DroneStatus = (typeof DRONE_STATUS)[number];

export const DroneState = schema({
  x: t.float32().default(0),
  z: t.float32().default(0),
  h: t.float32().default(0),
  speed: t.float32().default(0),
  status: t.uint8().default(0), // index into DRONE_STATUS
  cargo: t.float32().default(0),
  port: t.int8().default(-1),
  target: t.string().default(""), // asteroid id it is flying to / mining
}, "DroneState");
export type DroneState = SchemaType<typeof DroneState>;

export const StationState = schema({
  levels: t.map("uint8"),
  stored: t.float32().default(0),
  minersBought: t.uint8().default(0),
  // occupant per docking port: "" free, "p:<sessionId>" player, "d:<droneId>" drone
  ports: t.array("string"),
}, "StationState");
export type StationState = SchemaType<typeof StationState>;

export const SectorState = schema({
  time: t.float64().default(0), // server clock in seconds
  station: StationState,
  players: t.map(PlayerState),
  asteroids: t.map(AsteroidState),
  ore: t.map(OreState),
  miners: t.map(MinerState),
  drones: t.map(DroneState),
}, "SectorState");
export type SectorState = SchemaType<typeof SectorState>;

/** Messages exchanged besides state sync. */
export interface MoveMsg {
  x: number; z: number; h: number; vx: number; vz: number;
  th: number; b: boolean; d: boolean; tg: string;
}
export interface BoomMsg { x: number; z: number; r: number; vx: number; vz: number; by: string }
export interface ToastMsg { text: string }
export interface BuiltMsg { module: string; level: number; by: string }
export interface SnapMsg { x: number; z: number; vx: number; vz: number }
