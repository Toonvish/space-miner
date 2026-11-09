import * as THREE from "three";
import { ParticlePool, glowTexture } from "./particles";

/**
 * Engine exhaust: two nested additive plume cones (soft edges via view-angle falloff,
 * flicker and faint shock diamonds), a glow sprite at the nozzle, hot particles and a
 * point light. The plume points along local +Z (out of the nozzle).
 */
const plumeVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

const plumeFragment = /* glsl */ `
  uniform float uTime;
  uniform float uPower;
  uniform float uSeed;
  uniform vec3 uCore;
  uniform vec3 uEdge;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float t = vUv.y;                                  // 0 at nozzle, 1 at tip
    float a = vUv.x * 6.28318;
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float soft = pow(facing, 0.9);                    // fade at the silhouette
    float len = pow(1.0 - t, 1.5);
    float flick = 0.82 + 0.18 * sin(t * 22.0 - uTime * 45.0 + sin(a * 3.0 + uSeed) * 2.0);
    float diamonds = 1.0 + 0.4 * pow(0.5 + 0.5 * cos(t * 30.0), 8.0) * (1.0 - t);
    vec3 col = mix(uEdge, uCore, pow(facing, 3.0) * (1.0 - t * 0.8));
    gl_FragColor = vec4(col * soft * len * flick * diamonds * uPower, 1.0);
  }`;

function plume(radius: number, core: string, edge: string, seed: number, gain: number) {
  const geo = new THREE.ConeGeometry(radius, 1, 24, 12, true);
  geo.translate(0, -0.5, 0); // base at y=0, tip at y=-1
  geo.rotateX(-Math.PI / 2); // tip -> +Z
  const uv = geo.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i)); // 0 = nozzle
  const mat = new THREE.ShaderMaterial({
    vertexShader: plumeVertex,
    fragmentShader: plumeFragment,
    uniforms: {
      uTime: { value: 0 },
      uPower: { value: 0 },
      uSeed: { value: seed },
      uCore: { value: new THREE.Color(core).multiplyScalar(gain) },
      uEdge: { value: new THREE.Color(edge).multiplyScalar(gain) },
    },
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

export class Thruster {
  readonly group = new THREE.Group();
  private outer = plume(0.3, "#a8e4ff", "#2a6cff", 0, 1.3);
  private inner = plume(0.15, "#ffffff", "#9fdcff", 2.3, 2.2);
  private glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color: new THREE.Color("#7fc8ff").multiplyScalar(0.7),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  private light = new THREE.PointLight("#6cc0ff", 0, 5, 2);
  private glowMat?: THREE.MeshBasicMaterial;
  private glowBase = new THREE.Color();

  /** Hot sparks inside the plume (nozzle-local space: they turn with the ship). */
  private sparks = new ParticlePool(300, {
    size: 45, grow: 0.5, hot: new THREE.Color(0.8, 0.95, 1.0).multiplyScalar(2), cool: "#26f", gain: 0.8,
  });
  private sparkAcc = 0;

  /** Faint exhaust trail left behind in world space. Add `trail` to the scene. */
  private trailPool = new ParticlePool(500, {
    size: 80, grow: 2.8, hot: "#8fc8ff", cool: "#3a2a8a", gain: 0.3, drag: 1.2,
  });
  readonly trail = this.trailPool.points;
  private trailAcc = 0;
  private prevOrigin = new THREE.Vector3();
  private hasPrev = false;

  /** `light`: cast a small engine light on nearby geometry (keep it to one per ship). */
  constructor(private hasLight = true, private gain = 1) {
    this.inner.renderOrder = 2;
    this.outer.renderOrder = 1;
    this.glow.position.z = 0.08;
    this.light.position.z = 1.4;
    this.sparks.points.renderOrder = 3;
    this.group.add(this.outer, this.inner, this.glow, this.sparks.points);
    if (this.hasLight) this.group.add(this.light);
  }

  setGlowMaterial(mat: THREE.Material | undefined) {
    if (mat instanceof THREE.MeshBasicMaterial) {
      this.glowMat = mat;
      this.glowBase.copy(mat.color);
    }
  }

  update(dt: number, time: number, throttle: number, boost: boolean, shipVel: THREE.Vector3) {
    const power = throttle * (boost ? 1.45 : 1);
    const flick = 1 + Math.sin(time * 53) * 0.04 + Math.sin(time * 31.7) * 0.04;
    const idle = 0.12;
    const len = (idle + power * 1.6) * flick;
    const width = 0.75 + 0.3 * Math.min(power, 1.3);

    this.outer.scale.set(width, width, len);
    this.inner.scale.set(width, width, len * 0.6);
    for (const [m, p] of [[this.outer, 0.25 + power], [this.inner, 0.35 + power]] as const) {
      const u = (m.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = time;
      u.uPower.value = p * this.gain;
    }
    this.glow.scale.setScalar((0.22 + power * 0.45) * flick * Math.sqrt(this.gain));
    this.light.intensity = this.hasLight ? (0.1 + power * 1.2) * flick : 0;
    if (this.glowMat) this.glowMat.color.copy(this.glowBase).multiplyScalar(0.35 + power * 0.65);

    this.updateSparks(dt, power, len, width);
    this.updateTrail(dt, power, len, shipVel);
  }

  private updateSparks(dt: number, power: number, len: number, width: number) {
    // each spark travels about one plume length over its life
    this.sparkAcc += dt * (0.15 + power) * 80;
    let n = Math.floor(this.sparkAcc);
    this.sparkAcc -= n;
    while (n-- > 0) {
      const life = 0.18 + Math.random() * 0.22;
      const speed = (len * (0.8 + Math.random() * 0.7)) / life;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 0.12 * width;
      const c = Math.cos(a) * r, s = Math.sin(a) * r;
      // drift slightly toward the axis so sparks follow the narrowing cone
      this.sparks.spawn(c, s, 0, -c * 1.5, -s * 1.5, speed, life, Math.random() * dt);
    }
    this.sparks.update(dt);
  }

  private updateTrail(dt: number, power: number, len: number, shipVel: THREE.Vector3) {
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3(0, 0, 1);
    this.group.getWorldPosition(origin);
    dir.transformDirection(this.group.matrixWorld);
    if (!this.hasPrev) this.prevOrigin.copy(origin);

    this.trailAcc += dt * power * 90;
    const n = Math.floor(this.trailAcc);
    this.trailAcc -= n;
    for (let j = 0; j < n; j++) {
      // interpolate the emitter between last and current frame -> continuous ribbon in turns
      const f = (j + Math.random()) / n;
      const along = len * (0.4 + Math.random() * 0.5);
      const px = THREE.MathUtils.lerp(this.prevOrigin.x, origin.x, f) + dir.x * along;
      const pz = THREE.MathUtils.lerp(this.prevOrigin.z, origin.z, f) + dir.z * along;
      const sp = 3 + Math.random() * 2;
      const jit = 0.6;
      this.trailPool.spawn(
        px, origin.y, pz,
        shipVel.x * 0.4 + dir.x * sp + (Math.random() - 0.5) * jit,
        (Math.random() - 0.5) * 0.2,
        shipVel.z * 0.4 + dir.z * sp + (Math.random() - 0.5) * jit,
        0.5 + Math.random() * 0.5,
        (1 - f) * dt,
      );
    }
    this.prevOrigin.copy(origin);
    this.hasPrev = true;
    this.trailPool.update(dt);
  }
}
