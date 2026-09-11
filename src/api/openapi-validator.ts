/**
 * Executable checks for the public OpenAPI contract.
 *
 * This module deliberately does not import OPENAPI_DOCUMENT.  It is the
 * shared validation layer used by the source document checks and by tests
 * that supply intentionally malformed documents or runtime inventories.
 */

import {
  normalizeRoutePath,
  ROUTE_CONSUMER_SCOPES,
  ROUTE_SECURITY_PROFILES,
  type RouteConsumerScope,
  type RouteSecurityProfile,
} from "./route-contract.js";

export const OPENAPI_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type OpenApiHttpMethod = (typeof OPENAPI_HTTP_METHODS)[number];

export const SECURITY_PROFILES = ROUTE_SECURITY_PROFILES;
export type SecurityProfile = RouteSecurityProfile;

export const CONSUMER_SCOPES = ROUTE_CONSUMER_SCOPES;
export type ConsumerScope = RouteConsumerScope;

export function securityRequirementNames(profile: SecurityProfile): readonly string[] {
  if (profile === "public" || profile === "webhook") return [];
  return profile === "app_check_optional_bearer" ? ["appCheckAuth"] : ["bearerAuth"];
}

export type RuntimeRouteDescriptor = Readonly<{
  method: string;
  path: string;
  /** Diagnostic label observed on the registered handler/pre-handler. */
  securityProfile: string;
  /** OpenAPI metadata used to select the behavioral security probe. */
  declaredSecurityProfile: string;
  consumerScope: string;
  acceptsJson?: boolean;
}>;

type UnknownRecord = Record<string, unknown>;
type OpenApiOperation = UnknownRecord & {
  responses?: UnknownRecord;
  operationId?: unknown;
  security?: unknown;
  parameters?: unknown;
  requestBody?: unknown;
};
type OpenApiDocumentLike = UnknownRecord & { paths?: unknown; components?: unknown };
type OperationEntry = Readonly<{ method: string; path: string; operation: OpenApiOperation; pathItem: UnknownRecord }>;

const OPENAPI_METHOD_SET = new Set<string>(OPENAPI_HTTP_METHODS.map((method) => method.toLowerCase()));
const SECURITY_PROFILE_SET = new Set<string>(SECURITY_PROFILES);
const CONSUMER_SCOPE_SET = new Set<string>(CONSUMER_SCOPES);
const COMMON_ERROR_REF = "#/components/schemas/ErrorEnvelope";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

/**
 * Convert Fastify's `:param` notation and OpenAPI's `{param}` notation to the
 * same canonical path. Query strings and a trailing slash are not part of a
 * route identity.
 */
export function normalizeApiPath(value: string): string {
  return normalizeRoutePath(value);
}

export function normalizeHttpMethod(value: string): string {
  return value.trim().toUpperCase();
}

export function operationKey(method: string, path: string): string {
  return `${normalizeHttpMethod(method)} ${normalizeApiPath(path)}`;
}

function pathParameters(path: string): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const matcher = /\{([^}]+)\}/gu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(path)) !== null) {
    const name = match[1];
    if (name !== undefined && !seen.has(name)) {
      names.push(name);
      seen.add(name);
    }
  }
  return names;
}

function operationEntries(document: OpenApiDocumentLike): readonly OperationEntry[] {
  const paths = asRecord(document.paths);
  if (paths === null) return [];
  const entries: OperationEntry[] = [];
  for (const [path, pathItemValue] of Object.entries(paths)) {
    const pathItem = asRecord(pathItemValue);
    if (pathItem === null) continue;
    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!OPENAPI_METHOD_SET.has(method.toLowerCase())) continue;
      const operation = asRecord(operationValue);
      if (operation !== null) entries.push({ method: normalizeHttpMethod(method), path, operation, pathItem });
    }
  }
  return entries;
}

