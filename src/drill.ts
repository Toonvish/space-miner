import * as THREE from "three";
import type { Asteroid, AsteroidField } from "./asteroids";
import type { Effects } from "./fx";
import { glowTexture } from "./particles";

export const DRILL = {
  range: 11, // base reach from ship centre to asteroid surface (Beam Optics upgrades it)
  cone: THREE.MathUtils.degToRad(38), // auto-aim half angle in front of the ship
  dps: 24, // damage per second (asteroid hp = 8 * r²)
  beamWidth: 0.16,
  rampUp: 8, // how fast the beam reaches full power
};

const beamVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const beamFragment = /* glsl */ `
  uniform float uTime, uPower, uLen;
  uniform vec3 uCore, uColor;
  varying vec2 vUv;
  void main() {
    float x = (vUv.x - 0.5) * 2.0;
    float core = exp(-x * x * 28.0);
    float glow = exp(-x * x * 3.5) * 0.45;
    float flow = 0.75 + 0.25 * sin(vUv.y * uLen * 5.0 - uTime * 45.0);
    float ends = smoothstep(0.0, 0.03, vUv.y) * smoothstep(1.0, 0.97, vUv.y);
    vec3 c = (uCore * core + uColor * glow * flow) * uPower * ends;
    gl_FragColor = vec4(c, 1.0);
  }`;

export function makeBeam(core = new THREE.Color(1, 0.9, 0.75).multiplyScalar(3), color = new THREE.Color("#ff5a1a").multiplyScalar(2)) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: beamVertex,
    fragmentShader: beamFragment,
    uniforms: {
      uTime: { value: 0 },
      uPower: { value: 0 },
      uLen: { value: 1 },
      uCore: { value: core },
      uColor: { value: color },
    },
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.frustumCulled = false;
  return m;
}

const tmpBasis = new THREE.Matrix4();
const tmpSide = new THREE.Vector3();
const tmpView = new THREE.Vector3();
const tmpNorm = new THREE.Vector3();

/** Orient a unit plane as a camera-facing ribbon from a to b. */
export function placeBeam(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, cam: THREE.Vector3, width: number) {
  const axis = b.clone().sub(a);
  const len = axis.length();
  if (len < 1e-4) return;
  axis.divideScalar(len);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  tmpView.copy(cam).sub(mid).normalize();
  tmpSide.crossVectors(axis, tmpView).normalize();
  tmpNorm.crossVectors(tmpSide, axis);
  tmpBasis.makeBasis(tmpSide, axis, tmpNorm);
  mesh.quaternion.setFromRotationMatrix(tmpBasis);
  mesh.position.copy(mid);
  mesh.scale.set(width, len, 1);
  (mesh.material as THREE.ShaderMaterial).uniforms.uLen.value = len;
}

export interface DrillResult {
  destroyed: Asteroid | null;
}

/**
 * Twin mining lasers from the wing-pod barrels. Auto-targets the best asteroid in a
 * forward cone; beams converge on the asteroid surface point facing the ship.
 */
export class Drill {
  readonly group = new THREE.Group(); // world space
  target: Asteroid | null = null;
  dpsMul = 1; // upgraded by the Laser Lab
  range = DRILL.range; // upgraded by Beam Optics
  private beams = [makeBeam(), makeBeam()];
  private power = 0;
  private hitGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color: new THREE.Color("#ffa060").multiplyScalar(2.5),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  private hitLight = new THREE.PointLight("#ff8a40", 0, 8, 2);
  private raycaster = new THREE.Raycaster();
  readonly hitPoint = new THREE.Vector3();

  constructor(private mounts: THREE.Object3D[]) {
    this.group.add(...this.beams, this.hitGlow, this.hitLight);
    this.hitGlow.visible = false;
  }

  /** Best asteroid in the forward cone, preferring small angles, then distance. */
  private pickTarget(pos: THREE.Vector3, fwd: THREE.Vector3, field: AsteroidField): Asteroid | null {
    let best: Asteroid | null = null;
    let bestScore = Infinity;
    for (const a of field.list) {
      const dx = a.pos.x - pos.x;
      const dz = a.pos.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist - a.radius > this.range) continue;
      const ang = Math.acos(THREE.MathUtils.clamp((dx * fwd.x + dz * fwd.z) / dist, -1, 1));
      const slack = Math.atan2(a.radius, dist); // big/near rocks are easier to hit
      // keep the current target a bit longer so the beam doesn't flicker between rocks
      const cone = DRILL.cone + slack + (a === this.target ? 0.15 : 0);
      if (ang > cone) continue;
      const score = ang / cone + dist / this.range;
      if (score < bestScore) {
        bestScore = score;
        best = a;
      }
    }
    return best;
  }

  update(
    dt: number, time: number, firing: boolean,
    shipPos: THREE.Vector3, shipFwd: THREE.Vector3,
    field: AsteroidField, camera: THREE.Camera, fx: Effects,
  ): DrillResult {
    const result: DrillResult = { destroyed: null };
    this.power += ((firing ? 1 : 0) - this.power) * Math.min(1, DRILL.rampUp * dt);
    this.target = firing ? this.pickTarget(shipPos, shipFwd, field) : null;

    const visible = this.power > 0.02;
    for (const b of this.beams) b.visible = visible;
    this.hitGlow.visible = false;
    this.hitLight.intensity = 0;
    if (!visible) return result;

    const starts = this.mounts.map((m) => m.getWorldPosition(new THREE.Vector3()));
    const origin = starts.reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(starts.length);

    let end: THREE.Vector3;
    let hit = false;
    if (this.target) {
      const t = this.target;
      const dir = t.pos.clone().sub(origin).normalize();
      this.raycaster.set(origin, dir);
      this.raycaster.far = this.range + t.radius * 2;
      const hits = this.raycaster.intersectObject(t.mesh, false);
      end = hits.length ? hits[0].point : t.pos.clone().addScaledVector(dir, -t.radius);
      hit = true;
    } else {
      end = origin.clone().addScaledVector(shipFwd, this.range); // miss: beam into empty space
    }
    this.hitPoint.copy(end);

    const camPos = camera.getWorldPosition(new THREE.Vector3());
    this.beams.forEach((b, i) => {
      placeBeam(b, starts[i] ?? origin, end, camPos, DRILL.beamWidth);
      const u = (b.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = time + i * 0.37;
      u.uPower.value = this.power * (hit ? 1 : 0.45) * (0.9 + 0.1 * Math.sin(time * 70 + i));
    });

    if (hit && this.target) {
      const t = this.target;
      const normal = end.clone().sub(t.pos).setY(0).normalize();
      this.hitGlow.visible = true;
      this.hitGlow.position.copy(end).addScaledVector(normal, 0.1);
      this.hitGlow.scale.setScalar((0.9 + Math.random() * 0.4) * this.power);
      this.hitLight.position.copy(end).addScaledVector(normal, 0.6);
      this.hitLight.intensity = 6 * this.power;
      fx.drillImpact(end, normal, dt);
      t.shake = Math.max(t.shake, 0.06);
      t.hp -= DRILL.dps * this.dpsMul * this.power * dt;
      if (t.hp <= 0) {
        result.destroyed = t;
        this.target = null;
      }
    }
    return result;
  }
}
