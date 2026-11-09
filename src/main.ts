import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { Ship } from "./ship";
import { Starfield } from "./starfield";
import { createSpaceEnvironment, SUN_DIR } from "./environment";
import { AsteroidField } from "./asteroids";
import { Drill, DRILL } from "./drill";
import { Effects } from "./fx";
import { OreField } from "./ore";
import { Radar } from "./radar";
import { input } from "./input";
import { Station, STATION } from "./station";
import { StationMenu } from "./ui";
import {
  MINER, MODULES, MODULE_ORDER, loadState, minerCost, minersOwned, nextCost, saveState, stats, type ModuleId,
} from "./upgrades";
import { MinerFleet } from "./miners";

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
const CAM_MIN = 12;
const CAM_MAX = 42;
addEventListener("wheel", (e) => {
  camHeight = THREE.MathUtils.clamp(camHeight * Math.exp(e.deltaY * 0.001), CAM_MIN, CAM_MAX);
}, { passive: true });
const CAM_TILT = THREE.MathUtils.degToRad(18);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1000);

// Lighting: warm sun (casts self-shadows on the ship), cool rim light, faint fill.
const sun = new THREE.DirectionalLight("#fff1dc", 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 1, far: 20 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
const rim = new THREE.DirectionalLight("#7fa6ff", 1.4);
scene.add(sun, sun.target, rim, rim.target);
scene.add(new THREE.HemisphereLight("#33415e", "#0a0710", 0.5));

const stars = new Starfield();
scene.add(stars.group);

const labelLayer = document.getElementById("labels")!;
const [ship, field, station, fleet] = await Promise.all([
  Ship.load("/models/ship.glb"),
  AsteroidField.load("/models/asteroid.glb"),
  Station.load("/models/station.glb"),
  MinerFleet.load("/models/miner.glb", labelLayer),
]);
scene.add(station.root, fleet.group);
field.populate(ship.root.position);
const fx = new Effects(field.variants[0], field.material);
const ore = new OreField();
const drill = new Drill(ship.drillMounts);
scene.add(ship.root, ship.thruster.trail, field.group, fx.group, ore.group, drill.group);

const radar = new Radar(document.body);

// ---------------------------------------------------------------- progression
const state = loadState();
for (const id of MODULE_ORDER) station.setLevel(id, state.levels[id]);
for (const m of state.miners) fleet.spawn(m, field);
function applyStats() {
  const st = stats(state);
  drill.dpsMul = st.drillMul;
  drill.range = st.drillRange;
  ore.magnetRange = st.pickupRange;
  ship.boostMax = st.boostMax;
  ship.boostEnergy = Math.min(ship.boostEnergy, st.boostMax);
  return st;
}
let shipStats = applyStats();
ship.boostEnergy = ship.boostMax;

let docked = false;
const menu = new StationMenu(document.body, (id) => build(id), () => undock(), () => buyMiner());

const toastEl = document.getElementById("toast")!;
let toastTimer = 0;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  toastTimer = 2.5;
}

function buyMiner() {
  const cost = minerCost(state);
  if (!docked || state.stored < cost || minersOwned(state) >= MINER.maxOwned) return;
  state.stored -= cost;
  state.minersBought++;
  state.minerStock++;
  saveState(state);
  menu.render(state);
  menu.flashNote(`Automatic miner loaded · press F in space to deploy`);
}

/** Context action (F): collect from / pack up a nearby miner, or deploy a carried one. */
function minerAction() {
  if (docked) return;
  const p = ship.root.position;
  const near = fleet.nearest(p);
  if (near && near.dist < MINER.collectRange) {
    const m = near.miner;
    if (m.save.stored >= 1) {
      const take = Math.min(Math.floor(m.save.stored), shipStats.capacity - state.cargo);
      if (take <= 0) return toast("Cargo hold full");
      m.save.stored -= take;
      state.cargo += take;
      toast(`Collected ${take} ore from miner`);
    } else {
      fleet.remove(m, field);
      state.miners.splice(state.miners.indexOf(m.save), 1);
      state.minerStock++;
      toast("Miner packed up");
    }
  } else if (state.minerStock > 0) {
    if (Math.hypot(p.x, p.z) < STATION.socketRadius + 8) return toast("Too close to the station");
    if (near && near.dist < 6) return toast("Too close to another miner");
    const save = { x: p.x, z: p.z, stored: 0 };
    state.miners.push(save);
    state.minerStock--;
    fleet.spawn(save, field, true);
    fx.flash(new THREE.Vector3(p.x, 0, p.z), 4, 0.4);
    toast("Miner deployed");
  } else {
    return;
  }
  saveState(state);
}

