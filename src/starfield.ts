import * as THREE from "three";

/**
 * Infinite star layers at different depths below the play plane (y = 0).
 * Perspective gives natural parallax; each layer wraps around the camera.
 * Brightness follows a power law (many faint, few bright) like a real sky.
 */
const STAR_COLORS = ["#ffffff", "#dfe8ff", "#b9ccff", "#fff2dc", "#ffd9a8", "#ffb48a"];

function starLayer(count: number, depth: number, tile: number, size: number, bright: number) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const sz = new Float32Array(count);
  const palette = STAR_COLORS.map((c) => new THREE.Color(c));
  for (let i = 0; i < count; i++) {
    pos.set([Math.random() * tile, -depth, Math.random() * tile], i * 3);
    const c = palette[Math.floor(Math.random() ** 1.5 * palette.length)];
    const r = Math.random();
    const b = (0.08 + r ** 6 * 2.2) * bright; // HDR peaks bloom slightly
    col.set([c.r * b, c.g * b, c.b * b], i * 3);
    sz[i] = size * (0.7 + r ** 4 * 1.6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(sz, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uCam: { value: new THREE.Vector3() },
      uTile: { value: tile },
      uPixelRatio: { value: Math.min(devicePixelRatio, 2) },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uCam; uniform float uTile; uniform float uPixelRatio;
      attribute vec3 color; attribute float aSize;
      varying vec3 vColor;
      void main() {
        vec3 p = position;
        p.xz = mod(p.xz - uCam.xz + 0.5 * uTile, uTile) - 0.5 * uTile + uCam.xz;
        vColor = color;
        gl_PointSize = aSize * uPixelRatio;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float f = exp(-d * d * 4.0);
        gl_FragColor = vec4(vColor * f, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

/** Soft nebula clouds and dust lanes on a far plane that follows the camera. */
function nebula(depth: number, size: number) {
  const mat = new THREE.ShaderMaterial({
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
                   mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 6; i++) { v += a * noise(p); p = p * 2.02 + 17.0; a *= 0.5; }
        return v;
      }
      void main() {
        vec2 p = vWorld * 0.004;
        vec2 q = vec2(fbm(p + 3.1), fbm(p - 7.7));
        float n = fbm(p + q * 1.8);
        float hue = fbm(p * 0.6 + 11.0);
        float dens = smoothstep(0.42, 0.85, n);
        float dust = smoothstep(0.35, 0.65, fbm(p * 3.0 + q * 2.0));
        vec3 warm = vec3(0.32, 0.10, 0.22);
        vec3 cool = vec3(0.06, 0.16, 0.30);
        vec3 col = vec3(0.006, 0.008, 0.018);
        col += mix(warm, cool, smoothstep(0.35, 0.65, hue)) * dens * 0.55 * (0.45 + 0.55 * dust);
        col += vec3(0.5, 0.55, 0.7) * pow(dens, 3.0) * 0.08;  // brighter cores
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -depth;
  return plane;
}

export class Starfield {
  readonly group = new THREE.Group();
  private layers: THREE.Points[];
  private neb: THREE.Mesh;

  constructor() {
    this.layers = [
      starLayer(160, 4, 60, 1.6, 0.35), // near dust specks: strongest motion cue
      starLayer(900, 25, 110, 2.2, 1.0),
      starLayer(1800, 70, 200, 2.0, 0.9),
      starLayer(3500, 160, 380, 1.6, 0.8),
    ];
    this.neb = nebula(260, 2400);
    this.group.add(this.neb, ...this.layers);
  }

  update(cam: THREE.Vector3) {
    for (const l of this.layers) {
      (l.material as THREE.ShaderMaterial).uniforms.uCam.value.copy(cam);
    }
    this.neb.position.x = cam.x;
    this.neb.position.z = cam.z;
  }
}
