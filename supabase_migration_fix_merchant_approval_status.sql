-- Backfill NULL approval_status for merchants who haven't been explicitly approved/rejected.
-- This fixes merchants not appearing in the admin approval queue.
UPDATE merchants
SET approval_status = 'pending'
WHERE approval_status IS NULL;
