import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Asteroid, AsteroidField } from "./asteroids";
import type { Effects } from "./fx";
import { makeBeam, placeBeam } from "./drill";
import { glowTexture } from "./particles";
import { MINER, type MinerSave } from "./upgrades";

export type MinerStatus = "deploying" | "mining" | "aiming" | "idle" | "full";

export interface Miner {
  save: MinerSave; // persisted state (shared with GameState.miners)
  pos: THREE.Vector3;
  root: THREE.Object3D;
  turret: THREE.Object3D;
  emitter: THREE.Object3D;
  status: THREE.MeshBasicMaterial;
  beam: THREE.Mesh;
  hitGlow: THREE.Sprite;
  label: HTMLElement;
  anchor: { pos: THREE.Vector3; radius: number };
  target: Asteroid | null;
  power: number;
  age: number;
  state: MinerStatus;
}

const MINER_DEPTH = -1.2; // just below the flight plane: the ship flies over miners
const STATUS_COLORS: Record<MinerStatus, THREE.Color> = {
  deploying: new THREE.Color("#7fe9ff").multiplyScalar(3),
  mining: new THREE.Color("#40ff70").multiplyScalar(3),
  aiming: new THREE.Color("#40ff70").multiplyScalar(3),
  idle: new THREE.Color("#ffd23a").multiplyScalar(3),
  full: new THREE.Color("#ff3030").multiplyScalar(3),
};
const STATUS_TEXT: Record<MinerStatus, string> = {
  deploying: "DEPLOYING", mining: "MINING", aiming: "MINING", idle: "NO ROCKS IN RANGE", full: "FULL",
};

const tmpV = new THREE.Vector3();

/** Deployed automatic miners: pick the nearest rock, aim the turret, drill, store the ore. */
export class MinerFleet {
  readonly group = new THREE.Group();
  readonly list: Miner[] = [];

  static async load(url: string, labels: HTMLElement): Promise<MinerFleet> {
    const gltf = await new GLTFLoader().loadAsync(url);
    return new MinerFleet(gltf.scene.getObjectByName("Miner") ?? gltf.scene, labels);
  }

