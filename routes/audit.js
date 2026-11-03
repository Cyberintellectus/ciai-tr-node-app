// Study audit API (docs/AUDIT_LOGGING_DESIGN.md §6).
//
// - POST /audit/pipeline       Orthanc plugin batch sync of per-study pipeline times
// - POST /audit/events         viewer "AI report opened", report editor viewed / printed /
//                              downloaded as PDF or Word (fire-and-forget)
// - POST /audit/review         radiologist accept / reject, confirmed before the UI changes
// - GET  /audit/review-status  latest decision for the visible worklist rows
// - GET  /audit/studies        one row per study for a date range, JSON or CSV
//
// Identity (user, lab) always comes from the verified token (req.auth, req.labId),
// never from the request body.
const express = require('express');
const crypto = require('crypto');

const UID = /^[0-9.]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Decisions go through /review, saved edits through /reports (report_edited).
const USER_EVENTS = new Set(['radiologist_viewed', 'report_viewed', 'report_printed',
  'report_downloaded_pdf', 'report_downloaded_docx']);
const FILE_NAME = /^[^\u0000-\u001f\\/]{1,200}$/;

/** The details a viewer event may carry, nothing else: file name, format, report version, draft. */
function eventDetails(raw) {
  const details = {};
  if (!raw || typeof raw !== 'object') return details;
  if (typeof raw.file_name === 'string' && FILE_NAME.test(raw.file_name)) details.file_name = raw.file_name;
  if (raw.format === 'pdf' || raw.format === 'docx') details.format = raw.format;
  if (Number.isInteger(raw.version) && raw.version >= 0) details.version = raw.version;
  if (typeof raw.draft === 'boolean') details.draft = raw.draft;
  return details;
}
const REJECT_REASONS = new Set(['inaccurate', 'missed_findings', 'wrong_study_or_quality', 'other']);
const RADIOLOGIST_ROLE = process.env.AUDIT_RADIOLOGIST_ROLE || 'admin-role';
const TZ = process.env.AUDIT_TIMEZONE || 'Asia/Kolkata';
const PIPELINE_BATCH_MAX = 200;
const REVIEW_STATUS_MAX = 100;

// auditLog field (plugin record) → study_pipeline_audit column.
const PIPELINE_FIELDS = {
  study_pushed_at: 'pushed_at',
  study_push_completed_at: 'push_completed_at',
  analysis_started_at: 'analysis_started_at',
  analysis_ended_at: 'analysis_ended_at',
  analysis_total_seconds: 'analysis_seconds',
  analysis_status: 'analysis_status',
  analysis_error: 'analysis_error',
  instances_total: 'instances_total',
  instances_analyzed: 'instances_analyzed',
  instances_skipped: 'instances_skipped',
  instances_failed: 'instances_failed',
  sent_to_cloud_at: 'sent_to_cloud_at',
  report_started_at: 'report_started_at',
  report_generated_at: 'report_generated_at',
  report_status: 'report_status',
  report_error: 'report_error',
};
const PIPELINE_COLUMNS = ['pacs', 'lab_name', 'orthanc_study_id', ...Object.values(PIPELINE_FIELDS), 'audit_record', 'record_read_at'];
const PIPELINE_TYPES = {
  pacs: 'varchar', lab_name: 'varchar', orthanc_study_id: 'varchar',
  pushed_at: 'timestamptz', push_completed_at: 'timestamptz', analysis_started_at: 'timestamptz',
  analysis_ended_at: 'timestamptz', analysis_seconds: 'numeric', analysis_status: 'varchar', analysis_error: 'text',
  instances_total: 'int', instances_analyzed: 'int', instances_skipped: 'int', instances_failed: 'int',
  sent_to_cloud_at: 'timestamptz', report_started_at: 'timestamptz', report_generated_at: 'timestamptz',
  report_status: 'varchar', report_error: 'text', audit_record: 'jsonb', record_read_at: 'timestamptz',
};
const UPSERT_PIPELINE_SQL = `
  INSERT INTO public.study_pipeline_audit AS t (study_id, lab_id, ${PIPELINE_COLUMNS.join(', ')})
  SELECT r.study_id, $1, ${PIPELINE_COLUMNS.map((c) => 'r.' + c).join(', ')}
    FROM jsonb_to_recordset($2::jsonb) AS r(study_id varchar, ${PIPELINE_COLUMNS.map((c) => `${c} ${PIPELINE_TYPES[c]}`).join(', ')})
  ON CONFLICT (study_id, pacs) DO UPDATE SET
    ${PIPELINE_COLUMNS.filter((c) => c !== 'pacs').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()
  WHERE t.lab_id = EXCLUDED.lab_id AND EXCLUDED.record_read_at >= t.record_read_at
  RETURNING (xmax = 0) AS inserted`;