function responseStatus(status: string): number | null {
  if (!/^[1-5][0-9]{2}$/u.test(status)) return null;
  return Number(status);
}

function localReference(value: unknown): string | null {
  const record = asRecord(value);
  return typeof record?.$ref === "string" ? record.$ref : null;
}

function resolveLocalReference(document: OpenApiDocumentLike, value: unknown): unknown {
  const reference = localReference(value);
  if (reference === null || !reference.startsWith("#/")) return value;
  let current: unknown = document;
  for (const part of reference.slice(2).split("/")) {
    if (!isRecord(current)) return undefined;
    const decoded = part.replace(/~1/gu, "/").replace(/~0/gu, "~");
    current = current[decoded];
  }
  return current;
}

function schemaHasContent(document: OpenApiDocumentLike, value: unknown, seen = new Set<string>()): boolean {
  const reference = localReference(value);
  if (reference !== null) {
    if (reference === "#/components/schemas/EmptyRequest") return true;
    if (seen.has(reference)) return false;
    seen.add(reference);
    return schemaHasContent(document, resolveLocalReference(document, value), seen);
  }
  const schema = asRecord(value);
  if (schema === null) return false;
  let hasComposition = false;
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    if (keyword in schema) {
      hasComposition = true;
      const branches = schema[keyword];
      if (!Array.isArray(branches) || branches.length === 0 || !branches.some((branch) => schemaHasContent(document, branch, new Set(seen)))) return false;
    }
  }
  if (schema.not !== undefined && !schemaHasContent(document, schema.not, new Set(seen))) return false;
  if (schema.type === "object") {
    const properties = asRecord(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required : [];
    const additionalProperties = schema.additionalProperties;
    return (properties !== null && Object.keys(properties).length > 0)
      || required.length > 0
      || (isRecord(additionalProperties) && schemaHasContent(document, additionalProperties, new Set(seen)));
  }
  if (schema.type === "array") return schemaHasContent(document, schema.items, new Set(seen));
  if (typeof schema.type === "string" || schema.const !== undefined || Array.isArray(schema.enum) || typeof schema.format === "string" || typeof schema.pattern === "string") return true;
  return hasComposition;
}

function responseHasJsonSchema(document: OpenApiDocumentLike, response: unknown): boolean {
  const resolved = resolveLocalReference(document, response);
  const responseRecord = asRecord(resolved);
  const content = asRecord(responseRecord?.content);
  const json = asRecord(content?.["application/json"]);
  return schemaHasContent(document, json?.schema);
}

function requestBodyHasJsonSchema(document: OpenApiDocumentLike, operation: OpenApiOperation): boolean {
  const requestBody = resolveLocalReference(document, operation.requestBody);
  const requestRecord = asRecord(requestBody);
  const content = asRecord(requestRecord?.content);
  const json = asRecord(content?.["application/json"]);
  return schemaHasContent(document, json?.schema);
}

function parameterName(value: unknown): string | null {
  const parameter = asRecord(value);
  return typeof parameter?.name === "string" ? parameter.name : null;
}

function pathParameterDeclared(document: OpenApiDocumentLike, operation: OpenApiOperation, pathItem: UnknownRecord, name: string): boolean {
  const parameters = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];
  return parameters.some((parameterValue) => {
    const parameter = asRecord(resolveLocalReference(document, parameterValue));
    return parameter?.in === "path" && parameter?.required === true && parameterName(parameter) === name;
  });
}

function readSecurityRequirementNames(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const names = new Set<string>();
  for (const requirementValue of value) {
    const requirement = asRecord(requirementValue);
    if (requirement === null) return null;
    for (const name of Object.keys(requirement)) names.add(name);
  }
  return [...names].sort();
}

