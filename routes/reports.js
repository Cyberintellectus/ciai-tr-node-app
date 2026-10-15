// Report versions API (docs/AUDIT_LOGGING_DESIGN.md §10).
//
// - POST /reports/ai-draft                 Orthanc plugin: one AI draft per report run (deduplicated)
// - GET  /reports/:studyUid                 versions list + latest AI draft + latest radiologist version
// - GET  /reports/:studyUid/versions/:n     one full version (AI drafts include their ai_result)
// - POST /reports/:studyUid                 radiologist saves a new draft version
//
// Rows are append-only. Every query is scoped to the caller's lab (req.labId, from
// the token realm). Finalise / amend (and the PDF) come in the next step.
const express = require('express');
const crypto = require('crypto');
const {
  splitAiSections, aiSectionsText, htmlToText, sanitizeReportHtml, editPercent, markdownToText,
} = require('../lib/reportText');

const UID = /^[0-9.]{1,128}$/;
const RADIOLOGIST_ROLE = process.env.AUDIT_RADIOLOGIST_ROLE || 'admin-role';
const MAX_MARKDOWN = 500 * 1024;
const MAX_HTML = 1024 * 1024;
const MAX_FINDINGS = 200;

const hasRole = (req, role) => (req.auth.roles || []).includes(role);
const userName = (req) => String(req.user?.name || req.user?.preferred_username || '').slice(0, 200);
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const logAudit = (fields) => console.log(JSON.stringify({ kind: 'audit', ...fields }));

const META_COLUMNS = `report_id, version, kind, status, based_on_report_id, edit_status, edit_percent,
  created_by, created_by_name, created_at, finalised_by, finalised_at`;

// Findings the radiologist kept or removed in the editor, reduced to what the
// AI-accuracy statistics need (docs §10: "which AI findings radiologists drop").
const cleanFindings = (list) => (Array.isArray(list) ? list : []).slice(0, MAX_FINDINGS)
  .filter((f) => f && typeof f.name === 'string' && ['kept', 'removed'].includes(f.decision))
  .map((f) => ({
    name: f.name.slice(0, 200),
    severity: String(f.severity || '').slice(0, 20),
    modality: String(f.modality || '').slice(0, 10),
    flags: (Array.isArray(f.flags) ? f.flags : []).slice(0, 10).map((x) => String(x).slice(0, 40)),
    decision: f.decision,
  }));

