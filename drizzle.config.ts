import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infrastructure/database/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://patternly:patternly@127.0.0.1:5432/patternly",
  },
});
