const down = new Set<string>();
let mouseDrill = false;

addEventListener("keydown", (e) => {
  if (e.code === "Space") e.preventDefault(); // don't scroll / activate buttons
  down.add(e.code);
});
addEventListener("keyup", (e) => down.delete(e.code));
addEventListener("mousedown", (e) => { if (e.button === 0) mouseDrill = true; });
addEventListener("mouseup", (e) => { if (e.button === 0) mouseDrill = false; });
addEventListener("blur", () => { down.clear(); mouseDrill = false; });

export const input = {
  get thrust() { return down.has("KeyW") || down.has("ArrowUp"); },
  get brake() { return down.has("KeyS") || down.has("ArrowDown"); },
  get left() { return down.has("KeyA") || down.has("ArrowLeft"); },
  get right() { return down.has("KeyD") || down.has("ArrowRight"); },
  get boost() { return down.has("ShiftLeft") || down.has("ShiftRight"); },
  get drill() { return down.has("Space") || mouseDrill; },
};
