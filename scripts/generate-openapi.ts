import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OPENAPI_DOCUMENT } from "../src/api/openapi.js";

const output = resolve(process.cwd(), "openapi/patternly-v1.json");
await mkdir(resolve(process.cwd(), "openapi"), { recursive: true });
await writeFile(output, `${JSON.stringify(OPENAPI_DOCUMENT, null, 2)}\n`, "utf8");
console.log(`wrote ${output}`);
