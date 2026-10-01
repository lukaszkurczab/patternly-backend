import { openSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { ReadStream as TtyReadStream } from "node:tty";
import { stdin, stderr, stdout } from "node:process";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as ajvFormats from "ajv-formats";
import { OPENAPI_DOCUMENT } from "../src/api/openapi.js";

export type OperatorCliIO = Readonly<{
  inputIsTTY: boolean;
  stdinIsTTY: boolean;
  writeOut(text: string): void;
  writeError(text: string): void;
  readPayload(fd?: number): Promise<string>;
  readHidden(prompt: string): Promise<string>;
  readLine(prompt: string): Promise<string>;
}>;

type Command = "list" | "show" | "action" | "create-incident" | "authority-export";
type Family = "content-reports" | "privacy-requests" | "legal-requests" | "security-incidents";
type ParsedCommand = Readonly<{
  command: Command;
  family?: Family;
  id?: string;
  version?: number;
  origin: string;
  configPath: string;
  payloadFd?: number;
  createId?: string;
}>;

const MAX_INPUT_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const OPENAPI_SCHEMA_ID = "patternly-openapi";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FAMILY_ROUTES: Readonly<Record<Family, string>> = Object.freeze({
  "content-reports": "/v1/operator/content-reports",
  "privacy-requests": "/v1/operator/privacy-requests",
  "legal-requests": "/v1/operator/legal-requests",
  "security-incidents": "/v1/operator/security-incidents",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string): never {
  throw new Error(code);
}

function exactHttpsOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== value) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function parseArgs(argv: readonly string[]): ParsedCommand {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") fail("usage");
  const commandValue = argv[0];
  if (commandValue !== "list" && commandValue !== "show" && commandValue !== "action" && commandValue !== "create-incident" && commandValue !== "authority-export") fail("usage");
  const command: Command = commandValue;
  const positionals: string[] = [];
  let origin: string | undefined;
  let configPath: string | undefined;
  let payloadFd: number | undefined;
  let createId: string | undefined;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part?.startsWith("--")) {
      positionals.push(part ?? "");
      continue;
    }
    if (part !== "--origin" && part !== "--config" && part !== "--payload-fd" && part !== "--id") fail("unknown_option");
    if (seen.has(part)) fail("duplicate_option");
    seen.add(part);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("option_value_required");
    index += 1;
    if (part === "--origin") origin = value;
    else if (part === "--config") configPath = value;
    else if (part === "--payload-fd") {
      if (!/^(0|[1-9][0-9]*)$/u.test(value)) fail("payload_fd_invalid");
      payloadFd = Number(value);
      if (!Number.isSafeInteger(payloadFd) || payloadFd > 1024) fail("payload_fd_invalid");
    } else createId = value;
  }

  if (!origin || !configPath || exactHttpsOrigin(origin) === null) fail("origin_required_or_invalid");
  if (command !== "create-incident" && createId !== undefined) fail("id_not_allowed");
  if (command !== "action" && command !== "create-incident" && payloadFd !== undefined) fail("payload_fd_not_allowed");

  let family: Family | undefined;
  let id: string | undefined;
  let version: number | undefined;
  if (command === "list") {
    if (positionals.length !== 1 || !isFamily(positionals[0])) fail("usage");
    family = positionals[0];
  } else if (command === "show" || command === "action") {
    if (positionals.length !== 2 || !isFamily(positionals[0]) || !isValidId(positionals[0], positionals[1] ?? "")) fail("usage");
    family = positionals[0];
    id = positionals[1];
  } else if (command === "create-incident") {
    if (positionals.length !== 0) fail("usage");
    if (createId !== undefined) {
      if (!createId.startsWith("si_") || !UUID.test(createId.slice(3))) fail("incident_id_invalid");
    }
  } else {
    if (positionals.length !== 2 || !isValidId("security-incidents", positionals[0] ?? "")) fail("usage");
    const rawVersion = positionals[1] ?? "";
    if (!/^[1-9][0-9]*$/u.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion))) fail("version_invalid");
    id = positionals[0];
    version = Number(rawVersion);
  }

  return Object.freeze({ command, ...(family ? { family } : {}), ...(id ? { id } : {}), ...(version === undefined ? {} : { version }), origin, configPath: resolve(configPath), ...(payloadFd === undefined ? {} : { payloadFd }), ...(createId ? { createId } : {}) });
}

