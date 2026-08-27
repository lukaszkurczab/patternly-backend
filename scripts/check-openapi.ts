import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OPENAPI_DOCUMENT } from "../src/api/openapi.js";

const output = resolve(process.cwd(), "openapi/patternly-v1.json");
const expected = `${JSON.stringify(OPENAPI_DOCUMENT, null, 2)}\n`;
const actual = await readFile(output, "utf8");

if (actual !== expected) throw new Error("openapi_document_out_of_date");
console.log(`OpenAPI document matches ${output}`);
