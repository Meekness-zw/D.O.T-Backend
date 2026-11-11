-- DOT team working a managed store: each new order is sent to the store on
-- WhatsApp, and only accepted once the store confirms there. This records
-- when it was sent and confirmed, and by which DOT staff member, so every
-- agent sees the same state.
CREATE TABLE IF NOT EXISTS order_store_confirmations (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  sent_at timestamptz,
  sent_by uuid,
  confirmed_at timestamptz,
  confirmed_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Only the backend (service role) reads or writes this table.
ALTER TABLE order_store_confirmations ENABLE ROW LEVEL SECURITY;
