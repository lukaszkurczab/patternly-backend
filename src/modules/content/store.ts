import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord } from "../../infrastructure/firestore/values.js";

export type ContentVersionView = Readonly<{
  trackId: string;
  version: string;
  checksumSha256: string;
  packageUri: string;
  publishedAt: string;
}>;

export interface ContentVersionStore {
  readCurrent(): Promise<readonly ContentVersionView[]>;
}

export class FirestoreContentVersionStore implements ContentVersionStore {
  public constructor(private readonly db: Firestore) {}

  public async readCurrent(): Promise<readonly ContentVersionView[]> {
    const snapshot = await this.db.collection(COLLECTIONS.contentVersions).where("isCurrent", "==", true).get();
    return Object.freeze(snapshot.docs.map((document) => {
      const row = asRecord(document.data(), "content_version");
      if (typeof row.trackId !== "string" || typeof row.version !== "string" || typeof row.checksumSha256 !== "string" || typeof row.packageUri !== "string") throw new Error("content_version_record_invalid");
      return Object.freeze({ trackId: row.trackId, version: row.version, checksumSha256: row.checksumSha256, packageUri: row.packageUri, publishedAt: asIsoString(row.publishedAt, "content_version_published_at") });
    }));
  }
}