  private constructor(private template: THREE.Object3D, private labels: HTMLElement) {
    template.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshStandardMaterial;
      if (/Glow$/.test(src.name)) {
        mesh.material = new THREE.MeshBasicMaterial({
          name: src.name,
          color: src.emissive.clone().multiplyScalar(src.emissiveIntensity * 0.5),
        });
      } else {
        mesh.receiveShadow = true;
      }
    });
  }

  spawn(save: MinerSave, field: AsteroidField, animate = false): Miner {
    const root = this.template.clone(true);
    root.position.set(save.x, MINER_DEPTH, save.z);
    root.rotation.y = Math.random() * Math.PI * 2;
    // every miner gets its own status light material
    let status = new THREE.MeshBasicMaterial();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && (mesh.material as THREE.Material).name === "StatusGlow") {
        status = (mesh.material as THREE.MeshBasicMaterial).clone();
        mesh.material = status;
      }
    });
    const beam = makeBeam(new THREE.Color(1, 0.95, 0.7).multiplyScalar(2.5), new THREE.Color("#ffc21a").multiplyScalar(1.6));
    beam.visible = false;
    const hitGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: new THREE.Color("#ffd070").multiplyScalar(2),
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    hitGlow.visible = false;
    this.group.add(root, beam, hitGlow);

    const label = document.createElement("div");
    label.className = "miner-label";
    this.labels.appendChild(label);

    const pos = new THREE.Vector3(save.x, 0, save.z);
    const anchor = { pos, radius: MINER.range + 12 };
    field.anchors.push(anchor);
    const m: Miner = {
      save, pos, root, beam, hitGlow, label, anchor, status,
      turret: root.getObjectByName("Turret") ?? root,
      emitter: root.getObjectByName("MinerEmitter") ?? root,
      target: null, power: 0, age: animate ? 0 : 10, state: "deploying",
    };
    if (animate) root.scale.setScalar(0.001);
    this.list.push(m);
    return m;
  }

  remove(m: Miner, field: AsteroidField) {
    this.list.splice(this.list.indexOf(m), 1);
    this.group.remove(m.root, m.beam, m.hitGlow);
    m.label.remove();
    field.anchors.splice(field.anchors.indexOf(m.anchor), 1);
  }

  nearest(p: THREE.Vector3): { miner: Miner; dist: number } | null {
    let best: Miner | null = null;
    let bd = Infinity;
    for (const m of this.list) {
      const d = Math.hypot(m.pos.x - p.x, m.pos.z - p.z);
      if (d < bd) { bd = d; best = m; }
    }
    return best ? { miner: best, dist: bd } : null;
  }

  private pick(m: Miner, field: AsteroidField): Asteroid | null {
    let best: Asteroid | null = null;
    let bd = Infinity;
    for (const a of field.list) {
      const d = Math.hypot(a.pos.x - m.pos.x, a.pos.z - m.pos.z) - a.radius;
      if (d < MINER.range && d < bd) { bd = d; best = a; }
    }
    return best;
  }

  update(dt: number, time: number, field: AsteroidField, fx: Effects, player: THREE.Vector3, camera: THREE.Camera) {
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    for (const m of this.list) {
      m.age += dt;
      // deploy animation: pop in, then unfold for a moment before mining
      if (m.age < 0.8) {
        const k = m.age / 0.8;
        m.root.scale.setScalar(Math.max(0.001, 1 + 2.7 * (k - 1) ** 3 + 1.7 * (k - 1) ** 2));
      } else m.root.scale.setScalar(1);

      const full = m.save.stored >= MINER.capacity;
      if (m.target && (m.target.hp <= 0 || !field.list.includes(m.target))) m.target = null;
      if (!full && m.age > 1.2 && !m.target) m.target = this.pick(m, field);
      if (full) m.target = null;

      let firing = false;
      if (m.target) {
        // swing the turret towards the target, fire once roughly aligned
        const t = m.target;
        const want = Math.atan2(-(t.pos.z - m.pos.z), t.pos.x - m.pos.x) - m.root.rotation.y;
        const cur = m.turret.rotation.y;
        const diff = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        m.turret.rotation.y = cur + THREE.MathUtils.clamp(diff, -3 * dt, 3 * dt);
        firing = Math.abs(diff) < 0.15;
      }
      m.power += ((firing ? 1 : 0) - m.power) * Math.min(1, 8 * dt);
      m.state = m.age < 1.2 ? "deploying" : full ? "full" : !m.target ? "idle" : firing ? "mining" : "aiming";

      m.beam.visible = m.hitGlow.visible = m.power > 0.03 && !!m.target;
      if (m.beam.visible && m.target) {
        const t = m.target;
        m.root.updateMatrixWorld();
        const start = m.emitter.getWorldPosition(tmpV).clone();
        const dir = t.pos.clone().sub(start).setY(0).normalize();
        const end = t.pos.clone().addScaledVector(dir, -t.radius * 0.85);
        placeBeam(m.beam, start, end, camPos, 0.1);
        const u = (m.beam.material as THREE.ShaderMaterial).uniforms;
        u.uTime.value = time;
        u.uPower.value = m.power * (0.9 + 0.1 * Math.sin(time * 60));
        m.hitGlow.position.copy(end);
        m.hitGlow.scale.setScalar(0.7 * m.power);
        fx.drillImpact(end, dir.clone().negate(), dt * 0.5);
        t.shake = Math.max(t.shake, 0.04);
        t.hp -= MINER.dps * m.power * dt;
        if (t.hp <= 0) {
          const near = Math.max(0, 1 - player.distanceTo(t.pos) / 40); // no camera shake from far away
          fx.explode(t.pos, t.radius, t.vel, near);
          field.destroy(t);
          m.save.stored = Math.min(MINER.capacity, m.save.stored + Math.ceil(t.radius * 2));
          m.target = null;
        }
      }

      // status light: steady while working, blinking when it needs attention
      const blink = m.state === "full" || m.state === "idle" ? (time % 0.8 < 0.4 ? 1 : 0.15) : 1;
      m.status.color.copy(STATUS_COLORS[m.state]).multiplyScalar(blink);
    }
  }

  /** Floating "MINER 23/60" labels above each miner. */
  updateLabels(camera: THREE.Camera) {
    for (const m of this.list) {
      tmpV.copy(m.pos).setZ(m.pos.z - 2.2).project(camera);
      const onScreen = tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1;
      m.label.style.display = onScreen ? "block" : "none";
      if (!onScreen) continue;
      m.label.style.transform =
        `translate(${(tmpV.x * 0.5 + 0.5) * innerWidth}px, ${(-tmpV.y * 0.5 + 0.5) * innerHeight}px) translate(-50%, -100%)`;
      m.label.className = `miner-label ${m.state}`;
      m.label.innerHTML = `MINER <b>${Math.floor(m.save.stored)}/${MINER.capacity}</b><br><span>${STATUS_TEXT[m.state]}</span>`;
    }
  }
}
