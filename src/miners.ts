import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AsteroidField } from "./asteroids";
import type { Effects } from "./fx";
import { makeBeam, placeBeam } from "./drill";
import { glowTexture } from "./particles";
import { MINER } from "../shared/upgrades";
import { MINER_STATUS, type MinerState, type MinerStatus } from "../shared/schema";

/** Client view of a server-simulated automatic miner. */
export interface Miner {
  id: string;
  pos: THREE.Vector3; // smoothed hover position
  anchor: THREE.Vector3; // centre of the work zone
  zone: THREE.LineLoop;
  stored: number;
  state: MinerStatus;
  owner: string;
  root: THREE.Object3D;
  turret: THREE.Object3D;
  emitter: THREE.Object3D;
  status: THREE.MeshBasicMaterial;
  beam: THREE.Mesh;
  hitGlow: THREE.Sprite;
  label: HTMLElement;
  targetId: string;
  power: number;
  age: number;
}

interface MapLike<T> {
  forEach(cb: (value: T, key: string) => void): void;
  get(key: string): T | undefined;
}

const MINER_DEPTH = -1.2; // just below the flight plane: ships fly over miners
const STATUS_COLORS: Record<MinerStatus, THREE.Color> = {
  deploying: new THREE.Color("#7fe9ff").multiplyScalar(3),
  mining: new THREE.Color("#40ff70").multiplyScalar(3),
  moving: new THREE.Color("#40ff70").multiplyScalar(3),
  idle: new THREE.Color("#ffd23a").multiplyScalar(3),
  full: new THREE.Color("#ff3030").multiplyScalar(3),
};
const STATUS_TEXT: Record<MinerStatus, string> = {
  deploying: "DEPLOYING", mining: "MINING", moving: "MOVING TO ROCK", idle: "ZONE CLEARED", full: "FULL",
};

const tmpV = new THREE.Vector3();

/** Unit circle outline, scaled per miner to its work radius. */
const ZONE_GEO = new THREE.BufferGeometry().setFromPoints(
  Array.from({ length: 96 }, (_, i) => new THREE.Vector3(Math.cos((i / 96) * Math.PI * 2), 0, Math.sin((i / 96) * Math.PI * 2))));
const ZONE_MAT = new THREE.LineBasicMaterial({ color: new THREE.Color("#ffd23a").multiplyScalar(0.9), transparent: true, opacity: 0.35, depthWrite: false });

export class MinerFleet {
  readonly group = new THREE.Group();
  readonly list: Miner[] = [];
  private byId = new Map<string, Miner>();

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

  private create(id: string, s: MinerState): Miner {
    const root = this.template.clone(true);
    root.position.set(s.x, MINER_DEPTH, s.z);
    root.rotation.y = (parseInt(id.slice(1), 36) * 2.39996) % (Math.PI * 2);
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
    const zone = new THREE.LineLoop(ZONE_GEO, ZONE_MAT);
    zone.position.set(s.ax, MINER_DEPTH - 0.2, s.az);
    this.group.add(root, beam, hitGlow, zone);
    const label = document.createElement("div");
    label.className = "miner-label";
    this.labels.appendChild(label);
    const m: Miner = {
      id, root, beam, hitGlow, label, status, zone,
      pos: new THREE.Vector3(s.x, 0, s.z), anchor: new THREE.Vector3(s.ax, 0, s.az), stored: s.stored, owner: s.owner,
      state: MINER_STATUS[s.status] ?? "idle",
      turret: root.getObjectByName("Turret") ?? root,
      emitter: root.getObjectByName("MinerEmitter") ?? root,
      targetId: "", power: 0,
      age: MINER_STATUS[s.status] === "deploying" ? 0 : 10, // only pop in when freshly deployed
    };
    if (m.age === 0) root.scale.setScalar(0.001);
    this.byId.set(id, m);
    this.list.push(m);
    return m;
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

  sync(states: MapLike<MinerState>, dt: number, time: number, field: AsteroidField, fx: Effects, camera: THREE.Camera,
    zoneRadius: number) {
    states.forEach((s, id) => {
      const m = this.byId.get(id) ?? this.create(id, s);
      // ease towards the server position (synced at 20 Hz) so hovering looks smooth
      const k = Math.min(1, 6 * dt);
      m.pos.x += (s.x - m.pos.x) * k;
      m.pos.z += (s.z - m.pos.z) * k;
      m.anchor.set(s.ax, 0, s.az);
      m.zone.position.set(s.ax, MINER_DEPTH - 0.2, s.az);
      m.zone.scale.setScalar(zoneRadius);
      m.stored = s.stored;
      m.state = MINER_STATUS[s.status] ?? "idle";
      m.targetId = s.target;
      m.owner = s.owner;
    });
    for (let i = this.list.length - 1; i >= 0; i--) {
      const m = this.list[i];
      if (!states.get(m.id)) {
        this.group.remove(m.root, m.beam, m.hitGlow, m.zone);
        m.label.remove();
        this.byId.delete(m.id);
        this.list.splice(i, 1);
      }
    }

    const camPos = camera.getWorldPosition(new THREE.Vector3());
    for (const m of this.list) {
      m.age += dt;
      // hover: gentle bob and tilt, a little more while moving
      const ph = parseInt(m.id.slice(1), 36);
      m.root.position.set(m.pos.x, MINER_DEPTH + Math.sin(time * 1.6 + ph) * 0.12, m.pos.z);
      m.root.rotation.x = Math.sin(time * 1.1 + ph) * (m.state === "moving" ? 0.08 : 0.03);
      m.root.rotation.z = Math.cos(time * 0.9 + ph) * (m.state === "moving" ? 0.08 : 0.03);
      if (m.age < 0.8) {
        const k = m.age / 0.8;
        m.root.scale.setScalar(Math.max(0.001, 1 + 2.7 * (k - 1) ** 3 + 1.7 * (k - 1) ** 2));
      } else m.root.scale.setScalar(1);

      const target = m.targetId ? field.get(m.targetId) : undefined;
      let aligned = false;
      if (target) {
        const want = Math.atan2(-(target.pos.z - m.pos.z), target.pos.x - m.pos.x) - m.root.rotation.y;
        const cur = m.turret.rotation.y;
        const diff = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        m.turret.rotation.y = cur + THREE.MathUtils.clamp(diff, -3 * dt, 3 * dt);
        aligned = Math.abs(diff) < 0.2;
      }
      const firing = m.state === "mining" && aligned;
      m.power += ((firing ? 1 : 0) - m.power) * Math.min(1, 8 * dt);
      m.beam.visible = m.hitGlow.visible = m.power > 0.03 && !!target;
      if (m.beam.visible && target) {
        m.root.updateMatrixWorld();
        const start = m.emitter.getWorldPosition(tmpV).clone();
        const dir = target.pos.clone().sub(start).setY(0).normalize();
        const end = target.pos.clone().addScaledVector(dir, -target.radius * 0.85);
        placeBeam(m.beam, start, end, camPos, 0.1);
        const u = (m.beam.material as THREE.ShaderMaterial).uniforms;
        u.uTime.value = time;
        u.uPower.value = m.power * (0.9 + 0.1 * Math.sin(time * 60));
        m.hitGlow.position.copy(end);
        m.hitGlow.scale.setScalar(0.7 * m.power);
        fx.drillImpact(end, dir.clone().negate(), dt * 0.5);
      }
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
      m.label.innerHTML = `MINER <b>${Math.floor(m.stored)}/${MINER.capacity}</b><br><span>${STATUS_TEXT[m.state]}</span>`;
    }
  }
}
