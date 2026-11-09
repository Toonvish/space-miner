export type ModuleId =
  | "cargo" | "drill" | "range" | "fuel" | "tractor" | "ports" | "drones" // station modules (arms)
  | "minerReach" | "minerSpeed" | "droneReach" | "droneSpeed"; // fleet research (no station piece)

export interface ModuleDef {
  id: ModuleId;
  name: string;
  piece: string; // node name in station.glb ("" = research, no visual piece)
  angle: number; // arm direction around the station (radians, 0 = +X / east)
  stat: string;
  format: (v: number) => string;
  values: number[]; // stat value per level; index 0 = no module built
  costs: number[]; // ore cost to build level i+1
  requires?: Partial<Record<ModuleId, number>>; // minimum levels of other upgrades to unlock
}

/** Upgrade tables. Level 0 is the starting ship; each built module adds one level. */
export const MODULES: Record<ModuleId, ModuleDef> = {
  cargo: {
    id: "cargo", name: "Cargo Bay", piece: "CargoModule", angle: 0,
    stat: "Cargo capacity", format: (v) => `${v}`,
    values: [20, 35, 55, 80, 120, 170],
    costs: [12, 25, 45, 75, 120],
  },
  drill: {
    id: "drill", name: "Laser Lab", piece: "DrillModule", angle: Math.PI / 2,
    stat: "Drill strength", format: (v) => `×${v.toFixed(2)}`,
    values: [1, 1.35, 1.75, 2.25, 2.9, 3.7],
    costs: [15, 30, 55, 90, 140],
  },
  range: {
    id: "range", name: "Beam Optics", piece: "RangeModule", angle: Math.PI / 4,
    stat: "Drill range", format: (v) => `${v.toFixed(1)} m`,
    values: [11, 13.5, 16, 19, 22.5, 26],
    costs: [15, 30, 55, 90, 140],
  },
  fuel: {
    id: "fuel", name: "Fuel Depot", piece: "FuelModule", angle: Math.PI,
    stat: "Boost duration", format: (v) => `${v.toFixed(1)} s`,
    values: [2, 3.5, 5, 7, 9.5, 13],
    costs: [10, 22, 40, 70, 110],
  },
  tractor: {
    id: "tractor", name: "Tractor Array", piece: "TractorModule", angle: -Math.PI / 2,
    stat: "Pickup range", format: (v) => `${v.toFixed(1)} m`,
    values: [6, 9, 12.5, 16.5, 21, 26],
    costs: [10, 22, 40, 70, 110],
  },
  ports: {
    id: "ports", name: "Docking Port", piece: "PortModule", angle: (3 * Math.PI) / 4,
    stat: "Docking ports", format: (v) => `${v}`,
    values: [1, 2, 3, 4, 5, 6], // port 0 is the core landing pad; each module adds a pad
    costs: [20, 40, 70, 110, 160],
  },
  drones: {
    id: "drones", name: "Drone Bay", piece: "DroneBayModule", angle: (-3 * Math.PI) / 4,
    stat: "Cargo drones", format: (v) => `${v}`,
    values: [0, 1, 2, 3, 4, 5], // each bay houses one autonomous mining drone
    costs: [150, 220, 320, 450, 600],
    requires: { ports: 1, drill: 2, cargo: 2 }, // late game: needs a spare port and a developed station
  },
  minerReach: {
    id: "minerReach", name: "Miner Survey Arrays", piece: "", angle: 0,
    stat: "Miner work radius", format: (v) => `${v} m`,
    values: [12, 16, 20, 25, 30, 36],
    costs: [20, 40, 70, 110, 160],
  },
  minerSpeed: {
    id: "minerSpeed", name: "Miner Cutting Lasers", piece: "", angle: 0,
    stat: "Miner mining speed", format: (v) => `${v} dmg/s`,
    values: [12, 16, 21, 27, 34, 42],
    costs: [25, 45, 75, 115, 170],
  },
  droneReach: {
    id: "droneReach", name: "Drone Navigation Suite", piece: "", angle: 0,
    stat: "Drone roaming range", format: (v) => `${v} m`,
    values: [80, 110, 140, 180, 230, 290],
    costs: [80, 130, 190, 260, 340],
    requires: { drones: 1 },
  },
  droneSpeed: {
    id: "droneSpeed", name: "Drone Mining Lasers", piece: "", angle: 0,
    stat: "Drone mining speed", format: (v) => `${v} dmg/s`,
    values: [10, 14, 19, 25, 32, 40],
    costs: [80, 130, 190, 260, 340],
    requires: { drones: 1 },
  },
};

