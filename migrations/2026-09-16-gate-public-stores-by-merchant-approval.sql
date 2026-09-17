-- Prevent pending/rejected merchants from being exposed through direct anon
-- Supabase reads. API routes enforce the same rule, but RLS is the database
-- boundary and must fail closed independently of the application server.

-- Defensive for projects initialized from an older base schema. Existing
-- projects already have these columns from supabase_migration_merchant_approval_status.sql.
ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS approval_status TEXT;
ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS rejected_reason TEXT;
ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE;

-- Preserve merchants that were verified before the approval workflow existed;
-- every other legacy/null row fails closed as pending.
UPDATE public.merchants
SET approval_status = 'approved',
    approved_at = COALESCE(approved_at, updated_at, created_at, NOW())
WHERE approval_status IS NULL
  AND is_verified IS TRUE;

UPDATE public.merchants
SET approval_status = 'pending'
WHERE approval_status IS NULL;

ALTER TABLE public.merchants
  ALTER COLUMN approval_status SET DEFAULT 'pending';
ALTER TABLE public.merchants
  ALTER COLUMN approval_status SET NOT NULL;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'merchants_approval_status_check'
      AND conrelid = 'public.merchants'::regclass
  ) THEN
    ALTER TABLE public.merchants
      ADD CONSTRAINT merchants_approval_status_check
      CHECK (approval_status IN ('pending', 'approved', 'rejected'));
  END IF;
END
$constraint$;

CREATE INDEX IF NOT EXISTS idx_merchants_approval_status
  ON public.merchants(approval_status);

-- merchants contains private registration/tax fields, so do not solve this by
-- granting anon SELECT on approved merchant rows. This narrowly scoped helper
-- lets policies check publication eligibility without returning merchant data.
CREATE OR REPLACE FUNCTION public.is_merchant_approved_for_public_store(candidate_merchant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.merchants AS merchant
    WHERE merchant.id = candidate_merchant_id
      AND merchant.is_active IS TRUE
      AND merchant.approval_status = 'approved'
  );
$function$;

REVOKE ALL ON FUNCTION public.is_merchant_approved_for_public_store(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_merchant_approved_for_public_store(UUID)
  TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "Anyone can view active stores" ON public.stores;
CREATE POLICY "Anyone can view active stores" ON public.stores
  FOR SELECT
  USING (
    is_active IS TRUE
    AND public.is_merchant_approved_for_public_store(merchant_id)
  );

DROP POLICY IF EXISTS "Anyone can view available products" ON public.products;
CREATE POLICY "Anyone can view available products" ON public.products
  FOR SELECT
  USING (
    is_available IS TRUE
    AND EXISTS (
      SELECT 1
      FROM public.stores
      WHERE stores.id = products.store_id
        AND stores.is_active IS TRUE
        AND public.is_merchant_approved_for_public_store(stores.merchant_id)
    )
  );
