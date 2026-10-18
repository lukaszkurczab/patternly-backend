import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, identityDocumentId } from "../src/infrastructure/firestore/paths.js";
import { PseudonymKeyRing } from "../src/infrastructure/security/pseudonymKeyRing.js";
import type { AuthenticatedIdentity } from "../src/modules/auth/contracts.js";
import { FirestoreUserStore, type AccountRegistrationInput } from "../src/modules/users/store.js";

type MemoryReference = Readonly<{
  id: string;
  path: string;
  collection: (name: string) => MemoryCollection;
}>;
type MemoryCollection = Readonly<{ doc: (id: string) => MemoryReference }>;

function createMemoryFirestore(initial: Readonly<Record<string, unknown>> = {}) {
  const documents = new Map(Object.entries(initial));
  const writes: string[] = [];
  const reference = (path: string, id: string): MemoryReference => Object.freeze({
    id,
    path,
    collection: (name) => ({ doc: (childId) => reference(`${path}/${name}/${childId}`, childId) }),
  });
  const collection = (name: string): MemoryCollection => ({ doc: (id) => reference(`${name}/${id}`, id) });
  const snapshot = (ref: MemoryReference) => ({
    id: ref.id,
    ref,
    exists: documents.has(ref.path),
    data: () => documents.get(ref.path),
  });
  const transaction = {
    getAll: async (...references: MemoryReference[]) => references.map(snapshot),
    get: async (ref: MemoryReference) => snapshot(ref),
    create: async (ref: MemoryReference, value: unknown) => {
      if (documents.has(ref.path)) throw new Error("already_exists");
      documents.set(ref.path, value);
      writes.push(`create:${ref.path}`);
    },
    set: async (ref: MemoryReference, value: unknown) => {
      documents.set(ref.path, value);
      writes.push(`set:${ref.path}`);
    },
    update: async (ref: MemoryReference, value: unknown) => {
      documents.set(ref.path, { ...documents.get(ref.path) as Record<string, unknown>, ...value as Record<string, unknown> });
      writes.push(`update:${ref.path}`);
    },
    delete: async (ref: MemoryReference) => {
      documents.delete(ref.path);
      writes.push(`delete:${ref.path}`);
    },
  };
  const db = {
    collection,
    runTransaction: async <T>(callback: (tx: typeof transaction) => Promise<T>) => callback(transaction),
  } as unknown as Firestore;
  return { db, documents, writes };
}

const identity: AuthenticatedIdentity = Object.freeze({
  provider: "firebase",
  subject: "legacy-deleted-firebase-subject",
  email: "legacy@example.test",
  emailVerified: true,
  authTime: Math.floor(Date.now() / 1000),
});

const registration: AccountRegistrationInput = Object.freeze({
  termsVersion: "2026-09-30",
  termsLocale: "en",
  privacyPolicyVersion: "2026-09-30",
  privacyPolicyLocale: "en",
  privacyPolicyAcknowledged: true,
});

function storeFor(initial: Readonly<Record<string, unknown>>) {
  const memory = createMemoryFirestore(initial);
  const keyRing = new PseudonymKeyRing([{ version: "test-v1", status: "active", keyBase64: Buffer.alloc(32, 7).toString("base64") }]);
  return { ...memory, keyRing, store: new FirestoreUserStore(memory.db, keyRing) };
}

test("user lookups and registration continue to honor legacy SHA-256 deletion tombstones", async () => {
  const legacyPath = `${COLLECTIONS.deletedIdentities}/${identityDocumentId(identity.provider, identity.subject)}`;
  const { store, writes } = storeFor({ [legacyPath]: { provider: identity.provider, deletedAt: Timestamp.now(), operationId: "legacy-operation", proofId: "legacy-proof" } });

  await assert.rejects(store.resolveExistingUser(identity), { message: "account_deleted" });
  await assert.rejects(store.pinSessionAuthorization(identity), { message: "account_deleted" });
  await assert.rejects(store.registerUser(identity, registration), { message: "account_deleted" });
  assert.deepEqual(writes, []);
});

test("legacy SHA-256 tombstones without key metadata remain fail-closed despite a stale expiry", async () => {
  const legacyPath = `${COLLECTIONS.deletedIdentities}/${identityDocumentId(identity.provider, identity.subject)}`;
  const { store, documents, writes } = storeFor({
    [legacyPath]: { provider: identity.provider, deletedAt: Timestamp.fromMillis(Date.now() - 60_000), expiresAt: Timestamp.fromMillis(Date.now() - 1) },
  });

  await assert.rejects(store.registerUser(identity, registration), { message: "account_deleted" });
  assert.equal(documents.has(legacyPath), true);
  assert.deepEqual(writes, []);
});

test("known 45-day HMAC tombstones block only through seven days from their original deletion time", async () => {
  const deletedAtMs = Date.UTC(2026, 0, 1);
  const keyRing = new PseudonymKeyRing([{ version: "test-v1", status: "active", keyBase64: Buffer.alloc(32, 7).toString("base64") }]);
  const candidate = keyRing.active(identity.provider, identity.subject);
  const markerPath = `${COLLECTIONS.deletedIdentities}/${candidate.documentId}`;
  const { store, documents } = storeFor({
    [markerPath]: {
      provider: identity.provider,
      keyVersion: candidate.keyVersion,
      subjectHmac: candidate.subjectHmac,
      deletedAt: Timestamp.fromMillis(deletedAtMs),
      expiresAt: Timestamp.fromMillis(deletedAtMs + 45 * 24 * 60 * 60 * 1000),
    },
  });
  const originalDateNow = Date.now;
  try {
    Date.now = () => deletedAtMs + 6 * 24 * 60 * 60 * 1000;
    await assert.rejects(store.registerUser(identity, registration), { message: "account_deleted" });
    Date.now = () => deletedAtMs + 7 * 24 * 60 * 60 * 1000;
    const result = await store.registerUser(identity, registration);
    assert.equal(result.created, true);
    assert.equal(documents.has(markerPath), false);
  } finally {
    Date.now = originalDateNow;
  }
});

test("a stale tombstone whose payload does not match its candidate document ID fails closed without replacement", async () => {
  const deletedAtMs = Date.UTC(2026, 0, 1);
  const keyRing = new PseudonymKeyRing([{ version: "test-v1", status: "active", keyBase64: Buffer.alloc(32, 7).toString("base64") }]);
  const candidate = keyRing.active(identity.provider, identity.subject);
  const markerPath = `${COLLECTIONS.deletedIdentities}/${candidate.documentId}`;
  const { store, documents, writes } = storeFor({
    [markerPath]: {
      provider: identity.provider,
      keyVersion: candidate.keyVersion,
      subjectHmac: "0".repeat(64),
      deletedAt: Timestamp.fromMillis(deletedAtMs),
      expiresAt: Timestamp.fromMillis(deletedAtMs + 45 * 24 * 60 * 60 * 1000),
    },
  });
  const originalDateNow = Date.now;
  try {
    Date.now = () => deletedAtMs + 8 * 24 * 60 * 60 * 1000;
    await assert.rejects(store.registerUser(identity, registration), { message: "account_deleted" });
    assert.equal(documents.has(markerPath), true);
    assert.deepEqual(writes, []);
  } finally {
    Date.now = originalDateNow;
  }
});
