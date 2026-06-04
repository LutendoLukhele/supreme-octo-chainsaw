ALTER TABLE workflow_artifacts
  ADD COLUMN IF NOT EXISTS rendered_filename TEXT,
  ADD COLUMN IF NOT EXISTS byte_length BIGINT,
  ADD COLUMN IF NOT EXISTS generation_mode TEXT,
  ADD COLUMN IF NOT EXISTS preview_rows_json JSONB,
  ADD COLUMN IF NOT EXISTS preview_text TEXT;
