# Patient clinical history (2026-11-03)

Longitudinal history is kept in teleapp's PostgreSQL database, not in PACS
study metadata: it belongs to the patient and has to be there for every later
study.

## Tables (`migrations/2026-11-03-patient-history.sql`)

- `patient_profiles` — one row per patient: `(lab_id, patient_id)` primary key,
  `full_name`, `age`, `sex`, `created_at`, `updated_at`.
- `patient_clinical_history` — append-only entries (a trigger refuses UPDATE and
  DELETE): `study_id` (the study the entry was written for), `clinical_notes`,
  `past_medical_history`, `comorbidities`, `allergies`, `created_by` (Keycloak
  `sub`), `created_by_name`, `created_at`. Each entry holds the background as it
  stood after that save; the current background is the latest entry's.

- `patient_clinical_note_errors` (2026-11-24, `migrations/2026-11-24-clinical-note-errors.sql`) —
  clinical notes marked as entered in error, also append-only: `history_id` (primary
  key: one mark per entry), `lab_id`, `patient_id`, `reason`, `created_by`,
  `created_by_name`, `created_at`. A wrong note (a test note, the wrong patient, a
  wrong history) is never changed or removed: it is marked, shown struck through, and
  the viewer no longer sends it to the AI. Only the note is marked; background fields
  are corrected by saving new values. A mark cannot be taken back: write the note again.

Why `(lab_id, patient_id)` and not `patient_id` alone: the ID is assigned by the
lab, so two labs can use the same ID for different people, and test data in one
lab reused `009` for three patients. `lab_id` comes from the token
(`resolveLab`), never from the request. The first recorded name is kept; when a
study's name differs, the viewer shows a warning instead of overwriting it.

## API (`routes/patients.js`, mounted at `/api/patients`)

| Call | Who | Body / answer |
|---|---|---|
| `GET /api/patients/:patientId/history` | any user of the lab | `{ patient_id, profile, background: {field: {text, updated_at, updated_by_name}}, entries: [...] }`, newest first, at most 200 |
| `POST /api/patients/:patientId/history` | any user of the lab | `{ full_name?, age?, sex?, study_id?, clinical_notes?, past_medical_history?, comorbidities?, allergies? }` — the three background fields are the full current values (an emptied field is cleared). 201 with the new `history_id` and the history; 200 `{unchanged: true}` when nothing changed |

| `POST /api/patients/:patientId/history/:historyId/entered-in-error` | any user of the lab | `{ reason }` (1-1000 characters). 201 with the history; 404 when the entry is not this patient's in this lab, 400 when it has no clinical note, 409 when already marked |

Each entry in `entries` carries `entered_in_error`: `{ reason, by_name, at }` or `null`
(always `null` until the 2026-11-24 migration has run; the history still loads).

Limits: patient ID 1-64 characters without control characters or backslash
(DICOM LO); study ID a DICOM UID; sex `M` / `F` / `O`; note 8000 characters,
each background field 4000. One save at a time per patient (advisory lock).
Each save logs one audit line (`patient_history_saved`: lab, user, history_id,
study, whether a note was added / the background changed) — never the text.
Marking a note logs `patient_note_entered_in_error` (lab, user, history_id, study) —
never the note or the reason.

## Viewer

- Worklist: history button next to the patient name → dialog
  (`components/PatientHistory/PatientHistoryDialog.tsx`).
- AI report editor ("Review & edit"): "Patient Clinical History" section at the
  top of the left panel, loaded when the study opens; new entries are linked to
  the study.

- Each note has an "Entered in error" button (not in read-only views): the user gives a
  reason; the note is then struck through with who marked it, when and why.

## Deploy

1. Run `migrations/2026-11-03-patient-history.sql` on the cloud DB (safe to re-run).
2. Run `migrations/2026-11-24-clinical-note-errors.sql` (safe to re-run).
3. Deploy teleapp; rebuild the viewer.
