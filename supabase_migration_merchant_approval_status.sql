-- Add approval_status column to merchants table for admin approval workflow
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected'));

-- Add approved_at timestamp when merchant is approved
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE;

-- Add rejected_reason for when merchant is rejected
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS rejected_reason TEXT;

-- Create index for faster queries on approval status
CREATE INDEX IF NOT EXISTS idx_merchants_approval_status ON merchants(approval_status);