function isFamily(value: unknown): value is Family {
  return typeof value === "string" && Object.hasOwn(FAMILY_ROUTES, value);
}

function isValidId(family: Family, id: string): boolean {
  if (family === "privacy-requests") return /^pr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id);
  if (family === "legal-requests") return /^lr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id);
  if (family === "security-incidents") return id.startsWith("si_") && UUID.test(id.slice(3));
  return UUID.test(id);
}

async function readConfig(path: string, origin: string): Promise<void> {
  let value: unknown;
  try { value = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8")) as unknown; }
  catch { fail("config_unavailable_or_invalid"); }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "allowedOrigins") || !Array.isArray(value.allowedOrigins) || value.allowedOrigins.length === 0) fail("config_invalid");
  const origins = value.allowedOrigins.map(exactHttpsOrigin);
  if (origins.some((candidate) => candidate === null) || new Set(origins).size !== origins.length) fail("config_invalid");
  if (!origins.includes(origin)) fail("origin_not_allowed");
}

function decodeJwtSegment(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) fail("token_invalid");
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown; }
  catch { fail("token_invalid"); }
}

function validateLocalTokenShape(token: string, nowSeconds = Math.floor(Date.now() / 1000)): void {
  if (token.length > 16_384) fail("token_invalid");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) fail("token_invalid");
  const header = decodeJwtSegment(parts[0] ?? "");
  const claims = decodeJwtSegment(parts[1] ?? "");
  if (!isRecord(header) || header.alg !== "RS256" || header.typ !== "JWT" || !isRecord(claims)) fail("token_invalid");
  if (typeof claims.iss !== "string" || !claims.iss || typeof claims.aud !== "string" && !(Array.isArray(claims.aud) && claims.aud.length > 0 && claims.aud.every((value) => typeof value === "string" && value.length > 0))) fail("token_invalid");
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) || typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp)) fail("token_invalid");
  if (claims.iat > nowSeconds + 30 || claims.exp <= nowSeconds || claims.exp <= claims.iat || claims.exp - claims.iat > 3600 || claims.exp - nowSeconds > 3600) fail("token_invalid");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isSafeInteger(claims.nbf) || claims.nbf > nowSeconds + 30)) fail("token_invalid");
}

function makeAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  const addFormats = ajvFormats.default as unknown as (instance: Ajv2020) => Ajv2020;
  addFormats(ajv);
  ajv.addSchema(OPENAPI_DOCUMENT as unknown as Record<string, unknown>, OPENAPI_SCHEMA_ID);
  return ajv;
}

function operationAt(path: string, method: string): Record<string, unknown> {
  const paths = OPENAPI_DOCUMENT.paths as unknown as Record<string, Record<string, unknown>>;
  const pathItem = paths[path];
  const operation = pathItem?.[method.toLowerCase()];
  if (!isRecord(operation)) fail("canonical_schema_unavailable");
  return operation;
}

function qualifyReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(qualifyReferences);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === "$ref" && typeof child === "string" && child.startsWith("#/") ? `${OPENAPI_SCHEMA_ID}${child}` : qualifyReferences(child)]));
}

function requestValidator(ajv: Ajv2020, path: string, method: string): (value: unknown) => boolean {
  const requestBody = operationAt(path, method).requestBody;
  if (!isRecord(requestBody) || !isRecord(requestBody.content) || !isRecord(requestBody.content["application/json"])) fail("canonical_schema_unavailable");
  const schema = (requestBody.content["application/json"] as Record<string, unknown>).schema;
  if (!schema) fail("canonical_schema_unavailable");
  return ajv.compile(qualifyReferences(schema) as object);
}

