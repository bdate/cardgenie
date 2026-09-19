-- Sequential print-card order numbers for shopper/support reference.
-- First allocated order_number is 1001.

CREATE TABLE IF NOT EXISTS print_order_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_value INTEGER NOT NULL
);

INSERT OR IGNORE INTO print_order_counter (id, next_value) VALUES (1, 1000);

CREATE TABLE IF NOT EXISTS print_orders (
  order_number INTEGER PRIMARY KEY,
  user_id TEXT,
  card_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ship_to_name TEXT,
  ship_to_json TEXT NOT NULL,
  mail_from_json TEXT NOT NULL,
  shopper_email TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  credit_cost INTEGER NOT NULL DEFAULT 10
);

CREATE INDEX IF NOT EXISTS idx_print_orders_user_id ON print_orders (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_print_orders_card_id ON print_orders (card_id);
