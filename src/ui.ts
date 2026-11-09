import * as THREE from "three";
import { DRONE } from "../shared/config";
import { DRONE_STATUS, MINER_STATUS, type SectorState } from "../shared/schema";
import {
  MINER, MODULES, MODULE_ORDER, levelOf, maxLevel, minerCost, nextCost, stats, type ModuleId,
} from "../shared/upgrades";
import type { ShipTemplate } from "./ship";

/** Flavour + help text for the station terminal. */
const INFO: Record<ModuleId, { tag: string; desc: string }> = {
  cargo: { tag: "LOGISTICS", desc: "Pressurised container racks bolted onto the east truss. Every pilot's hold grows with each bay." },
  drill: { tag: "INDUSTRY", desc: "Laser research lab. Tunes the frequency of every mining laser in the fleet for faster rock breakup." },
  range: { tag: "INDUSTRY", desc: "Focusing mirror arrays. Collimated beams reach rocks further away from the ship." },
  fuel: { tag: "PROPULSION", desc: "Cryogenic propellant depot. Larger boost tanks for every ship docked here." },
  tractor: { tag: "LOGISTICS", desc: "Tractor field emitters. Ore crystals are pulled in from further away." },
  ports: { tag: "INFRASTRUCTURE", desc: "Additional landing pad. Ships and cargo drones need a free port to dock and unload." },
  drones: { tag: "AUTOMATION", desc: `Hangar cradle with one autonomous cargo drone. Drones fly to miners holding ${DRONE.minPickup}+ ore, load up to ${DRONE.capacity}, and unload at a free docking port.` },
};

type Tab = "modules" | "fleet" | "ship";

export interface StationActions {
  build(id: ModuleId): void;
  buyMiner(): void;
  undock(): void;
}

/**
 * Full-screen station terminal (EVE/Starfield-inspired): top bar with station status,
 * left navigation, list + detail panes. Rendered from the synced sector state.
 */
export class StationMenu {
  readonly el = document.createElement("div");
  isOpen = false;
  private tab: Tab = "modules";
  private selected: ModuleId = "cargo";
  private note = "";
  private noteTimer = 0;
  private preview: ShipPreview | null = null;
  private lastRender = "";

