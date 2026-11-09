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

export class Ship {
  readonly root = new THREE.Group(); // position + heading
  private bankGroup = new THREE.Group(); // visual roll
  readonly velocity = new THREE.Vector3();
  heading = 0;
  private angVel = 0;
  throttle = 0;
  readonly thruster = new Thruster();
  readonly radius = 1.1; // collision radius on the XZ plane
  controlsEnabled = true; // false while docked
  boostMax = 2; // seconds of boost (upgradable)
  boostEnergy = 2;
  readonly drillMounts: THREE.Object3D[] = [];
  private navLights: THREE.MeshBasicMaterial[] = [];

  static async load(url: string): Promise<Ship> {
    const gltf = await new GLTFLoader().loadAsync(url);
    return new Ship(gltf.scene);
  }

  private constructor(model: THREE.Object3D) {
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
    this.root.add(this.bankGroup);
    this.bankGroup.add(model);

    for (const n of ["DrillMountL", "DrillMountR"]) {
      const m = model.getObjectByName(n);
      if (m) this.drillMounts.push(m);
    }
    if (this.drillMounts.length === 0) this.drillMounts.push(model);

    const mount = model.getObjectByName("ThrusterMount");
    (mount ?? model).add(this.thruster.group);
    this.thruster.setGlowMaterial(glowMats.get("EngineGlow"));
    for (const n of ["NavRed", "NavGreen"]) {
      const m = glowMats.get(n);
      if (m) this.navLights.push(m);
    }
    this.navLights.forEach((m) => (m.userData.base = m.color.clone()));
  }

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

    const bankTarget = THREE.MathUtils.clamp(this.angVel * F.bank, -F.maxBank, F.maxBank);
    this.bankGroup.rotation.z += (bankTarget - this.bankGroup.rotation.z) * Math.min(1, 8 * dt);

    // blinking navigation lights
    const blink = (time % 1.2) < 0.12 ? 1 : 0.15;
    for (const m of this.navLights) m.color.copy(m.userData.base).multiplyScalar(blink);

    this.root.updateMatrixWorld();
    this.thruster.update(dt, time, this.throttle, boost, this.velocity);
  }
}
