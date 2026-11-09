import type { Asteroid } from "./asteroids";
import type { Miner } from "./miners";
import { MINER } from "../shared/upgrades";

export interface RadarExtras {
  pilots: { x: number; z: number; hue: number }[];
  drones: { x: number; z: number }[];
  sectorRadius: number;
}

export const RADAR = {
  range: 90, // world units from the ship to the radar edge
  size: 190, // css pixels
};

interface Blip {
  x: number;
  z: number;
}

/** North-up circular radar drawn on a 2D canvas overlay. */
export class Radar {
  readonly canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.min(devicePixelRatio, 2);

  constructor(parent: HTMLElement) {
    const s = RADAR.size;
    this.canvas.id = "radar";
    this.canvas.width = s * this.dpr;
    this.canvas.height = s * this.dpr;
    this.canvas.style.width = this.canvas.style.height = `${s}px`;
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
  }

  draw(
    ship: { x: number; z: number; heading: number },
    asteroids: Asteroid[], ore: Blip[], target: Asteroid | null,
    drillRange: number, time: number, station: Blip, miners: Miner[] = [],
    extras: RadarExtras = { pilots: [], drones: [], sectorRadius: 0 },
  ) {
    const g = this.ctx;
    const s = RADAR.size;
    const R = s / 2 - 4;
    const k = R / RADAR.range;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, s, s);
    g.save();
    g.translate(s / 2, s / 2);

    // body
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    const bg = g.createRadialGradient(0, 0, 0, 0, 0, R);
    bg.addColorStop(0, "rgba(14, 40, 52, 0.78)");
    bg.addColorStop(1, "rgba(4, 12, 20, 0.88)");
    g.fillStyle = bg;
    g.fill();
    g.clip();

    // grid rings + cross
    g.strokeStyle = "rgba(120, 220, 255, 0.14)";
    g.lineWidth = 1;
    for (const f of [1 / 3, 2 / 3]) {
      g.beginPath();
      g.arc(0, 0, R * f, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(-R, 0); g.lineTo(R, 0);
    g.moveTo(0, -R); g.lineTo(0, R);
    g.stroke();

    // sweep with fading wedge
    const sweep = (time * 1.6) % (Math.PI * 2);
    for (let i = 0; i < 12; i++) {
      const a0 = sweep - (i + 1) * 0.06;
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, R, a0, a0 + 0.06);
      g.closePath();
      g.fillStyle = `rgba(110, 230, 255, ${0.16 * (1 - i / 12)})`;
      g.fill();
    }

    // drill range
    g.setLineDash([3, 3]);
    g.strokeStyle = "rgba(255, 140, 60, 0.45)";
    g.beginPath();
    g.arc(0, 0, drillRange * k, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);

    // asteroids
    for (const a of asteroids) {
      const x = (a.pos.x - ship.x) * k;
      const y = (a.pos.z - ship.z) * k;
      if (x * x + y * y > (R + 4) ** 2) continue;
      const r = Math.max(1.6, a.radius * k);
      const dmg = 1 - a.hp / a.maxHp;
      g.fillStyle = dmg > 0.01 ? `rgb(${200 + 55 * dmg}, ${190 - 60 * dmg}, ${170 - 100 * dmg})` : "rgba(200, 192, 176, 0.9)";
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      if (a === target) {
        g.strokeStyle = "#ff8a3a";
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(x, y, r + 3, 0, Math.PI * 2);
        g.stroke();
        g.lineWidth = 1;
      }
    }

    // ore
    g.fillStyle = "#ffc04a";
    for (const o of ore) {
      const x = (o.x - ship.x) * k;
      const y = (o.z - ship.z) * k;
      if (x * x + y * y > R * R) continue;
      g.fillRect(x - 1, y - 1, 2, 2);
    }

    // miners: diamonds coloured by status, with a fill bar
    for (const m of miners) {
      const x = (m.pos.x - ship.x) * k;
      const y = (m.pos.z - ship.z) * k;
      if (x * x + y * y > (R - 4) ** 2) continue;
      const col = m.state === "full" ? "#ff5a4a" : m.state === "idle" ? "#ffd23a" : "#6aff8e";
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(x, y - 4.5); g.lineTo(x + 4.5, y); g.lineTo(x, y + 4.5); g.lineTo(x - 4.5, y);
      g.closePath();
      g.fill();
      g.fillStyle = "rgba(255,255,255,0.25)";
      g.fillRect(x - 5, y + 6, 10, 2);
      g.fillStyle = col;
      g.fillRect(x - 5, y + 6, 10 * Math.min(1, m.stored / MINER.capacity), 2);
    }

    // sector boundary
    if (extras.sectorRadius > 0) {
      const bx = (0 - ship.x) * k, by = (0 - ship.z) * k;
      g.strokeStyle = "rgba(255, 90, 74, 0.5)";
      g.setLineDash([2, 4]);
      g.beginPath();
      g.arc(bx, by, extras.sectorRadius * k, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }

    // cargo drones: small white dots
    g.fillStyle = "#e8eef5";
    for (const d of extras.drones) {
      const x = (d.x - ship.x) * k, y = (d.z - ship.z) * k;
      if (x * x + y * y < R * R) g.fillRect(x - 1.5, y - 1.5, 3, 3);
    }

    // other pilots: coloured triangles
    for (const o of extras.pilots) {
      const x = (o.x - ship.x) * k, y = (o.z - ship.z) * k;
      if (x * x + y * y > (R - 3) ** 2) continue;
      g.fillStyle = `hsl(${o.hue}, 90%, 65%)`;
      g.beginPath();
      g.moveTo(x, y - 4); g.lineTo(x + 3.5, y + 3); g.lineTo(x - 3.5, y + 3);
      g.closePath();
      g.fill();
    }

    // home station: square icon, pinned to the rim with an arrow when out of range
    {
      let x = (station.x - ship.x) * k;
      let y = (station.z - ship.z) * k;
      const d = Math.hypot(x, y);
      g.strokeStyle = "#7fffd8";
      g.fillStyle = "rgba(127, 255, 216, 0.25)";
      g.lineWidth = 1.5;
      if (d > R - 8) {
        const a = Math.atan2(y, x);
        x = Math.cos(a) * (R - 8);
        y = Math.sin(a) * (R - 8);
        g.save();
        g.translate(x, y);
        g.rotate(a);
        g.beginPath();
        g.moveTo(6, 0); g.lineTo(-3, -4.5); g.lineTo(-3, 4.5);
        g.closePath();
        g.fillStyle = "#7fffd8";
        g.fill();
        g.restore();
      } else {
        g.fillRect(x - 5, y - 5, 10, 10);
        g.strokeRect(x - 5, y - 5, 10, 10);
      }
      g.lineWidth = 1;
    }

    // player (forward = (-sin h, -cos h) in x/z)
    g.rotate(-ship.heading);
    g.fillStyle = "#7fe9ff";
    g.beginPath();
    g.moveTo(0, -6);
    g.lineTo(4.5, 5);
    g.lineTo(0, 3);
    g.lineTo(-4.5, 5);
    g.closePath();
    g.fill();
    g.restore();

    // rim + north marker
    g.save();
    g.translate(s / 2, s / 2);
    g.strokeStyle = "rgba(127, 233, 255, 0.55)";
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = "rgba(127, 233, 255, 0.8)";
    g.font = "600 9px ui-monospace, monospace";
    g.textAlign = "center";
    g.fillText("N", 0, -R + 11);
    g.restore();
  }
}