// Current AI-review state of one study: latest decision, and whether the report is final.
const REVIEW_STATE_SQL = `
  SELECT
    (SELECT row_to_json(d) FROM (
       SELECT event_id, replace(event_type, 'radiologist_', '') AS decision, user_id, user_name,
              event_time AS decided_at, details->>'reason' AS reason
         FROM public.study_user_events
        WHERE study_id = $1 AND lab_id = $2 AND event_type IN ('radiologist_accepted','radiologist_rejected')
        ORDER BY event_time DESC, id DESC LIMIT 1) d) AS current,
    EXISTS (SELECT 1 FROM public.study_user_events
             WHERE study_id = $1 AND lab_id = $2 AND event_type = 'report_finalised') AS finalised`;

const STUDIES_SQL = `
  WITH p AS (
    SELECT * FROM public.study_pipeline_audit
     WHERE lab_id = $1
       AND COALESCE(pushed_at, first_received_at) >= ($2::date)::timestamp AT TIME ZONE $4
       AND COALESCE(pushed_at, first_received_at) <  ($3::date + 1)::timestamp AT TIME ZONE $4),
  u AS (
    SELECT study_id,
      min(event_time) FILTER (WHERE event_type = 'radiologist_viewed')                                AS first_viewed_at,
      (array_agg(user_name ORDER BY event_time) FILTER (WHERE event_type = 'radiologist_viewed'))[1]  AS first_viewed_by,
      (array_agg(event_type ORDER BY event_time DESC, id DESC)
         FILTER (WHERE event_type IN ('radiologist_accepted','radiologist_rejected')))[1]             AS decision,
      (array_agg(user_name ORDER BY event_time DESC, id DESC)
         FILTER (WHERE event_type IN ('radiologist_accepted','radiologist_rejected')))[1]             AS decision_by,
      max(event_time) FILTER (WHERE event_type IN ('radiologist_accepted','radiologist_rejected'))     AS decision_at,
      bool_or(event_type = 'report_edited')                                                           AS edited,
      (array_agg((details->>'edit_percent')::numeric ORDER BY event_time DESC)
         FILTER (WHERE event_type = 'report_edited'))[1]                                              AS edit_percent,
      max(event_time) FILTER (WHERE event_type = 'report_finalised')                                  AS finalised_at,
      (array_agg(user_name ORDER BY event_time DESC) FILTER (WHERE event_type = 'report_finalised'))[1] AS finalised_by
    FROM public.study_user_events WHERE lab_id = $1 AND study_id IN (SELECT study_id FROM p)
    GROUP BY study_id)
  SELECT p.study_id, p.pacs, p.lab_id, p.lab_name,
         to_char(p.pushed_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS')           AS pushed_at,
         to_char(p.push_completed_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS')   AS push_completed_at,
         to_char(p.analysis_started_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS') AS analysis_started_at,
         to_char(p.analysis_ended_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS')   AS analysis_ended_at,
         p.analysis_seconds, p.analysis_status,
         p.instances_total, p.instances_analyzed, p.instances_skipped, p.instances_failed,
         to_char(p.sent_to_cloud_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS')    AS sent_to_cloud_at,
         to_char(p.report_generated_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS') AS report_generated_at,
         p.report_status,
         round(COALESCE(p.analysis_seconds, 0)
               + COALESCE(extract(epoch FROM p.report_generated_at - p.report_started_at)::numeric, 0), 1) AS ai_total_seconds,
         to_char(u.first_viewed_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS')     AS first_viewed_at,
         u.first_viewed_by,
         replace(u.decision, 'radiologist_', '')                                AS decision,
         u.decision_by,
         to_char(u.decision_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS')         AS decision_at,
         CASE WHEN u.edited THEN 'edited' ELSE 'not_edited' END                 AS edit_status,
         u.edit_percent,
         to_char(u.finalised_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS')        AS finalised_at,
         u.finalised_by
    FROM p LEFT JOIN u USING (study_id)
   ORDER BY p.pushed_at DESC NULLS LAST
   LIMIT 50000`;

const hasRole = (req, role) => (req.auth.roles || []).includes(role);
const userName = (req) => String(req.user?.name || req.user?.preferred_username || '').slice(0, 200);
const logAudit = (fields) => console.log(JSON.stringify({ kind: 'audit', ...fields }));

const csvCell = (value) => (value == null ? '' : `"${String(value instanceof Date ? value.toISOString() : value).replace(/"/g, '""')}"`);

