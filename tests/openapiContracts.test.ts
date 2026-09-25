import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildApplication } from "../src/api/app.js";
import { loadEnvironment } from "../src/config/environment.js";
import { OPENAPI_DOCUMENT } from "../src/api/openapi.js";
import { assertOpenApiContract, assertRuntimeParity, collectOpenApiContractErrors, operationKey, runtimeRoute, type RuntimeRouteDescriptor } from "../src/api/openapi-validator.js";
import { assertSecurityProbes, buildSecurityProbeApplication, SECURITY_PROBE_REGISTRATION_PAYLOAD, type SecurityProbeRegistrationCall } from "../src/api/security-probes.js";

const execFileAsync = promisify(execFile);

type MutableDocument = {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: Record<string, unknown>;
};

function documentCopy(): MutableDocument {
  return JSON.parse(JSON.stringify(OPENAPI_DOCUMENT)) as MutableDocument;
}

function operation(document: MutableDocument, key: string): Record<string, unknown> {
  const separator = key.indexOf(" ");
  const method = key.slice(0, separator).toLowerCase();
  const path = key.slice(separator + 1);
  const value = document.paths[path]?.[method];
  assert.ok(value, `operation ${key} should exist`);
  return value;
}

function testEnvironment() {
  return loadEnvironment({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:19099",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:18080",
    ADMIN_WEB_ORIGIN: "http://127.0.0.1:29199",
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
}

/** Build the real Fastify application; never derive this inventory from OpenAPI. */
async function runtimeInventory(): Promise<RuntimeRouteDescriptor[]> {
  const app = buildApplication({ environment: testEnvironment(), firestore: null, verifier: null, appCheckVerifier: null, stores: null });
  await app.ready();
  try {
    return [...app.patternlyRouteInventory];
  } finally {
    await app.close();
  }
}

test("GATE-02 source OpenAPI document is complete", () => {
  assert.doesNotThrow(() => assertOpenApiContract(OPENAPI_DOCUMENT));
});

test("unready runtime response matches the documented 503 schema", async () => {
  const app = buildSecurityProbeApplication(testEnvironment());
  await app.ready();
  try {
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 503);
    const readyResponse = OPENAPI_DOCUMENT.paths["/ready"].get.responses["503"] as unknown as { content: { "application/json": { schema: object } } };
    const documented = readyResponse.content["application/json"].schema;
    const validate = new Ajv2020({ strict: false }).compile(documented);
    assert.equal(validate(response.json()), true, JSON.stringify(validate.errors));
    assert.deepEqual(response.json(), { status: "not_ready", checks: { database: false, authentication: true, providerReader: true } });
  } finally {
    await app.close();
  }
});

test("runtime parity uses the real app, normalizes parameters, and ignores automatic HEAD", async () => {
  const routes = await runtimeInventory();
  assert.equal(routes.length, 58);
  assert.equal(routes.find((route) => operationKey(route.method, route.path) === "POST /v1/account/registration")?.securityProfile, "app_check_verify_only_bearer");
  assert.equal(routes.find((route) => operationKey(route.method, route.path) === "POST /v1/account/session/exchange")?.securityProfile, "app_check_verify_only_bearer");
  assert.equal(OPENAPI_DOCUMENT.paths["/v1/account/session/exchange"].post.requestBody.required, false);
  assert.equal(routes.find((route) => operationKey(route.method, route.path) === "GET /v1/admin/overview")?.securityProfile, "admin");
  assert.equal(routes.find((route) => operationKey(route.method, route.path) === "POST /v1/content/reports")?.securityProfile, "app_check_optional_bearer");
  const health = routes.find((route) => operationKey(route.method, route.path) === "GET /health");
  assert.ok(health);
  routes.push({ ...health, method: "HEAD" });
  assert.doesNotThrow(() => assertRuntimeParity(routes, OPENAPI_DOCUMENT));
});

test("runtime parity rejects a missing operation", async () => {
  const routes = await runtimeInventory();
  const index = routes.findIndex((route) => operationKey(route.method, route.path) === "GET /health");
  assert.notEqual(index, -1);
  routes.splice(index, 1);
  assert.throws(() => assertRuntimeParity(routes, OPENAPI_DOCUMENT), /openapi_operation_missing_from_runtime:GET \/health/u);
});

test("runtime parity rejects an extra operation", async () => {
  const routes = await runtimeInventory();
  routes.push(runtimeRoute("GET", "/v1/unknown", undefined, "none", false));
  assert.throws(() => assertRuntimeParity(routes, OPENAPI_DOCUMENT), /runtime_operation_missing_from_openapi:GET \/v1\/unknown/u);
});

test("runtime parity rejects a wrong method", async () => {
  const routes = await runtimeInventory();
  const route = routes.find((candidate) => operationKey(candidate.method, candidate.path) === "GET /v1/me");
  assert.ok(route);
  routes[routes.indexOf(route)] = { ...route, method: "POST", acceptsJson: true };
  assert.throws(() => assertRuntimeParity(routes, OPENAPI_DOCUMENT), /runtime_operation_missing_from_openapi:POST \/v1\/me/u);
});

test("behavioral security probes exercise every protected profile", async () => {
  const registrationCalls: SecurityProbeRegistrationCall[] = [];
  const app = buildSecurityProbeApplication(testEnvironment(), (call) => { registrationCalls.push(call); });
  await app.ready();
  try {
    await assertSecurityProbes(app, OPENAPI_DOCUMENT);
    assert.equal(registrationCalls.length, 1);
    assert.deepEqual(registrationCalls[0]?.input, SECURITY_PROBE_REGISTRATION_PAYLOAD);
    assert.equal(registrationCalls[0]?.identity.subject, "security-probe-subject");
  } finally {
    await app.close();
  }
});

test("every account-resolving operation documents account_not_found", () => {
  const documented: string[] = [];
  for (const [path, pathItem] of Object.entries(documentCopy().paths)) {
    for (const [method, candidate] of Object.entries(pathItem)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const profile = candidate["x-patternly-security-profile"];
      if (profile !== "bearer" && profile !== "app_check_optional_bearer") continue;
      const response = (candidate.responses as Record<string, Record<string, unknown>> | undefined)?.["404"];
      assert.ok(response, `${method.toUpperCase()} ${path} must document 404 account_not_found`);
      assert.match(String(response.description), /account_not_found/u);
      assert.ok(Array.isArray(response["x-patternly-error-codes"]));
      assert.ok(response["x-patternly-error-codes"].includes("account_not_found"));
      documented.push(`${method.toUpperCase()} ${path}`);
    }
  }
  assert.ok(documented.length > 0);
});

test("behavioral security probes reject a no-op guard fixture", async () => {
  const app = Fastify({ logger: false });
  app.get("/v1/security-probe", { preHandler: async () => undefined }, async () => ({ ok: true }));
  await app.ready();
  try {
    const document = { paths: { "/v1/security-probe": { get: { "x-patternly-security-profile": "bearer" } } } };
    await assert.rejects(assertSecurityProbes(app, document), /security_probe_failed:GET \/v1\/security-probe:bearer:authentication_rejection_expected:401:authentication_required:got:200:no_code/u);
  } finally {
    await app.close();
  }
});

test("an unregistered no-op pre-handler is unknown and cannot impersonate a public route", async () => {
  const routeContractModule = await import("../src/api/route-contract.js");
  assert.equal("markRouteProtection" in routeContractModule, false);
  assert.equal("readRouteProtection" in routeContractModule, false);
  const app = buildApplication({ environment: testEnvironment(), firestore: null, verifier: null, appCheckVerifier: null, stores: null });
  app.get("/v1/unregistered-noop", { preHandler: async () => undefined }, async () => ({ ok: true }));
  await app.ready();
  try {
    const route = app.patternlyRouteInventory.find((candidate) => operationKey(candidate.method, candidate.path) === "GET /v1/unregistered-noop");
    assert.ok(route);
    assert.equal(route.securityProfile, "unknown");
    assert.equal(route.declaredSecurityProfile, "unknown");
    assert.throws(() => assertRuntimeParity(app.patternlyRouteInventory, OPENAPI_DOCUMENT), /runtime_operation_missing_from_openapi:GET \/v1\/unregistered-noop/u);
  } finally {
    await app.close();
  }
});

test("completeness rejects a missing request schema", () => {
  const document = documentCopy();
  delete operation(document, "POST /v1/legal-acceptances").requestBody;
  assert.match(collectOpenApiContractErrors(document).join("\n"), /POST \/v1\/legal-acceptances:json_request_schema_missing/u);
});

test("completeness rejects an empty request schema", () => {
  const document = documentCopy();
  operation(document, "POST /v1/legal-acceptances").requestBody = { required: true, content: { "application/json": { schema: {} } } };
  assert.match(collectOpenApiContractErrors(document).join("\n"), /POST \/v1\/legal-acceptances:json_request_schema_missing/u);
});

test("completeness rejects a missing success response schema", () => {
  const document = documentCopy();
  const response = operation(document, "GET /v1/me").responses as Record<string, Record<string, unknown>>;
  delete response["200"]!.content;
  assert.match(collectOpenApiContractErrors(document).join("\n"), /GET \/v1\/me:success_schema_missing:200/u);
});

test("completeness rejects an empty success response schema", () => {
  const document = documentCopy();
  const response = operation(document, "GET /v1/me").responses as Record<string, Record<string, unknown>>;
  response["200"]!.content = { "application/json": { schema: { type: "object", additionalProperties: true } } };
  assert.match(collectOpenApiContractErrors(document).join("\n"), /GET \/v1\/me:success_schema_missing:200/u);
});

test("completeness rejects duplicate operation identities", () => {
  const document = documentCopy();
  operation(document, "GET /v1/me").operationId = operation(document, "GET /health").operationId;
  assert.match(collectOpenApiContractErrors(document).join("\n"), /operation_id_duplicate/u);
});

test("completeness rejects an incorrect protection profile", () => {
  const document = documentCopy();
  const me = operation(document, "GET /v1/me");
  me["x-patternly-security-profile"] = "public";
  assert.match(collectOpenApiContractErrors(document).join("\n"), /GET \/v1\/me:security_requirements_expected:none/u);
});

test("completeness rejects an unclassified consumer operation", () => {
  const document = documentCopy();
  delete operation(document, "GET /v1/me")["x-patternly-consumer-scope"];
  assert.match(collectOpenApiContractErrors(document).join("\n"), /GET \/v1\/me:consumer_scope_missing_or_unknown/u);
});

test("ordinary error responses use the closed common envelope", () => {
  const document = documentCopy();
  const response = operation(document, "GET /v1/me").responses as Record<string, Record<string, unknown>>;
  response["401"]!.content = { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } };
  assert.match(collectOpenApiContractErrors(document).join("\n"), /GET \/v1\/me:error_schema_not_common_envelope:401/u);
});

