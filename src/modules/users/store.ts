import { and, eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { identities, users } from "../../infrastructure/database/schema.js";
import type { AuthenticatedIdentity } from "../auth/contracts.js";

export type UserProfile = Readonly<{
  id: string;
  createdAt: string;
  identity: Readonly<{ provider: string; subject: string; email: string | null; emailVerified: boolean }>;
}>;

export interface UserStore {
  ensureUser(identity: AuthenticatedIdentity): Promise<Readonly<{ userId: string }>>;
  readProfile(userId: string): Promise<UserProfile | null>;
}

export class DrizzleUserStore implements UserStore {
  public constructor(private readonly db: Database) {}

  public async ensureUser(identity: AuthenticatedIdentity): Promise<Readonly<{ userId: string }>> {
    const existing = await this.db.select({ userId: identities.userId })
      .from(identities)
      .where(and(eq(identities.provider, identity.provider), eq(identities.subject, identity.subject)))
      .limit(1);
    const found = existing[0];
    if (found) return Object.freeze({ userId: found.userId });
    const created = await this.db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({}).returning({ id: users.id });
      if (!user) throw new Error("user_insert_failed");
      const [linked] = await tx.insert(identities).values({
        userId: user.id,
        provider: identity.provider,
        subject: identity.subject,
        ...(identity.email === undefined ? {} : { email: identity.email }),
        emailVerified: identity.emailVerified,
      }).returning({ userId: identities.userId });
      if (!linked) throw new Error("identity_insert_failed");
      return linked;
    });
    return Object.freeze({ userId: created.userId });
  }

  public async readProfile(userId: string): Promise<UserProfile | null> {
    const rows = await this.db.select({ user: users, identity: identities })
      .from(users)
      .innerJoin(identities, eq(identities.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row || row.user.deletedAt) return null;
    return Object.freeze({
      id: row.user.id,
      createdAt: row.user.createdAt.toISOString(),
      identity: Object.freeze({
        provider: row.identity.provider,
        subject: row.identity.subject,
        email: row.identity.email,
        emailVerified: row.identity.emailVerified,
      }),
    });
  }
}
