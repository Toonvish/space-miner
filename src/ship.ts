import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Thruster } from "./thruster";
import { input } from "./input";

/**
 * Flight tuning — arcade "assisted" flight on the XZ plane (nose = local -Z).
 * Real space has no drag; the ship's flight computer fakes some grip so it's fun to steer.
 */
export const FLIGHT = {
  thrust: 20, // forward acceleration at full throttle, units/s²
  boostMul: 1.7,
  maxSpeed: 22,
  boostMaxSpeed: 32,
  overspeedDecay: 2.5, // how fast speed above the cap bleeds off (no hard snap after boost)
  maxTurn: 4.2, // rad/s (~240°/s)
  turnResponse: 14, // how fast the turn rate reaches its target (higher = snappier)
  gripCoast: 1.6, // sideways-drift damping when not thrusting, 1/s
  gripThrust: 4.5, // ... while thrusting: carve through turns
  reverseKill: 3.5, // thrusting against your motion cancels it this fast, 1/s
  dragCoast: 1.0, // inertial dampeners when coasting (glide ~3 s)
  dragThrust: 0.12,
  brake: 18, // S: retro deceleration, units/s²
  throttleRate: 7, // how fast throttle ramps 0..1
  bank: 0.13, // visual roll per rad/s of turn
  maxBank: 0.6,
};

/** Materials that emit light: rendered unlit with HDR colour so bloom picks them up. */
const GLOW = new Set(["EngineGlow", "NavRed", "NavGreen"]);

/** Loaded ship model; `create()` makes independent visual instances (local + remote ships). */
export class ShipTemplate {
  static async load(url: string): Promise<ShipTemplate> {
    const gltf = await new GLTFLoader().loadAsync(url);
    return new ShipTemplate(gltf.scene);
  }

  private constructor(private model: THREE.Object3D) {
    const glowMats = new Map<string, THREE.MeshBasicMaterial>();
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshStandardMaterial;
      if (GLOW.has(src.name)) {
        let m = glowMats.get(src.name);
        if (!m) {
          m = new THREE.MeshBasicMaterial({
            name: src.name,
            color: src.emissive.clone().multiplyScalar(src.emissiveIntensity * 0.6),
          });
          m.userData.base = m.color.clone();
          glowMats.set(src.name, m);
        }
        mesh.material = m;
      } else {
        if (src.name === "Glass") {
          // tinted canopy: faint interior glow so it reads as glass, not a hole
          src.color.set("#1c3646");
          src.metalness = 0.5;
          src.roughness = 0.08;
          src.emissive.set("#0e2a38");
          src.emissiveIntensity = 0.6;
        }
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
  }

  create(): ShipVisual {
    return new ShipVisual(this.model.clone(true));
  }
}

/** One rendered ship: model, banking, engine plume, nav lights, drill emitters. */
export class ShipVisual {
  readonly root = new THREE.Group(); // position + heading
  readonly bankGroup = new THREE.Group(); // visual roll
  readonly thruster = new Thruster(); // main engine
  readonly thrusters: Thruster[] = [this.thruster]; // main + optional pod engines
  readonly drillMounts: THREE.Object3D[] = [];
  private navLights: THREE.MeshBasicMaterial[] = [];

  /** World-space exhaust trails: add these to the scene. */
  get trails(): THREE.Points[] { return this.thrusters.map((t) => t.trail); }

  constructor(model: THREE.Object3D) {
    this.root.add(this.bankGroup);
    this.bankGroup.add(model);
    for (const n of ["DrillMountL", "DrillMountR"]) {
      const m = model.getObjectByName(n);
      if (m) this.drillMounts.push(m);
    }
    if (this.drillMounts.length === 0) this.drillMounts.push(model);
    (model.getObjectByName("ThrusterMount") ?? model).add(this.thruster.group);
    for (const n of ["ThrusterMountL", "ThrusterMountR"]) {
      const mount = model.getObjectByName(n);
      if (!mount) continue;
      const t = new Thruster();
      t.group.scale.setScalar(0.55);
      mount.add(t.group);
      this.thrusters.push(t);
    }
    let ownGlow: THREE.MeshBasicMaterial | null = null;
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.Material;
      if (mat.name === "EngineGlow") {
        // one per-ship copy shared by all nozzles: the glow follows this ship's throttle
        if (!ownGlow) {
          ownGlow = (mat as THREE.MeshBasicMaterial).clone();
          this.thruster.setGlowMaterial(ownGlow);
        }
        mesh.material = ownGlow;
      } else if (mat.name === "NavRed" || mat.name === "NavGreen") {
        if (!this.navLights.includes(mat as THREE.MeshBasicMaterial)) this.navLights.push(mat as THREE.MeshBasicMaterial);
      }
    });
  }

  /** Visual-only update shared by the local and remote ships. */
  animate(dt: number, time: number, throttle: number, boost: boolean, vel: THREE.Vector3, bankTarget: number) {
    this.bankGroup.rotation.z += (bankTarget - this.bankGroup.rotation.z) * Math.min(1, 8 * dt);
    const blink = (time % 1.2) < 0.12 ? 1 : 0.15;
    for (const m of this.navLights) m.color.copy(m.userData.base).multiplyScalar(blink);
    this.root.updateMatrixWorld();
    for (const t of this.thrusters) t.update(dt, time, throttle, boost, vel);
  }
}

