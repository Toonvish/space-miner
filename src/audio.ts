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

/** Mixer channels shown in the sound settings. */
export const CHANNELS = [
  { id: "engine", label: "Engine" },
  { id: "lasers", label: "Mining Lasers" },
  { id: "effects", label: "Effects" },
  { id: "ui", label: "Interface" },
] as const;
export type Channel = (typeof CHANNELS)[number]["id"];

const CHANNEL_OF: Record<SoundName, Channel> = {
  engine_loop: "engine", boost_loop: "engine", boost_start: "engine",
  laser_loop: "lasers", drill_hit_loop: "lasers",
  explosion_small: "effects", explosion_large: "effects", ore_pickup: "effects", collect: "effects",
  dock: "effects", undock: "effects", build: "effects", deploy: "effects", collision: "effects",
  cargo_full: "ui", notify: "ui", ui_click: "ui", ui_deny: "ui",
};

export interface AudioSettings {
  muted: boolean;
  master: number; // 0..1
  channels: Record<Channel, number>; // 0..1
}

const SETTINGS_KEY = "space-miner-audio";
const DEFAULTS: AudioSettings = {
  muted: false, master: 0.7, channels: { engine: 0.8, lasers: 0.8, effects: 1, ui: 0.8 },
};

function loadSettings(): AudioSettings {
  const s: AudioSettings = { ...DEFAULTS, channels: { ...DEFAULTS.channels } };
  try {
    const d = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    if (d) {
      s.muted = !!d.muted;
      if (Number.isFinite(d.master)) s.master = Math.max(0, Math.min(1, d.master));
      for (const c of CHANNELS) {
        const v = d.channels?.[c.id];
        if (Number.isFinite(v)) s.channels[c.id] = Math.max(0, Math.min(1, v));
      }
    } else if (localStorage.getItem("space-miner-muted") === "1") {
      s.muted = true; // migrate the old mute flag
    }
  } catch { /* storage unavailable: defaults */ }
  return s;
}

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
  private channelGain = new Map<Channel, GainNode>();
  private buffers = new Map<SoundName, AudioBuffer>();
  private loops = new Map<SoundName, Loop>();
  private lastPlay = new Map<SoundName, number>();
  readonly settings = loadSettings();

  get muted() { return this.settings.muted; }

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
    this.master.gain.value = this.settings.muted ? 0 : this.settings.master;
    this.master.connect(comp).connect(ctx.destination);
    for (const c of CHANNELS) {
      const g = ctx.createGain();
      g.gain.value = this.settings.channels[c.id];
      g.connect(this.master);
      this.channelGain.set(c.id, g);
    }
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
    this.update({ muted: !this.settings.muted });
    return this.settings.muted;
  }

  /** Change settings (live) and persist them. */
  update(change: { muted?: boolean; master?: number; channel?: [Channel, number] }) {
    const s = this.settings;
    if (change.muted !== undefined) s.muted = change.muted;
    if (change.master !== undefined) s.master = Math.max(0, Math.min(1, change.master));
    if (change.channel) s.channels[change.channel[0]] = Math.max(0, Math.min(1, change.channel[1]));
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : s.master, t, 0.03);
    for (const c of CHANNELS) this.channelGain.get(c.id)?.gain.setTargetAtTime(s.channels[c.id], t, 0.03);
  }

  private out(name: SoundName): AudioNode {
    return this.channelGain.get(CHANNEL_OF[name]) ?? this.master;
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
    node.connect(this.out(name));
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
    src.connect(g).connect(this.out(name));
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
