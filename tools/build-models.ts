// Builds every tools/blender/<name>.py into public/models/<name>.glb,
// saves an editable assets-src/<name>.blend and renders previews.
// Usage: bun run models [name...]
import { Glob } from "bun";
import { basename } from "node:path";

const only = process.argv.slice(2);
const scripts = [...new Glob("tools/blender/*.py").scanSync(".")]
  .filter((p) => !basename(p).startsWith("_"))
  .filter((p) => only.length === 0 || only.includes(basename(p, ".py")))
  .sort();

let failed = false;
for (const script of scripts) {
  const name = basename(script, ".py");
  console.log(`▶ ${name}`);
  const proc = Bun.spawnSync(
    [
      "blender", "-b", "--factory-startup", "-P", script, "--",
      `public/models/${name}.glb`,
      "tools/blender/previews",
      `assets-src/${name}.blend`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = proc.stdout.toString() + proc.stderr.toString();
  const lines = out.split("\n").filter((l) => /^\[|Error|Traceback|File "/.test(l));
  console.log(lines.join("\n"));
  if (proc.exitCode !== 0 || /Traceback|Error:/.test(out)) {
    failed = true;
    console.error(out.slice(-3000));
  }
}
process.exit(failed ? 1 : 0);
