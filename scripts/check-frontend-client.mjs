import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, resolve } from "node:path";

const backendRoot = resolve(process.cwd());
const mobileRoot = resolve(process.env.PATTERNLY_FRONTEND_ROOT ?? join(backendRoot, "../patternly"));
const webRoot = resolve(process.env.PATTERNLY_WEB_ROOT ?? join(backendRoot, "../patternly-web"));
const artifactPath = resolve(backendRoot, "openapi/patternly-v1.json");
const spec = JSON.parse(await readFile(artifactPath, "utf8"));

const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);
const ignoredDirectories = new Set(["node_modules", "dist", "build", "coverage"]);
const ignoredFilePattern = /(?:\.test|\.spec)\.[^.]+$/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(value) {
  const withoutQuery = value.split(/[?#]/u, 1)[0] ?? value;
  const withBraces = withoutQuery
    .replace(/\$\{\s*encodeURIComponent\(\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\)\s*\}/gu, (_match, expression) => `{${expression.split(".").at(-1)}}`)
    .replace(/\$\{\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\}/gu, (_match, expression) => `{${expression.split(".").at(-1)}}`)
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]+>)?/gu, "{$1}");
  let parameterIndex = 0;
  const positional = withBraces.replace(/\{[^}]+\}/gu, () => `{param${parameterIndex++}}`);
  const prefixed = positional.startsWith("/") ? positional : `/${positional}`;
  if (prefixed === "/") return prefixed;
  return prefixed.replace(/\/+$/u, "");
}

function endpointFromExpression(value) {
  const expression = String(value).replaceAll("\\`", "`");
  if (expression.includes("identitytoolkit") || expression.includes("/accounts:")) return null;
  const marker = expression.search(/\/(?:v[0-9]+)(?:\/|$)|\/(?:health|ready|openapi\.json)(?:[/?]|$)/u);
  if (marker < 0) return null;
  return normalizePath(expression.slice(marker));
}

function operationKey(method, path) {
  return `${method} ${normalizePath(path)}`;
}

function endpointOperations(document) {
  const result = new Map();
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      const upper = method.toUpperCase();
      if (!methods.has(upper) || !isRecord(operation)) continue;
      result.set(operationKey(upper, path), { method: upper, path: normalizePath(path), operation });
    }
  }
  return result;
}

async function pathExists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function sourceFiles(root) {
  const sourceRoot = await pathExists(join(root, "src")) ? join(root, "src") : root;
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(join(directory, entry.name));
        continue;
      }
      if (!sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf("."))) || ignoredFilePattern.test(entry.name)) continue;
      files.push(join(directory, entry.name));
    }
  }
  await visit(sourceRoot);
  return files.sort();
}

function consumerPath(value) {
  if (typeof value !== "string") return null;
  return endpointFromExpression(value);
}

function addOperation(list, scope, file, method, rawPath, source, offset, reason) {
  const path = consumerPath(rawPath);
  if (path === null) return;
  if (path === "/v1") return;
  const upperMethod = method === undefined || method === null ? null : String(method).toUpperCase();
  list.push(Object.freeze({
    file,
    method: upperMethod,
    path,
    rawPath,
    reason,
    scope,
    line: source.slice(0, offset).split("\n").length,
  }));
}

