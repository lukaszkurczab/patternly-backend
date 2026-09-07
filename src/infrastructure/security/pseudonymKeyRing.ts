import { createHmac, timingSafeEqual } from "node:crypto";

export type PseudonymKeyStatus = "active" | "verify_only";
export type PseudonymKeyConfig = Readonly<{ version: string; status: PseudonymKeyStatus; keyBase64: string }>;
export type IdentityPseudonym = Readonly<{ keyVersion: string; subjectHmac: string; documentId: string }>;

const VERSION = /^[a-z][a-z0-9_-]{0,31}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length < 32 || key.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) throw new Error("invalid_deletion_pseudonym_keyring");
  return key;
}
function digest(key: Buffer, provider: string, subject: string): string {
  return createHmac("sha256", key).update(`patternly:deleted-identity:v1\0${provider}\0${subject}`, "utf8").digest("hex");
}

export class PseudonymKeyRing {
  private readonly keys: ReadonlyMap<string, Readonly<{ status: PseudonymKeyStatus; key: Buffer }>>;
  private readonly activeVersion: string;

  public constructor(configuration: readonly PseudonymKeyConfig[]) {
    if (configuration.length === 0 || new Set(configuration.map(({ version }) => version)).size !== configuration.length) throw new Error("invalid_deletion_pseudonym_keyring");
    const active = configuration.filter(({ status }) => status === "active");
    if (active.length !== 1) throw new Error("invalid_deletion_pseudonym_keyring");
    const entries = configuration.map(({ version, status, keyBase64 }) => {
      if (!VERSION.test(version) || !["active", "verify_only"].includes(status)) throw new Error("invalid_deletion_pseudonym_keyring");
      return [version, Object.freeze({ status, key: decodeKey(keyBase64) })] as const;
    });
    this.keys = new Map(entries);
    this.activeVersion = active[0]!.version;
  }

  public active(provider: string, subject: string): IdentityPseudonym {
    const entry = this.keys.get(this.activeVersion);
    if (!entry) throw new Error("deletion_pseudonym_key_unavailable");
    return this.create(this.activeVersion, entry.key, provider, subject);
  }

  public candidates(provider: string, subject: string): readonly IdentityPseudonym[] {
    return Object.freeze([...this.keys.entries()].map(([version, { key }]) => this.create(version, key, provider, subject)));
  }

  public verify(provider: string, subject: string, value: Pick<IdentityPseudonym, "keyVersion" | "subjectHmac">): boolean {
    const entry = this.keys.get(value.keyVersion);
    if (!entry || !DIGEST.test(value.subjectHmac)) return false;
    const expected = digest(entry.key, provider, subject);
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(value.subjectHmac, "hex"));
  }

  private create(keyVersion: string, key: Buffer, provider: string, subject: string): IdentityPseudonym {
    if (!provider || !subject) throw new Error("identity_pseudonym_input_required");
    const subjectHmac = digest(key, provider, subject);
    return Object.freeze({ keyVersion, subjectHmac, documentId: `${keyVersion}_${subjectHmac}` });
  }
}

export function parsePseudonymKeyRing(value: string): PseudonymKeyRing {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("invalid_deletion_pseudonym_keyring"); }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry))) throw new Error("invalid_deletion_pseudonym_keyring");
  return new PseudonymKeyRing(parsed as PseudonymKeyConfig[]);
}