function dock() {
  docked = true;
  ship.controlsEnabled = false;
  const unloaded = state.cargo;
  state.stored += unloaded;
  state.cargo = 0;
  ship.boostEnergy = ship.boostMax; // refuel
  saveState(state);
  menu.render(state);
  menu.open(unloaded > 0 ? `Unloaded ${unloaded} ore · boost tank refilled` : "Boost tank refilled");
}

function undock() {
  docked = false;
  ship.controlsEnabled = true;
  menu.close();
}

function build(id: ModuleId) {
  const cost = nextCost(state, id);
  if (!docked || state.stored < cost) return;
  state.stored -= cost;
  state.levels[id]++;
  for (const pos of station.setLevel(id, state.levels[id], true)) {
    fx.flash(pos.setY(STATION.depth + 1), 6, 0.6);
  }
  shipStats = applyStats();
  ship.boostEnergy = ship.boostMax; // docked: tank is topped up to the new size
  saveState(state);
  menu.render(state);
  menu.flashNote(`${MODULES[id].name} level ${state.levels[id]} built`);
}

addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.code === "KeyE") {
    if (docked) undock();
    else if (canDock()) dock();
  } else if (e.code === "Escape" && docked) {
    undock();
  } else if (docked && /^Digit[1-5]$/.test(e.code)) {
    build(MODULE_ORDER[Number(e.code.slice(5)) - 1]);
  } else if (docked && e.code === "Digit6") {
    buyMiner();
  } else if (e.code === "KeyF") {
    minerAction();
  }
});

function canDock() {
  return Math.hypot(ship.root.position.x, ship.root.position.z) < STATION.dockRadius
    && ship.velocity.length() < STATION.dockMaxSpeed;
}

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.45, 0.5, 0.95));
composer.addPass(new OutputPass());

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

const speedEl = document.getElementById("speed")!;
const oreEl = document.getElementById("ore")!;
const capEl = document.getElementById("cap")!;
const cargoBar = document.querySelector<HTMLElement>("#cargo .bar > i")!;
const cargoBox = document.getElementById("cargo")!;
const boostBar = document.querySelector<HTMLElement>("#boost .bar > i")!;
const promptEl = document.getElementById("prompt")!;
const minersEl = document.getElementById("miners")!;
let saveTimer = 0;
const targetEl = document.getElementById("target")!;
const targetBar = targetEl.querySelector<HTMLElement>(".bar > i")!;
const targetLabel = targetEl.querySelector<HTMLElement>(".label")!;
const tmpV = new THREE.Vector3();
const fpsEl = document.getElementById("fps")!;
let fpsFrames = 0;
let fpsTime = 0;
const camFocus = new THREE.Vector3();
const timer = new THREE.Timer();
timer.connect(document);
const RIM_DIR = new THREE.Vector3(0.6, 0.35, -0.7).normalize();

