// Smoke test for CI: start the PRODUCTION server (serving dist/) on a spare port with a
// throwaway save dir, check /health and the client page, join the game room with the
// real SDK and check the sector is populated, then shut the server down and check that
// it wrote its world save. Exit code 0 = pass.
import { Client } from "@colyseus/sdk";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SectorState } from "../shared/schema";

const port = 28000 + Math.floor(Math.random() * 1000);
const dataDir = mkdtempSync(join(tmpdir(), "space-miner-smoke-"));
const server = Bun.spawn(["bun", "server/index.ts"], {
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATA_DIR: dataDir },
  stdout: "inherit",
  stderr: "inherit",
});
const fail = (msg: string): never => {
  console.error(`SMOKE FAIL: ${msg}`);
  server.kill();
  process.exit(1);
};
const base = `http://localhost:${port}`;

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await Bun.sleep(200);
    up = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
  }
  if (!up) fail("/health never answered");

  const page = await fetch(`${base}/`).then((r) => r.text());
  if (!page.includes('<div id="login">')) fail("index.html is not the game client");
  if (!(await fetch(`${base}/models/ship.glb`)).ok) fail("models are not served");
  if (!(await fetch(`${base}/sounds/laser_loop.wav`)).ok) fail("sounds are not served");

  const room = await new Client(`ws://localhost:${port}`).joinOrCreate("sector", { name: "Smoke", token: "smoketest0001" }, SectorState);
  for (const t of ["toast", "built", "boom", "snap"]) room.onMessage(t, () => {});
  await Bun.sleep(600);
  if (room.state.asteroids.size < 100) fail(`sector has only ${room.state.asteroids.size} asteroids`);
  if (!room.state.players.get(room.sessionId)) fail("joined but not in the player list");
  console.log(`smoke: joined, ${room.state.asteroids.size} asteroids, server time ${room.state.time.toFixed(1)} s`);
  await room.leave();

  await Bun.sleep(500); // room empties -> disposes -> writes the save
  server.kill("SIGTERM");
  await server.exited;
  if (!existsSync(join(dataDir, "world.json"))) fail("no world.json written");
  console.log("smoke: ok");
} finally {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
