// Patient clinical history API (2026-11-03; migration 2026-11-03-patient-history.sql).
//
// - GET  /api/patients/:patientId/history   profile, current background, every entry (newest first)
// - POST /api/patients/:patientId/history   save: background (past medical history, comorbidities,
//                                            allergies) as it now stands and/or a new clinical note
//
// History is longitudinal: it belongs to the patient, not to one study. Rows are
// append-only (each save is a new entry, kept with who and when). Every query is
// scoped to the caller's lab (req.labId from the token); identity (created_by)
// comes from the token, never from the request body.
const express = require('express');

const PATIENT_ID = /^[^\u0000-\u001f\\]{1,64}$/;                       // DICOM LO: no control chars, no backslash
const UID = /^[0-9.]{1,128}$/;
const SEXES = new Set(['M', 'F', 'O']);
const MAX_NOTE = 8000;
const MAX_BACKGROUND = 4000;
const MAX_ENTRIES = 200;
const BACKGROUND = ['past_medical_history', 'comorbidities', 'allergies'];
const userName = (req) => String(req.user?.name || req.user?.preferred_username || '').slice(0, 200);
// Who and what, never the clinical text: logs are not the place for it.
const logAudit = (fields) => console.log(JSON.stringify({ kind: 'audit', ...fields }));

const text = (value) => (typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '');

/** The patient ID from the path, or null when it is not a valid DICOM PatientID. */
function patientIdOf(req) {
  const id = String(req.params.patientId || '').trim();
  return PATIENT_ID.test(id) ? id : null;
}

/** Background as it now stands: the latest entry's values, with when / by whom each last changed. */
function backgroundOf(entries) {
  const background = {};
  BACKGROUND.forEach((field) => {
    const latest = entries[0];
    // The entry where the field took its current value (oldest of the run of equal values).
    let since = latest;
    for (const entry of entries) {
      if ((entry[field] || '') !== (latest?.[field] || '')) break;
      since = entry;
    }
    background[field] = {
      text: latest?.[field] || '',
      updated_at: latest?.[field] ? since.created_at : null,
      updated_by_name: latest?.[field] ? since.created_by_name : null,
    };
  });
  return background;
}

module.exports = function patientRoutes({ auth, resolveLab, pool }) {
  const router = express.Router();

  const history = async (client, labId, patientId) => {
    const [profile, entries] = await Promise.all([
      client.query(
        `SELECT patient_id, full_name, age, sex, created_at, updated_at
         FROM public.patient_profiles WHERE lab_id = $1 AND patient_id = $2`, [labId, patientId]),
      client.query(
        `SELECT history_id, study_id, clinical_notes, past_medical_history, comorbidities, allergies,
                created_by, created_by_name, created_at
         FROM public.patient_clinical_history WHERE lab_id = $1 AND patient_id = $2
         ORDER BY created_at DESC, history_id DESC LIMIT ${MAX_ENTRIES}`, [labId, patientId]),
    ]);
    return {
      patient_id: patientId,
      profile: profile.rows[0] || null,
      background: backgroundOf(entries.rows),
      entries: entries.rows,
    };
  };

  /** GET /api/patients/:patientId/history   any user of the lab. */
  router.get('/:patientId/history', auth.isAuthorized, resolveLab, async (req, res, next) => {
    const patientId = patientIdOf(req);
    if (!patientId) return res.status(400).json({ error: 'Invalid patient ID' });
    const client = await pool.connect();
    try {
      res.json(await history(client, req.labId, patientId));
    } catch (err) {
      next(err);
    } finally {
      client.release();
    }
  });

  /**
   * POST /api/patients/:patientId/history   any user of the lab.
   * { full_name?, age?, sex?, study_id?, clinical_notes?, past_medical_history?, comorbidities?, allergies? }
   * The three background fields are the full current values (the form starts from the
   * current ones; an emptied field is cleared). clinical_notes is a new note.
   * 201 with the new entry and the history; 200 { unchanged: true } when nothing changed.
   */
  router.post('/:patientId/history', auth.isAuthorized, resolveLab, async (req, res, next) => {
    const patientId = patientIdOf(req);
    if (!patientId) return res.status(400).json({ error: 'Invalid patient ID' });
    const body = req.body || {};
    const studyId = text(body.study_id);
    const sex = text(body.sex).toUpperCase().slice(0, 1);
    const entry = {
      clinical_notes: text(body.clinical_notes),
      past_medical_history: text(body.past_medical_history),
      comorbidities: text(body.comorbidities),
      allergies: text(body.allergies),
    };
    if (studyId && !UID.test(studyId)) return res.status(400).json({ error: 'Invalid study ID' });
    if (sex && !SEXES.has(sex)) return res.status(400).json({ error: 'Sex must be M, F or O' });
    if (entry.clinical_notes.length > MAX_NOTE) return res.status(400).json({ error: `Clinical note longer than ${MAX_NOTE} characters` });
    if (BACKGROUND.some((field) => entry[field].length > MAX_BACKGROUND)) {
      return res.status(400).json({ error: `History fields are limited to ${MAX_BACKGROUND} characters` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // One save at a time per patient, so "latest" stays well defined.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), $2)', [`patient:${patientId}`, req.labId]);
      // The name is kept as first recorded: a different name under the same ID is
      // shown to the user as a warning, never silently overwritten.
      await client.query(
        `INSERT INTO public.patient_profiles (lab_id, patient_id, full_name, age, sex)
         VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''))
         ON CONFLICT (lab_id, patient_id) DO UPDATE SET
           full_name  = COALESCE(public.patient_profiles.full_name, EXCLUDED.full_name),
           age        = COALESCE(EXCLUDED.age, public.patient_profiles.age),
           sex        = COALESCE(EXCLUDED.sex, public.patient_profiles.sex),
           updated_at = now()`,
        [req.labId, patientId, text(body.full_name).slice(0, 200), text(body.age).slice(0, 16), sex]);
      const latest = await client.query(
        `SELECT past_medical_history, comorbidities, allergies FROM public.patient_clinical_history
         WHERE lab_id = $1 AND patient_id = $2 ORDER BY created_at DESC, history_id DESC LIMIT 1`,
        [req.labId, patientId]);
      const previous = latest.rows[0] || {};
      const changed = BACKGROUND.some((field) => entry[field] !== (previous[field] || ''));
      if (!entry.clinical_notes && !changed) {
        await client.query('COMMIT');
        return res.json({ unchanged: true, ...(await history(client, req.labId, patientId)) });
      }
      const inserted = await client.query(
        `INSERT INTO public.patient_clinical_history
           (lab_id, patient_id, study_id, clinical_notes, past_medical_history, comorbidities, allergies,
            created_by, created_by_name)
         VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), $8, $9)
         RETURNING history_id`,
        [req.labId, patientId, studyId, entry.clinical_notes, entry.past_medical_history, entry.comorbidities,
         entry.allergies, req.auth.sub, userName(req)]);
      await client.query('COMMIT');
      logAudit({
        source: 'viewer', event: 'patient_history_saved', lab_id: req.labId, user_id: req.auth.sub,
        history_id: inserted.rows[0].history_id, study_id: studyId || null,
        note: Boolean(entry.clinical_notes), background_changed: changed,
      });
      res.status(201).json({ history_id: inserted.rows[0].history_id, ...(await history(client, req.labId, patientId)) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  });

  return router;
};

module.exports.backgroundOf = backgroundOf;
