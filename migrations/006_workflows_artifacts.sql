CREATE TABLE IF NOT EXISTS workflow_specs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  session_id TEXT,
  source TEXT NOT NULL,
  display_text TEXT NOT NULL,
  spec_json JSONB NOT NULL,
  compiled_plan_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_specs_user_created
  ON workflow_specs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_artifacts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow_specs(id) ON DELETE CASCADE,
  workflow_step_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  format TEXT NOT NULL,
  title TEXT NOT NULL,
  sections_json JSONB NOT NULL DEFAULT '[]',
  bindings_json JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  rendered_path TEXT,
  rendered_filename TEXT,
  byte_length BIGINT,
  generation_mode TEXT,
  preview_rows_json JSONB,
  preview_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_workflow_created
  ON workflow_artifacts(workflow_id, created_at DESC);
