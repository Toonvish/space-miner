import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { asteroidPosAt, asteroidVelAt, hash } from "../shared/config";
import type { AsteroidState } from "../shared/schema";

/** Client-side view of one server asteroid. */
export interface Asteroid {
  id: string;
  mesh: THREE.Mesh;
  pos: THREE.Vector3; // extrapolated from the synced motion parameters
  vel: THREE.Vector3;
  radius: number;
  hp: number;
  maxHp: number;
  spinAxis: THREE.Vector3;
  spin: number;
  shake: number;
}

interface MapLike<T> {
  forEach(cb: (value: T, key: string) => void): void;
  get(key: string): T | undefined;
}

const tmpQ = new THREE.Quaternion();

/** Renders the server's asteroid map. Motion is extrapolated (no per-tick position sync). */
export class AsteroidField {
  readonly group = new THREE.Group();
  readonly list: Asteroid[] = [];
  private byId = new Map<string, Asteroid>();

  static async load(url: string): Promise<AsteroidField> {
    const gltf = await new GLTFLoader().loadAsync(url);
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    meshes.sort((a, b) => a.name.localeCompare(b.name));
    const geos = meshes.map((m) => {
      const g = m.geometry.clone();
      g.computeBoundingSphere();
      const s = g.boundingSphere!;
      g.translate(-s.center.x, -s.center.y, -s.center.z);
      g.scale(1 / s.radius, 1 / s.radius, 1 / s.radius); // unit radius
      g.computeBoundingSphere();
      return g;
    });
    return new AsteroidField(geos, meshes[0].material as THREE.Material);
  }

  private constructor(readonly variants: THREE.BufferGeometry[], readonly material: THREE.Material) {}

  private create(id: string, s: AsteroidState): Asteroid {
    // cosmetic randomness derived from the id, so every client sees the same rock
    let h = hash(id);
    const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0) % 10000) / 10000;
    const mesh = new THREE.Mesh(this.variants[Math.floor(rnd() * this.variants.length)], this.material);
    const r = s.r;
    mesh.scale.set(r * (0.85 + rnd() * 0.3), r * (0.85 + rnd() * 0.3), r * (0.85 + rnd() * 0.3));
    mesh.quaternion.setFromEuler(new THREE.Euler(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28));
    mesh.receiveShadow = true;
    this.group.add(mesh);
    const a: Asteroid = {
      id, mesh, radius: r, hp: s.hp, maxHp: s.maxHp,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      spinAxis: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
      spin: (rnd() - 0.5) * (1.2 / r),
      shake: 0,
    };
    this.byId.set(id, a);
    this.list.push(a);
    return a;
  }

  get(id: string) { return this.byId.get(id); }

  /** Reconcile with the synced map and advance visuals to server time `t`. */
  sync(states: MapLike<AsteroidState>, t: number, dt: number) {
    states.forEach((s, id) => {
      const a = this.byId.get(id) ?? this.create(id, s);
      if (s.hp < a.hp - 0.01) a.shake = Math.max(a.shake, 0.06); // being drilled
      a.hp = s.hp;
      a.maxHp = s.maxHp;
      const p = asteroidPosAt(s, t);
      const v = asteroidVelAt(s, t);
      a.pos.set(p.x, 0, p.z);
      a.vel.set(v.vx, 0, v.vz);
    });
    for (let i = this.list.length - 1; i >= 0; i--) {
      const a = this.list[i];
      if (!states.get(a.id)) {
        this.group.remove(a.mesh);
        this.byId.delete(a.id);
        this.list.splice(i, 1);
        continue;
      }
      tmpQ.setFromAxisAngle(a.spinAxis, a.spin * dt);
      a.mesh.quaternion.premultiply(tmpQ);
      a.mesh.position.copy(a.pos);
      if (a.shake > 0.001) {
        a.mesh.position.x += (Math.random() - 0.5) * a.shake;
        a.mesh.position.z += (Math.random() - 0.5) * a.shake;
        a.shake *= Math.exp(-12 * dt);
      }
      a.mesh.updateMatrixWorld();
    }
  }

  /** Client-side ship bounce (asteroids are server-owned and don't move from it). */
  collide(pos: THREE.Vector3, vel: THREE.Vector3, shipRadius: number): number {
    let impact = 0;
    for (const a of this.list) {
      const dx = pos.x - a.pos.x;
      const dz = pos.z - a.pos.z;
      const dist = Math.hypot(dx, dz);
      const minD = a.radius * 0.92 + shipRadius;
      if (dist >= minD || dist === 0) continue;
      const nx = dx / dist;
      const nz = dz / dist;
      pos.x += nx * (minD - dist);
      pos.z += nz * (minD - dist);
      const vn = (vel.x - a.vel.x) * nx + (vel.z - a.vel.z) * nz;
      if (vn < 0) {
        vel.x -= 1.35 * vn * nx;
        vel.z -= 1.35 * vn * nz;
        impact = Math.max(impact, -vn);
      }
    }
    return impact;
  }
}
