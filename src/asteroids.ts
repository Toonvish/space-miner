import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface Asteroid {
  id: number;
  mesh: THREE.Mesh;
  pos: THREE.Vector3; // logical position (mesh may be offset by shake)
  vel: THREE.Vector3;
  radius: number; // collision / gameplay radius
  hp: number;
  maxHp: number;
  spinAxis: THREE.Vector3;
  spin: number; // rad/s
  shake: number; // visual shake amount, decays
}

export const ASTEROIDS = {
  targetCount: 45, // kept around the player
  spawnMin: 75, // new asteroids appear this far away (outside the view)
  spawnMax: 125,
  despawn: 160,
  minRadius: 0.9,
  maxRadius: 4.5,
  splitRadius: 1.8, // bigger than this splits into fragments on destruction
  hpPerArea: 8, // hp = hpPerArea * r²
  clearRadius: 34, // keep the area around the station (at the origin) free
};

const tmpQ = new THREE.Quaternion();

export class AsteroidField {
  readonly group = new THREE.Group();
  readonly list: Asteroid[] = [];
  /** Points (e.g. deployed miners) around which asteroids are never despawned. */
  anchors: { pos: THREE.Vector3; radius: number }[] = [];
  private nextId = 1;

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

  /** Fill the area around `center`, keeping a clear zone for the player. */
  populate(center: THREE.Vector3) {
    let guard = 0;
    while (this.list.length < ASTEROIDS.targetCount && guard++ < 2000) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * ASTEROIDS.spawnMax;
      this.trySpawn(new THREE.Vector3(center.x + Math.cos(a) * d, 0, center.z + Math.sin(a) * d));
    }
  }

  private randomRadius() {
    return ASTEROIDS.minRadius + Math.random() ** 2.2 * (ASTEROIDS.maxRadius - ASTEROIDS.minRadius);
  }

  private trySpawn(pos: THREE.Vector3, radius = this.randomRadius()): Asteroid | null {
    if (Math.hypot(pos.x, pos.z) < ASTEROIDS.clearRadius + radius) return null;
    for (const o of this.list) {
      if (o.pos.distanceTo(pos) < o.radius + radius + 2) return null;
    }
    const drift = new THREE.Vector3((Math.random() - 0.5) * 1.2, 0, (Math.random() - 0.5) * 1.2);
    return this.spawn(pos, radius, drift);
  }

  spawn(pos: THREE.Vector3, radius: number, vel: THREE.Vector3): Asteroid {
    const geo = this.variants[Math.floor(Math.random() * this.variants.length)];
    const mesh = new THREE.Mesh(geo, this.material);
    // per-instance stretch for variety; gameplay radius stays the mean
    mesh.scale.set(
      radius * (0.85 + Math.random() * 0.3),
      radius * (0.85 + Math.random() * 0.3),
      radius * (0.85 + Math.random() * 0.3),
    );
    mesh.quaternion.random();
    mesh.receiveShadow = true;
    mesh.position.copy(pos);
    this.group.add(mesh);
    const maxHp = ASTEROIDS.hpPerArea * radius * radius;
    const a: Asteroid = {
      id: this.nextId++,
      mesh,
      pos: pos.clone(),
      vel,
      radius,
      hp: maxHp,
      maxHp,
      spinAxis: new THREE.Vector3().randomDirection(),
      spin: (Math.random() - 0.5) * (1.2 / radius),
      shake: 0,
    };
    this.list.push(a);
    return a;
  }

  remove(a: Asteroid) {
    const i = this.list.indexOf(a);
    if (i >= 0) this.list.splice(i, 1);
    this.group.remove(a.mesh);
  }

  /** Remove `a`; large asteroids break into 2-3 smaller ones flying apart. */
  destroy(a: Asteroid): Asteroid[] {
    this.remove(a);
    if (a.radius <= ASTEROIDS.splitRadius) return [];
    const n = a.radius > 3.2 ? 3 : 2;
    const children: Asteroid[] = [];
    const base = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const ang = base + (i / n) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
      const r = a.radius * (n === 3 ? 0.5 : 0.6) * (0.9 + Math.random() * 0.2);
      const pos = a.pos.clone().addScaledVector(dir, a.radius * 0.5);
      const vel = a.vel.clone().addScaledVector(dir, 1.5 + Math.random() * 1.5);
      children.push(this.spawn(pos, r, vel));
    }
    return children;
  }

  update(dt: number, player: THREE.Vector3) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const a = this.list[i];
      // gently push drifting rocks out of the station's clear zone
      const fromStation = Math.hypot(a.pos.x, a.pos.z);
      if (fromStation < ASTEROIDS.clearRadius * 0.85 && fromStation > 0) {
        a.vel.x += (a.pos.x / fromStation) * 0.8 * dt;
        a.vel.z += (a.pos.z / fromStation) * 0.8 * dt;
      }
      a.pos.addScaledVector(a.vel, dt);
      a.vel.multiplyScalar(Math.exp(-0.05 * dt)); // fragments settle down slowly
      if (a.pos.distanceTo(player) > ASTEROIDS.despawn && !this.anchors.some((n) => n.pos.distanceTo(a.pos) < n.radius)) {
        this.remove(a);
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
    // keep the field populated just outside the visible area
    let guard = 0;
    while (this.list.length < ASTEROIDS.targetCount && guard++ < 20) {
      const ang = Math.random() * Math.PI * 2;
      const d = ASTEROIDS.spawnMin + Math.random() * (ASTEROIDS.spawnMax - ASTEROIDS.spawnMin);
      this.trySpawn(new THREE.Vector3(player.x + Math.cos(ang) * d, 0, player.z + Math.sin(ang) * d));
    }
  }

  /**
   * Circle-vs-circle collision with the ship on the XZ plane (mass ∝ r²).
   * Returns the impact speed (0 if no contact) for camera shake.
   */
  collide(pos: THREE.Vector3, vel: THREE.Vector3, shipRadius: number, shipMass = 1.5): number {
    let impact = 0;
    for (const a of this.list) {
      const dx = pos.x - a.pos.x;
      const dz = pos.z - a.pos.z;
      const dist = Math.hypot(dx, dz);
      const minD = a.radius * 0.92 + shipRadius;
      if (dist >= minD || dist === 0) continue;
      const nx = dx / dist;
      const nz = dz / dist;
      const astMass = a.radius * a.radius * 2;
      // separate proportionally to inverse mass
      const pen = minD - dist;
      const wShip = astMass / (astMass + shipMass);
      pos.x += nx * pen * wShip;
      pos.z += nz * pen * wShip;
      a.pos.x -= nx * pen * (1 - wShip);
      a.pos.z -= nz * pen * (1 - wShip);
      // bounce
      const vn = (vel.x - a.vel.x) * nx + (vel.z - a.vel.z) * nz;
      if (vn < 0) {
        const e = 0.35;
        const j = (-(1 + e) * vn) / (1 / shipMass + 1 / astMass);
        vel.x += (nx * j) / shipMass;
        vel.z += (nz * j) / shipMass;
        a.vel.x -= (nx * j) / astMass;
        a.vel.z -= (nz * j) / astMass;
        impact = Math.max(impact, -vn);
      }
    }
    return impact;
  }
}
