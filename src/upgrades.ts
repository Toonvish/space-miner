export type ModuleId = "cargo" | "drill" | "range" | "fuel" | "tractor";

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
};

export const MODULE_ORDER: ModuleId[] = ["cargo", "drill", "range", "fuel", "tractor"];

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

export const minerCost = (s: GameState) => Math.round(MINER.baseCost * MINER.costGrowth ** s.minersBought);
export const minersOwned = (s: GameState) => s.minerStock + s.miners.length;

export interface MinerSave {
  x: number;
  z: number;
  stored: number;
}

export interface GameState {
  levels: Record<ModuleId, number>;
  stored: number; // ore in the station (currency)
  cargo: number; // ore in the ship's hold
  minerStock: number; // miners carried by the ship, ready to deploy
  minersBought: number; // drives the price of the next miner
  miners: MinerSave[]; // deployed miners
}

export interface ShipStats {
  capacity: number;
  drillMul: number;
  drillRange: number;
  boostMax: number;
  pickupRange: number;
}

export function stats(s: GameState): ShipStats {
  return {
    capacity: MODULES.cargo.values[s.levels.cargo],
    drillMul: MODULES.drill.values[s.levels.drill],
    drillRange: MODULES.range.values[s.levels.range],
    boostMax: MODULES.fuel.values[s.levels.fuel],
    pickupRange: MODULES.tractor.values[s.levels.tractor],
  };
}

export const maxLevel = (id: ModuleId) => MODULES[id].costs.length;
export const nextCost = (s: GameState, id: ModuleId) =>
  s.levels[id] < maxLevel(id) ? MODULES[id].costs[s.levels[id]] : Infinity;

// ---------------------------------------------------------------- persistence
const SAVE_KEY = "space-miner-save-v1";

export function newState(): GameState {
  return {
    levels: { cargo: 0, drill: 0, range: 0, fuel: 0, tractor: 0 },
    stored: 0, cargo: 0, minerStock: 0, minersBought: 0, miners: [],
  };
}

export function loadState(): GameState {
  const s = newState();
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return s;
    const d = JSON.parse(raw);
    for (const id of MODULE_ORDER) {
      const v = Number(d?.levels?.[id]);
      if (Number.isInteger(v)) s.levels[id] = Math.max(0, Math.min(maxLevel(id), v));
    }
    s.stored = Math.max(0, Number(d?.stored) || 0);
    s.cargo = Math.max(0, Number(d?.cargo) || 0);
    s.minerStock = Math.max(0, Math.floor(Number(d?.minerStock) || 0));
    s.minersBought = Math.max(0, Math.floor(Number(d?.minersBought) || 0));
    if (Array.isArray(d?.miners)) {
      for (const m of d.miners) {
        const x = Number(m?.x), z = Number(m?.z);
        if (Number.isFinite(x) && Number.isFinite(z)) {
          s.miners.push({ x, z, stored: Math.max(0, Math.min(MINER.capacity, Number(m?.stored) || 0)) });
        }
      }
    }
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return s;
}

export function saveState(s: GameState) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
  } catch {
    /* ignore (private mode etc.) */
  }
}
