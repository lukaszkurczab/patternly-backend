import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const identityProvider = pgEnum("identity_provider", ["firebase", "apple", "google"]);
export const subscriptionProvider = pgEnum("subscription_provider", ["revenuecat", "app_store", "play_store"]);
export const subscriptionStatus = pgEnum("subscription_status", ["active", "grace_period", "paused", "expired", "revoked"]);
export const progressKind = pgEnum("progress_kind", ["node", "item"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
});

export const identities = pgTable("identities", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: identityProvider("provider").notNull(),
  subject: text("subject").notNull(),
  email: text("email"),
  emailVerified: boolean("email_verified").default(false).notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("identities_provider_subject_unique").on(table.provider, table.subject)]);

export const devices = pgTable("devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceKey: text("device_key").notNull(),
  platform: text("platform").notNull(),
  appVersion: text("app_version").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("devices_user_device_key_unique").on(table.userId, table.deviceKey)]);

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: subscriptionProvider("provider").notNull(),
  providerSubscriptionId: text("provider_subscription_id").notNull(),
  status: subscriptionStatus("status").notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("subscriptions_provider_id_unique").on(table.provider, table.providerSubscriptionId)]);

export const entitlements = pgTable("entitlements", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  entitlement: text("entitlement").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("entitlements_user_name_unique").on(table.userId, table.entitlement)]);

export const trackAccess = pgTable("track_access", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  trackId: text("track_id").notNull(),
  source: text("source").notNull(),
  status: text("status").notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("track_access_user_track_unique").on(table.userId, table.trackId)]);

export const nodeProgress = pgTable("node_progress", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  trackId: text("track_id").notNull(),
  nodeId: text("node_id").notNull(),
  version: integer("version").default(1).notNull(),
  state: jsonb("state").$type<Record<string, unknown>>().notNull(),
  lastMutationId: text("last_mutation_id").notNull(),
  ...timestamps,
}, (table) => [primaryKey({ columns: [table.userId, table.trackId, table.nodeId] })]);

export const itemProgress = pgTable("item_progress", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  trackId: text("track_id").notNull(),
  itemId: text("item_id").notNull(),
  version: integer("version").default(1).notNull(),
  state: jsonb("state").$type<Record<string, unknown>>().notNull(),
  lastMutationId: text("last_mutation_id").notNull(),
  ...timestamps,
}, (table) => [primaryKey({ columns: [table.userId, table.trackId, table.itemId] })]);

export const syncMutations = pgTable("sync_mutations", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
  mutationId: text("mutation_id").notNull(),
  kind: progressKind("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  appliedVersion: integer("applied_version").notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("sync_mutations_user_mutation_unique").on(table.userId, table.mutationId)]);

export const contentVersions = pgTable("content_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  trackId: text("track_id").notNull(),
  version: text("version").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  packageUri: text("package_uri").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  isCurrent: boolean("is_current").default(false).notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("content_versions_track_version_unique").on(table.trackId, table.version)]);

export const usersRelations = relations(users, ({ many }) => ({
  identities: many(identities),
  devices: many(devices),
  entitlements: many(entitlements),
  subscriptions: many(subscriptions),
}));

export const databaseSchema = {
  users,
  identities,
  devices,
  subscriptions,
  entitlements,
  trackAccess,
  nodeProgress,
  itemProgress,
  syncMutations,
  contentVersions,
};

export const utcNow = () => sql`now()`;

export type UserRow = typeof users.$inferSelect;
export type IdentityRow = typeof identities.$inferSelect;
export type EntitlementRow = typeof entitlements.$inferSelect;
export type NodeProgressRow = typeof nodeProgress.$inferSelect;
export type ItemProgressRow = typeof itemProgress.$inferSelect;
