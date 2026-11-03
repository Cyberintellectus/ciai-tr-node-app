-- Patient clinical history (2026-11-03). Safe to run more than once.
--
-- Longitudinal history lives here, not in PACS study metadata: it belongs to the
-- patient and must survive across studies.
--
-- Keyed by (lab_id, patient_id): a patient ID is assigned by the lab, so two labs
-- can use the same ID for different people (and one lab's test data reused "009"
-- for three patients - the viewer warns when the stored name differs from the
-- study's). lab_id always comes from the caller's token (resolveLab), never from
-- the request.
CREATE TABLE IF NOT EXISTS public.patient_profiles (
    lab_id      integer      NOT NULL,
    patient_id  varchar(64)  NOT NULL,                        -- DICOM PatientID (LO, max 64)
    full_name   varchar(200),
    age         varchar(16),                                  -- as recorded, e.g. "47Y" (DICOM AS "047Y")
    sex         varchar(1)   CHECK (sex IN ('M','F','O')),
    created_at  timestamptz  NOT NULL DEFAULT now(),
    updated_at  timestamptz  NOT NULL DEFAULT now(),
    PRIMARY KEY (lab_id, patient_id)
);

-- Append-only: every save is a new row, so the history of what was recorded,
-- by whom and when is kept. Each row holds the background (past medical
-- history, comorbidities, allergies) as it stood after that save, plus an
-- optional clinical note; the current background is the latest row's.
CREATE TABLE IF NOT EXISTS public.patient_clinical_history (
    history_id            bigserial    PRIMARY KEY,
    lab_id                integer      NOT NULL,
    patient_id            varchar(64)  NOT NULL,
    study_id              varchar(128),                       -- StudyInstanceUID the entry was written for, if any
    clinical_notes        text,
    past_medical_history  text,
    comorbidities         text,
    allergies             text,
    created_by            varchar(64)  NOT NULL,              -- Keycloak sub
    created_by_name       varchar(200),                       -- token name at the time
    created_at            timestamptz  NOT NULL DEFAULT now(),
    FOREIGN KEY (lab_id, patient_id) REFERENCES public.patient_profiles (lab_id, patient_id)
);
CREATE INDEX IF NOT EXISTS patient_clinical_history_patient_idx
    ON public.patient_clinical_history (lab_id, patient_id, created_at DESC);

-- Rows are never changed or removed by the application.
CREATE OR REPLACE FUNCTION public.patient_clinical_history_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'patient_clinical_history is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS patient_clinical_history_append_only ON public.patient_clinical_history;
CREATE TRIGGER patient_clinical_history_append_only
    BEFORE UPDATE OR DELETE ON public.patient_clinical_history
    FOR EACH ROW EXECUTE FUNCTION public.patient_clinical_history_append_only();
