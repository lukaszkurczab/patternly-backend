import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as ajvFormats from "ajv-formats";
import { assertSecurityProbes, buildSecurityProbeApplication } from "../src/api/security-probes.js";
import { loadEnvironment } from "../src/config/environment.js";
import { OPENAPI_DOCUMENT } from "../src/api/openapi.js";
import { assertOpenApiContract, assertRuntimeParity } from "../src/api/openapi-validator.js";

const output = resolve(process.cwd(), "openapi/patternly-v1.json");
const expected = `${JSON.stringify(OPENAPI_DOCUMENT, null, 2)}\n`;
const actual = await readFile(output, "utf8");

if (actual !== expected) throw new Error("openapi_document_out_of_date");

assertOpenApiContract(OPENAPI_DOCUMENT);
const artifact = JSON.parse(actual) as unknown;
assertOpenApiContract(artifact);

const ajv = new Ajv2020({ strict: false });
const addFormats = ajvFormats.default as unknown as (instance: Ajv2020) => Ajv2020;
addFormats(ajv);
const artifactSchema = artifact as Record<string, unknown>;
ajv.addSchema(artifactSchema, "patternly-openapi");
const artifactRecord = artifact as { components?: { schemas?: Record<string, unknown> } };
const schemaNames = Object.keys(artifactRecord.components?.schemas ?? {});
for (const schemaName of schemaNames) {
  ajv.compile({ $ref: `patternly-openapi#/components/schemas/${schemaName}` });
}

const environment = loadEnvironment({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  REPORT_RATE_LIMIT_HASH_SECRET: "openapi-check-report-rate-limit-secret-0123456789",
  DELETION_PSEUDONYM_KEYS_JSON: "[]",
  PRIVACY_RESPONSE_KEY_BASE64: "openapi-check-privacy-key",
  PRIVACY_AUDIT_HMAC_SECRET: "openapi-check-privacy-audit-secret-0123456789",
  ADMINISTRATOR_EMAIL: "security-probe-admin@example.com",
  REVENUECAT_WEBHOOK_SECRET: "security-probe-webhook-secret",
  REVENUECAT_APP_ID: "security-probe-app",
  REVENUECAT_ENTITLEMENT_ID: "security-probe-entitlement",
  REVENUECAT_PRODUCT_ID: "security-probe-product",
  REVENUECAT_WEBHOOK_ENVIRONMENT: "SANDBOX",
});
const app = buildSecurityProbeApplication(environment);
try {
  await app.ready();
  assertRuntimeParity(app.patternlyRouteInventory, OPENAPI_DOCUMENT);
  await assertSecurityProbes(app, OPENAPI_DOCUMENT);
} finally {
  await app.close();
}

console.log(`OpenAPI document and runtime routes match ${output} (54 operations)`);