function securityProfileValid(document: OpenApiDocumentLike, method: string, path: string, operation: OpenApiOperation): readonly string[] {
  const failures: string[] = [];
  const profile = operation["x-patternly-security-profile"];
  if (typeof profile !== "string" || !SECURITY_PROFILE_SET.has(profile)) {
    failures.push("security_profile_missing_or_unknown");
    return failures;
  }
  const names = readSecurityRequirementNames(operation.security);
  if (names === null) {
    failures.push("security_requirements_missing_or_invalid");
    return failures;
  }
  const requiredNames = securityRequirementNames(profile as SecurityProfile);
  if (names.join(",") !== requiredNames.join(",")) failures.push(`security_requirements_expected:${requiredNames.join(",") || "none"}`);
  const components = asRecord(document.components);
  const schemes = asRecord(components?.securitySchemes);
  for (const name of requiredNames) if (!isRecord(schemes?.[name])) failures.push(`security_scheme_missing:${name}`);
  return failures;
}

function consumerScopeValid(operation: OpenApiOperation): readonly string[] {
  const value = operation["x-patternly-consumer-scope"];
  if (typeof value !== "string" || !CONSUMER_SCOPE_SET.has(value)) return ["consumer_scope_missing_or_unknown"];
  return [];
}

function errorEnvelopeIsClosed(document: OpenApiDocumentLike): boolean {
  const components = asRecord(document.components);
  const schemas = asRecord(components?.schemas);
  const envelope = asRecord(schemas?.ErrorEnvelope);
  const error = asRecord(asRecord(envelope?.properties)?.error);
  const errorProperties = asRecord(error?.properties);
  return envelope?.type === "object"
    && envelope?.additionalProperties === false
    && Array.isArray(envelope.required)
    && envelope.required.includes("error")
    && error?.type === "object"
    && error?.additionalProperties === false
    && Array.isArray(error.required)
    && error.required.includes("code")
    && errorProperties?.code !== undefined;
}

/**
 * Return every contract violation rather than stopping at the first one. This
 * keeps CI output actionable and gives negative tests a stable diagnostic.
 */
export function collectOpenApiContractErrors(documentValue: unknown): readonly string[] {
  const document = asRecord(documentValue);
  if (document === null) return ["document_not_object"];
  const failures: string[] = [];
  const paths = asRecord(document.paths);
  if (paths === null) return ["paths_missing_or_invalid"];
  if (!errorEnvelopeIsClosed(document)) failures.push("error_envelope_missing_or_open");

  const operationIds = new Map<string, string>();
  for (const entry of operationEntries(document)) {
    const identity = operationKey(entry.method, entry.path);
    const operationId = entry.operation.operationId;
    if (typeof operationId !== "string" || operationId.trim().length === 0) failures.push(`${identity}:operation_id_missing`);
    else {
      const previous = operationIds.get(operationId);
      if (previous !== undefined) failures.push(`${identity}:operation_id_duplicate:${operationId}:${previous}`);
      else operationIds.set(operationId, identity);
    }
    failures.push(...securityProfileValid(document, entry.method, entry.path, entry.operation).map((failure) => `${identity}:${failure}`));
    failures.push(...consumerScopeValid(entry.operation).map((failure) => `${identity}:${failure}`));

    for (const parameter of pathParameters(entry.path)) {
      if (!pathParameterDeclared(document, entry.operation, entry.pathItem, parameter)) failures.push(`${identity}:path_parameter_missing:${parameter}`);
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(entry.method) && !requestBodyHasJsonSchema(document, entry.operation)) {
      failures.push(`${identity}:json_request_schema_missing`);
    }

    const responses = asRecord(entry.operation.responses);
    if (responses === null || Object.keys(responses).length === 0) {
      failures.push(`${identity}:responses_missing`);
      continue;
    }
    for (const [status, response] of Object.entries(responses)) {
      const numericStatus = responseStatus(status);
      if (numericStatus === null) continue;
      if (numericStatus >= 200 && numericStatus < 300) {
        if (numericStatus !== 204 && !responseHasJsonSchema(document, response)) failures.push(`${identity}:success_schema_missing:${status}`);
      } else if (numericStatus >= 400 && !responseHasJsonSchema(document, response)) {
        failures.push(`${identity}:error_schema_missing:${status}`);
      } else if (numericStatus >= 400) {
        const resolved = asRecord(resolveLocalReference(document, response));
        const schema = asRecord(asRecord(asRecord(resolved?.content)?.["application/json"])?.schema);
        if (schema?.$ref !== COMMON_ERROR_REF) failures.push(`${identity}:error_schema_not_common_envelope:${status}`);
      }
    }
  }
  if (operationIds.size === 0) failures.push("operations_missing");
  return failures;
}

