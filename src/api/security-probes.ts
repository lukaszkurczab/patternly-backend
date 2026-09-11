/**
 * Behavioral checks for the protection profiles declared by OpenAPI.
 *
 * Route labels are useful for inventory diagnostics, but they are not proof
 * that a registered handler actually rejects an unauthenticated request.
 * These probes exercise the real Fastify app and therefore make a missing or
 * no-op guard observable without Firestore or an emulator.
 */

import type { InjectOptions, Response as InjectResponse } from "light-my-request";
import { buildApplication, type ApplicationDependencies } from "./app.js";
import type { Environment } from "../config/environment.js";
import type { BackendStores } from "../infrastructure/firestore/stores.js";
import type { IdentityTokenVerifier } from "../infrastructure/firebase/verifier.js";
import type { AppCheckTokenVerifier } from "../infrastructure/firebase/appCheckVerifier.js";

const SECURITY_PROBE_TOKEN = "patternly-security-probe-valid-token";
const SECURITY_PROBE_USER_ID = "00000000-0000-4000-8000-000000000001";
const SECURITY_PROBE_NON_ADMIN_EMAIL = "security-probe-user@example.com";

type UnknownRecord = Record<string, unknown>;
type ProbeOperation = Readonly<{ method: string; path: string; profile: string }>;
type ProbeApp = Readonly<{ inject(options: InjectOptions): Promise<InjectResponse> }>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probeOperations(document: unknown): readonly ProbeOperation[] {
  if (!isRecord(document) || !isRecord(document.paths)) return [];
  const operations: ProbeOperation[] = [];
  for (const [path, pathItemValue] of Object.entries(document.paths)) {
    if (!isRecord(pathItemValue)) continue;
    for (const [method, operationValue] of Object.entries(pathItemValue)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      if (!isRecord(operationValue) || typeof operationValue["x-patternly-security-profile"] !== "string") continue;
      operations.push({ method: method.toUpperCase(), path, profile: operationValue["x-patternly-security-profile"] });
    }
  }
  return operations;
}

function probePath(path: string): string {
  return path.replace(/\{[^}]+\}/gu, "security-probe");
}

function responseErrorCode(response: Readonly<{ body: string }>): string | null {
  try {
    const payload: unknown = JSON.parse(response.body);
    if (!isRecord(payload) || !isRecord(payload.error) || typeof payload.error.code !== "string") return null;
    return payload.error.code;
  } catch {
    return null;
  }
}

async function probe(
  app: ProbeApp,
  operation: ProbeOperation,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ statusCode: number; body: string; errorCode: string | null }> {
  const response = await app.inject({ method: operation.method as NonNullable<InjectOptions["method"]>, url: probePath(operation.path), headers: { ...headers } });
  return { statusCode: response.statusCode, body: response.body, errorCode: responseErrorCode(response) };
}

function describe(operation: ProbeOperation): string {
  return `${operation.method} ${operation.path}:${operation.profile}`;
}

function expectAuthenticationRejection(operation: ProbeOperation, response: Readonly<{ statusCode: number; errorCode: string | null }>, failures: string[]): void {
  if (response.statusCode !== 401 || response.errorCode !== "authentication_required") {
    failures.push(`${describe(operation)}:authentication_rejection_expected:401:authentication_required:got:${response.statusCode}:${response.errorCode ?? "no_code"}`);
  }
}

function isAuthenticationRejection(response: Readonly<{ statusCode: number; errorCode: string | null }>): boolean {
  return response.statusCode === 401 && ["authentication_required", "app_check_required", "administrator_required"].includes(response.errorCode ?? "");
}

/**
 * Exercise every documented operation whose profile requires protection.
 * The valid bearer probe intentionally uses a non-admin identity: this
 * distinguishes bearer/app-check routes from an accidentally attached admin
 * guard while the missing-header probes distinguish a no-op handler.
 */
