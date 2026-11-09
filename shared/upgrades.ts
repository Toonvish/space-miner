export type ModuleId = "cargo" | "drill" | "range" | "fuel" | "tractor" | "ports" | "drones";

export interface ModuleDef {
  id: ModuleId;
  name: string;
  piece: string; // node name in station.glb
  angle: number; // arm direction around the station (radians, 0 = +X / east)
  stat: string;
  format: (v: number) => string;
  values: number[]; // stat value per level; index 0 = no module built
  costs: number[]; // ore cost to build level i+1
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
    values: [0, 1, 2, 3, 4, 5], // each bay houses one drone that ferries ore from miners
    costs: [60, 90, 130, 180, 240],
  },
};

export const MODULE_ORDER: ModuleId[] = ["cargo", "drill", "range", "fuel", "tractor", "ports", "drones"];

/** Automatic miners: bought with stored ore, carried by the ship, deployed in space. */
export const MINER = {
  baseCost: 100,
  costGrowth: 1.6, // each further miner costs 60 % more
  maxOwned: 6,
  capacity: 60, // ore a miner can hold before it stops
  range: 16, // how far it reaches for asteroids
  dps: 9, // drill damage per second (player drill base: 24)
  collectRange: 5, // how close the ship must be to collect / pack up
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

export const maxLevel = (id: ModuleId) => MODULES[id].costs.length;
export const nextCost = (levels: LevelSource, id: ModuleId) =>
  levelOf(levels, id) < maxLevel(id) ? MODULES[id].costs[levelOf(levels, id)] : Infinity;
