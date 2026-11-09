/**
 * Small Web Audio sound engine: one-shots with gain/pitch/pan, and continuous loops whose
 * gain/pitch are smoothly driven every frame (engine, boost, laser, drill impact).
 * Sounds are the generated WAVs in public/sounds (see tools/build-sounds.ts).
 */
export const SOUNDS = [
  "engine_loop", "boost_loop", "boost_start", "laser_loop", "drill_hit_loop",
  "explosion_small", "explosion_large", "ore_pickup", "collect", "dock", "undock", "build",
  "deploy", "collision", "cargo_full", "notify", "ui_click", "ui_deny",
] as const;
export type SoundName = (typeof SOUNDS)[number];

const MUTE_KEY = "space-miner-muted";

export interface PlayOptions {
  gain?: number;
  rate?: number; // playback rate (pitch)
  pan?: number; // -1 left .. 1 right
}

export class Loop {
  constructor(private ctx: AudioContext, private src: AudioBufferSourceNode, private g: GainNode) {}
  /** Smoothly move towards the target gain/rate (call every frame). */
  set(gain: number, rate = 1, smooth = 0.06) {
    const t = this.ctx.currentTime;
    this.g.gain.setTargetAtTime(Math.max(0, gain), t, smooth);
    this.src.playbackRate.setTargetAtTime(rate, t, smooth);
  }
}

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private buffers = new Map<SoundName, AudioBuffer>();
  private loops = new Map<SoundName, Loop>();
  private lastPlay = new Map<SoundName, number>();
  muted = false;
  volume = 0.7;

  constructor() {
    try { this.muted = localStorage.getItem(MUTE_KEY) === "1"; } catch { /* ignore */ }
  }

  /** Must be called from a user gesture (browsers block audio before one). */
  async start() {
    if (this.ctx) { await this.ctx.resume(); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    // gentle limiter so stacked explosions don't clip
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp).connect(ctx.destination);
    await Promise.all(SOUNDS.map(async (name) => {
      try {
        const res = await fetch(`/sounds/${name}.wav`);
        this.buffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch (e) {
        console.warn(`[audio] could not load ${name}`, e);
      }
    }));
    await ctx.resume();
  }

  get ready() { return !!this.ctx && this.buffers.size > 0; }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try { localStorage.setItem(MUTE_KEY, this.muted ? "1" : "0"); } catch { /* ignore */ }
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  /** Fire-and-forget. `minGap` (s) rate-limits rapid repeats of the same sound. */
  play(name: SoundName, o: PlayOptions = {}, minGap = 0) {
    const ctx = this.ctx;
    const b = this.buffers.get(name);
    if (!ctx || !b || (o.gain ?? 1) <= 0.001) return;
    const now = ctx.currentTime;
    if (minGap > 0 && now - (this.lastPlay.get(name) ?? -1) < minGap) return;
    this.lastPlay.set(name, now);
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = o.rate ?? 1;
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    let node: AudioNode = src.connect(g);
    if (o.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      node = node.connect(p);
    }
    node.connect(this.master);
    src.start();
  }

  /** Continuous loop (created silent on first use). */
  loop(name: SoundName): Loop | null {
    const existing = this.loops.get(name);
    if (existing) return existing;
    const ctx = this.ctx;
    const b = this.buffers.get(name);
    if (!ctx || !b) return null;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(this.master);
    src.start(0, Math.random() * b.duration);
    const l = new Loop(ctx, src, g);
    this.loops.set(name, l);
    return l;
  }
}

/** Distance falloff (1 at the listener, 0 at `range`) and stereo pan from a world offset. */
export function spatial(dx: number, dz: number, range = 60) {
  const d = Math.hypot(dx, dz);
  const k = Math.max(0, 1 - d / range);
  return { gain: k * k, pan: Math.max(-1, Math.min(1, dx / 25)) };
}
