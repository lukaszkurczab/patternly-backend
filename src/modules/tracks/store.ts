import { eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { trackAccess } from "../../infrastructure/database/schema.js";

export type TrackAccessView = Readonly<{ trackId: string; source: string; status: string; updatedAt: string }>;

export interface TrackStore {
  readAccess(userId: string): Promise<readonly TrackAccessView[]>;
}

export class DrizzleTrackStore implements TrackStore {
  public constructor(private readonly db: Database) {}

  public async readAccess(userId: string): Promise<readonly TrackAccessView[]> {
    const rows = await this.db.select().from(trackAccess).where(eq(trackAccess.userId, userId));
    return Object.freeze(rows.map((row) => Object.freeze({ trackId: row.trackId, source: row.source, status: row.status, updatedAt: row.updatedAt.toISOString() })));
  }
}
