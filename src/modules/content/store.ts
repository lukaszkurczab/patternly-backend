import { and, eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { contentVersions } from "../../infrastructure/database/schema.js";

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

export class DrizzleContentVersionStore implements ContentVersionStore {
  public constructor(private readonly db: Database) {}

  public async readCurrent(): Promise<readonly ContentVersionView[]> {
    const rows = await this.db.select().from(contentVersions).where(eq(contentVersions.isCurrent, true));
    return Object.freeze(rows.map((row) => Object.freeze({ trackId: row.trackId, version: row.version, checksumSha256: row.checksumSha256, packageUri: row.packageUri, publishedAt: row.publishedAt.toISOString() })));
  }
}
