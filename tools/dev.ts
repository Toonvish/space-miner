// Runs the game server (with --watch) and the Vite client dev server together.
const procs = [
  Bun.spawn(["bun", "--watch", "server/index.ts"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--bun", "vite"], { stdout: "inherit", stderr: "inherit" }),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(procs.map((p) => p.exited));
stop();
