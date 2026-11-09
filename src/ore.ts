import * as THREE from "three";

interface Ore {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
}

export const ORE = {
  magnetPull: 40,
  collectRange: 1.1,
  lifetime: 40, // seconds before an uncollected crystal fades
};

/** Glowing ore crystals dropped by destroyed asteroids; pulled in by the ship. */
export class OreField {
  readonly group = new THREE.Group();
  readonly items: Ore[] = [];
  magnetRange = 6; // upgraded by the Tractor Array
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

  spawn(pos: THREE.Vector3, count: number, baseVel: THREE.Vector3) {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.geo, this.mat);
      const a = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 3;
      mesh.position.copy(pos).add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(Math.random() * 0.8));
      mesh.position.y = 0;
      this.group.add(mesh);
      this.items.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(a) * sp, 0, Math.sin(a) * sp).add(baseVel),
        spin: new THREE.Vector3(Math.random() * 3, Math.random() * 3, Math.random() * 3),
        age: 0,
      });
    }
  }

  /** Collects at most `space` crystals (free cargo). Returns how many were collected. */
  update(dt: number, ship: THREE.Vector3, space: number): number {
    let collected = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const o = this.items[i];
      o.age += dt;
      const p = o.mesh.position;
      const dx = ship.x - p.x;
      const dz = ship.z - p.z;
      const d = Math.hypot(dx, dz);
      const canTake = collected < space;
      if (canTake && d < ORE.collectRange) {
        collected++;
        this.group.remove(o.mesh);
        this.items.splice(i, 1);
        continue;
      }
      if (o.age > ORE.lifetime) {
        this.group.remove(o.mesh);
        this.items.splice(i, 1);
        continue;
      }
      if (canTake && d < this.magnetRange && o.age > 0.4) {
        const pull = (ORE.magnetPull / (d + 0.5)) * dt;
        o.vel.x += (dx / d) * pull;
        o.vel.z += (dz / d) * pull;
        o.vel.multiplyScalar(Math.exp(-2.5 * dt)); // damp orbiting
      } else {
        o.vel.multiplyScalar(Math.exp(-1.2 * dt));
      }
      p.addScaledVector(o.vel, dt);
      o.mesh.rotation.x += o.spin.x * dt;
      o.mesh.rotation.y += o.spin.y * dt;
      // blink during the last 5 seconds
      o.mesh.visible = o.age < ORE.lifetime - 5 || Math.floor(o.age * 6) % 2 === 0;
    }
    return collected;
  }
}
