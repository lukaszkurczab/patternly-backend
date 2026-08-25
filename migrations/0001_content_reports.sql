DO $$ BEGIN
  CREATE TYPE content_report_reason AS ENUM ('incorrect_answer', 'unclear_explanation', 'outdated_content', 'technical_issue', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE content_report_status AS ENUM ('open', 'in_review', 'resolved', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS content_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_submission_id uuid NOT NULL,
  track_id text NOT NULL,
  content_version text NOT NULL,
  item_id text NOT NULL,
  reason content_report_reason NOT NULL,
  description text NOT NULL CHECK (char_length(description) BETWEEN 10 AND 2000),
  status content_report_status NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_reports_user_submission_unique UNIQUE (user_id, client_submission_id)
);

CREATE INDEX IF NOT EXISTS content_reports_status_created_idx ON content_reports(status, created_at DESC);