function frame(now?: number) {
  timer.update(now);
  const dt = Math.min(timer.getDelta(), 1 / 20);
  const t = timer.getElapsed();

  if (docked) {
    // settle onto the landing pad, nose north
    const p0 = ship.root.position;
    p0.x += (0 - p0.x) * Math.min(1, 3 * dt);
    p0.z += (0 - p0.z) * Math.min(1, 3 * dt);
    ship.velocity.multiplyScalar(Math.exp(-6 * dt));
    const dh = Math.atan2(Math.sin(-ship.heading), Math.cos(-ship.heading));
    ship.heading += dh * Math.min(1, 3 * dt);
  }
  ship.update(dt, t);
  const p = ship.root.position;
  station.update(dt, t);

  // --- gameplay
  field.update(dt, p);
  const impact = field.collide(p, ship.velocity, ship.radius);
  if (impact > 1) fx.shake = Math.min(1, fx.shake + impact * 0.04);
  ship.root.updateMatrixWorld();

  const res = drill.update(dt, t, input.drill && !docked, p, ship.forward, field, camera, fx);
  if (res.destroyed) {
    const a = res.destroyed;
    fx.explode(a.pos, a.radius, a.vel);
    ore.spawn(a.pos, Math.ceil(a.radius * 2), a.vel);
    field.destroy(a);
  }
  const got = ore.update(dt, p, Math.max(0, shipStats.capacity - state.cargo));
  if (got > 0) {
    state.cargo += got;
    oreEl.classList.remove("bump");
    void oreEl.offsetWidth; // restart the CSS animation
    oreEl.classList.add("bump");
  }
  saveTimer += dt;
  if (saveTimer > 5) {
    saveTimer = 0;
    saveState(state);
  }
  fleet.update(dt, t, field, fx, p, camera);
  fx.update(dt);

  // look slightly ahead in the direction of travel, zoom out with speed
  const speed = ship.velocity.length();
  const lead = ship.velocity.clone().multiplyScalar(0.35);
  camFocus.lerp(p.clone().add(lead), 1 - Math.exp(-4 * dt));
  const h = camHeight + speed * 0.25;
  camera.position.set(camFocus.x, h, camFocus.z + h * Math.tan(CAM_TILT));
  camera.lookAt(camFocus);
  if (fx.shake > 0.01) {
    const s = fx.shake * 0.35;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.z += (Math.random() - 0.5) * s;
  }

  // lights travel with the ship so the shadow frustum stays tight
  sun.position.copy(p).addScaledVector(SUN_DIR, 10);
  sun.target.position.copy(p);
  rim.position.copy(p).addScaledVector(RIM_DIR, 10);
  rim.target.position.copy(p);

  stars.update(camera.position);
  speedEl.textContent = speed.toFixed(1);

  // cargo / boost HUD and docking prompt
  oreEl.textContent = String(state.cargo);
  capEl.textContent = String(shipStats.capacity);
  const fill = state.cargo / shipStats.capacity;
  cargoBar.style.width = `${Math.min(1, fill) * 100}%`;
  cargoBox.classList.toggle("full", fill >= 1);
  boostBar.style.width = `${(ship.boostEnergy / ship.boostMax) * 100}%`;
  const nearMiner = fleet.nearest(p);
  if (docked) {
    promptEl.textContent = "";
  } else if (Math.hypot(p.x, p.z) < STATION.dockRadius) {
    promptEl.textContent = canDock() ? "Press E to dock" : "Slow down to dock";
  } else if (nearMiner && nearMiner.dist < MINER.collectRange) {
    const st = Math.floor(nearMiner.miner.save.stored);
    promptEl.textContent = st > 0 ? `Press F to collect ${st} ore` : "Press F to pack up the miner";
  } else if (fill >= 1) {
    promptEl.textContent = "Cargo hold full — return to the station";
  } else {
    promptEl.textContent = "";
  }

  minersEl.textContent = state.minerStock > 0 ? `MINERS ${state.minerStock} · F to deploy` : "";
  if (toastTimer > 0 && (toastTimer -= dt) <= 0) toastEl.classList.remove("show");
  fleet.updateLabels(camera);

  // target integrity bar floats above the drilled asteroid
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
  radar.draw(
    { x: p.x, z: p.z, heading: ship.heading },
    field.list, ore.items.map((o) => o.mesh.position), drill.target, drill.range, t,
    { x: 0, z: 0 }, fleet.list,
  );

  // FPS counter, refreshed twice per second (uses real frame time, not the clamped dt)
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
  Object.assign(window, { __game: { THREE, ship, field, drill, ore, fx, station, state, dock, undock, build, input, fleet, minerAction } });
}
