-- Clinical notes entered in error (2026-11-24). Safe to run more than once.
-- Run after 2026-11-03-patient-history.sql.
--
-- patient_clinical_history is append-only, so a note written by mistake (a test
-- note, the wrong patient, a wrong history) is never changed or removed: it is
-- marked here, with who marked it, when and why. The history keeps the note and
-- shows it struck through; the viewer no longer sends it to the AI with a report
-- request. Only the entry's clinical note is marked: background fields (past
-- medical history, comorbidities, allergies) are corrected by saving new values.
CREATE TABLE IF NOT EXISTS public.patient_clinical_note_errors (
    history_id       bigint       PRIMARY KEY REFERENCES public.patient_clinical_history (history_id),
    lab_id           integer      NOT NULL,
    patient_id       varchar(64)  NOT NULL,
    reason           text         NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
    created_by       varchar(64)  NOT NULL,                   -- Keycloak sub
    created_by_name  varchar(200),                            -- token name at the time
    created_at       timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS patient_clinical_note_errors_patient_idx
    ON public.patient_clinical_note_errors (lab_id, patient_id);

-- Append-only too: a mark is never changed or taken back (a note marked by
-- mistake is written again as a new note).
CREATE OR REPLACE FUNCTION public.patient_clinical_note_errors_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'patient_clinical_note_errors is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS patient_clinical_note_errors_append_only ON public.patient_clinical_note_errors;
CREATE TRIGGER patient_clinical_note_errors_append_only
    BEFORE UPDATE OR DELETE ON public.patient_clinical_note_errors
    FOR EACH ROW EXECUTE FUNCTION public.patient_clinical_note_errors_append_only();
