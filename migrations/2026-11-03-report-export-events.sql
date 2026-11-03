-- Report editor audit events (2026-11-03): the report viewed in the editor,
-- printed, and downloaded as PDF or Word. Safe to run more than once.
-- Run before deploying the teleapp that accepts these event types: until then
-- POST /audit/events answers 202 but the insert fails the CHECK and is logged
-- as audit_db_failed.
--
-- The CHECK constraint was declared inline in 2026-10-15-study-audit.sql, so
-- Postgres named it study_user_events_event_type_check.
ALTER TABLE public.study_user_events DROP CONSTRAINT IF EXISTS study_user_events_event_type_check;
ALTER TABLE public.study_user_events ADD CONSTRAINT study_user_events_event_type_check CHECK (event_type IN (
    'radiologist_viewed','radiologist_accepted','radiologist_rejected',
    'report_edited','report_finalised','report_amended',
    'report_viewed','report_printed','report_downloaded_pdf','report_downloaded_docx'));
