import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRONE_STATUS, type DroneState, type DroneStatus } from "../shared/schema";
import { Thruster } from "./thruster";

/** Client view of a server-simulated cargo drone (a small autonomous ship). */
export interface Drone {
  id: string;
  root: THREE.Group;
  bank: THREE.Group;
  thruster: Thruster;
  pos: THREE.Vector3; // smoothed render position
  vel: THREE.Vector3;
  heading: number;
  state: DroneStatus;
  cargo: number;
  lastH: number;
}

interface MapLike<T> {
  forEach(cb: (value: T, key: string) => void): void;
  get(key: string): T | undefined;
}

export class DroneFleet {
  readonly group = new THREE.Group();
  readonly list: Drone[] = [];
  private byId = new Map<string, Drone>();

  static async load(url: string, scene: THREE.Scene): Promise<DroneFleet> {
    const gltf = await new GLTFLoader().loadAsync(url);
    return new DroneFleet(gltf.scene.getObjectByName("Drone") ?? gltf.scene, scene);
  }

  private constructor(private template: THREE.Object3D, private scene: THREE.Scene) {
    template.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshStandardMaterial;
      if (/Glow$/.test(src.name)) {
        mesh.material = new THREE.MeshBasicMaterial({
          name: src.name, color: src.emissive.clone().multiplyScalar(src.emissiveIntensity * 0.5),
        });
      } else {
        mesh.castShadow = mesh.receiveShadow = true;
      }
    });
  }

  private create(id: string, s: DroneState): Drone {
    const root = new THREE.Group();
    const bank = new THREE.Group();
    const model = this.template.clone(true);
    bank.add(model);
    root.add(bank);
    const thruster = new Thruster(false);
    thruster.group.scale.setScalar(0.45);
    (model.getObjectByName("DroneThruster") ?? model).add(thruster.group);
    this.group.add(root);
    this.scene.add(thruster.trail);
    const d: Drone = {
      id, root, bank, thruster,
      pos: new THREE.Vector3(s.x, 0, s.z), vel: new THREE.Vector3(),
      heading: s.h, lastH: s.h, state: DRONE_STATUS[s.status] ?? "parked", cargo: s.cargo,
    };
    this.byId.set(id, d);
    this.list.push(d);
    return d;
  }

  sync(states: MapLike<DroneState>, dt: number, time: number) {
    states.forEach((s, id) => {
      const d = this.byId.get(id) ?? this.create(id, s);
      d.state = DRONE_STATUS[s.status] ?? "parked";
      d.cargo = s.cargo;
      // extrapolate with the synced speed/heading, then smooth towards it
      d.vel.set(-Math.sin(s.h) * s.speed, 0, -Math.cos(s.h) * s.speed);
      const k = Math.min(1, 10 * dt);
      d.pos.x += (s.x - d.pos.x) * k + d.vel.x * dt * (1 - k);
      d.pos.z += (s.z - d.pos.z) * k + d.vel.z * dt * (1 - k);
      const dh = Math.atan2(Math.sin(s.h - d.heading), Math.cos(s.h - d.heading));
      d.heading += dh * k;
      const turnRate = dh / Math.max(dt, 1e-3);
      d.bank.rotation.z += (THREE.MathUtils.clamp(turnRate * 0.04, -0.5, 0.5) - d.bank.rotation.z) * k;
    });
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      if (!states.get(d.id)) {
        this.group.remove(d.root);
        this.scene.remove(d.thruster.trail);
        this.byId.delete(d.id);
        this.list.splice(i, 1);
        continue;
      }
      d.root.position.copy(d.pos);
      d.root.rotation.y = d.heading;
      d.root.updateMatrixWorld();
      const moving = d.state === "outbound" || d.state === "returning" || d.state === "waiting";
      d.thruster.update(dt, time, moving ? Math.min(1, d.vel.length() / 10) : 0.05, false, d.vel);
    }
  }
}
