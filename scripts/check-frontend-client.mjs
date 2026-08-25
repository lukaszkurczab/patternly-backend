import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const frontendRoot = process.env.PATTERNLY_FRONTEND_ROOT
  ? resolve(process.env.PATTERNLY_FRONTEND_ROOT)
  : resolve(process.cwd(), "../patternly");
const spec = JSON.parse(await readFile(resolve(process.cwd(), "openapi/patternly-v1.json"), "utf8"));
const clientPath = join(frontendRoot, "src/infrastructure/clients/PatternlyApiClientAdapter.ts");
const client = await readFile(clientPath, "utf8");
if (!client.includes("Synchronized with patternly-backend/openapi/patternly-v1.json")) throw new Error("frontend_api_client_header_missing");
for (const path of Object.keys(spec.paths).filter((path) => path.startsWith("/v1/"))) {
  const templatePath = path.replace(/\{([^}]+)\}/gu, "\${$1}");
  if (!client.includes(`\"${path}\"`) && !client.includes(`\`${templatePath}\``)) throw new Error(`frontend_generated_client_missing_path:${path}`);
}
console.log(`frontend client matches ${Object.keys(spec.paths).filter((path) => path.startsWith("/v1/")).length} versioned paths`);
