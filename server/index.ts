import { Server } from "@colyseus/core";
import { BunWebSockets } from "@colyseus/bun-websockets";
import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NET } from "../shared/config";
import { SectorRoom } from "./SectorRoom";

const port = Number(process.env.PORT ?? NET.port);
const distDir = resolve(process.env.CLIENT_DIR ?? "dist");
// in production the same process serves the built client, so everything runs on one port
const serveClient = process.env.NODE_ENV === "production" && existsSync(distDir);

const server = new Server({
  transport: new BunWebSockets(),
  greet: false,
  express: (app) => {
    app.get("/health", (_req, res) => { res.json({ ok: true }); });
    if (serveClient) {
      app.use(express.static(distDir, { maxAge: "1h", index: "index.html" }));
    }
  },
});
server.define("sector", SectorRoom);
await server.listen(port);
console.log(`[server] listening on :${port}${serveClient ? ` (serving client from ${distDir})` : ""}`);