module.exports = function reportRoutes({ auth, resolveLab, pool }) {
  const router = express.Router();

  const withStudyLock = async (studyId, labId, work) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), $2)', [studyId, labId]);
      const result = await work(client);
      await client.query(result?.rollback ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };

  /** POST /reports/ai-draft  { study_id, report_text, ai_result?, ai_version?, pacs? }   plugin, audit_writer. */
  router.post('/ai-draft', auth.isAuthorized, resolveLab, async (req, res, next) => {
    try {
      if (!hasRole(req, 'audit_writer')) return res.status(403).json({ error: 'Not allowed' });
      const { study_id: studyId, report_text: markdown } = req.body || {};
      if (!UID.test(studyId || '') || typeof markdown !== 'string' || !markdown.trim() || markdown.length > MAX_MARKDOWN) {
        return res.status(400).json({ error: 'study_id and report_text are required' });
      }
      let sections = splitAiSections(markdown);
      if (!sections.length) sections = [{ key: 'report', title: 'Report', markdown: markdown.trim() }];
      const content = { markdown, sections };
      const hash = sha256(content);
      const aiResult = req.body.ai_result && typeof req.body.ai_result === 'object' ? req.body.ai_result : null;

      const result = await withStudyLock(studyId, req.labId, async (client) => {
        const { rows: [latestAi] } = await client.query(
          `SELECT report_id, version, sha256 FROM public.study_reports
            WHERE study_id = $1 AND lab_id = $2 AND kind = 'ai_draft' ORDER BY version DESC LIMIT 1`,
          [studyId, req.labId]);
        if (latestAi && latestAi.sha256 === hash) {
          return { unchanged: true, report_id: latestAi.report_id, version: latestAi.version };
        }
        const { rows: [inserted] } = await client.query(
          `INSERT INTO public.study_reports
             (study_id, lab_id, version, kind, content, content_text, ai_result, ai_version, pacs, created_by, sha256)
           SELECT $1::varchar, $2::int, COALESCE(MAX(version), 0) + 1, 'ai_draft', $3::jsonb, $4::text, $5::jsonb,
                  $6::varchar, $7::varchar, 'system', $8::char(64)
             FROM public.study_reports WHERE study_id = $1::varchar AND lab_id = $2::int
           RETURNING report_id, version`,
          [studyId, req.labId, content, aiSectionsText(sections), aiResult,
           String(req.body.ai_version || '').slice(0, 60) || null, String(req.body.pacs || '').slice(0, 100) || null, hash]);
        return { unchanged: false, ...inserted };
      });
      logAudit({ source: 'orthanc', event: 'ai_draft', study_id: studyId, lab_id: req.labId, ...result });
      res.json(result);
    } catch (err) { next(err); }
  });

  /** GET /reports/:studyUid   any user of the lab. */
  router.get('/:studyUid', auth.isAuthorized, resolveLab, async (req, res, next) => {
    try {
      const studyId = req.params.studyUid;
      if (!UID.test(studyId)) return res.status(400).json({ error: 'Invalid study' });
      const [versions, ai, latest] = await Promise.all([
        pool.query(
          `SELECT ${META_COLUMNS} FROM public.study_reports
            WHERE study_id = $1 AND lab_id = $2 ORDER BY version DESC`, [studyId, req.labId]),
        pool.query(
          `SELECT report_id, version, created_at, ai_version, content FROM public.study_reports
            WHERE study_id = $1 AND lab_id = $2 AND kind = 'ai_draft' ORDER BY version DESC LIMIT 1`, [studyId, req.labId]),
        pool.query(
          `SELECT ${META_COLUMNS}, content FROM public.study_reports
            WHERE study_id = $1 AND lab_id = $2 AND kind = 'radiologist' ORDER BY version DESC LIMIT 1`, [studyId, req.labId]),
      ]);
      res.json({
        study_id: studyId,
        latest_version: versions.rows[0]?.version || 0,
        finalised: versions.rows.some((v) => v.status !== 'draft'),
        versions: versions.rows,
        latest_ai_draft: ai.rows[0] || null,
        latest_radiologist: latest.rows[0] || null,
      });
    } catch (err) { next(err); }
  });

  /** GET /reports/:studyUid/versions/:version   one full version. */
  router.get('/:studyUid/versions/:version', auth.isAuthorized, resolveLab, async (req, res, next) => {
    try {
      const { studyUid } = req.params;
      const version = Number(req.params.version);
      if (!UID.test(studyUid) || !Number.isInteger(version) || version < 1) return res.status(400).json({ error: 'Invalid version' });
      const { rows: [row] } = await pool.query(
        `SELECT ${META_COLUMNS}, content, ai_result, ai_version FROM public.study_reports
          WHERE study_id = $1 AND lab_id = $2 AND version = $3`, [studyUid, req.labId, version]);
      if (!row) return res.status(404).json({ error: 'No such version' });
      res.json(row);
    } catch (err) { next(err); }
  });

  /**
   * POST /reports/:studyUid  { html, based_on_report_id, expected_version, findings? }   radiologist.
   * Saves a new draft version. expected_version = the latest version the editor
   * loaded: if someone saved since → 409. Once finalised → 423 (amend comes later).
   * The edit status is worked out here against the AI draft the text came from.
   */
  router.post('/:studyUid', auth.isAuthorized, resolveLab, async (req, res, next) => {
    try {
      if (!hasRole(req, RADIOLOGIST_ROLE)) return res.status(403).json({ error: 'Not allowed' });
      const studyId = req.params.studyUid;
      const { html, based_on_report_id: basedOn = null } = req.body || {};
      const expectedVersion = Number(req.body?.expected_version ?? -1);
      if (!UID.test(studyId) || typeof html !== 'string' || html.length > MAX_HTML || !Number.isInteger(expectedVersion)) {
        return res.status(400).json({ error: 'html and expected_version are required' });
      }
      const clean = sanitizeReportHtml(html);
      const text = htmlToText(clean);
      if (!text) return res.status(400).json({ error: 'The report is empty' });
      const content = { html: clean };
      const hash = sha256(content);
      const findings = cleanFindings(req.body.findings);

      const result = await withStudyLock(studyId, req.labId, async (client) => {
        const { rows: [latest] } = await client.query(
          `SELECT version, kind, sha256, status, report_id FROM public.study_reports
            WHERE study_id = $1 AND lab_id = $2 ORDER BY version DESC LIMIT 1`, [studyId, req.labId]);
        const { rows: [finalRow] } = await client.query(
          `SELECT 1 FROM public.study_reports WHERE study_id = $1 AND lab_id = $2 AND status <> 'draft' LIMIT 1`,
          [studyId, req.labId]);
        if (finalRow) return { rollback: true, status: 423, body: { error: 'Report is finalised' } };
        if ((latest?.version || 0) !== expectedVersion) {
          return { rollback: true, status: 409, body: { error: 'A newer version was saved', latest_version: latest?.version || 0 } };
        }
        if (latest && latest.kind === 'radiologist' && latest.sha256 === hash) {
          return { status: 200, body: { unchanged: true, report_id: latest.report_id, version: latest.version } };
        }

        // The AI draft this text descends from: follow based_on back to an ai_draft.
        let aiBase = null;
        if (basedOn) {
          const { rows } = await client.query(
            `WITH RECURSIVE chain AS (
               SELECT report_id, based_on_report_id, kind, content_text, 1 AS depth FROM public.study_reports
                WHERE report_id = $1 AND study_id = $2 AND lab_id = $3
               UNION ALL
               SELECT r.report_id, r.based_on_report_id, r.kind, r.content_text, c.depth + 1
                 FROM public.study_reports r JOIN chain c ON r.report_id = c.based_on_report_id
                WHERE c.kind <> 'ai_draft' AND c.depth < 100)
             SELECT report_id, content_text FROM chain WHERE kind = 'ai_draft' LIMIT 1`,
            [basedOn, studyId, req.labId]);
          aiBase = rows[0] || null;
          if (!aiBase) {
            const { rows: [base] } = await client.query(
              'SELECT 1 FROM public.study_reports WHERE report_id = $1 AND study_id = $2 AND lab_id = $3', [basedOn, studyId, req.labId]);
            if (!base) return { rollback: true, status: 400, body: { error: 'based_on_report_id is not a version of this study' } };
          }
        }
        const percent = aiBase ? editPercent(aiBase.content_text, text) : null;
        const editStatus = !aiBase ? 'not_from_ai' : percent === 0 ? 'not_edited' : 'edited';

        const { rows: [saved] } = await client.query(
          `INSERT INTO public.study_reports
             (study_id, lab_id, version, kind, based_on_report_id, content, content_text, edit_status, edit_percent,
              created_by, created_by_name, sha256)
           VALUES ($1, $2, $3, 'radiologist', $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING ${META_COLUMNS}`,
          [studyId, req.labId, expectedVersion + 1, basedOn, content, text, editStatus, percent,
           req.auth.sub, userName(req), hash]);

        const removed = findings.filter((f) => f.decision === 'removed');
        if (editStatus === 'edited' || removed.length) {
          // One event per save; statistics use each study's latest report_edited event.
          const details = {
            version: saved.version, edit_percent: percent, ai_report_id: aiBase?.report_id || null,
            findings_kept: findings.filter((f) => f.decision === 'kept'), findings_removed: removed,
          };
          await client.query(
            `INSERT INTO public.study_user_events (event_id, study_id, lab_id, user_id, user_name, event_type, details)
             VALUES ($1, $2, $3, $4, $5, 'report_edited', $6)`,
            [crypto.randomUUID(), studyId, req.labId, req.auth.sub, userName(req), details]);
        }
        return { status: 200, body: { unchanged: false, ...saved }, removedCount: removed.length };
      });

      if (result.status === 200 && !result.body.unchanged) {
        logAudit({ source: 'viewer', event: 'report_saved', study_id: studyId, lab_id: req.labId, user_id: req.auth.sub,
                   version: result.body.version, edit_status: result.body.edit_status, edit_percent: result.body.edit_percent,
                   findings_removed: result.removedCount });
      }
      res.status(result.status).json(result.body);
    } catch (err) { next(err); }
  });

  return router;
};

module.exports.markdownToText = markdownToText;
