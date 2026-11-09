import { CHANNELS, type Channel, type Sfx, type SoundName } from "./audio";

/** Sound played when a slider is released, so the player hears the new level. */
const PREVIEW: Record<Channel, SoundName> = {
  engine: "boost_start", lasers: "ore_pickup", effects: "explosion_small", ui: "notify",
};

/** Settings overlay (sound mixer). Opens with O or the gear button, works in flight and docked. */
export class SettingsPanel {
  readonly el = document.createElement("div");
  isOpen = false;

  constructor(parent: HTMLElement, private sfx: Sfx) {
    this.el.id = "settings";
    const row = (key: string, label: string, value: number) => `
      <label class="set-row"><span>${label}</span>
        <input type="range" min="0" max="100" step="1" value="${Math.round(value * 100)}" data-k="${key}">
        <output>${Math.round(value * 100)}</output></label>`;
    const s = sfx.settings;
    this.el.innerHTML = `
      <div class="set-panel">
        <header><div><div class="st-kicker">OPTIONS</div><h2>Sound</h2></div><button class="set-close" title="Close (O / Esc)">✕</button></header>
        <label class="set-row set-mute"><span>Sound enabled</span><input type="checkbox" data-k="enabled" ${s.muted ? "" : "checked"}>
          <small>shortcut <kbd>N</kbd></small></label>
        ${row("master", "Master volume", s.master)}
        <div class="set-sub">CHANNELS</div>
        ${CHANNELS.map((c) => row(c.id, c.label, s.channels[c.id])).join("")}
        <footer><button class="set-reset">Reset to defaults</button><span><kbd>O</kbd> options · <kbd>Esc</kbd> close</span></footer>
      </div>`;
    this.el.addEventListener("mousedown", (e) => e.stopPropagation()); // don't fire the laser
    this.el.addEventListener("click", (e) => { if (e.target === this.el) this.close(); });
    this.el.querySelector(".set-close")!.addEventListener("click", () => this.close());
    this.el.querySelector(".set-reset")!.addEventListener("click", () => this.reset());
    this.el.addEventListener("input", (e) => this.onInput(e.target as HTMLInputElement, false));
    this.el.addEventListener("change", (e) => this.onInput(e.target as HTMLInputElement, true));
    parent.appendChild(this.el);
  }

  private onInput(input: HTMLInputElement, committed: boolean) {
    const k = input.dataset.k;
    if (!k) return;
    if (k === "enabled") {
      this.sfx.update({ muted: !input.checked });
      if (input.checked) this.sfx.play("ui_click");
      return;
    }
    const v = Number(input.value) / 100;
    input.parentElement!.querySelector("output")!.textContent = input.value;
    if (k === "master") this.sfx.update({ master: v });
    else this.sfx.update({ channel: [k as Channel, v] });
    if (committed) this.sfx.play(k === "master" ? "notify" : PREVIEW[k as Channel]);
  }

  private reset() {
    this.sfx.update({ muted: false, master: 0.7 });
    for (const c of CHANNELS) this.sfx.update({ channel: [c.id, c.id === "effects" ? 1 : 0.8] });
    this.sync();
  }

  /** Reflect current settings (e.g. after N toggled mute). */
  sync() {
    const s = this.sfx.settings;
    const set = (k: string, v: number) => {
      const i = this.el.querySelector<HTMLInputElement>(`input[data-k="${k}"]`)!;
      i.value = String(Math.round(v * 100));
      i.parentElement!.querySelector("output")!.textContent = i.value;
    };
    this.el.querySelector<HTMLInputElement>('input[data-k="enabled"]')!.checked = !s.muted;
    set("master", s.master);
    for (const c of CHANNELS) set(c.id, s.channels[c.id]);
  }

  open() { this.sync(); this.isOpen = true; this.el.classList.add("open"); }
  close() { this.isOpen = false; this.el.classList.remove("open"); }
  toggle() { this.isOpen ? this.close() : this.open(); }
}
