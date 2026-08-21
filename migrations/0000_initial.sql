CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE identity_provider AS ENUM ('firebase', 'apple', 'google');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE subscription_provider AS ENUM ('revenuecat', 'app_store', 'play_store');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM ('active', 'grace_period', 'paused', 'expired', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE progress_kind AS ENUM ('node', 'item');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider identity_provider NOT NULL,
  subject text NOT NULL,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identities_provider_subject_unique UNIQUE (provider, subject)
);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_key text NOT NULL,
  platform text NOT NULL,
  app_version text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_user_device_key_unique UNIQUE (user_id, device_key)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider subscription_provider NOT NULL,
  provider_subscription_id text NOT NULL,
  status subscription_status NOT NULL,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_provider_id_unique UNIQUE (provider, provider_subscription_id)
);

CREATE TABLE IF NOT EXISTS entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entitlement text NOT NULL,
  status text NOT NULL,
  source text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlements_user_name_unique UNIQUE (user_id, entitlement)
);

CREATE TABLE IF NOT EXISTS track_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id text NOT NULL,
  source text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT track_access_user_track_unique UNIQUE (user_id, track_id)
);

CREATE TABLE IF NOT EXISTS node_progress (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id text NOT NULL,
  node_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  state jsonb NOT NULL,
  last_mutation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, track_id, node_id)
);

CREATE TABLE IF NOT EXISTS item_progress (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id text NOT NULL,
  item_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  state jsonb NOT NULL,
  last_mutation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, track_id, item_id)
);

CREATE TABLE IF NOT EXISTS sync_mutations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  mutation_id text NOT NULL,
  kind progress_kind NOT NULL,
  payload jsonb NOT NULL,
  applied_version integer NOT NULL CHECK (applied_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_mutations_user_mutation_unique UNIQUE (user_id, mutation_id)
);

CREATE TABLE IF NOT EXISTS content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id text NOT NULL,
  version text NOT NULL,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  package_uri text NOT NULL,
  published_at timestamptz NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_versions_track_version_unique UNIQUE (track_id, version)
);

CREATE INDEX IF NOT EXISTS identities_user_id_idx ON identities(user_id);
CREATE INDEX IF NOT EXISTS devices_user_id_idx ON devices(user_id);
CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS entitlements_user_id_idx ON entitlements(user_id);
CREATE INDEX IF NOT EXISTS track_access_user_id_idx ON track_access(user_id);
CREATE INDEX IF NOT EXISTS sync_mutations_user_created_idx ON sync_mutations(user_id, created_at);
CREATE INDEX IF NOT EXISTS content_versions_current_idx ON content_versions(track_id, is_current);
