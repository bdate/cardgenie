-- Recipient thank-you messages sent back to the card sender.
CREATE TABLE IF NOT EXISTS thank_yous (
  card_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  message TEXT NOT NULL,
  method TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL,
  recipient_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_thank_yous_user_id ON thank_yous (user_id, created_at);
