import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord } from "../../infrastructure/firestore/values.js";

export type TrackAccessView = Readonly<{ trackId: string; source: string; status: string; updatedAt: string }>;

export interface TrackStore {
  readAccess(userId: string): Promise<readonly TrackAccessView[]>;
}

export class FirestoreTrackStore implements TrackStore {
  public constructor(private readonly db: Firestore) {}

  public async readAccess(userId: string): Promise<readonly TrackAccessView[]> {
    const snapshot = await this.db.collection(COLLECTIONS.users).doc(userId).collection("trackAccess").get();
    return Object.freeze(snapshot.docs.map((document) => {
      const row = asRecord(document.data(), "track_access");
      if (typeof row.trackId !== "string" || typeof row.source !== "string" || typeof row.status !== "string") throw new Error("track_access_record_invalid");
      return Object.freeze({ trackId: row.trackId, source: row.source, status: row.status, updatedAt: asIsoString(row.updatedAt, "track_access_updated_at") });
    }));
  }
}
