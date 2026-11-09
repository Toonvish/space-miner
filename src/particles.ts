import * as THREE from "three";

export interface ParticleStyle {
  size: number; // world-ish size (scaled by distance)
  grow: number; // size multiplier at end of life
  hot: THREE.ColorRepresentation; // colour at birth
  cool: THREE.ColorRepresentation; // colour at death
  gain: number; // overall brightness (HDR > 1 blooms)
  drag?: number; // velocity damping per second
}

/**
 * Fixed-size ring buffer of additive, soft round particles.
 * Positions are in the coordinate space of whatever `points` is added to.
 */
export class ParticlePool {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private age: Float32Array;
  private lifeAttr: THREE.BufferAttribute;
  private next = 0;
  private drag: number;

  constructor(readonly max: number, style: ParticleStyle) {
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max).fill(1);
    this.age = new Float32Array(max).fill(1);
    this.drag = style.drag ?? 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.lifeAttr = new THREE.BufferAttribute(new Float32Array(max).fill(1), 1);
    geo.setAttribute("aLife", this.lifeAttr);

    const hot = new THREE.Color(style.hot);
    const cool = new THREE.Color(style.cool);
    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        uniforms: {
          uPixelRatio: { value: Math.min(devicePixelRatio, 2) },
          uSize: { value: style.size },
          uGrow: { value: style.grow },
          uHot: { value: hot },
          uCool: { value: cool },
          uGain: { value: style.gain },
        },
        vertexShader: /* glsl */ `
          attribute float aLife;   // 0 = new, 1 = dead
          uniform float uPixelRatio, uSize, uGrow;
          varying float vLife;
          void main() {
            vLife = aLife;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = aLife >= 1.0 ? 0.0 : uSize * mix(1.0, uGrow, aLife) * uPixelRatio / -mv.z;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uHot, uCool;
          uniform float uGain;
          varying float vLife;
          void main() {
            if (vLife >= 1.0) discard;
            float d = length(gl_PointCoord - 0.5) * 2.0;
            float f = exp(-d * d * 3.5);
            vec3 c = mix(uHot, uCool, vLife);
            gl_FragColor = vec4(c * f * (1.0 - vLife) * uGain, 1.0);
          }`,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.points.frustumCulled = false;
  }

  /** `age` > 0 pre-ages a particle (used to spread spawns across a frame). */
  spawn(px: number, py: number, pz: number, vx: number, vy: number, vz: number, life: number, age = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos.set([px + vx * age, py + vy * age, pz + vz * age], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.life[i] = life;
    this.age[i] = age;
  }

  update(dt: number) {
    const damp = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= this.life[i]) {
        this.lifeAttr.setX(i, 1);
        continue;
      }
      this.age[i] += dt;
      const k = i * 3;
      this.vel[k] *= damp;
      this.vel[k + 1] *= damp;
      this.vel[k + 2] *= damp;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      this.lifeAttr.setX(i, Math.min(1, this.age[i] / this.life[i]));
    }
    this.lifeAttr.needsUpdate = true;
    this.points.geometry.getAttribute("position").needsUpdate = true;
  }
}

let glowTex: THREE.Texture | undefined;
/** Shared soft radial glow sprite texture. */
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.45)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
