-- Report versions (docs/AUDIT_LOGGING_DESIGN.md §10). Safe to run more than once.
-- Every AI draft and every radiologist save is a new row; rows are never changed
-- except to record finalisation once (trigger below).
CREATE TABLE IF NOT EXISTS public.study_reports (
    report_id          bigserial    PRIMARY KEY,
    study_id           varchar(128) NOT NULL,          -- StudyInstanceUID
    lab_id             integer      NOT NULL,
    version            integer      NOT NULL,          -- 1, 2, 3 … per study and lab (AI and radiologist share the sequence)
    kind               varchar(12)  NOT NULL CHECK (kind IN ('ai_draft','radiologist')),
    status             varchar(10)  NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','amended')),
    based_on_report_id bigint       REFERENCES public.study_reports(report_id),
    -- ai_draft: {"markdown": "...", "sections": [{"key","title","markdown"}]}
    -- radiologist: {"html": "..."} (sections as <h2> headings)
    content            jsonb        NOT NULL,
    content_text       text         NOT NULL,          -- plain text of the editable sections (edit %, search)
    ai_result          jsonb,                          -- ai_draft only: reportGenerationResult of that run (no image bytes)
    ai_version         varchar(60),                    -- ai_draft only, when known
    pacs               varchar(100),                   -- ai_draft only: which Orthanc sent it
    edit_status        varchar(12)  CHECK (edit_status IN ('edited','not_edited','not_from_ai')),
    edit_percent       numeric(5,1),                   -- share of the AI draft text changed (radiologist rows)
    created_by         varchar(64)  NOT NULL,          -- Keycloak sub, or 'system' for AI drafts
    created_by_name    varchar(200),
    created_at         timestamptz  NOT NULL DEFAULT now(),
    finalised_by       varchar(64),
    finalised_at       timestamptz,
    pdf_sop_instance_uid varchar(128),
    sha256             char(64)     NOT NULL,          -- of content
    UNIQUE (study_id, lab_id, version)
);
CREATE INDEX IF NOT EXISTS study_reports_study_idx ON public.study_reports (study_id, lab_id, version DESC);
CREATE INDEX IF NOT EXISTS study_reports_lab_idx   ON public.study_reports (lab_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.study_reports_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('final','amended')
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.content_text IS DISTINCT FROM OLD.content_text
     OR NEW.study_id IS DISTINCT FROM OLD.study_id
     OR NEW.lab_id IS DISTINCT FROM OLD.lab_id
     OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'study_reports rows are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS study_reports_lock ON public.study_reports;
CREATE TRIGGER study_reports_lock BEFORE UPDATE ON public.study_reports
  FOR EACH ROW EXECUTE FUNCTION public.study_reports_lock();
CREATE OR REPLACE FUNCTION public.study_reports_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'study_reports rows cannot be deleted';
END $$;
DROP TRIGGER IF EXISTS study_reports_no_delete ON public.study_reports;
CREATE TRIGGER study_reports_no_delete BEFORE DELETE ON public.study_reports
  FOR EACH ROW EXECUTE FUNCTION public.study_reports_no_delete();

-- Repair for a table created by hand or from an older copy of this file: version
-- numbers must be unique per study and lab.
CREATE UNIQUE INDEX IF NOT EXISTS study_reports_study_lab_version_key ON public.study_reports (study_id, lab_id, version);
