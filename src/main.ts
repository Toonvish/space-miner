import "./style.css";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { PILOT_COLORS, SECTOR, STATION, armPodPos } from "../shared/config";
import type { BoomMsg, BuiltMsg, SnapMsg, ToastMsg } from "../shared/schema";
import { MINER, MODULES, MODULE_ORDER, levelOf, stats, type ModuleId } from "../shared/upgrades";
import { AsteroidField } from "./asteroids";
import { Drill } from "./drill";
import { DroneFleet } from "./drones";
import { createSpaceEnvironment, SUN_DIR } from "./environment";
import { Effects } from "./fx";
import { input } from "./input";
import { MinerFleet } from "./miners";
import { Net, identity, rememberName } from "./net";
import { OreField } from "./ore";
import { Radar } from "./radar";
import { RemoteShips } from "./remotes";
import { Ship, ShipTemplate } from "./ship";
import { Starfield } from "./starfield";
import { Station } from "./station";
import { StationMenu } from "./ui";

// ---------------------------------------------------------------- renderer & scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#020308");
scene.environment = createSpaceEnvironment(renderer);
scene.environmentIntensity = 0.9;

// Camera: perspective, tilted ~18° from straight down, follows the ship. Mouse wheel zooms.
let camHeight = 22;
addEventListener("wheel", (e) => {
  if (menu?.isOpen) return;
  camHeight = THREE.MathUtils.clamp(camHeight * Math.exp(e.deltaY * 0.001), 12, 42);
}, { passive: true });
const CAM_TILT = THREE.MathUtils.degToRad(18);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1000);

// Lighting: warm sun (self-shadows on the local ship), cool rim light, faint fill.
const sun = new THREE.DirectionalLight("#fff1dc", 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 1, far: 20 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
const rim = new THREE.DirectionalLight("#7fa6ff", 1.4);
scene.add(sun, sun.target, rim, rim.target);
scene.add(new THREE.HemisphereLight("#33415e", "#0a0710", 0.5));
const RIM_DIR = new THREE.Vector3(0.6, 0.35, -0.7).normalize();

const stars = new Starfield();
scene.add(stars.group);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.45, 0.95));
composer.addPass(new OutputPass());
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- assets (load while the pilot logs in)
const labelLayer = document.getElementById("labels")!;
const assets = Promise.all([
  ShipTemplate.load("/models/ship.glb"),
  AsteroidField.load("/models/asteroid.glb"),
  Station.load("/models/station.glb"),
  MinerFleet.load("/models/miner.glb", labelLayer),
  DroneFleet.load("/models/drone.glb", scene),
]);

// ---------------------------------------------------------------- login
const login = document.getElementById("login")!;
const loginForm = login.querySelector("form")!;
const nameInput = login.querySelector<HTMLInputElement>("input")!;
const loginMsg = login.querySelector<HTMLElement>(".msg")!;
const id = identity();
nameInput.value = id.name;
nameInput.focus();

async function connect(): Promise<Net> {
  return new Promise((resolve) => {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim() || "Pilot";
      rememberName(name);
      loginMsg.textContent = "Connecting…";
      loginForm.classList.add("busy");
      try {
        await assets;
        const net = await Net.connect(name, id.token);
        login.classList.add("hidden");
        resolve(net);
      } catch (err) {
        console.error(err);
        loginMsg.textContent = "Could not reach the game server. Is it running?";
        loginForm.classList.remove("busy");
      }
    });
  });
}

let menu: StationMenu | null = null;
const net = await connect();
const [shipTemplate, field, station, fleet, drones] = await assets;

// ---------------------------------------------------------------- world objects
const ship = new Ship(shipTemplate.create());
const me0 = net.me!;
ship.root.position.set(me0.x, 0, me0.z);
ship.heading = me0.h;
const fx = new Effects(field.variants[0], field.material);
const ore = new OreField();
const drill = new Drill(ship.drillMounts);
const remotes = new RemoteShips(shipTemplate, scene, labelLayer);
scene.add(ship.root, ...ship.visual.trails, field.group, fx.group, ore.group, drill.group,
  station.root, fleet.group, drones.group, remotes.group);
const radar = new Radar(document.body);

const levelsSeen = new Map<ModuleId, number>();
for (const mid of MODULE_ORDER) {
  const l = levelOf(net.state.station.levels, mid);
  station.setLevel(mid, l);
  levelsSeen.set(mid, l);
}

// ---------------------------------------------------------------- HUD
const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const speedEl = $("#speed"), oreEl = $("#ore"), capEl = $("#cap"), cargoBar = $("#cargo .bar > i");
const cargoBox = $("#cargo"), boostBar = $("#boost .bar > i"), promptEl = $("#prompt"), minersEl = $("#miners");
const targetEl = $("#target"), targetBar = $("#target .bar > i"), targetLabel = $("#target .label");
const toastEl = $("#toast"), fpsEl = $("#fps"), pilotsEl = $("#pilots");
let toastTimer = 0;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  toastTimer = 2.5;
}