/** The local player's ship: assisted flight model on top of a ShipVisual. */
export class Ship {
  readonly visual: ShipVisual;
  readonly root: THREE.Group;
  readonly velocity = new THREE.Vector3();
  heading = 0;
  private angVel = 0;
  throttle = 0;
  boosting = false;
  readonly radius = 1.3; // collision radius on the XZ plane (hauler with outrigger pods)
  controlsEnabled = true; // false while docked
  boostMax = 2; // seconds of boost (upgradable)
  boostEnergy = 2;

  constructor(visual: ShipVisual) {
    this.visual = visual;
    this.root = visual.root;
  }

  get thruster() { return this.visual.thruster; }
  get drillMounts() { return this.visual.drillMounts; }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  update(dt: number, time: number) {
    const F = FLIGHT;
    const on = this.controlsEnabled;
    const turn = on ? (input.left ? 1 : 0) - (input.right ? 1 : 0) : 0;
    // turn rate eases quickly to its target: responsive, but still smooth
    this.angVel += (turn * F.maxTurn - this.angVel) * Math.min(1, F.turnResponse * dt);
    this.heading += this.angVel * dt;

    const thrusting = on && input.thrust;
    const target = thrusting ? 1 : 0;
    this.throttle += (target - this.throttle) * Math.min(1, F.throttleRate * dt);

    // boost drains a tank; it refills (in ~6 s) only while the boost key is released
    const wantBoost = on && input.boost && thrusting;
    const boost = wantBoost && this.boostEnergy > 0;
    if (boost) this.boostEnergy = Math.max(0, this.boostEnergy - dt);
    else if (!wantBoost) this.boostEnergy = Math.min(this.boostMax, this.boostEnergy + (this.boostMax / 6) * dt);

    const fwd = this.forward;
    const cap = boost ? F.boostMaxSpeed : F.maxSpeed;
    // thrust tapers off near the speed cap, so top speed is reached smoothly
    const vf0 = Math.max(0, this.velocity.x * fwd.x + this.velocity.z * fwd.z);
    const taper = Math.max(0, 1 - (vf0 / cap) ** 3);
    const accel = F.thrust * this.throttle * (boost ? F.boostMul : 1) * taper;
    this.velocity.addScaledVector(fwd, accel * dt);

    // split velocity into forward and sideways parts relative to the nose
    let vf = this.velocity.x * fwd.x + this.velocity.z * fwd.z;
    const sx = this.velocity.x - fwd.x * vf;
    const sz = this.velocity.z - fwd.z * vf;
    const grip = Math.exp(-(thrusting ? F.gripThrust : F.gripCoast) * dt);
    if (thrusting && vf < 0) vf *= Math.exp(-F.reverseKill * dt); // snappy U-turns
    this.velocity.set(fwd.x * vf + sx * grip, 0, fwd.z * vf + sz * grip);

    if (on && input.brake) {
      const speed = this.velocity.length();
      if (speed > 0) this.velocity.multiplyScalar(Math.max(0, speed - F.brake * dt) / speed);
    }
    this.velocity.multiplyScalar(Math.exp(-(thrusting ? F.dragThrust : F.dragCoast) * dt));

    const speed = this.velocity.length();
    if (speed > cap) {
      // soft cap: bleed off excess instead of snapping
      const target = cap + (speed - cap) * Math.exp(-F.overspeedDecay * dt);
      this.velocity.multiplyScalar(target / speed);
    }

    this.root.position.addScaledVector(this.velocity, dt);
    this.root.rotation.y = this.heading;

    this.boosting = boost;
    const bankTarget = THREE.MathUtils.clamp(this.angVel * F.bank, -F.maxBank, F.maxBank);
    this.visual.animate(dt, time, this.throttle, boost, this.velocity, bankTarget);
  }
}
