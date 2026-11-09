import * as THREE from "three";
import { DRONE, PILOT_COLORS } from "../shared/config";
import { DRONE_STATUS, MINER_STATUS, type SectorState } from "../shared/schema";
import {
  MINER, MODULES, MODULE_ORDER, RESEARCH_ORDER, fleetStats, levelOf, maxLevel, minerCost, missingRequirements, nextCost,
  stats, type ModuleId,
} from "../shared/upgrades";
import type { ShipTemplate, ShipVisual } from "./ship";

/** Flavour + help text for the station terminal. */
const INFO: Record<ModuleId, { tag: string; desc: string }> = {
  cargo: { tag: "LOGISTICS", desc: "Pressurised container racks bolted onto the east truss. Every pilot's hold grows with each bay." },
  drill: { tag: "INDUSTRY", desc: "Laser research lab. Tunes the frequency of every mining laser in the fleet for faster rock breakup." },
  range: { tag: "INDUSTRY", desc: "Focusing mirror arrays. Collimated beams reach rocks further away from the ship." },
  fuel: { tag: "PROPULSION", desc: "Cryogenic propellant depot. Larger boost tanks for every ship docked here." },
  tractor: { tag: "LOGISTICS", desc: "Tractor field emitters. Ore crystals are pulled in from further away." },
  ports: { tag: "INFRASTRUCTURE", desc: "Additional landing pad. Ships and mining drones need a free port to dock and unload." },
  drones: { tag: "AUTOMATION", desc: `Hangar cradle with one autonomous mining drone. Drones roam around the station, mine rocks with their own laser, carry up to ${DRONE.capacity} ore and deliver it through a free docking port. They leave miners' zones alone.` },
  minerReach: { tag: "MINER RESEARCH", desc: "Wider survey sensors: every miner claims and clears a larger circular work zone." },
  minerSpeed: { tag: "MINER RESEARCH", desc: "Higher-output cutting lasers for all automatic miners." },
  droneReach: { tag: "DRONE RESEARCH", desc: "Long-range navigation: drones roam further from the station to find rocks." },
  droneSpeed: { tag: "DRONE RESEARCH", desc: "Higher-output mining lasers for all drones." },
};

type Tab = "modules" | "miners" | "drones" | "ship";
const TABS: Tab[] = ["modules", "miners", "drones", "ship"];
/** Station modules listed in the modules tab (Drone Bays are built from the Drones tab). */
const MODULE_TAB = MODULE_ORDER.filter((id) => id !== "drones");
const MINER_RESEARCH: ModuleId[] = ["minerReach", "minerSpeed"];
const DRONE_RESEARCH: ModuleId[] = ["droneReach", "droneSpeed"];