menu = new StationMenu(document.body, {
  build: (module) => net.send("build", { module }),
  buyMiner: () => net.send("buyMiner"),
  setColor: (color) => net.send("setColor", { color }),
  undock: () => net.send("undock"),
}, shipTemplate);

// ---------------------------------------------------------------- server events
net.on<BoomMsg>("boom", (m) => {
  const near = Math.max(0, 1 - Math.hypot(m.x - ship.root.position.x, m.z - ship.root.position.z) / 40);
  fx.explode(new THREE.Vector3(m.x, 0, m.z), m.r, new THREE.Vector3(m.vx, 0, m.vz), near);
});
net.on<ToastMsg>("toast", (m) => (menu?.isOpen ? menu.flash(m.text) : toast(m.text)));
net.on<BuiltMsg>("built", (m) => {
  const text = `${m.by} built ${MODULES[m.module as ModuleId]?.name ?? m.module} MK ${m.level}`;
  menu?.isOpen ? menu.flash(text) : toast(text);
});
net.on<SnapMsg>("snap", (m) => {
  ship.root.position.set(m.x, 0, m.z);
  ship.velocity.set(m.vx, 0, m.vz);
});
net.room.onLeave(() => {
  login.classList.remove("hidden");
  loginForm.classList.add("busy");
  loginMsg.innerHTML = `Connection lost. <a href="">Reconnect</a>`;
});

addEventListener("keydown", (e) => {
  if (e.repeat || !login.classList.contains("hidden")) return;
  if (menu!.isOpen && menu!.key(e)) { e.preventDefault(); return; }
  if (e.code === "KeyE") net.send(docked ? "undock" : "dock");
  else if (e.code === "Escape" && docked) net.send("undock");
  else if (e.code === "KeyF" && !docked) net.send("minerAction");
});

function portPos(k: number) {
  return k === 0 ? { x: 0, z: 0 } : armPodPos(MODULES.ports.angle, k - 1);
}

// ---------------------------------------------------------------- frame loop
let docked = false;
const camFocus = ship.root.position.clone();
const timer = new THREE.Timer();
timer.connect(document);
let fpsFrames = 0, fpsTime = 0;
const tmpV = new THREE.Vector3();

