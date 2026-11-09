import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MODULES, MODULE_ORDER, type ModuleId } from "../shared/upgrades";
import { STATION } from "../shared/config";

export { STATION };


const isGlow = (name: string) => /Glow$/.test(name);

interface Building {
  obj: THREE.Object3D;
  t: number;
}

/** The home station: a core hub whose four arms grow one piece per module level. */
export class Station {
  readonly root = new THREE.Group();
  private pieces = new Map<string, THREE.Object3D>();
  private arms = new Map<ModuleId, THREE.Object3D[]>();
  private building: Building[] = [];
  private beacon?: THREE.MeshBasicMaterial;
  private beaconBase = new THREE.Color();

  static async load(url: string): Promise<Station> {
    const gltf = await new GLTFLoader().loadAsync(url);
    return new Station(gltf.scene);
  }

  private constructor(scene: THREE.Object3D) {
    // glowing materials -> unlit HDR colour (bloom picks them up)
    const glow = new Map<string, THREE.MeshBasicMaterial>();
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshStandardMaterial;
      if (isGlow(src.name)) {
        let m = glow.get(src.name);
        if (!m) {
          m = new THREE.MeshBasicMaterial({
            name: src.name,
            color: src.emissive.clone().multiplyScalar(src.emissiveIntensity * 0.5),
          });
          glow.set(src.name, m);
        }
        mesh.material = m;
      } else {
        mesh.receiveShadow = true;
      }
    });
    this.beacon = glow.get("BeaconGlow");
    if (this.beacon) this.beaconBase.copy(this.beacon.color);

    for (const name of ["Core", ...MODULE_ORDER.map((id) => MODULES[id].piece)]) {
      const node = scene.getObjectByName(name);
      if (node) this.pieces.set(name, node);
    }
    this.root.position.y = STATION.depth;
    const core = this.pieces.get("Core");
    if (core) this.root.add(core.clone(true));
    for (const id of MODULE_ORDER) this.arms.set(id, []);
  }

  /** Make the arm for `id` show exactly `level` pieces (animate newly added ones). */
  setLevel(id: ModuleId, level: number, animate = false): THREE.Vector3[] {
    const def = MODULES[id];
    const arm = this.arms.get(id)!;
    const added: THREE.Vector3[] = [];
    const src = this.pieces.get(def.piece);
    if (!src) return added;
    while (arm.length < level) {
      const k = arm.length;
      const piece = src.clone(true);
      const r = STATION.socketRadius + k * STATION.moduleLength;
      // Blender +X arm direction maps to (cos a, 0, -sin a) in three.js
      piece.position.set(Math.cos(def.angle) * r, 0, -Math.sin(def.angle) * r);
      piece.rotation.y = def.angle;
      this.root.add(piece);
      arm.push(piece);
      if (animate) {
        piece.scale.setScalar(0.001);
        this.building.push({ obj: piece, t: 0 });
      }
      const centre = new THREE.Vector3(2.5, 0, 0).applyEuler(piece.rotation).add(piece.position);
      added.push(centre.add(this.root.position));
    }
    while (arm.length > level) this.root.remove(arm.pop()!);
    return added;
  }

  update(dt: number, time: number) {
    for (let i = this.building.length - 1; i >= 0; i--) {
      const b = this.building[i];
      b.t = Math.min(1, b.t + dt / 0.9);
      // ease-out-back: pops slightly past full size then settles
      const c = 1.7;
      const x = b.t - 1;
      b.obj.scale.setScalar(Math.max(0.001, 1 + (c + 1) * x ** 3 + c * x ** 2));
      if (b.t >= 1) this.building.splice(i, 1);
    }
    if (this.beacon) {
      const on = time % 1.6 < 0.15 ? 1 : 0.08;
      this.beacon.color.copy(this.beaconBase).multiplyScalar(on);
    }
  }
}
