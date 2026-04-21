-- Fix NULL approval_status for merchants created before the approval_status column was added.
--
-- Merchants with is_verified = true were already active/trusted before the approval
-- workflow existed — promote them directly to 'approved' so they're not locked out.
--
-- Merchants with is_verified = false have never been verified — set to 'pending' so
-- they appear in the admin approval queue.

UPDATE merchants
SET approval_status = 'approved',
    is_active       = true
WHERE approval_status IS NULL
  AND is_verified   = true;

UPDATE merchants
SET approval_status = 'pending'
WHERE approval_status IS NULL
  AND (is_verified = false OR is_verified IS NULL);