export interface StationActions {
  build(id: ModuleId): void;
  buyMiner(): void;
  undock(): void;
  settings(): void;
  setColor(index: number): void;
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
        <button class="st-gear" data-a="settings" title="Options (O)">⚙</button>
        <button class="st-undock" data-a="undock">UNDOCK <kbd>E</kbd></button>
      </div>
      <nav class="st-nav">
        <button data-tab="modules"><i>▣</i>Station<br>Modules</button>
        <button data-tab="miners"><i>◈</i>Miners</button>
        <button data-tab="drones"><i>✦</i>Drones</button>
        <button data-tab="ship"><i>△</i>Ship<br>Fitting</button>
      </nav>
      <main class="st-main"></main>
      <div class="st-note"></div>`;
    this.el.addEventListener("mousedown", (e) => e.stopPropagation()); // mouse = drill in flight
    this.el.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tab],[data-sel],[data-a],[data-color]");
      if (!t) return;
      if (t.dataset.tab) { this.tab = t.dataset.tab as Tab; this.lastRender = ""; }
      if (t.dataset.sel) { this.selected = t.dataset.sel as ModuleId; this.lastRender = ""; }
      if (t.dataset.a === "build") this.actions.build(this.selected);
      if (t.dataset.a === "research" && t.dataset.id) this.actions.build(t.dataset.id as ModuleId);
      if (t.dataset.a === "buyMiner") this.actions.buyMiner();
      if (t.dataset.color && !t.classList.contains("taken")) this.actions.setColor(Number(t.dataset.color));
      if (t.dataset.a === "undock") this.actions.undock();
      if (t.dataset.a === "settings") this.actions.settings();
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
    if (new RegExp(`^Digit[1-${MODULE_TAB.length}]$`).test(e.code)) {
      this.tab = "modules";
      this.selected = MODULE_TAB[Number(e.code.slice(5)) - 1];
      this.lastRender = "";
      return true;
    }
    if (e.code === "Enter" && this.tab === "modules") { this.actions.build(this.selected); return true; }
    if (e.code === "KeyM") { this.actions.buyMiner(); return true; }
    if (e.code === "Tab") {
      this.tab = TABS[(TABS.indexOf(this.tab) + 1) % TABS.length];
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
    const levels = [...MODULE_ORDER, ...RESEARCH_ORDER].map((id) => levelOf(st.levels, id)).join(",");
    const me = s.players.get(selfId);
    let fleetSig = "";
    if (this.tab === "miners") {
      s.miners.forEach((m, id) => (fleetSig += `${id}:${Math.floor(m.stored)}:${m.status};`));
    } else if (this.tab === "drones") {
      s.drones.forEach((d, id) => (fleetSig += `${id}:${d.status}:${Math.floor(d.cargo)}:${Math.round(Math.hypot(d.x, d.z) / 5)};`));
    }
    let colorSig = "";
    s.players.forEach((p, sid) => (colorSig += `${sid}:${p.color}:${p.name};`));
    const sig = `${colorSig}|${this.tab}|${this.selected}|${levels}|${Math.floor(st.stored)}|${st.minersBought}|${me?.minerStock}|${fleetSig}`;
    if (sig !== this.lastRender) {
      this.lastRender = sig;
      const main = this.el.querySelector<HTMLElement>(".st-main")!;
      if (this.tab !== "ship") { this.preview?.dispose(); this.preview = null; }
      if (this.tab === "modules") main.innerHTML = this.renderModules(s);
      else if (this.tab === "miners") main.innerHTML = this.renderMiners(s, selfId, shipPos);
      else if (this.tab === "drones") main.innerHTML = this.renderDrones(s);
      else {
        main.innerHTML = this.renderShip(s, selfId);
        if (!this.preview) this.preview = new ShipPreview(this.shipTemplate);
        this.preview.setAccent(me?.color ?? 0);
        main.querySelector(".st-preview")!.appendChild(this.preview.canvas);
      }
    }
    this.preview?.render(dt);
  }

  private renderModules(s: SectorState): string {
    const st = s.station;
    if (this.selected === "drones" || !MODULE_TAB.includes(this.selected)) this.selected = MODULE_TAB[0];
    const rows = MODULE_TAB.map((id, i) => {
      const lvl = levelOf(st.levels, id);
      const max = maxLevel(id);
      const pips = Array.from({ length: max }, (_, k) => `<i class="${k < lvl ? "on" : ""}"></i>`).join("");
      const rowCost = nextCost(st.levels, id);
      const locked = missingRequirements(st.levels, id).length > 0;
      const price = lvl >= max
        ? `<span class="price max">MAX</span>`
        : locked ? `<span class="price short">LOCKED</span>`
        : `<span class="price ${st.stored >= rowCost ? "ok" : "short"}">${rowCost} ore</span>`;
      return `<button class="st-row ${id === this.selected ? "sel" : ""}" data-sel="${id}">
        <kbd>${i + 1}</kbd><span class="nm">${MODULES[id].name}<small>${INFO[id].tag}</small></span>
        <span class="meta"><span class="pips">${pips}</span>${price}</span></button>`;
    }).join("");

    const id = this.selected;
    const def = MODULES[id];
    const lvl = levelOf(st.levels, id);
    const max = maxLevel(id);
    const cost = nextCost(st.levels, id);
    const table = def.values.map((v, k) =>
      `<tr class="${k === lvl ? "cur" : k === lvl + 1 ? "next" : ""}"><td>${k === 0 ? "BASE" : `MK ${k}`}</td>
        <td>${def.format(v)}</td><td>${k === 0 ? "—" : `${def.costs[k - 1]} ore`}</td></tr>`).join("");
    const missing = missingRequirements(st.levels, id);
    const canBuild = lvl < max && st.stored >= cost && missing.length === 0;
    const action = lvl >= max
      ? `<div class="st-max">FULLY UPGRADED</div>`
      : `<button class="st-build ${canBuild ? "" : "off"}" data-a="build">CONSTRUCT MK ${lvl + 1}
           <span>${cost} ore</span></button>
         ${missing.length ? `<div class="st-short">Requires ${missing.join(", ")}</div>`
           : canBuild ? "" : `<div class="st-short">Need ${Math.ceil(cost - st.stored)} more ore in the station</div>`}`;
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

  /** Compact research row: name, pips, current → next value, build button. */
  private researchRow(s: SectorState, id: ModuleId): string {
    const st = s.station;
    const def = MODULES[id];
    const lvl = levelOf(st.levels, id);
    const max = maxLevel(id);
    const cost = nextCost(st.levels, id);
    const missing = missingRequirements(st.levels, id);
    const pips = Array.from({ length: max }, (_, k) => `<i class="${k < lvl ? "on" : ""}"></i>`).join("");
    const btn = lvl >= max ? `<span class="price max">MAX</span>`
      : missing.length ? `<span class="price short" title="Requires ${missing.join(", ")}">LOCKED</span>`
      : `<button class="st-mini ${st.stored >= cost ? "" : "off"}" data-a="research" data-id="${id}">MK ${lvl + 1} · ${cost} ore</button>`;
    return `<div class="st-research" title="${INFO[id].desc}">
      <div><b>${def.name}</b><small>${def.format(def.values[lvl])}${lvl < max ? ` → <em>${def.format(def.values[lvl + 1])}</em>` : ""}</small></div>
      <span class="pips">${pips}</span>${btn}</div>`;
  }

  private renderMiners(s: SectorState, selfId: string, shipPos: { x: number; z: number }): string {
    const st = s.station;
    const me = s.players.get(selfId);
    const fl = fleetStats(st.levels);
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
    return `
      <section class="st-list">
        <header>AUTOMATED MINERS</header>
        <div class="st-card">
          <div class="st-kicker">UNIT · AM-100 "PROSPECTOR"</div>
          <h3>Automatic Miner</h3>
          <p>Deploy with <kbd>F</kbd>. It claims a ${fl.minerRadius} m work zone, hovers from rock to rock and
             mines everything inside it, storing up to ${MINER.capacity} ore. Collect with <kbd>F</kbd>.</p>
          <div class="st-kv"><span>Carried by you</span><b>${me?.minerStock ?? 0}</b></div>
          <div class="st-kv"><span>Fleet (deployed + carried)</span><b>${owned} / ${MINER.maxOwned}</b></div>
          ${full ? `<div class="st-max">FLEET LIMIT REACHED</div>`
            : `<button class="st-build ${canBuy ? "" : "off"}" data-a="buyMiner">PURCHASE <kbd>M</kbd><span>${cost} ore</span></button>`}
        </div>
        <header style="margin-top:18px">MINER RESEARCH</header>
        ${MINER_RESEARCH.map((id) => this.researchRow(s, id)).join("")}
      </section>
      <section class="st-detail">
        <div class="st-kicker">DEPLOYED MINERS · ${s.miners.size}</div>
        <div class="st-chips"><span>ZONE <b>${fl.minerRadius} m</b></span><span>MINING <b>${fl.minerDps} dmg/s</b></span>
          <span>HOLD <b>${MINER.capacity} ore</b></span></div>
        <table class="st-table"><thead><tr><th>OWNER</th><th>STATUS</th><th>ORE</th><th>DIST</th></tr></thead>
          <tbody>${miners.join("") || `<tr><td colspan="4" class="empty">No miners deployed</td></tr>`}</tbody></table>
      </section>`;
  }

  private renderDrones(s: SectorState): string {
    const st = s.station;
    const fl = fleetStats(st.levels);
    const lvl = levelOf(st.levels, "drones");
    const max = maxLevel("drones");
    const cost = nextCost(st.levels, "drones");
    const missing = missingRequirements(st.levels, "drones");
    const canBuild = lvl < max && missing.length === 0 && st.stored >= cost;
    const reqs = Object.entries(MODULES.drones.requires ?? {}).map(([rid, need]) => {
      const ok = levelOf(st.levels, rid as ModuleId) >= (need ?? 0);
      return `<div class="st-kv"><span>${MODULES[rid as ModuleId].name} MK ${need}</span><b class="${ok ? "ok" : "no"}">${ok ? "✓" : "✕"}</b></div>`;
    }).join("");
    const action = lvl >= max ? `<div class="st-max">ALL BAYS BUILT</div>`
      : `<button class="st-build ${canBuild ? "" : "off"}" data-a="research" data-id="drones">BUILD DRONE BAY ${lvl + 1}<span>${cost} ore</span></button>
         ${missing.length ? `<div class="st-short">Requires ${missing.join(", ")}</div>`
           : canBuild ? "" : `<div class="st-short">Need ${Math.ceil(cost - st.stored)} more ore in the station</div>`}`;
    const drones: string[] = [];
    let n = 1;
    s.drones.forEach((d) => {
      const status = DRONE_STATUS[d.status] ?? "parked";
      drones.push(`<tr><td>DRONE-${String(n++).padStart(2, "0")}</td><td class="d-${status}">${status.toUpperCase()}</td>
        <td><span class="bar"><i style="width:${(d.cargo / DRONE.capacity) * 100}%"></i></span>${Math.floor(d.cargo)}</td>
        <td>${Math.hypot(d.x, d.z).toFixed(0)} m</td></tr>`);
    });
    return `
      <section class="st-list">
        <header>MINING DRONES</header>
        <div class="st-card">
          <div class="st-kicker">UNIT · MD-40 "MAGPIE" · LATE-GAME AUTOMATION</div>
          <h3>Drone Bay</h3>
          <p>${INFO.drones.desc}</p>
          <div class="st-kv"><span>Drone bays (one drone each)</span><b>${lvl} / ${max}</b></div>
          ${lvl === 0 ? `<div class="st-sub">UNLOCK REQUIREMENTS</div>${reqs}` : ""}
          ${action}
        </div>
        <header style="margin-top:18px">DRONE RESEARCH</header>
        ${DRONE_RESEARCH.map((id) => this.researchRow(s, id)).join("")}
      </section>
      <section class="st-detail">
        <div class="st-kicker">ACTIVE DRONES · ${s.drones.size}</div>
        <div class="st-chips"><span>RANGE <b>${fl.droneReach} m</b></span><span>MINING <b>${fl.droneDps} dmg/s</b></span>
          <span>HOLD <b>${DRONE.capacity} ore</b></span></div>
        <table class="st-table"><thead><tr><th>UNIT</th><th>STATUS</th><th>CARGO</th><th>FROM STATION</th></tr></thead>
          <tbody>${drones.join("") || `<tr><td colspan="4" class="empty">${missing.length ? "Locked: meet the requirements to build a Drone Bay" : "Build a Drone Bay to launch your first drone"}</td></tr>`}</tbody></table>
      </section>`;
  }

  private renderShip(s: SectorState, selfId: string): string {
    const st = stats(s.station.levels);
    const mine = s.players.get(selfId)?.color ?? -1;
    const owners = new Map<number, string>();
    s.players.forEach((p, sid) => { if (sid !== selfId) owners.set(p.color, p.name); });
    const swatches = PILOT_COLORS.map((c, i) => {
      const owner = owners.get(i);
      const cls = i === mine ? "mine" : owner !== undefined ? "taken" : "";
      const title = owner !== undefined ? `${c.name} — taken by ${owner}` : c.name;
      return `<button class="swatch ${cls}" data-color="${i}" style="--c:${c.hex}" title="${title.replace(/"/g, "")}"></button>`;
    }).join("");
    const mineName = mine >= 0 ? PILOT_COLORS[mine].name : "";
    const row = (k: string, v: string) => `<div class="st-kv"><span>${k}</span><b>${v}</b></div>`;
    return `
      <section class="st-list st-preview-wrap">
        <header>HANGAR</header>
        <div class="st-preview"></div>
        <div class="st-kicker">HULL · HEAVY MINING FRIGATE "KESTREL"</div>
        <header style="margin-top:16px">HIGHLIGHT COLOUR · <span class="st-colorname">${mineName}</span></header>
        <div class="swatches">${swatches}</div>
        <div class="st-hint">Each pilot flies a unique colour. Crossed-out colours are in use.</div>
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
  private visual!: ShipVisual;

  setAccent(index: number) { this.visual.setAccent(index); }

  constructor(template: ShipTemplate) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(360, 260);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.canvas = this.renderer.domElement;
    const v = template.create();
    this.visual = v;
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
