-- Run BEFORE deploying the teleapp image that contains the CT-ID-001 fix.
-- send_study_referral now records the requester from the verified Keycloak
-- token (sub) and the lab resolved from the token realm, instead of the
-- client-supplied sr_requester_id.

ALTER TABLE public.tr_study_referrals ADD COLUMN IF NOT EXISTS sr_requester_sub varchar(64);
ALTER TABLE public.tr_study_referrals ADD COLUMN IF NOT EXISTS sr_lab_id integer;

-- sr_requester_id is no longer written; keep old rows but allow NULL for new ones.
ALTER TABLE public.tr_study_referrals ALTER COLUMN sr_requester_id DROP NOT NULL;
