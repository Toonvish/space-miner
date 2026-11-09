import * as THREE from "three";

/** Direction the sunlight comes FROM (world space). Shared by lights and env map. */
export const SUN_DIR = new THREE.Vector3(-0.55, 0.75, 0.35).normalize();

/**
 * Prefiltered environment for reflections: dark space with faint nebula tint,
 * a bright sun disc and a cool bounce from below. Cheap: rendered once at start.
 */
export function createSpaceEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const envScene = new THREE.Scene();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(50, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { uSun: { value: SUN_DIR } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSun;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float s = max(dot(d, uSun), 0.0);
          vec3 col = vec3(0.010, 0.013, 0.030);
          col += vec3(0.05, 0.03, 0.09) * smoothstep(-0.2, 0.8, d.x * 0.6 + d.z * 0.4);   // nebula tint
          col += vec3(0.02, 0.06, 0.08) * smoothstep(0.0, -0.9, d.y);                     // cool bounce
          col += vec3(1.0, 0.92, 0.8) * (pow(s, 600.0) * 60.0 + pow(s, 24.0) * 0.6);     // sun + halo
          gl_FragColor = vec4(col, 1.0);
        }`,
    }),
  );
  envScene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(envScene, 0);
  pmrem.dispose();
  return rt.texture;
}