module.exports = function auditRoutes({ auth, resolveLab, executeQuery, pool }) {
  const router = express.Router();

  /**
   * POST /audit/pipeline  { records: [auditLog JSON + read_at] }   Orthanc plugin, role audit_writer.
   * Upserts one row per (study, pacs). An older copy never overwrites a newer one
   * (record_read_at), and a row never moves to another lab.
   */
  router.post('/pipeline', auth.isAuthorized, resolveLab, async (req, res, next) => {
    try {
      if (!hasRole(req, 'audit_writer')) return res.status(403).json({ error: 'Not allowed' });
      const records = (Array.isArray(req.body?.records) ? req.body.records : [])
        .slice(0, PIPELINE_BATCH_MAX)
        .filter((r) => r && typeof r === 'object' && UID.test(r.study_instance_uid || '') && !Number.isNaN(Date.parse(r.read_at)));
      if (records.length === 0) return res.json({ inserted: 0, updated: 0, ignored: 0 });

      // One row per (study, pacs) in a batch: the newest read wins.
      const byKey = new Map();
      for (const r of records) {
        const key = `${r.study_instance_uid}|${r.pacs || ''}`;
        const seen = byKey.get(key);
        if (!seen || Date.parse(r.read_at) >= Date.parse(seen.read_at)) byKey.set(key, r);
      }
      const rows = [...byKey.values()].map((r) => {
        const row = {
          study_id: r.study_instance_uid,
          pacs: String(r.pacs || '').slice(0, 100),
          lab_name: String(r.lab_name || '').slice(0, 200),
          orthanc_study_id: String(r.orthanc_study_id || '').slice(0, 64),
          audit_record: r,
          record_read_at: r.read_at,
        };
        for (const [field, column] of Object.entries(PIPELINE_FIELDS)) row[column] = r[field] ?? null;
        return row;
      });

      const { rows: result } = await executeQuery(UPSERT_PIPELINE_SQL, [req.labId, JSON.stringify(rows)]);
      const inserted = result.filter((r) => r.inserted).length;
      const summary = { inserted, updated: result.length - inserted, ignored: records.length - result.length };
      logAudit({ source: 'orthanc', event: 'pipeline_batch', lab_id: req.labId, pacs: rows[0].pacs, records: records.length, ...summary });
      res.json(summary);
    } catch (err) { next(err); }
  });

  /**
   * POST /audit/events  { event_type, study_id, event_id?, details? }   viewer, user token.
   * event_type: radiologist_viewed | report_viewed | report_printed | report_downloaded_pdf |
   * report_downloaded_docx; details: { file_name, format, version, draft } (others dropped).
   */
  router.post('/events', auth.isAuthorized, resolveLab, (req, res) => {
    const { event_type, study_id } = req.body || {};
    if (!USER_EVENTS.has(event_type) || !UID.test(study_id || '')) return res.status(400).json({ error: 'Invalid event' });
    const eventId = UUID.test(req.body.event_id || '') ? req.body.event_id : crypto.randomUUID();
    const details = eventDetails(req.body.details);
    res.status(202).json({ event_id: eventId });                        // the UI never waits for the DB
    const fields = { source: 'viewer', event: event_type, study_id, lab_id: req.labId, user_id: req.auth.sub, ...details };
    executeQuery(
      `INSERT INTO public.study_user_events (event_id, study_id, lab_id, user_id, user_name, event_type, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, study_id, req.labId, req.auth.sub, userName(req), event_type, details])
      .then((result) => { if (result.rowCount) logAudit(fields); })     // a retried event is stored and logged once
      .catch((err) => console.error(JSON.stringify({ kind: 'audit', reason: 'audit_db_failed', ...fields, error: err.message })));
  });

  /**
   * POST /audit/review  { study_id, decision: 'accepted'|'rejected', reason?, comment?, expected_event_id }
   * Radiologist (admin-role). The viewer waits for this answer and changes the screen only on 200.
   * expected_event_id is the decision the user was looking at (null if none): if someone else
   * decided in between → 409 with the current decision. Locked (423) once the report is finalised.
   * Every call adds a row, so the full history of changes is kept.
   */
  router.post('/review', auth.isAuthorized, resolveLab, async (req, res, next) => {
    if (!hasRole(req, RADIOLOGIST_ROLE)) return res.status(403).json({ error: 'Not allowed' });
    const { study_id, decision } = req.body || {};
    const expectedEventId = req.body?.expected_event_id || null;
    const reason = String(req.body?.reason || '');
    const comment = String(req.body?.comment || '').trim().slice(0, 500);
    if (!UID.test(study_id || '') || !['accepted', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Invalid decision' });
    }
    if (decision === 'rejected' && !REJECT_REASONS.has(reason)) {
      return res.status(400).json({ error: 'A reason is required to reject' });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // One decision at a time per study, so two radiologists can't both "win".
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [study_id]);
      const { rows: [state] } = await client.query(REVIEW_STATE_SQL, [study_id, req.labId]);
      if (state.finalised) {
        await client.query('ROLLBACK');
        return res.status(423).json({ error: 'Report is finalised', ...state });
      }
      if ((state.current?.event_id || null) !== expectedEventId) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Decision changed by someone else', ...state });
      }
      const details = decision === 'rejected' ? { reason, ...(comment && { comment }) } : {};
      if (state.current) details.previous = state.current.decision;    // a change, not a first decision
      await client.query(
        `INSERT INTO public.study_user_events (event_id, study_id, lab_id, user_id, user_name, event_type, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [crypto.randomUUID(), study_id, req.labId, req.auth.sub, userName(req), `radiologist_${decision}`, details]);
      const { rows: [after] } = await client.query(REVIEW_STATE_SQL, [study_id, req.labId]);
      await client.query('COMMIT');
      logAudit({ source: 'viewer', event: `radiologist_${decision}`, study_id, lab_id: req.labId, user_id: req.auth.sub, ...details });
      res.json(after);
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      if (client) client.release();
    }
  });

  /**
   * GET /audit/review-status?study_ids=uid1,uid2,…  (max 100)   any user of the lab.
   * Latest decision per study, for the visible worklist rows. Studies without one are absent.
   */
  router.get('/review-status', auth.isAuthorized, resolveLab, async (req, res, next) => {
    try {
      const ids = [...new Set(String(req.query.study_ids || '').split(',').filter((id) => UID.test(id)))].slice(0, REVIEW_STATUS_MAX);
      if (ids.length === 0) return res.json({ data: {} });
      const { rows } = await executeQuery(
        `SELECT DISTINCT ON (study_id) study_id, event_id, replace(event_type, 'radiologist_', '') AS decision,
                user_id, user_name, event_time AS decided_at, details->>'reason' AS reason, details->>'previous' AS previous
           FROM public.study_user_events
          WHERE lab_id = $1 AND study_id = ANY($2) AND event_type IN ('radiologist_accepted','radiologist_rejected')
          ORDER BY study_id, event_time DESC, id DESC`,
        [req.labId, ids]);
      res.json({ data: Object.fromEntries(rows.map((r) => [r.study_id, r])) });
    } catch (err) { next(err); }
  });

  /** GET /audit/studies?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv   roles audit_viewer / audit_admin, caller's lab only. */
  router.get('/studies', auth.isAuthorized, resolveLab, async (req, res, next) => {
    try {
      if (!hasRole(req, 'audit_viewer') && !hasRole(req, 'audit_admin')) return res.status(403).json({ error: 'Not allowed' });
      const { from, to } = req.query;
      if (!DATE.test(from || '') || !DATE.test(to || '') || from > to) {
        return res.status(400).json({ error: 'from/to must be YYYY-MM-DD, from <= to' });
      }
      const { rows } = await executeQuery(STUDIES_SQL, [req.labId, from, to, TZ]);
      if (req.query.format !== 'csv') return res.json({ timezone: TZ, data: rows });

      const cols = rows.length ? Object.keys(rows[0]) : ['study_id'];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="study-audit_${from}_${to}.csv"`);
      res.write('﻿' + cols.join(',') + '\n');                    // BOM: Excel reads UTF-8 correctly
      for (const r of rows) res.write(cols.map((c) => csvCell(r[c])).join(',') + '\n');
      res.end();
    } catch (err) { next(err); }
  });

  return router;
};

// Daily retention (§5): deletes in chunks of 5 000 until nothing older is left.
const PRUNE_SQL = [
  `DELETE FROM public.study_user_events WHERE id IN (
     SELECT id FROM public.study_user_events WHERE event_time < now() - make_interval(months => $1) LIMIT 5000)`,
  `DELETE FROM public.study_pipeline_audit WHERE (study_id, pacs) IN (
     SELECT study_id, pacs FROM public.study_pipeline_audit
      WHERE COALESCE(pushed_at, first_received_at) < now() - make_interval(months => $1) LIMIT 5000)`,
];

module.exports.pruneAudit = async (executeQuery, keepMonths) => {
  for (const sql of PRUNE_SQL) {
    let deleted;
    do {
      deleted = (await executeQuery(sql, [keepMonths])).rowCount;
    } while (deleted >= 5000);
  }
};
