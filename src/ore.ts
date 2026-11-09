import * as THREE from "three";
import type { OreState } from "../shared/schema";

interface OreView {
  mesh: THREE.Mesh;
  spin: THREE.Vector3;
}

interface MapLike<T> {
  forEach(cb: (value: T, key: string) => void): void;
  get(key: string): T | undefined;
}

/** Glowing ore crystals (server-simulated; rendered with smoothing). */
export class OreField {
  readonly group = new THREE.Group();
  private items = new Map<string, OreView>();
  private geo = new THREE.OctahedronGeometry(0.17, 0);
  private mat = new THREE.MeshStandardMaterial({
    color: "#ffb547",
    emissive: "#ff9420",
    emissiveIntensity: 2.2,
    metalness: 0.3,
    roughness: 0.3,
    flatShading: true,
  });

  constructor() {
    this.geo.scale(1, 1.6, 1);
  }

  get positions(): THREE.Vector3[] {
    return [...this.items.values()].map((o) => o.mesh.position);
  }

  sync(states: MapLike<OreState>, dt: number) {
    states.forEach((s, id) => {
      let o = this.items.get(id);
      if (!o) {
        const mesh = new THREE.Mesh(this.geo, this.mat);
        mesh.position.set(s.x, 0, s.z);
        this.group.add(mesh);
        o = { mesh, spin: new THREE.Vector3(Math.random() * 3, Math.random() * 3, 0) };
        this.items.set(id, o);
      }
      const k = Math.min(1, 14 * dt);
      o.mesh.position.x += (s.x - o.mesh.position.x) * k;
      o.mesh.position.z += (s.z - o.mesh.position.z) * k;
      o.mesh.rotation.x += o.spin.x * dt;
      o.mesh.rotation.y += o.spin.y * dt;
    });
    for (const [id, o] of this.items) {
      if (!states.get(id)) {
        this.group.remove(o.mesh);
        this.items.delete(id);
      }
    }
  }
}
