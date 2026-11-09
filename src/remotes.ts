import * as THREE from "three";
import type { PlayerState } from "../shared/schema";
import type { AsteroidField } from "./asteroids";
import { makeBeam, placeBeam } from "./drill";
import type { Effects } from "./fx";
import type { ShipTemplate, ShipVisual } from "./ship";

/** Another pilot's ship: interpolated from synced state, with drill beams and a nameplate. */
interface Remote {
  id: string;
  visual: ShipVisual;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  heading: number;
  turn: number;
  beams: THREE.Mesh[];
  beamPower: number;
  label: HTMLElement;
  name: string;
  hue: number;
}

interface MapLike<T> {
  forEach(cb: (value: T, key: string) => void): void;
  get(key: string): T | undefined;
}

const tmpV = new THREE.Vector3();

export class RemoteShips {
  readonly group = new THREE.Group();
  readonly list: Remote[] = [];
  private byId = new Map<string, Remote>();

  constructor(private template: ShipTemplate, private scene: THREE.Scene, private labels: HTMLElement) {}

  private create(id: string, s: PlayerState): Remote {
    const visual = this.template.create();
    this.group.add(visual.root);
    this.scene.add(...visual.trails);
    const beams = [makeBeam(), makeBeam()];
    beams.forEach((b) => { b.visible = false; this.group.add(b); });
    const label = document.createElement("div");
    label.className = "pilot-label";
    this.labels.appendChild(label);
    const r: Remote = {
      id, visual, beams, label, name: s.name, hue: s.hue,
      pos: new THREE.Vector3(s.x, 0, s.z), vel: new THREE.Vector3(), heading: s.h, turn: 0, beamPower: 0,
    };
    label.textContent = s.name;
    label.style.color = `hsl(${s.hue}, 90%, 75%)`;
    this.byId.set(id, r);
    this.list.push(r);
    return r;
  }

  sync(states: MapLike<PlayerState>, selfId: string, dt: number, time: number,
    field: AsteroidField, camera: THREE.Camera, fx: Effects) {
    states.forEach((s, id) => {
      if (id === selfId) return;
      const r = this.byId.get(id) ?? this.create(id, s);
      r.vel.set(s.vx, 0, s.vz);
      // dead-reckon from the last update, then ease towards it
      const k = Math.min(1, 12 * dt);
      r.pos.x += (s.x - r.pos.x) * k + s.vx * dt * (1 - k);
      r.pos.z += (s.z - r.pos.z) * k + s.vz * dt * (1 - k);
      const dh = Math.atan2(Math.sin(s.h - r.heading), Math.cos(s.h - r.heading));
      r.heading += dh * k;
      r.turn += (dh / Math.max(dt, 1e-3) - r.turn) * k;

      r.visual.root.position.copy(r.pos);
      r.visual.root.rotation.y = r.heading;
      r.visual.animate(dt, time, s.throttle, s.boost, r.vel, THREE.MathUtils.clamp(r.turn * 0.13, -0.6, 0.6));

      // drill beams towards their target
      const target = s.drilling && s.target ? field.get(s.target) : undefined;
      r.beamPower += ((target ? 1 : 0) - r.beamPower) * Math.min(1, 8 * dt);
      const visible = r.beamPower > 0.03 && !!target;
      r.beams.forEach((b) => (b.visible = visible));
      if (visible && target) {
        const camPos = camera.getWorldPosition(new THREE.Vector3());
        const starts = r.visual.drillMounts.map((m) => m.getWorldPosition(new THREE.Vector3()));
        const origin = starts.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(starts.length);
        const dir = target.pos.clone().sub(origin).setY(0).normalize();
        const end = target.pos.clone().addScaledVector(dir, -target.radius * 0.85);
        r.beams.forEach((b, i) => {
          placeBeam(b, starts[i] ?? origin, end, camPos, 0.16);
          const u = (b.material as THREE.ShaderMaterial).uniforms;
          u.uTime.value = time + i * 0.37;
          u.uPower.value = r.beamPower;
        });
        fx.drillImpact(end, dir.negate(), dt);
      }
      r.visual.root.visible = true;
    });
    for (let i = this.list.length - 1; i >= 0; i--) {
      const r = this.list[i];
      if (!states.get(r.id)) {
        this.group.remove(r.visual.root, ...r.beams);
        this.scene.remove(...r.visual.trails);
        r.label.remove();
        this.byId.delete(r.id);
        this.list.splice(i, 1);
      }
    }
  }

  updateLabels(camera: THREE.Camera) {
    for (const r of this.list) {
      tmpV.copy(r.pos).setZ(r.pos.z + 2.2).project(camera);
      const on = tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1;
      r.label.style.display = on ? "block" : "none";
      if (on) {
        r.label.style.transform =
          `translate(${(tmpV.x * 0.5 + 0.5) * innerWidth}px, ${(-tmpV.y * 0.5 + 0.5) * innerHeight}px) translate(-50%, 0)`;
      }
    }
  }
}
