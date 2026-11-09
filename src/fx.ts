import * as THREE from "three";
import { ParticlePool, glowTexture } from "./particles";

interface Debris {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  axis: THREE.Vector3;
  spin: number;
  size: number;
  age: number;
  life: number;
}

interface Flash {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  size: number;
}

const MAX_DEBRIS = 220;
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();

/**
 * World-space effects for mining: drill sparks, rock dust, tumbling debris chunks,
 * explosion flashes and camera shake. Uses a fixed number of lights (no shader recompiles).
 */
export class Effects {
  readonly group = new THREE.Group();
  shake = 0;

  private sparks = new ParticlePool(600, {
    size: 30, grow: 0.6, hot: new THREE.Color(1.0, 0.75, 0.4).multiplyScalar(3), cool: "#a2380f", gain: 1.0, drag: 2.5,
  });
  private dust = new ParticlePool(500, {
    size: 160, grow: 3.0, hot: "#9a8b7a", cool: "#2a2420", gain: 0.12, drag: 1.8,
  });
  private debris: Debris[] = [];
  private debrisMesh: THREE.InstancedMesh;
  private flashes: Flash[] = [];
  private blastLight = new THREE.PointLight("#ffb070", 0, 14, 2);

  constructor(rockGeo: THREE.BufferGeometry, rockMat: THREE.Material) {
    this.debrisMesh = new THREE.InstancedMesh(rockGeo, rockMat, MAX_DEBRIS);
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    this.group.add(this.sparks.points, this.dust.points, this.debrisMesh, this.blastLight);
  }

  /** Continuous drill contact: call every frame while drilling. */
  drillImpact(p: THREE.Vector3, normal: THREE.Vector3, dt: number) {
    const n = Math.max(1, Math.round(dt * 140));
    for (let i = 0; i < n; i++) {
      const v = normal.clone().multiplyScalar(3 + Math.random() * 5);
      v.x += (Math.random() - 0.5) * 6;
      v.y += (Math.random() - 0.5) * 3;
      v.z += (Math.random() - 0.5) * 6;
      this.sparks.spawn(p.x, p.y, p.z, v.x, v.y, v.z, 0.2 + Math.random() * 0.35, Math.random() * dt);
    }
    if (Math.random() < dt * 25) {
      const v = normal.clone().multiplyScalar(1 + Math.random() * 1.5);
      this.dust.spawn(p.x, p.y, p.z, v.x + (Math.random() - 0.5), 0, v.z + (Math.random() - 0.5), 0.8 + Math.random() * 0.8);
    }
  }

  explode(pos: THREE.Vector3, radius: number, vel: THREE.Vector3, shakeScale = 1) {
    this.flash(pos, radius * 1.8, 0.35);
    this.blastLight.position.copy(pos).setY(1.5);
    this.blastLight.intensity = 30 + radius * 20;
    this.shake = Math.min(1, this.shake + (0.25 + radius * 0.1) * shakeScale);

    for (let i = 0; i < 60 + radius * 40; i++) {
      const d = new THREE.Vector3().randomDirection();
      d.y *= 0.4;
      const v = d.multiplyScalar(4 + Math.random() * 10 * Math.sqrt(radius)).add(vel);
      this.sparks.spawn(pos.x, pos.y, pos.z, v.x, v.y, v.z, 0.3 + Math.random() * 0.6);
    }
    for (let i = 0; i < 20 + radius * 12; i++) {
      const d = new THREE.Vector3().randomDirection();
      d.y *= 0.3;
      const p = pos.clone().addScaledVector(d, Math.random() * radius * 0.8);
      const v = d.multiplyScalar(1 + Math.random() * 3).add(vel);
      this.dust.spawn(p.x, p.y, p.z, v.x, v.y, v.z, 1.2 + Math.random() * 1.6);
    }
    const chunks = Math.round(6 + radius * 5);
    for (let i = 0; i < chunks && this.debris.length < MAX_DEBRIS; i++) {
      const d = new THREE.Vector3().randomDirection();
      d.y *= 0.35;
      this.debris.push({
        pos: pos.clone().addScaledVector(d, radius * 0.5 * Math.random()),
        vel: d.clone().multiplyScalar(2 + Math.random() * 6).add(vel),
        quat: new THREE.Quaternion().random(),
        axis: new THREE.Vector3().randomDirection(),
        spin: (Math.random() - 0.5) * 8,
        size: (0.04 + Math.random() * 0.1) * Math.min(radius, 2.5),
        age: 0,
        life: 1.2 + Math.random() * 1.6,
      });
    }
  }

  flash(pos: THREE.Vector3, size: number, life: number) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        color: new THREE.Color("#ffc890").multiplyScalar(1.4),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    sprite.position.copy(pos).setY(1);
    this.group.add(sprite);
    this.flashes.push({ sprite, age: 0, life, size });
  }

  update(dt: number) {
    this.sparks.update(dt);
    this.dust.update(dt);
    this.shake *= Math.exp(-5 * dt);
    this.blastLight.intensity *= Math.exp(-9 * dt);

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.age += dt;
      const k = f.age / f.life;
      if (k >= 1) {
        this.group.remove(f.sprite);
        f.sprite.material.dispose();
        this.flashes.splice(i, 1);
        continue;
      }
      f.sprite.scale.setScalar(f.size * (0.6 + k * 0.8));
      f.sprite.material.opacity = (1 - k) ** 2;
    }

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      if (d.age >= d.life) {
        this.debris[i] = this.debris[this.debris.length - 1];
        this.debris.pop();
        continue;
      }
      d.vel.multiplyScalar(Math.exp(-0.6 * dt));
      d.pos.addScaledVector(d.vel, dt);
      d.quat.premultiply(tmpQ.setFromAxisAngle(d.axis, d.spin * dt));
    }
    for (let i = 0; i < this.debris.length; i++) {
      const d = this.debris[i];
      const shrink = Math.min(1, (d.life - d.age) / 0.8); // shrink out at end of life
      tmpS.setScalar(d.size * shrink);
      tmpM.compose(d.pos, d.quat, tmpS);
      this.debrisMesh.setMatrixAt(i, tmpM);
    }
    this.debrisMesh.count = this.debris.length;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
  }
}
