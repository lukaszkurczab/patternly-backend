import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("../src/", import.meta.url);
const failures = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.name.endsWith(".ts")) {
      const source = await readFile(path, "utf8");
      if (/\bconsole\.(log|warn|error)\s*\(/u.test(source)) failures.push(`${relative(root.pathname, path)}: use the structured logger`);
      if (/\bany\b/u.test(source)) failures.push(`${relative(root.pathname, path)}: explicit any is not allowed`);
    }
  }
}

await visit(root.pathname);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log("lint passed");