function adminReadWrapperMethod(source) {
  const wrapperStart = source.indexOf("function useAdminRead(");
  if (wrapperStart < 0) return "GET";
  const wrapperEnd = source.indexOf("\nfunction ", wrapperStart + 1);
  const wrapper = source.slice(wrapperStart, wrapperEnd < 0 ? source.length : wrapperEnd);
  return wrapper.match(/\bmethod\s*:\s*([`'”"])(GET|POST|PUT|DELETE|PATCH)\1/u)?.[2] ?? "GET";
}

function extractOperations(source, file, scope) {
  const operations = [];
  const adminReadMethod = adminReadWrapperMethod(source);
  const variableValues = new Map();
  const variablePattern = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\s*:\s*[^=;\n]+)?\s*=\s*([\s\S]*?);/gu;
  for (const match of source.matchAll(variablePattern)) variableValues.set(match[1], match[2]);

  // The mobile adapter is the canonical transport wrapper. Its second
  // argument is the actual HTTP method, so this catches every adapter method.
  const requestJsonPattern = /\brequestJson(?:<[\s\S]*?>)?\(\s*([`'”"])([\s\S]*?)\1\s*,\s*([`'”"])(GET|POST|PUT|DELETE|PATCH)\3/gu;
  for (const match of source.matchAll(requestJsonPattern)) addOperation(operations, scope, file, match[4], match[2], source, match.index ?? 0, "requestJson");

  // A transport may construct a query path in a local variable before
  // passing it to the method-bearing wrapper (for example paginated reads).
  // Resolve that local expression so dynamic path construction still proves
  // the concrete method+path identity without relying on a methodless path
  // constant elsewhere in the UI.
  const requestJsonVariablePattern = /\brequestJson(?:<[\s\S]*?>)?\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*([`'”"])(GET|POST|PUT|PATCH|DELETE)\2/gu;
  for (const match of source.matchAll(requestJsonVariablePattern)) {
    const value = variableValues.get(match[1]);
    if (value !== undefined) {
      const path = endpointFromExpression(value);
      if (path !== null) addOperation(operations, scope, file, match[3], path, source, match.index ?? 0, "requestJson-variable");
    }
  }

  // Public web privacy requests use a small POST wrapper.
  const postPattern = /\bpost\(\s*([`'”"])([\s\S]*?)\1\s*,/gu;
  for (const match of source.matchAll(postPattern)) addOperation(operations, scope, file, "POST", match[2], source, match.index ?? 0, "post");

  // Admin panels share a request(user, path, options) wrapper. A missing
  // options object means fetch's GET default.
  const requestPattern = /\brequest\(\s*[^,\n]+,\s*([`'”"])([\s\S]*?)\1/gu;
  for (const match of source.matchAll(requestPattern)) {
    const afterPath = source.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 600);
    const options = afterPath.match(/^\s*,\s*\{([\s\S]{0,500}?)\}\s*\)/u)?.[1] ?? "";
    const method = options.match(/\bmethod\s*:\s*([`'”"])(GET|POST|PUT|DELETE|PATCH)\1/u)?.[2] ?? "GET";
    addOperation(operations, scope, file, method, match[2], source, match.index ?? 0, "request");
  }

  // Direct web fetch calls (AdminPage and AdminWorkspace's read helper).
  const fetchPattern = /\bfetch\(\s*([`'”"])([\s\S]*?)\1\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/gu;
  for (const match of source.matchAll(fetchPattern)) {
    // AdminWorkspace's generic wrapper receives its concrete path through
    // useAdminRead call sites below; `${path}` alone is not a real endpoint.
    if (match[2].includes("${path}")) continue;
    const method = match[3]?.match(/\bmethod\s*:\s*([`'”"])(GET|POST|PUT|DELETE|PATCH)\1/u)?.[2] ?? "GET";
    addOperation(operations, scope, file, method, match[2], source, match.index ?? 0, "fetch");
  }

  // Resolve the one deliberate web read helper that prefixes /v1/admin/.
  const adminReadPattern = /\buseAdminRead\(\s*user\s*,\s*([`'”"])([^`'”"]+)\1/gu;
  for (const match of source.matchAll(adminReadPattern)) {
    const concrete = match[2].split(/[?#]/u, 1)[0] ?? match[2];
    addOperation(operations, scope, file, adminReadMethod, `/v1/admin/${concrete}`, source, match.index ?? 0, "useAdminRead");
  }

  // A statically declared endpoint outside a transport call is checked for an
  // unknown path, but can never satisfy a consumer operation: only evidence
  // with an observed HTTP method proves the transport identity.
  const staticPathPattern = /([`'”"])(\/(?:v[0-9]+|health|ready|openapi\.json)(?:[^`'”"]*))\1/gu;
  for (const match of source.matchAll(staticPathPattern)) addOperation(operations, scope, file, null, match[2], source, match.index ?? 0, "static-path");

  return operations;
}

const [mobileFiles, webFiles] = await Promise.all([sourceFiles(mobileRoot), sourceFiles(webRoot)]);
const extracted = [];
const mobileAdapterPath = join(mobileRoot, "src/infrastructure/clients/PatternlyApiClientAdapter.ts");
if (await pathExists(mobileAdapterPath)) {
  const mobileAdapter = await readFile(mobileAdapterPath, "utf8");
  if (!mobileAdapter.includes("Synchronized with patternly-backend/openapi/patternly-v1.json")) throw new Error("frontend_api_client_header_missing");
}
for (const file of mobileFiles) extracted.push(...extractOperations(await readFile(file, "utf8"), file, "mobile"));
for (const file of webFiles) extracted.push(...extractOperations(await readFile(file, "utf8"), file, "web"));

const documented = endpointOperations(spec);
const failures = [];
const used = new Map();
const seenEvidence = new Set();
for (const candidate of extracted) {
  const evidenceKey = `${candidate.scope}|${candidate.file}|${candidate.line}|${candidate.method ?? "?"}|${candidate.path}`;
  if (seenEvidence.has(evidenceKey)) continue;
  seenEvidence.add(evidenceKey);
  const exact = candidate.method === null ? undefined : documented.get(operationKey(candidate.method, candidate.path));
  if (candidate.method === null) {
    const pathMatches = [...documented.values()].filter((entry) => entry.path === candidate.path);
    if (pathMatches.length === 0) failures.push(`frontend_unknown_path:${candidate.scope}:${candidate.path}:${relative(backendRoot, candidate.file)}:${candidate.line}`);
    continue;
  }
  if (exact === undefined) {
    const pathMatches = [...documented.values()].filter((entry) => entry.path === candidate.path);
    if (pathMatches.length > 0) {
      failures.push(`frontend_method_mismatch:${candidate.scope}:${candidate.method} ${candidate.path}:${relative(backendRoot, candidate.file)}:${candidate.line}`);
    } else {
      failures.push(`frontend_unknown_operation:${candidate.scope}:${candidate.method} ${candidate.path}:${relative(backendRoot, candidate.file)}:${candidate.line}`);
    }
    continue;
  }
  const key = operationKey(candidate.method, candidate.path);
  const entry = used.get(key) ?? { scopes: new Set(), evidence: [] };
  entry.scopes.add(candidate.scope);
  entry.evidence.push(candidate);
  used.set(key, entry);
}

const expectedScopes = new Map();
for (const [key, entry] of documented) {
  const scope = entry.operation["x-patternly-consumer-scope"];
  if (typeof scope === "string") expectedScopes.set(key, scope);
}

for (const [key, scope] of expectedScopes) {
  if (scope === "backend-only") continue;
  const usage = used.get(key);
  if (usage === undefined) {
    failures.push(`frontend_missing_consumer_operation:${key}:${scope}`);
    continue;
  }
  const requiredScopes = scope === "mobile+web" ? ["mobile", "web"] : scope === "diagnostic" ? ["mobile"] : [scope];
  for (const required of requiredScopes) if (!usage.scopes.has(required)) failures.push(`frontend_consumer_scope_missing:${key}:${required}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  const usedKeys = [...used.keys()].sort();
  const backendOnly = [...expectedScopes].filter(([, scope]) => scope === "backend-only").map(([key]) => key).sort();
  const diagnostics = [...expectedScopes].filter(([, scope]) => scope === "diagnostic").map(([key]) => key).sort();
  console.log(`frontend transport inventory matches ${usedKeys.length} used operations`);
  console.log(`used: ${usedKeys.join(", ")}`);
  console.log(`backend-only: ${backendOnly.join(", ") || "none"}`);
  console.log(`diagnostic: ${diagnostics.join(", ") || "none"}`);
}