export async function assertSecurityProbes(app: ProbeApp, document: unknown): Promise<void> {
  const failures: string[] = [];
  for (const operation of probeOperations(document)) {
    if (operation.profile === "public") {
      const publicResponse = await probe(app, operation);
      if (isAuthenticationRejection(publicResponse)) {
        failures.push(`${describe(operation)}:public_route_rejected_without_credentials:${publicResponse.statusCode}:${publicResponse.errorCode ?? "no_code"}`);
      }
    } else if (operation.profile === "bearer") {
      expectAuthenticationRejection(operation, await probe(app, operation), failures);
      const authenticated = await probe(app, operation, { authorization: `Bearer ${SECURITY_PROBE_TOKEN}` });
      if (authenticated.statusCode === 401 || authenticated.errorCode === "authentication_required" || authenticated.errorCode === "administrator_required") {
        failures.push(`${describe(operation)}:valid_bearer_rejected:${authenticated.statusCode}:${authenticated.errorCode ?? "no_code"}`);
      }
    } else if (operation.profile === "app_check_optional_bearer") {
      const missingAppCheck = await probe(app, operation, { authorization: `Bearer ${SECURITY_PROBE_TOKEN}` });
      if (missingAppCheck.statusCode !== 401 || missingAppCheck.errorCode !== "app_check_required") {
        failures.push(`${describe(operation)}:app_check_rejection_expected:401:app_check_required:got:${missingAppCheck.statusCode}:${missingAppCheck.errorCode ?? "no_code"}`);
      }
    } else if (operation.profile === "admin") {
      expectAuthenticationRejection(operation, await probe(app, operation), failures);
      const nonAdmin = await probe(app, operation, { authorization: `Bearer ${SECURITY_PROBE_TOKEN}` });
      if (nonAdmin.statusCode !== 403 || nonAdmin.errorCode !== "administrator_required") {
        failures.push(`${describe(operation)}:admin_rejection_expected:403:administrator_required:got:${nonAdmin.statusCode}:${nonAdmin.errorCode ?? "no_code"}`);
      }
    } else if (operation.profile === "webhook") {
      const missingAuthorization = await probe(app, operation);
      if (missingAuthorization.statusCode !== 401 || missingAuthorization.errorCode !== "revenuecat_webhook_unauthorized") {
        failures.push(`${describe(operation)}:webhook_rejection_expected:401:revenuecat_webhook_unauthorized:got:${missingAuthorization.statusCode}:${missingAuthorization.errorCode ?? "no_code"}`);
      }
      const wrongAuthorization = await probe(app, operation, { authorization: "security-probe-wrong-webhook-secret" });
      if (wrongAuthorization.statusCode !== 401 || wrongAuthorization.errorCode !== "revenuecat_webhook_unauthorized") {
        failures.push(`${describe(operation)}:wrong_webhook_rejection_expected:401:revenuecat_webhook_unauthorized:got:${wrongAuthorization.statusCode}:${wrongAuthorization.errorCode ?? "no_code"}`);
      }
    }
  }
  if (failures.length > 0) throw new Error(`security_probe_failed:${failures.join(";")}`);
}

function securityProbeVerifier(): IdentityTokenVerifier {
  return {
    async verify(token: string) {
      if (token !== SECURITY_PROBE_TOKEN) throw new Error("firebase_token_invalid");
      return Object.freeze({
        provider: "firebase" as const,
        subject: "security-probe-subject",
        email: SECURITY_PROBE_NON_ADMIN_EMAIL,
        emailVerified: true,
        authTime: Math.floor(Date.now() / 1000),
      });
    },
  };
}

function securityProbeAppCheckVerifier(): AppCheckTokenVerifier {
  return { async verify() {} };
}

function securityProbeStores(): BackendStores {
  const users = {
    async ensureUser() {
      return { userId: SECURITY_PROBE_USER_ID };
    },
  };
  return { users } as unknown as BackendStores;
}

/** Build the real app with in-memory auth seams; no Firestore or emulator is used. */
export function buildSecurityProbeApplication(environment: Environment) {
  const dependencies: ApplicationDependencies = {
    environment,
    firestore: null,
    verifier: securityProbeVerifier(),
    appCheckVerifier: securityProbeAppCheckVerifier(),
    stores: securityProbeStores(),
  };
  return buildApplication(dependencies);
}
