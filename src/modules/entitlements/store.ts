import { eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { entitlements } from "../../infrastructure/database/schema.js";

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

export class DrizzleEntitlementStore implements EntitlementStore {
  public constructor(private readonly db: Database) {}

  public async read(userId: string): Promise<readonly EntitlementView[]> {
    const rows = await this.db.select().from(entitlements).where(eq(entitlements.userId, userId));
    return Object.freeze(rows.map((row) => Object.freeze({
      entitlement: row.entitlement,
      status: row.status,
      source: row.source,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    })));
  }
}
