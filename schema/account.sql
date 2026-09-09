-- Card Genie account, credit, payment, and history tables.
-- Phone number is the login. Email is optional until a copy or a purchase.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone_e164 TEXT NOT NULL UNIQUE,
  email TEXT,
  email_updated_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  signup_source TEXT NOT NULL DEFAULT 'web',
  first_card_created_at TEXT,
  first_card_sent_at TEXT,
  first_purchase_at TEXT,
  last_card_created_at TEXT,
  last_card_sent_at TEXT,
  last_purchase_at TEXT,
  last_refund_at TEXT,
  cards_created_count INTEGER NOT NULL DEFAULT 0,
  cards_sent_count INTEGER NOT NULL DEFAULT 0,
  send_failure_count INTEGER NOT NULL DEFAULT 0,
  copy_to_self_count INTEGER NOT NULL DEFAULT 0,
  credit_balance INTEGER NOT NULL DEFAULT 0,
  credits_granted INTEGER NOT NULL DEFAULT 0,
  credits_purchased INTEGER NOT NULL DEFAULT 0,
  credits_spent INTEGER NOT NULL DEFAULT 0,
  credits_refunded INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  amount_refunded_cents INTEGER NOT NULL DEFAULT 0,
  last_client TEXT,
  last_error_at TEXT,
  last_error_code TEXT,
  admin_notes TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  credits_delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_label TEXT,
  payment_id TEXT,
  refund_id TEXT,
  card_id TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  status TEXT NOT NULL,
  credits_purchased INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  amount_refunded_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  stripe_checkout_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_customer_id TEXT,
  receipt_email TEXT,
  failure_code TEXT
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  credits_reversed INTEGER NOT NULL DEFAULT 0,
  stripe_refund_id TEXT,
  actor_type TEXT NOT NULL,
  actor_label TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  recipient_name TEXT,
  occasion TEXT,
  sender_name TEXT,
  credits_spent INTEGER NOT NULL DEFAULT 0,
  revision_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  method TEXT NOT NULL,
  destination TEXT NOT NULL,
  is_sender_copy INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error_code TEXT,
  provider_message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_credit_events_user_id ON credit_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON refunds (payment_id);
CREATE INDEX IF NOT EXISTS idx_cards_user_id ON cards (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_user_id ON deliveries (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_card_id ON deliveries (card_id);
