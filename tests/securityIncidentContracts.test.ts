import assert from "node:assert/strict";
import test from "node:test";
import { addUtcCalendarYears, createSecurityIncidentSchema, incidentDeadline, incidentRetentionExpiry, securityIncidentActionSchema } from "../src/modules/security-incidents/contracts.js";
import { OPENAPI_DOCUMENT } from "../src/api/openapi.js";

test("security incident contract requires an explicit revision for every mutation", () => {
  assert.equal(securityIncidentActionSchema.safeParse({ action: "acknowledge_awareness" }).success, false);
  assert.equal(securityIncidentActionSchema.safeParse({ action: "acknowledge_awareness", expectedRevision: 0 }).success, true);
  assert.equal(securityIncidentActionSchema.safeParse({ action: "decide_authority", decision: "not_required", reason: "Low risk", expectedRevision: 0 }).success, true);
});

test("security incident calendar retention preserves leap-year legal dates", () => {
  const leap = new Date("2024-02-29T12:30:00.000Z");
  assert.equal(addUtcCalendarYears(leap, 1).toISOString(), "2025-02-28T12:30:00.000Z");
  assert.equal(incidentRetentionExpiry(leap).toISOString(), "2030-02-28T12:30:00.000Z");
});

test("security incident awareness deadline is immutable UTC +72 hours", () => {
  assert.equal(incidentDeadline(new Date("2026-03-29T00:00:00.000Z")).toISOString(), "2026-04-01T00:00:00.000Z");
});

test("OpenAPI exposes every runtime security-incident action and exact export route", () => {
  assert.equal(securityIncidentActionSchema.options.length, 14);
  const schema = OPENAPI_DOCUMENT.components.schemas.SecurityIncidentAction as { oneOf?: readonly { required?: readonly string[]; additionalProperties?: unknown; properties?: { action?: { const?: string } } }[] };
  assert.equal(schema.oneOf?.length, securityIncidentActionSchema.options.length);
  for (const runtime of securityIncidentActionSchema.options) {
    const action = String(runtime.shape.action.value);
    const documented: { required?: readonly string[]; additionalProperties?: unknown; properties?: { action?: { const?: string } } } | undefined = schema.oneOf?.find((option) => option.properties?.action?.const === action);
    assert.ok(documented);
    assert.equal(documented?.additionalProperties, false);
    const runtimeRequired = Object.entries(runtime.shape).filter(([, value]) => !value.isOptional()).map(([key]) => key).sort();
    assert.deepEqual([...documented!.required!].sort(), runtimeRequired);
  }
  const exported = OPENAPI_DOCUMENT.paths["/v1/admin/security-incidents/{incidentId}/authority-exports/{version}"].get.responses["200"] as { content?: { "application/json"?: { schema?: { required?: readonly string[] } } } };
  assert.deepEqual(exported.content?.["application/json"]?.schema?.required, ["payload", "digest", "version"]);
  const response = OPENAPI_DOCUMENT.components.schemas.SecurityIncidentResponse as { additionalProperties?: unknown; properties?: { incident?: { $ref?: string } } };
  const list = OPENAPI_DOCUMENT.components.schemas.SecurityIncidentListResponse as { additionalProperties?: unknown; properties?: { incidents?: { items?: { $ref?: string } } } };
  assert.equal(response.additionalProperties, false);
  assert.equal(response.properties?.incident?.$ref, "#/components/schemas/SecurityIncidentDetails");
  assert.equal(list.additionalProperties, false);
  assert.equal(list.properties?.incidents?.items?.$ref, "#/components/schemas/SecurityIncidentListItem");
  for (const [name, value] of Object.entries(OPENAPI_DOCUMENT.components.schemas).filter(([name]) => name.startsWith("SecurityIncident"))) assert.equal(JSON.stringify(value).includes("\"additionalProperties\":true"), false, name);
  const create = OPENAPI_DOCUMENT.components.schemas.SecurityIncidentCreate as { properties?: Record<string, unknown> };
  assert.deepEqual(Object.keys(create.properties ?? {}).sort(), Object.keys(createSecurityIncidentSchema.shape).sort());
  const delivery = OPENAPI_DOCUMENT.components.schemas.SecurityIncidentDelivery as { properties?: { status?: { enum?: readonly string[] } } };
  assert.ok(delivery.properties?.status?.enum?.includes("superseded"));
});