function responseValidator(ajv: Ajv2020, path: string, method: string, status: number): (value: unknown) => boolean {
  const responses = operationAt(path, method).responses;
  const response = isRecord(responses) ? responses[String(status)] : undefined;
  const content = isRecord(response) ? response.content : undefined;
  const media = isRecord(content) ? content["application/json"] : undefined;
  const schema = isRecord(media) ? media.schema : undefined;
  if (!schema) fail("canonical_schema_unavailable");
  return ajv.compile(qualifyReferences(schema) as object);
}

function requestUrl(origin: string, route: string): string {
  return new URL(route, `${origin}/`).toString();
}

async function sendRequest(url: string, method: string, token: string, body?: unknown): Promise<Response> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") fail("insecure_tls_configuration");
  return fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function responseBody(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_INPUT_BYTES) fail("response_too_large");
  const reader = response.body?.getReader();
  if (!reader) fail("response_invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > MAX_INPUT_BYTES) {
      await reader.cancel();
      fail("response_too_large");
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { fail("response_invalid"); }
}

function codedError(body: unknown): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string" && /^[a-z][a-z0-9_]{0,80}$/u.test(body.error.code)) return body.error.code;
  return "request_rejected";
}

function reportError(io: OperatorCliIO, error: unknown): number {
  const code = error instanceof Error && /^[a-z][a-z0-9_]{0,80}$/u.test(error.message) ? error.message : "operator_cli_failed";
  io.writeError(`Error: ${code}\n`);
  return code === "cancelled" ? 130 : 1;
}

function familyRoute(family: Family, id?: string): string {
  return id ? `${FAMILY_ROUTES[family]}/${encodeURIComponent(id)}` : FAMILY_ROUTES[family];
}

function operatorFamilyPath(family: Family, detail: boolean): string {
  if (!detail) return FAMILY_ROUTES[family];
  const parameter = family === "content-reports" ? "clientSubmissionId" : family === "security-incidents" ? "incidentId" : "requestId";
  return `${FAMILY_ROUTES[family]}/{${parameter}}`;
}

function parsePayload(raw: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) fail("payload_too_large");
  try { return JSON.parse(raw) as unknown; }
  catch { fail("payload_invalid_json"); }
}

function assertValid(validator: (value: unknown) => boolean, value: unknown, errorCode: string): void {
  if (!validator(value)) fail(errorCode);
}

function bodyItem(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.item)) fail("response_invalid");
  return value.item;
}

async function apiRead(url: string, token: string, validator: (value: unknown) => boolean): Promise<unknown> {
  let response: Response;
  try { response = await sendRequest(url, "GET", token); }
  catch { fail("request_transport_failed"); }
  let body: unknown;
  try { body = await responseBody(response); }
  catch { fail(response.status >= 200 && response.status < 300 ? "response_invalid" : `http_${response.status}`); }
  if (response.status >= 400 && response.status < 500) fail(codedError(body));
  if (response.status !== 200) fail(response.status >= 500 ? `http_${response.status}` : "response_status_unexpected");
  assertValid(validator, body, "response_invalid");
  return body;
}

function currentRevision(detail: unknown): number | null {
  const item = bodyItem(detail);
  return typeof item.revision === "number" && Number.isSafeInteger(item.revision) ? item.revision : null;
}

function validateActionPrecondition(family: Family, detail: unknown, payload: unknown): void {
  if (!isRecord(payload)) fail("payload_invalid");
  const item = bodyItem(detail);
  if (family === "content-reports") {
    if (typeof item.status !== "string" || payload.expectedStatus !== item.status) fail("status_precondition_conflict");
    return;
  }
  const revision = currentRevision(detail);
  if (revision === null || payload.expectedRevision !== revision) fail("revision_precondition_conflict");
}

