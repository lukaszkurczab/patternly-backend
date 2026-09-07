import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("../src/", import.meta.url);
const failures = [];

function hasCanonicalFastifyLogger(path, source) {
  const constructors = source.match(/\bFastify\s*\(/gu) ?? [];
  return path.endsWith("/api/app.ts") && constructors.length === 1 && /Fastify\s*\(\s*\{[\s\S]*loggerInstance:\s*createLogger\(/u.test(source);
}

if (hasCanonicalFastifyLogger("/api/app.ts", "Fastify({ loggerInstance: createLogger(environment) }); Fastify({ loggerInstance: createLogger(environment) });")) {
  failures.push("lint invariant regression: a second Fastify constructor must be rejected");
}

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.name.endsWith(".ts")) {
      const source = await readFile(path, "utf8");
      if (/\bconsole\.[A-Za-z]+\s*\(/u.test(source)) failures.push(`${relative(root.pathname, path)}: use the structured logger`);
      if (/\bprocess\.(stdout|stderr)\b/u.test(source)) failures.push(`${relative(root.pathname, path)}: stdout/stderr bypasses the structured logger`);
      if (!path.endsWith("/infrastructure/logging/logger.ts") && /\bpino\s*\(/u.test(source)) failures.push(`${relative(root.pathname, path)}: use createLogger instead of constructing pino`);
      if (/\bFastify\s*\(/u.test(source) && !hasCanonicalFastifyLogger(path, source)) failures.push(`${relative(root.pathname, path)}: Fastify must use the canonical createLogger instance`);
      if (/\blogger\s*:\s*(?:\{|true\b|false\b|[a-z])/u.test(source)) failures.push(`${relative(root.pathname, path)}: Fastify logger configuration bypasses createLogger`);
      if (/\bany\b/u.test(source)) failures.push(`${relative(root.pathname, path)}: explicit any is not allowed`);
    }
  }
}

await visit(root.pathname);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log("lint passed");
