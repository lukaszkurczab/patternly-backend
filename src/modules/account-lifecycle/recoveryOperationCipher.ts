import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type RecoveryOperationKeyStatus = "active" | "decrypt_only";
export type RecoveryOperationKeyConfig = Readonly<{
  keyBase64: string;
  status: RecoveryOperationKeyStatus;
  version: string;
}>;
export type RecoveryOperationCipherContext = Readonly<{
  generation: number;
  kind: "recovery" | "reissue";
  operationId: string;
  userId: string;
}>;
export type RecoveryOperationCipherEnvelope = Readonly<{
  ciphertext: string;
  keyVersion: string;
  tag: string;
  version: 1;
  iv: string;
}>;

const KEYRING_VERSION = 1;
const KEY_VERSION_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ENVELOPE_KEYS = ["ciphertext", "iv", "keyVersion", "tag", "version"] as const;

type KeyEntry = Readonly<{ key: Buffer; status: RecoveryOperationKeyStatus }>;

function decodeKey(value: unknown): Buffer {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/u.test(value)) {
    throw new Error("invalid_recovery_operation_keyring");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) throw new Error("invalid_recovery_operation_keyring");
  return decoded;
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function assertContext(context: RecoveryOperationCipherContext): void {
  if (typeof context.userId !== "string" || context.userId.length === 0
    || typeof context.operationId !== "string" || !UUID_PATTERN.test(context.operationId)
    || (context.kind !== "recovery" && context.kind !== "reissue")
    || !Number.isSafeInteger(context.generation) || context.generation <= 0) {
    throw new Error("invalid_recovery_operation_context");
  }
}

function aad(context: RecoveryOperationCipherContext, keyVersion: string): Buffer {
  return Buffer.from(JSON.stringify([
    "patternly:recovery-operation:v1",
    context.userId,
    context.operationId.toLowerCase(),
    context.kind,
    context.generation,
    keyVersion,
  ]), "utf8");
}

function parseEnvelope(value: unknown): RecoveryOperationCipherEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_recovery_operation_envelope");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((key, index) => key !== [...ENVELOPE_KEYS].sort()[index])
    || record.version !== 1 || typeof record.keyVersion !== "string" || !KEY_VERSION_PATTERN.test(record.keyVersion)
    || !isCanonicalBase64(record.iv) || Buffer.from(record.iv, "base64").length !== 12
    || !isCanonicalBase64(record.tag) || Buffer.from(record.tag, "base64").length !== 16
    || !isCanonicalBase64(record.ciphertext)) {
    throw new Error("invalid_recovery_operation_envelope");
  }
  return Object.freeze({
    ciphertext: record.ciphertext,
    iv: record.iv,
    keyVersion: record.keyVersion,
    tag: record.tag,
    version: 1,
  });
}

export class RecoveryOperationCipher {
  private readonly keys: ReadonlyMap<string, KeyEntry>;
  private readonly activeVersion: string;

  public constructor(keyring: readonly RecoveryOperationKeyConfig[]) {
    if (!Array.isArray(keyring) || keyring.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "keyBase64,status,version")) {
      throw new Error("invalid_recovery_operation_keyring");
    }
    const active = keyring.filter(({ status }) => status === "active");
    if (keyring.length === 0 || active.length !== 1 || new Set(keyring.map(({ version }) => version)).size !== keyring.length) {
      throw new Error("invalid_recovery_operation_keyring");
    }
    const decoded = keyring.map(({ version, status, keyBase64 }) => {
      if (!KEY_VERSION_PATTERN.test(version) || (status !== "active" && status !== "decrypt_only")) throw new Error("invalid_recovery_operation_keyring");
      return [version, Object.freeze({ key: decodeKey(keyBase64), status })] as const;
    });
    if (new Set(decoded.map(([, entry]) => entry.key.toString("hex"))).size !== decoded.length) throw new Error("invalid_recovery_operation_keyring");
    this.keys = new Map(decoded);
    this.activeVersion = active[0]!.version;
  }

  public encrypt(plaintext: string, context: RecoveryOperationCipherContext): RecoveryOperationCipherEnvelope {
    assertContext(context);
    if (typeof plaintext !== "string") throw new Error("invalid_recovery_operation_plaintext");
    const entry = this.keys.get(this.activeVersion);
    if (!entry || entry.status !== "active") throw new Error("recovery_operation_key_unavailable");
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", entry.key, iv, { authTagLength: 16 });
      cipher.setAAD(aad(context, this.activeVersion));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Object.freeze({
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        keyVersion: this.activeVersion,
        tag: cipher.getAuthTag().toString("base64"),
        version: 1,
      });
    } catch {
      throw new Error("recovery_operation_encryption_failed");
    }
  }

  public decrypt(value: unknown, context: RecoveryOperationCipherContext): string {
    assertContext(context);
    const envelope = parseEnvelope(value);
    const entry = this.keys.get(envelope.keyVersion);
    if (!entry) throw new Error("recovery_operation_key_unavailable");
    try {
      const decipher = createDecipheriv("aes-256-gcm", entry.key, Buffer.from(envelope.iv, "base64"), { authTagLength: 16 });
      decipher.setAAD(aad(context, envelope.keyVersion));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("recovery_operation_decryption_failed");
    }
  }
}

export function parseRecoveryOperationCipherKeyRing(value: string): RecoveryOperationCipher {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("invalid_recovery_operation_keyring"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid_recovery_operation_keyring");
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "keys,version" || record.version !== KEYRING_VERSION || !Array.isArray(record.keys)) {
    throw new Error("invalid_recovery_operation_keyring");
  }
  if (record.keys.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry)
    || Object.keys(entry).sort().join(",") !== "keyBase64,status,version")) {
    throw new Error("invalid_recovery_operation_keyring");
  }
  return new RecoveryOperationCipher(record.keys as RecoveryOperationKeyConfig[]);
}