export function assertOpenApiContract(document: unknown): void {
  const failures = collectOpenApiContractErrors(document);
  if (failures.length > 0) throw new Error(`openapi_contract_invalid:${failures.join(";")}`);
}

/** Alias kept descriptive for callers that prefer a validator-style name. */
export const validateOpenApiDocument = assertOpenApiContract;
export const validateOpenApiContract = assertOpenApiContract;
export const validateOpenApiCompleteness = assertOpenApiContract;

export function collectRuntimeParityErrors(runtimeRoutes: readonly RuntimeRouteDescriptor[], documentValue: unknown): readonly string[] {
  const document = asRecord(documentValue);
  if (document === null) return ["document_not_object"];
  const failures: string[] = [];
  const runtime = new Map<string, RuntimeRouteDescriptor>();
  for (const route of runtimeRoutes) {
    const method = normalizeHttpMethod(route.method);
    if (method === "HEAD") continue;
    const key = operationKey(method, route.path);
    if (runtime.has(key)) failures.push(`runtime_operation_duplicate:${key}`);
    else runtime.set(key, route);
  }
  const documented = new Map<string, OpenApiOperation>();
  for (const entry of operationEntries(document)) documented.set(operationKey(entry.method, entry.path), entry.operation);
  for (const key of runtime.keys()) if (!documented.has(key)) failures.push(`runtime_operation_missing_from_openapi:${key}`);
  for (const key of documented.keys()) if (!runtime.has(key)) failures.push(`openapi_operation_missing_from_runtime:${key}`);
  for (const [key, route] of runtime) {
    const operation = documented.get(key);
    if (operation === undefined) continue;
    if (route.acceptsJson === true && !requestBodyHasJsonSchema(document, operation)) failures.push(`runtime_json_request_schema_missing:${key}`);
  }
  return failures;
}

export function assertRuntimeParity(runtimeRoutes: readonly RuntimeRouteDescriptor[], document: unknown): void {
  const failures = collectRuntimeParityErrors(runtimeRoutes, document);
  if (failures.length > 0) throw new Error(`runtime_openapi_parity_invalid:${failures.join(";")}`);
}

/** Alias for callers that use "parity" as the operation name. */
export const validateRuntimeParity = assertRuntimeParity;
export const validateRuntimeOpenApiParity = assertRuntimeParity;
export const normalizeRuntimePath = normalizeApiPath;

function profileForObservedGuard(value: string): string {
  return value === "none" ? "public" : value;
}

export function runtimeRoute(
  method: string,
  path: string,
  operation: Readonly<Record<string, unknown>> | undefined,
  observedProtection: string,
  acceptsJson?: boolean,
): RuntimeRouteDescriptor {
  const declaredSecurityProfile = operation?.["x-patternly-security-profile"];
  const consumerScope = operation?.["x-patternly-consumer-scope"];
  return Object.freeze({
    method: normalizeHttpMethod(method),
    path: normalizeApiPath(path),
    securityProfile: profileForObservedGuard(observedProtection),
    declaredSecurityProfile: typeof declaredSecurityProfile === "string" ? declaredSecurityProfile : "unknown",
    consumerScope: typeof consumerScope === "string" ? consumerScope : "unknown",
    ...(acceptsJson === undefined ? {} : { acceptsJson }),
  });
}
