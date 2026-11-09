import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Everything that survives a server restart. Asteroids and ore pickups are regenerated. */
export interface WorldSave {
  version: 1;
  station: { levels: Record<string, number>; stored: number; minersBought: number };
  miners: { x: number; z: number; stored: number; owner: string }[];
  players: Record<string, PlayerSave>; // keyed by the client's secret token
  droneCargo: number; // ore in flight when the server stopped; returned to the station on load
}

export interface PlayerSave {
  name: string;
  color?: number; // preferred PILOT_COLORS index
  cargo: number;
  minerStock: number;
  x: number;
  z: number;
}

const DATA_DIR = process.env.DATA_DIR ?? "server-data";
const FILE = join(DATA_DIR, "world.json");

export function emptySave(): WorldSave {
  return {
    version: 1,
    station: { levels: {}, stored: 0, minersBought: 0 },
    miners: [],
    players: {},
    droneCargo: 0,
  };
}

export async function loadWorld(): Promise<WorldSave> {
  try {
    const f = Bun.file(FILE);
    if (!(await f.exists())) return emptySave();
    const d = (await f.json()) as Partial<WorldSave>;
    return { ...emptySave(), ...d, version: 1 };
  } catch (e) {
    console.error("[save] could not read world, starting fresh:", e);
    return emptySave();
  }
}

let writing: Promise<void> = Promise.resolve();

/** Atomic write (temp file + rename); writes are serialised. */
export function saveWorld(save: WorldSave): Promise<void> {
  const json = JSON.stringify(save, null, 1);
  writing = writing.then(async () => {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      const tmp = FILE + ".tmp";
      await writeFile(tmp, json);
      await rename(tmp, FILE);
    } catch (e) {
      console.error("[save] failed:", e);
    }
  });
  return writing;
}
