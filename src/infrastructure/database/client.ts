import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Environment } from "../../config/environment.js";
import { databaseSchema } from "./schema.js";

export type Database = ReturnType<typeof drizzle<typeof databaseSchema>>;

export type DatabaseRuntime = Readonly<{
  db: Database;
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
}>;

export function createDatabase(environment: Environment): DatabaseRuntime | null {
  if (!environment.databaseUrl) return null;
  const pool = new Pool({ connectionString: environment.databaseUrl, max: 10 });
  const db = drizzle(pool, { schema: databaseSchema });
  return Object.freeze({
    db,
    async ping() {
      const client = await pool.connect();
      try {
        await client.query("select 1");
        return true;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  });
}