function safeEffectSummary(family: Family, payload: Record<string, unknown>): Record<string, unknown> {
  const action = payload.action;
  if (family === "content-reports" && typeof payload.status === "string") return { status: payload.status };
  if (family === "legal-requests") {
    if (action === "set_legal_hold" && typeof payload.active === "boolean") return { legalHold: payload.active };
    if (action === "start_review") return { status: "in_review" };
    if (action === "answer") return { status: "answered" };
    if (action === "close") return { status: "closed" };
  }
  if (family === "privacy-requests") {
    const effects: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
      require_verification: { status: "identity_verification_required" },
      verify_subject: { status: "received" },
      start_review: { status: "in_review" },
      execute_export: { effect: "execute_account_data_export" },
      extend: { effect: "extend_deadline_and_send_notice" },
      retry_extension_notice: { effect: "retry_extension_notice_delivery" },
      prepare_response: { effect: "prepare_response", outcome: payload.outcome },
      deliver: { effect: "deliver_prepared_response" },
      close: { status: "closed" },
    };
    return typeof action === "string" ? effects[action] ?? { action } : {};
  }
  if (family === "security-incidents") {
    if (action === "set_legal_hold") return { legalHold: true };
    if (action === "release_legal_hold") return { legalHold: false };
    if (action === "classify") return { classification: payload.classification };
    if (action === "decide_authority") return { authorityDecision: payload.decision };
    if (action === "decide_subject") return { subjectDecision: payload.decision };
    const effects: Readonly<Record<string, string>> = {
      acknowledge_awareness: "record_awareness",
      correct_assessment: "correct_assessment",
      prepare_authority_export: "prepare_authority_export",
      record_authority_submission: "record_authority_submission",
      prepare_subject_notification: "prepare_subject_notification",
      send_subject_notification: "send_subject_notification",
      resolve_subject_notification_unknown: "resolve_subject_notification_delivery",
      reconcile_subject_notifications: "reconcile_subject_notifications",
      close: "close_incident",
    };
    return typeof action === "string" ? { effect: effects[action] ?? action } : {};
  }
  return typeof action === "string" ? { action } : {};
}

async function reconcile(url: string, token: string, validator: (value: unknown) => boolean, io: OperatorCliIO): Promise<void> {
  try {
    const observed = await apiRead(url, token, validator);
    io.writeError("AMBIGUOUS — RECONCILIATION REQUIRED: mutation outcome is unknown. Observed current state does not prove whether this request caused it.\n");
    io.writeOut(`${JSON.stringify(observed, null, 2)}\n`);
  } catch {
    io.writeError("AMBIGUOUS: mutation outcome is unknown, and the single reconciliation read did not produce a validated current state.\n");
  }
}

