-- Fix: order_status_history RLS blocking the log_order_status_change trigger.
--
-- The trigger fires AFTER UPDATE on orders and tries to INSERT into
-- order_status_history. If RLS is enabled on that table with no INSERT policy,
-- the trigger's insert is blocked (even when the backend uses the service role,
-- because the trigger inherits the caller's security context).
--
-- Two-part fix:
-- 1. Redefine the trigger function as SECURITY DEFINER so it always runs as
--    its owner (postgres / superuser) who bypasses RLS entirely.
-- 2. Add permissive RLS policies so explicit server-side inserts also succeed
--    (the backend already uses the service role, but belt-and-suspenders).

-- Part 1: Make the trigger function SECURITY DEFINER
CREATE OR REPLACE FUNCTION log_order_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO order_status_history (order_id, status, changed_by)
    VALUES (NEW.id, NEW.status, NEW.courier_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Part 2: Ensure the table has RLS enabled and open policies for
--         service-role inserts (all writes come from the backend).
ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all inserts on order_status_history" ON order_status_history;
CREATE POLICY "Allow all inserts on order_status_history" ON order_status_history
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all selects on order_status_history" ON order_status_history;
CREATE POLICY "Allow all selects on order_status_history" ON order_status_history
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow all updates on order_status_history" ON order_status_history;
CREATE POLICY "Allow all updates on order_status_history" ON order_status_history
  FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all deletes on order_status_history" ON order_status_history;
CREATE POLICY "Allow all deletes on order_status_history" ON order_status_history
  FOR DELETE USING (true);
