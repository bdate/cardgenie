-- Soft feedback / notes from senders. Stored pending for manual approval.
-- Do not display publicly until approved.
CREATE TABLE IF NOT EXISTS testimonials (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT,
  rating INTEGER,
  comment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT,
  phone_e164 TEXT,
  source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_testimonials_status ON testimonials (status, created_at);
CREATE INDEX IF NOT EXISTS idx_testimonials_user_id ON testimonials (user_id, created_at);
