import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord } from "../../infrastructure/firestore/values.js";

export type EntitlementView = Readonly<{
  entitlement: string;
  status: string;
  source: string;
  expiresAt: string | null;
  updatedAt: string;
}>;

export interface EntitlementStore {
  read(userId: string): Promise<readonly EntitlementView[]>;
}

export class FirestoreEntitlementStore implements EntitlementStore {
  public constructor(private readonly db: Firestore) {}

  public async read(userId: string): Promise<readonly EntitlementView[]> {
    const snapshot = await this.db.collection(COLLECTIONS.users).doc(userId).collection("entitlements").get();
    return Object.freeze(snapshot.docs.map((document) => {
      const row = asRecord(document.data(), "entitlement");
      if (typeof row.entitlement !== "string" || typeof row.status !== "string" || typeof row.source !== "string") throw new Error("entitlement_record_invalid");
      return Object.freeze({
        entitlement: row.entitlement,
        status: row.status,
        source: row.source,
        expiresAt: row.expiresAt === null || row.expiresAt === undefined ? null : asIsoString(row.expiresAt, "entitlement_expires_at"),
        updatedAt: asIsoString(row.updatedAt, "entitlement_updated_at"),
      });
    }));
  }
}