/** Station modules (shown in the modules tab, keys 1-7, each adds a station piece). */
export const MODULE_ORDER: ModuleId[] = ["cargo", "drill", "range", "fuel", "tractor", "ports", "drones"];
/** Fleet research (shown in the Miners & Drones tab). */
export const RESEARCH_ORDER: ModuleId[] = ["minerReach", "minerSpeed", "droneReach", "droneSpeed"];
export const ALL_UPGRADES: ModuleId[] = [...MODULE_ORDER, ...RESEARCH_ORDER];

/** Automatic miners: bought with stored ore, carried by the ship, deployed in space. */
export const MINER = {
  baseCost: 80,
  costGrowth: 1.5, // each further miner costs 50 % more
  maxOwned: 6,
  capacity: 100, // ore a miner can hold before it stops
  laserRange: 5, // how close (to the rock surface) a miner hovers while cutting
  speed: 6, // hover speed inside its work zone
  collectRange: 5, // how close the ship must be to collect / pack up
  refillDelay: 6, // seconds a zone must sit empty before a new rock drifts in
  refillOffset: 8, // new rocks appear this far outside the ring
  refillBudget: 40, // extra rocks allowed above the sector's normal asteroid count
};

export const minerCost = (minersBought: number) => Math.round(MINER.baseCost * MINER.costGrowth ** minersBought);

/** Anything that can report module levels (plain object or synced Colyseus map). */
export interface LevelSource {
  get(id: string): number | undefined;
}
export const levelOf = (levels: LevelSource, id: ModuleId) => levels.get(id) ?? 0;

export interface ShipStats {
  capacity: number;
  drillMul: number;
  drillRange: number;
  boostMax: number;
  pickupRange: number;
  ports: number;
  drones: number;
}

/** Co-op: station modules apply to every ship. */
export function stats(levels: LevelSource): ShipStats {
  const v = (id: ModuleId) => MODULES[id].values[levelOf(levels, id)];
  return {
    capacity: v("cargo"),
    drillMul: v("drill"),
    drillRange: v("range"),
    boostMax: v("fuel"),
    pickupRange: v("tractor"),
    ports: v("ports"),
    drones: v("drones"),
  };
}

/** Fleet research applies to every miner and drone. */
export function fleetStats(levels: LevelSource) {
  const v = (id: ModuleId) => MODULES[id].values[levelOf(levels, id)];
  return { minerRadius: v("minerReach"), minerDps: v("minerSpeed"), droneReach: v("droneReach"), droneDps: v("droneSpeed") };
}

/** Unmet unlock requirements, e.g. ["Docking Port MK 1"]; empty = unlocked. */
export function missingRequirements(levels: LevelSource, id: ModuleId): string[] {
  const req = MODULES[id].requires ?? {};
  return Object.entries(req)
    .filter(([rid, lvl]) => levelOf(levels, rid as ModuleId) < (lvl ?? 0))
    .map(([rid, lvl]) => `${MODULES[rid as ModuleId].name} MK ${lvl}`);
}

export const maxLevel = (id: ModuleId) => MODULES[id].costs.length;
export const nextCost = (levels: LevelSource, id: ModuleId) =>
  levelOf(levels, id) < maxLevel(id) ? MODULES[id].costs[levelOf(levels, id)] : Infinity;