export async function runOperatorCli(argv: readonly string[], io: OperatorCliIO): Promise<number> {
  let mutationDispatched = false;
  let reconciliation: Readonly<{ url: string; validator: (value: unknown) => boolean; token: string }> | undefined;
  try {
    const command = parseArgs(argv);
    await readConfig(command.configPath, command.origin);
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") fail("insecure_tls_configuration");
    const ajv = makeAjv();

    let mutationBody: unknown;
    let incidentId: string | undefined;
    if (command.command === "action" || command.command === "create-incident") {
      if (command.payloadFd === undefined && io.stdinIsTTY) fail("payload_fd_required_for_interactive_input");
      mutationBody = parsePayload(await io.readPayload(command.payloadFd));
      incidentId = command.command === "create-incident" ? command.createId ?? `si_${randomUUID()}` : undefined;
      const requestPath = command.command === "create-incident" ? "/v1/operator/security-incidents/{incidentId}" : operatorFamilyPath(command.family!, true);
      assertValid(requestValidator(ajv, requestPath, command.command === "create-incident" ? "PUT" : "PATCH"), mutationBody, "payload_invalid");
    }

    if (command.command === "action" && command.family && command.id) {
      const token = await getToken(io);
      const detailPath = operatorFamilyPath(command.family, true);
      const detailSchema = responseValidator(ajv, detailPath, "get", 200);
      const current = await apiRead(requestUrl(command.origin, familyRoute(command.family, command.id)), token, detailSchema);
      validateActionPrecondition(command.family, current, mutationBody);
      const action = command.family === "content-reports" ? "transition" : (mutationBody as Record<string, unknown>).action;
      const phrase = `apply ${command.family} ${String(action)} to ${command.id}`;
      const effect = safeEffectSummary(command.family, mutationBody as Record<string, unknown>);
      io.writeOut(`Current state: ${JSON.stringify({
        status: bodyItem(current).status,
        revision: bodyItem(current).revision,
        proposedEffect: effect,
      })}\n`);
      if (await io.readLine(`Type "${phrase}" to confirm: `) !== phrase) fail("cancelled");
      const pathTemplate = command.family === "content-reports" ? "/v1/operator/content-reports/{clientSubmissionId}" : command.family === "privacy-requests" ? "/v1/operator/privacy-requests/{requestId}" : command.family === "legal-requests" ? "/v1/operator/legal-requests/{requestId}" : "/v1/operator/security-incidents/{incidentId}";
      const validator = responseValidator(ajv, pathTemplate, "patch", 200);
      const url = requestUrl(command.origin, familyRoute(command.family, command.id));
      reconciliation = { url, validator: detailSchema, token };
      mutationDispatched = true;
      const response = await sendRequest(url, "PATCH", token, mutationBody);
      if (response.status >= 400 && response.status < 500) { io.writeError(`Error: ${await safeHttpCode(response)}\n`); return 1; }
      if (response.status !== 200) {
        await reconcile(url, token, detailSchema, io);
        return 2;
      }
      let responseValue: unknown;
      try { responseValue = await responseBody(response); }
      catch { await reconcile(url, token, detailSchema, io); return 2; }
      if (!validator(responseValue)) { await reconcile(url, token, detailSchema, io); return 2; }
      io.writeOut(`${JSON.stringify(responseValue, null, 2)}\n`);
      return 0;
    }

    if (command.command === "create-incident") {
      const id = incidentId!;
      const route = `/v1/operator/security-incidents/${id}`;
      const token = await getToken(io);
      const detailValidator = responseValidator(ajv, "/v1/operator/security-incidents/{incidentId}", "get", 200);
      io.writeOut(`Incident ID: ${id}\n`);
      io.writeOut(`Proposed effect: ${JSON.stringify({ effect: "create_or_replay_incident", classification: "triage", subjectNotificationStatus: "not_started" })}\n`);
      io.writeOut("An exact-payload replay may return the existing incident in its current state; this does not reset it.\n");
      if (await io.readLine(`Type "create incident ${id}" to confirm: `) !== `create incident ${id}`) fail("cancelled");
      const validator = responseValidator(ajv, "/v1/operator/security-incidents/{incidentId}", "put", 200);
      const url = requestUrl(command.origin, route);
      reconciliation = { url: requestUrl(command.origin, `${FAMILY_ROUTES["security-incidents"]}/${id}`), validator: detailValidator, token };
      mutationDispatched = true;
      const response = await sendRequest(url, "PUT", token, mutationBody);
      if (response.status >= 400 && response.status < 500) { io.writeError(`Error: ${await safeHttpCode(response)}\n`); return 1; }
      if (response.status !== 200) { await reconcile(reconciliation.url, token, detailValidator, io); return 2; }
      let responseValue: unknown;
      try { responseValue = await responseBody(response); }
      catch { await reconcile(reconciliation.url, token, detailValidator, io); return 2; }
      if (!validator(responseValue)) { await reconcile(reconciliation.url, token, detailValidator, io); return 2; }
      io.writeOut(`${JSON.stringify(responseValue, null, 2)}\n`);
      return 0;
    }

    const token = await getToken(io);
    if (command.command === "list" && command.family) {
      const route = FAMILY_ROUTES[command.family];
      const queueSchema = responseValidator(ajv, route, "get", 200);
      const result = await apiRead(requestUrl(command.origin, route), token, queueSchema);
      if (!isRecord(result) || !Array.isArray(result.items)) fail("response_invalid");
      if (result.truncated === true) io.writeError("Warning: list is truncated to 100 items.\n");
      io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (command.command === "show" && command.family && command.id) {
      const route = familyRoute(command.family, command.id);
      const schema = responseValidator(ajv, operatorFamilyPath(command.family, true), "get", 200);
      const result = await apiRead(requestUrl(command.origin, route), token, schema);
      io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (command.command === "authority-export" && command.id && command.version) {
      const route = `${FAMILY_ROUTES["security-incidents"]}/${command.id}/authority-exports/${command.version}`;
      const result = await apiRead(requestUrl(command.origin, route), token, responseValidator(ajv, "/v1/operator/security-incidents/{incidentId}/authority-exports/{version}", "get", 200));
      io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    fail("usage");
  } catch (error) {
    if (mutationDispatched && reconciliation) {
      await reconcile(reconciliation.url, reconciliation.token, reconciliation.validator, io);
      return 2;
    }
    return reportError(io, error);
  }
}

async function getToken(io: OperatorCliIO): Promise<string> {
  if (!io.inputIsTTY) fail("token_prompt_requires_tty");
  const token = await io.readHidden("Operator OIDC token (hidden): ");
  validateLocalTokenShape(token);
  return token;
}

async function safeHttpCode(response: Response): Promise<string> {
  try { return codedError(await responseBody(response)); }
  catch { return "request_rejected"; }
}

function readFd(fd: number): string {
  const read = readFileSync(fd, "utf8");
  if (Buffer.byteLength(read, "utf8") > MAX_INPUT_BYTES) fail("payload_too_large");
  return read;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of stream as AsyncIterable<Buffer | string>) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > MAX_INPUT_BYTES) fail("payload_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

let promptInput: NodeJS.ReadStream | undefined;
function getPromptInput(): NodeJS.ReadStream | undefined {
  if (stdin.isTTY === true) return stdin;
  if (promptInput) return promptInput;
  try {
    promptInput = new TtyReadStream(openSync("/dev/tty", "r+"));
    return promptInput;
  } catch {
    return undefined;
  }
}

const nodeIO: OperatorCliIO = Object.freeze({
  inputIsTTY: getPromptInput() !== undefined,
  stdinIsTTY: stdin.isTTY === true,
  writeOut: (text: string) => stdout.write(text),
  writeError: (text: string) => stderr.write(text),
  readPayload: (fd?: number) => fd === undefined ? readStream(stdin) : Promise.resolve(readFd(fd)),
  readHidden: async (prompt: string) => {
    const input = getPromptInput();
    if (!input || typeof input.setRawMode !== "function") fail("token_prompt_requires_tty");
    const previousRawMode = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    return await new Promise<string>((resolveToken, rejectToken) => {
      let token = "";
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        input.removeListener("data", onData);
        process.removeListener("SIGINT", onSigint);
        input.pause();
        input.setRawMode(previousRawMode ?? false);
        stderr.write("\n");
      };
      const onSigint = () => { cleanup(); rejectToken(new Error("cancelled")); };
      const onData = (chunk: string | Buffer) => {
        for (const char of String(chunk)) {
          if (char === "\u0003") { cleanup(); rejectToken(new Error("cancelled")); return; }
          if (char === "\r" || char === "\n") { cleanup(); resolveToken(token); return; }
          if (char === "\u0004") { cleanup(); rejectToken(new Error("cancelled")); return; }
          if (char === "\u007f" || char === "\b") token = token.slice(0, -1);
          else if (char >= " ") token += char;
        }
      };
      input.on("data", onData);
      process.once("SIGINT", onSigint);
      stderr.write(prompt);
    });
  },
  readLine: async (prompt: string) => {
    const input = getPromptInput();
    if (!input) fail("confirmation_requires_tty");
    const readline = createInterface({ input, output: stderr, terminal: true });
    try { return await readline.question(prompt); }
    catch { fail("cancelled"); }
    finally { readline.close(); }
  },
});

const directEntry = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (directEntry) {
  runOperatorCli(process.argv.slice(2), nodeIO).then((code) => { process.exitCode = code; }).catch(() => {
    stderr.write("Error: operator_cli_failed\n");
    process.exitCode = 1;
  }).finally(() => {
    // Close only the /dev/tty stream this CLI opened; never destroy standard stdin.
    promptInput?.destroy();
    promptInput = undefined;
  });
}
