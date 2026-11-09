import {
  MINER, MODULES, MODULE_ORDER, maxLevel, minerCost, minersOwned, nextCost, type GameState, type ModuleId,
} from "./upgrades";

/** Station build menu shown while docked. Plain DOM, styled in index.html. */
export class StationMenu {
  readonly el = document.createElement("div");
  private storedEl: HTMLElement;
  private noteEl: HTMLElement;
  private cards = new Map<ModuleId, HTMLElement>();
  private minerCard: HTMLElement;
  isOpen = false;

  constructor(
    parent: HTMLElement,
    private onBuild: (id: ModuleId) => void,
    private onUndock: () => void,
    private onBuyMiner: () => void,
  ) {
    this.el.id = "station-menu";
    this.el.innerHTML = `
      <header>
        <div><h1>HOME STATION</h1><div class="note"></div></div>
        <div class="stored">ORE STORED <b>0</b></div>
      </header>
      <div class="cards"></div>
      <footer><button class="undock">Undock</button><span>E / Esc to undock · 1–5 build · 6 buy miner</span></footer>`;
    this.storedEl = this.el.querySelector(".stored b")!;
    this.noteEl = this.el.querySelector(".note")!;
    const cards = this.el.querySelector(".cards")!;
    MODULE_ORDER.forEach((id, i) => {
      const c = document.createElement("div");
      c.className = `card ${id}`;
      c.innerHTML = `
        <div class="title"><span class="key">${i + 1}</span>${MODULES[id].name}</div>
        <div class="pips"></div>
        <div class="stat"></div>
        <button class="build"></button>`;
      c.querySelector("button")!.addEventListener("click", () => this.onBuild(id));
      cards.appendChild(c);
      this.cards.set(id, c);
    });
    this.minerCard = document.createElement("div");
    this.minerCard.className = "card miner";
    this.minerCard.innerHTML = `
      <div class="title"><span class="key">6</span>Automatic Miner</div>
      <div class="stat">Deploy near asteroids with F. Mines on its own<br>
        (range ${MINER.range} m, holds ${MINER.capacity} ore). Fly back and press F to collect.</div>
      <div class="owned"></div>
      <button class="build"></button>`;
    this.minerCard.querySelector("button")!.addEventListener("click", () => this.onBuyMiner());
    cards.appendChild(this.minerCard);
    this.el.querySelector(".undock")!.addEventListener("click", () => this.onUndock());
    // keep clicks in the menu from reaching the game (mouse = drill)
    this.el.addEventListener("mousedown", (e) => e.stopPropagation());
    parent.appendChild(this.el);
  }

  open(note: string) {
    this.isOpen = true;
    this.noteEl.textContent = note;
    this.el.classList.add("open");
  }

  close() {
    this.isOpen = false;
    this.el.classList.remove("open");
  }

  flashNote(text: string) {
    this.noteEl.textContent = text;
  }

  render(s: GameState) {
    this.storedEl.textContent = String(Math.floor(s.stored));
    for (const id of MODULE_ORDER) {
      const def = MODULES[id];
      const card = this.cards.get(id)!;
      const lvl = s.levels[id];
      const max = maxLevel(id);
      card.querySelector(".pips")!.innerHTML = Array.from({ length: max }, (_, i) =>
        `<i class="${i < lvl ? "on" : ""}"></i>`).join("");
      const cur = def.format(def.values[lvl]);
      card.querySelector(".stat")!.innerHTML = lvl < max
        ? `${def.stat}<br><b>${cur}</b> → <b class="next">${def.format(def.values[lvl + 1])}</b>`
        : `${def.stat}<br><b>${cur}</b>`;
      const btn = card.querySelector("button")!;
      const cost = nextCost(s, id);
      if (lvl >= max) {
        btn.textContent = "MAX LEVEL";
        btn.disabled = true;
      } else {
        btn.textContent = `Build · ${cost} ore`;
        btn.disabled = s.stored < cost;
      }
    }
    const owned = minersOwned(s);
    this.minerCard.querySelector(".owned")!.innerHTML =
      `Carried <b>${s.minerStock}</b> · deployed <b>${s.miners.length}</b> · max ${MINER.maxOwned}`;
    const mb = this.minerCard.querySelector("button")!;
    if (owned >= MINER.maxOwned) {
      mb.textContent = "FLEET FULL";
      mb.disabled = true;
    } else {
      const cost = minerCost(s);
      mb.textContent = `Buy · ${cost} ore`;
      mb.disabled = s.stored < cost;
    }
  }
}