test("frontend checker rejects an unknown consumer operation", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "patternly-gate02-"));
  try {
    const mobile = join(root, "mobile");
    const web = join(root, "web");
    await mkdir(join(mobile, "src"), { recursive: true });
    await mkdir(join(web, "src"), { recursive: true });
    await writeFile(join(mobile, "src", "transport.ts"), 'fetch("/v1/not-documented", { method: "GET" });\n', "utf8");
    await assert.rejects(
      execFileAsync(process.execPath, [resolve(process.cwd(), "scripts/check-frontend-client.mjs")], {
        cwd: process.cwd(),
        env: { ...process.env, PATTERNLY_FRONTEND_ROOT: mobile, PATTERNLY_WEB_ROOT: web },
      }),
      (error: unknown) => error instanceof Error && error.message.includes("frontend_unknown_operation:mobile:GET /v1/not-documented"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frontend checker does not let a methodless static path satisfy a consumer operation", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "patternly-gate02-static-path-"));
  try {
    const mobile = join(root, "mobile");
    const web = join(root, "web");
    await mkdir(join(mobile, "src"), { recursive: true });
    await mkdir(join(web, "src"), { recursive: true });
    await writeFile(join(mobile, "src", "paths.ts"), 'export const endpoint = "/v1/me";\n', "utf8");
    await assert.rejects(
      execFileAsync(process.execPath, [resolve(process.cwd(), "scripts/check-frontend-client.mjs")], {
        cwd: process.cwd(),
        env: { ...process.env, PATTERNLY_FRONTEND_ROOT: mobile, PATTERNLY_WEB_ROOT: web },
      }),
      (error: unknown) => error instanceof Error && error.message.includes("frontend_missing_consumer_operation:GET /v1/me:mobile"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runAdminReadFixture(wrapper: string, callsite: string): Promise<unknown> {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "patternly-gate02-admin-read-"));
  try {
    const mobile = join(root, "mobile");
    const web = join(root, "web");
    await mkdir(join(mobile, "src"), { recursive: true });
    await mkdir(join(web, "src"), { recursive: true });
    await writeFile(join(web, "src", "AdminWorkspace.jsx"), `${wrapper}\n${callsite}\n`, "utf8");
    return await execFileAsync(process.execPath, [resolve(process.cwd(), "scripts/check-frontend-client.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env, PATTERNLY_FRONTEND_ROOT: mobile, PATTERNLY_WEB_ROOT: web },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("frontend checker binds useAdminRead callsites to the wrapper method", async () => {
  const wrapper = String.raw`function useAdminRead(user, path) { return fetch(\`/v1/admin/\${path}\`, { method: "POST" }); }`;
  await assert.rejects(
    runAdminReadFixture(wrapper, `useAdminRead(user, "overview", validate);`),
    (error: unknown) => error instanceof Error && error.message.includes("frontend_method_mismatch:web:POST /v1/admin/overview"),
  );
});

test("frontend checker rejects a useAdminRead callsite with no expected operation", async () => {
  const wrapper = String.raw`function useAdminRead(user, path) { return fetch(\`/v1/admin/\${path}\`); }`;
  await assert.rejects(
    runAdminReadFixture(wrapper, `useAdminRead(user, "does-not-exist", validate);`),
    (error: unknown) => error instanceof Error && error.message.includes("frontend_unknown_operation:web:GET /v1/admin/does-not-exist"),
  );
});