function frame(now?: number) {
  timer.update(now);
  const dt = Math.min(timer.getDelta(), 1 / 20);
  const t = timer.getElapsed();
  const state = net.state;
  const serverNow = net.serverTime();
  const me = net.me;
  const st = stats(state.station.levels);
  if (me) ship.visual.setAccent(me.color);

  // docking transitions are driven by the server (port assignment)
  const nowDocked = !!me && me.port >= 0;
  if (nowDocked !== docked) {
    docked = nowDocked;
    ship.controlsEnabled = !docked;
    document.body.classList.toggle("docked", docked);
    if (docked) { ship.boostEnergy = st.boostMax; menu!.open(); } else menu!.close();
  }
  ship.boostMax = st.boostMax;
  drill.range = st.drillRange;
  if (docked && me) {
    const pp = portPos(me.port);
    const p0 = ship.root.position;
    p0.x += (pp.x - p0.x) * Math.min(1, 3 * dt);
    p0.z += (pp.z - p0.z) * Math.min(1, 3 * dt);
    ship.velocity.multiplyScalar(Math.exp(-6 * dt));
    ship.heading += Math.atan2(Math.sin(-ship.heading), Math.cos(-ship.heading)) * Math.min(1, 3 * dt);
  }

  // --- world (server-owned) views
  field.sync(state.asteroids, serverNow, dt);
  ship.update(dt, t);
  const p = ship.root.position;
  // soft sector boundary
  const r = Math.hypot(p.x, p.z);
  if (r > SECTOR.radius) {
    ship.velocity.x -= (p.x / r) * (r - SECTOR.radius) * 2 * dt;
    ship.velocity.z -= (p.z / r) * (r - SECTOR.radius) * 2 * dt;
  }
  if (!docked) {
    const impact = field.collide(p, ship.velocity, ship.radius);
    if (impact > 1) fx.shake = Math.min(1, fx.shake + impact * 0.04);
  }
  ship.root.updateMatrixWorld();
  drill.update(dt, t, input.drill && !docked, p, ship.forward, field, camera, fx);
  net.sendMove(dt, {
    x: p.x, z: p.z, h: ship.heading, vx: ship.velocity.x, vz: ship.velocity.z,
    th: ship.throttle, b: ship.boosting, d: !!drill.target, tg: drill.target?.id ?? "",
  });

  ore.sync(state.ore, dt);
  fleet.sync(state.miners, dt, t, field, fx, camera);
  drones.sync(state.drones, dt, t);
  remotes.sync(state.players, net.sessionId, dt, t, field, camera, fx);
  for (const mid of MODULE_ORDER) {
    const l = levelOf(state.station.levels, mid);
    if (l !== levelsSeen.get(mid)) {
      for (const pos of station.setLevel(mid, l, true)) fx.flash(pos.setY(STATION.depth + 1), 6, 0.6);
      levelsSeen.set(mid, l);
    }
  }
  station.update(dt, t);
  fx.update(dt);

  // --- camera & lights
  const speed = ship.velocity.length();
  camFocus.lerp(p.clone().addScaledVector(ship.velocity, 0.35), 1 - Math.exp(-4 * dt));
  const h = camHeight + speed * 0.25 + (docked ? 6 : 0);
  camera.position.set(camFocus.x, h, camFocus.z + h * Math.tan(CAM_TILT));
  camera.lookAt(camFocus);
  if (fx.shake > 0.01) {
    camera.position.x += (Math.random() - 0.5) * fx.shake * 0.35;
    camera.position.z += (Math.random() - 0.5) * fx.shake * 0.35;
  }
  sun.position.copy(p).addScaledVector(SUN_DIR, 10);
  sun.target.position.copy(p);
  rim.position.copy(p).addScaledVector(RIM_DIR, 10);
  rim.target.position.copy(p);
  stars.update(camera.position);

  // --- HUD
  const cargo = me?.cargo ?? 0;
  speedEl.textContent = speed.toFixed(1);
  oreEl.textContent = String(cargo);
  capEl.textContent = String(st.capacity);
  const fill = cargo / st.capacity;
  cargoBar.style.width = `${Math.min(1, fill) * 100}%`;
  cargoBox.classList.toggle("full", fill >= 1);
  boostBar.style.width = `${(ship.boostEnergy / ship.boostMax) * 100}%`;
  minersEl.textContent = me && me.minerStock > 0 ? `MINERS ${me.minerStock} · F to deploy` : "";

  let prompt = "";
  if (!docked) {
    let port = -1, pd = STATION.dockRadius;
    state.station.ports.forEach((_, k) => {
      const pp = portPos(k);
      const d = Math.hypot(pp.x - p.x, pp.z - p.z);
      if (d < pd) { pd = d; port = k; }
    });
    const nearMiner = fleet.nearest(p);
    if (port >= 0) {
      const occ = state.station.ports[port];
      prompt = occ !== "" ? "Port occupied" : speed > STATION.dockMaxSpeed ? "Slow down to dock" : "Press E to dock";
    } else if (nearMiner && nearMiner.dist < MINER.collectRange) {
      const s = Math.floor(nearMiner.miner.stored);
      prompt = s > 0 ? `Press F to collect ${s} ore` : "Press F to pack up the miner";
    } else if (fill >= 1) {
      prompt = "Cargo hold full — return to the station";
    } else if (r > SECTOR.radius - 10) {
      prompt = "Leaving the sector";
    }
  }
  promptEl.textContent = prompt;
  if (toastTimer > 0 && (toastTimer -= dt) <= 0) toastEl.classList.remove("show");

  const names: string[] = [];
  state.players.forEach((pl, sid) => names.push(
    `<span style="color:${PILOT_COLORS[pl.color % PILOT_COLORS.length].hex}">${sid === net.sessionId ? "▸ " : ""}${pl.name.replace(/</g, "")}</span>`));
  pilotsEl.innerHTML = `PILOTS ${state.players.size}<br>${names.join("<br>")}`;

  const tgt = drill.target;
  if (tgt) {
    tmpV.copy(tgt.pos).setZ(tgt.pos.z - tgt.radius * 1.15).project(camera);
    targetEl.style.display = "block";
    targetEl.style.transform = `translate(${(tmpV.x * 0.5 + 0.5) * innerWidth}px, ${(-tmpV.y * 0.5 + 0.5) * innerHeight}px) translate(-50%, -100%)`;
    const frac = Math.max(0, tgt.hp / tgt.maxHp);
    targetBar.style.width = `${frac * 100}%`;
    targetLabel.textContent = `ROCK Ø${(tgt.radius * 2).toFixed(1)}  ${Math.ceil(frac * 100)}%`;
  } else {
    targetEl.style.display = "none";
  }
  fleet.updateLabels(camera);
  remotes.updateLabels(camera);
  menu!.update(dt, state, net.sessionId, p);

  const pilots: { x: number; z: number; color: string }[] = [];
  const droneDots: { x: number; z: number }[] = [];
  state.players.forEach((pl, sid) => { if (sid !== net.sessionId) pilots.push({ x: pl.x, z: pl.z, color: PILOT_COLORS[pl.color % PILOT_COLORS.length].hex }); });
  for (const d of drones.list) droneDots.push({ x: d.pos.x, z: d.pos.z });
  radar.draw({ x: p.x, z: p.z, heading: ship.heading }, field.list, ore.positions, drill.target, drill.range, t,
    { x: 0, z: 0 }, fleet.list, { pilots, drones: droneDots, sectorRadius: SECTOR.radius });

  fpsFrames++;
  fpsTime += timer.getDelta();
  if (fpsTime >= 0.5) {
    fpsEl.textContent = `${Math.round(fpsFrames / fpsTime)} FPS · ${((fpsTime / fpsFrames) * 1000).toFixed(1)} ms`;
    fpsFrames = 0;
    fpsTime = 0;
  }

  composer.render();
  requestAnimationFrame(frame);
}
frame();

// dev-only handle for automated testing / console tinkering
if (import.meta.env.DEV) {
  Object.assign(window, { __game: { THREE, net, ship, field, drill, ore, fx, station, fleet, drones, remotes, input, menu } });
}