  constructor(parent: HTMLElement, private actions: StationActions, private shipTemplate: ShipTemplate) {
    this.el.id = "station";
    this.el.innerHTML = `
      <div class="st-top">
        <div class="st-id"><div class="st-kicker">DOCKED · CO-OP HOME STATION</div><h1>MERIDIAN ANCHORAGE</h1></div>
        <div class="st-stat"><span>ORE STORED</span><b data-k="stored">0</b></div>
        <div class="st-stat"><span>PORTS</span><div class="st-ports" data-k="ports"></div></div>
        <div class="st-stat"><span>PILOTS</span><b data-k="pilots">0</b></div>
        <button class="st-undock" data-a="undock">UNDOCK <kbd>E</kbd></button>
      </div>
      <nav class="st-nav">
        <button data-tab="modules"><i>▣</i>Station<br>Modules</button>
        <button data-tab="fleet"><i>◈</i>Miners &amp;<br>Drones</button>
        <button data-tab="ship"><i>△</i>Ship<br>Fitting</button>
      </nav>
      <main class="st-main"></main>
      <div class="st-note"></div>`;
    this.el.addEventListener("mousedown", (e) => e.stopPropagation()); // mouse = drill in flight
    this.el.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tab],[data-sel],[data-a]");
      if (!t) return;
      if (t.dataset.tab) { this.tab = t.dataset.tab as Tab; this.lastRender = ""; }
      if (t.dataset.sel) { this.selected = t.dataset.sel as ModuleId; this.lastRender = ""; }
      if (t.dataset.a === "build") this.actions.build(this.selected);
      if (t.dataset.a === "buyMiner") this.actions.buyMiner();
      if (t.dataset.a === "undock") this.actions.undock();
    });
    parent.appendChild(this.el);
  }

  open() {
    this.isOpen = true;
    this.lastRender = "";
    this.el.classList.add("open");
  }

  close() {
    this.isOpen = false;
    this.el.classList.remove("open");
    this.preview?.dispose();
    this.preview = null;
  }

  flash(text: string) {
    this.note = text;
    this.noteTimer = 3;
  }

  /** Keyboard while docked: 1-7 select module, Enter build, Tab cycle tabs, M buy miner. */
  key(e: KeyboardEvent): boolean {
    if (/^Digit[1-7]$/.test(e.code)) {
      this.tab = "modules";
      this.selected = MODULE_ORDER[Number(e.code.slice(5)) - 1];
      this.lastRender = "";
      return true;
    }
    if (e.code === "Enter" && this.tab === "modules") { this.actions.build(this.selected); return true; }
    if (e.code === "KeyM") { this.actions.buyMiner(); return true; }
    if (e.code === "Tab") {
      const tabs: Tab[] = ["modules", "fleet", "ship"];
      this.tab = tabs[(tabs.indexOf(this.tab) + 1) % tabs.length];
      this.lastRender = "";
      return true;
    }
    return false;
  }

  update(dt: number, s: SectorState, selfId: string, shipPos: { x: number; z: number }) {
    if (!this.isOpen) return;
    this.noteTimer -= dt;
    const st = s.station;
    const q = (k: string) => this.el.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
    q("stored").textContent = Math.floor(st.stored).toLocaleString();
    q("pilots").textContent = String(s.players.size);
    q("ports").innerHTML = [...st.ports].map((o, i) =>
      `<i class="${o === "" ? "free" : o === `p:${selfId}` ? "me" : o.startsWith("d:") ? "drone" : "ship"}" title="Port ${i}"></i>`).join("");
    const note = this.el.querySelector<HTMLElement>(".st-note")!;
    note.textContent = this.note;
    note.classList.toggle("show", this.noteTimer > 0);
    this.el.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === this.tab));

    // re-render the main pane only when something relevant changed
    const levels = MODULE_ORDER.map((id) => levelOf(st.levels, id)).join(",");
    const me = s.players.get(selfId);
    let fleetSig = "";
    if (this.tab === "fleet") {
      s.miners.forEach((m, id) => (fleetSig += `${id}:${Math.floor(m.stored)}:${m.status};`));
      s.drones.forEach((d, id) => (fleetSig += `${id}:${d.status}:${Math.floor(d.cargo)};`));
    }
    const sig = `${this.tab}|${this.selected}|${levels}|${Math.floor(st.stored)}|${st.minersBought}|${me?.minerStock}|${fleetSig}`;
    if (sig !== this.lastRender) {
      this.lastRender = sig;
      const main = this.el.querySelector<HTMLElement>(".st-main")!;
      if (this.tab !== "ship") { this.preview?.dispose(); this.preview = null; }
      if (this.tab === "modules") main.innerHTML = this.renderModules(s);
      else if (this.tab === "fleet") main.innerHTML = this.renderFleet(s, selfId, shipPos);
      else {
        main.innerHTML = this.renderShip(s);
        if (!this.preview) this.preview = new ShipPreview(this.shipTemplate);
        main.querySelector(".st-preview")!.appendChild(this.preview.canvas);
      }
    }
    this.preview?.render(dt);
  }

  private renderModules(s: SectorState): string {
    const st = s.station;
    const rows = MODULE_ORDER.map((id, i) => {
      const lvl = levelOf(st.levels, id);
      const max = maxLevel(id);
      const pips = Array.from({ length: max }, (_, k) => `<i class="${k < lvl ? "on" : ""}"></i>`).join("");
      return `<button class="st-row ${id === this.selected ? "sel" : ""}" data-sel="${id}">
        <kbd>${i + 1}</kbd><span class="nm">${MODULES[id].name}<small>${INFO[id].tag}</small></span>
        <span class="pips">${pips}</span></button>`;
    }).join("");

    const id = this.selected;
    const def = MODULES[id];
    const lvl = levelOf(st.levels, id);
    const max = maxLevel(id);
    const cost = nextCost(st.levels, id);
    const table = def.values.map((v, k) =>
      `<tr class="${k === lvl ? "cur" : k === lvl + 1 ? "next" : ""}"><td>${k === 0 ? "BASE" : `MK ${k}`}</td>
        <td>${def.format(v)}</td><td>${k === 0 ? "—" : `${def.costs[k - 1]} ore`}</td></tr>`).join("");
    const canBuild = lvl < max && st.stored >= cost;
    const action = lvl >= max
      ? `<div class="st-max">FULLY UPGRADED</div>`
      : `<button class="st-build ${canBuild ? "" : "off"}" data-a="build">CONSTRUCT MK ${lvl + 1}
           <span>${cost} ore</span></button>
         ${canBuild ? "" : `<div class="st-short">Need ${Math.ceil(cost - st.stored)} more ore in the station</div>`}`;
    return `
      <section class="st-list"><header>STATION MODULES</header>${rows}</section>
      <section class="st-detail">
        <div class="st-kicker">${INFO[id].tag} · MK ${lvl} / ${max}</div>
        <h2>${def.name}</h2>
        <p>${INFO[id].desc}</p>
        <div class="st-bigstat"><span>${def.stat}</span>
          <b>${def.format(def.values[lvl])}</b>${lvl < max ? `<em>→ ${def.format(def.values[lvl + 1])}</em>` : ""}</div>
        <table class="st-table"><thead><tr><th>TIER</th><th>${def.stat.toUpperCase()}</th><th>COST</th></tr></thead>
          <tbody>${table}</tbody></table>
        ${action}
      </section>`;
  }

  private renderFleet(s: SectorState, selfId: string, shipPos: { x: number; z: number }): string {
    const st = s.station;
    const me = s.players.get(selfId);
    let carried = 0;
    s.players.forEach((p) => (carried += p.minerStock));
    const owned = carried + s.miners.size;
    const cost = minerCost(st.minersBought);
    const full = owned >= MINER.maxOwned;
    const canBuy = !full && st.stored >= cost;

    const miners: string[] = [];
    s.miners.forEach((m) => {
      const d = Math.hypot(m.x - shipPos.x, m.z - shipPos.z);
      const status = MINER_STATUS[m.status] ?? "idle";
      miners.push(`<tr><td>${m.owner}</td><td class="s-${status}">${status.toUpperCase()}</td>
        <td><span class="bar"><i style="width:${(m.stored / MINER.capacity) * 100}%"></i></span>${Math.floor(m.stored)}</td>
        <td>${d.toFixed(0)} m</td></tr>`);
    });
    const drones: string[] = [];
    let n = 1;
    s.drones.forEach((d) => {
      const status = DRONE_STATUS[d.status] ?? "parked";
      drones.push(`<tr><td>HAULER-${String(n++).padStart(2, "0")}</td><td class="d-${status}">${status.toUpperCase()}</td>
        <td><span class="bar"><i style="width:${(d.cargo / DRONE.capacity) * 100}%"></i></span>${Math.floor(d.cargo)}</td>
        <td>${d.port >= 0 ? `PORT ${d.port}` : "—"}</td></tr>`);
    });
    return `
      <section class="st-list">
        <header>AUTOMATED MINING</header>
        <div class="st-card">
          <div class="st-kicker">UNIT · AM-60 "PROSPECTOR"</div>
          <h3>Automatic Miner</h3>
          <p>Deploy with <kbd>F</kbd> near asteroids. Mines rocks within ${MINER.range} m and stores up to ${MINER.capacity} ore.
             Collect with <kbd>F</kbd>, or let cargo drones ferry it home.</p>
          <div class="st-kv"><span>Carried by you</span><b>${me?.minerStock ?? 0}</b></div>
          <div class="st-kv"><span>Fleet (deployed + carried)</span><b>${owned} / ${MINER.maxOwned}</b></div>
          ${full ? `<div class="st-max">FLEET LIMIT REACHED</div>`
            : `<button class="st-build ${canBuy ? "" : "off"}" data-a="buyMiner">PURCHASE <kbd>M</kbd><span>${cost} ore</span></button>`}
        </div>
      </section>
      <section class="st-detail">
        <div class="st-kicker">DEPLOYED MINERS · ${s.miners.size}</div>
        <table class="st-table"><thead><tr><th>OWNER</th><th>STATUS</th><th>ORE</th><th>DIST</th></tr></thead>
          <tbody>${miners.join("") || `<tr><td colspan="4" class="empty">No miners deployed</td></tr>`}</tbody></table>
        <div class="st-kicker" style="margin-top:18px">CARGO DRONES · ${s.drones.size}</div>
        <table class="st-table"><thead><tr><th>UNIT</th><th>STATUS</th><th>CARGO</th><th>PORT</th></tr></thead>
          <tbody>${drones.join("") || `<tr><td colspan="4" class="empty">Build a Drone Bay to get cargo drones</td></tr>`}</tbody></table>
      </section>`;
  }

  private renderShip(s: SectorState): string {
    const st = stats(s.station.levels);
    const row = (k: string, v: string) => `<div class="st-kv"><span>${k}</span><b>${v}</b></div>`;
    return `
      <section class="st-list st-preview-wrap">
        <header>HANGAR</header>
        <div class="st-preview"></div>
        <div class="st-kicker">HULL · MK-II ORE HAULER "KESTREL"</div>
      </section>
      <section class="st-detail">
        <div class="st-kicker">FITTING · STATION BONUSES APPLY TO ALL PILOTS</div>
        <h2>Ship Systems</h2>
        ${row("Cargo hold", `${st.capacity} ore`)}
        ${row("Mining laser output", `${(24 * st.drillMul).toFixed(1)} dmg/s`)}
        ${row("Mining laser range", `${st.drillRange.toFixed(1)} m`)}
        ${row("Boost tank", `${st.boostMax.toFixed(1)} s`)}
        ${row("Tractor range", `${st.pickupRange.toFixed(1)} m`)}
        ${row("Docking ports", `${st.ports}`)}
        ${row("Cargo drones", `${st.drones}`)}
      </section>`;
  }
}

/** Slowly turning ship model in the hangar pane (own tiny renderer, only while visible). */
class ShipPreview {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  private pivot = new THREE.Group();

  constructor(template: ShipTemplate) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(360, 260);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.canvas = this.renderer.domElement;
    const v = template.create();
    for (const t of v.thrusters) t.group.visible = false;
    this.pivot.add(v.root);
    this.scene.add(this.pivot);
    this.scene.add(new THREE.HemisphereLight("#9fb4d0", "#20140c", 1.2));
    const key = new THREE.DirectionalLight("#fff1dc", 3);
    key.position.set(-3, 4, 2);
    const rim = new THREE.DirectionalLight("#7fa6ff", 2);
    rim.position.set(3, 1, -3);
    this.scene.add(key, rim);
    this.camera.position.set(4.2, 3.2, 4.6);
    this.camera.lookAt(0, 0, 0);
  }

  render(dt: number) {
    this.pivot.rotation.y += dt * 0.35;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
    this.canvas.remove();
  }
}
