-- Study audit (docs/AUDIT_LOGGING_DESIGN.md §4). Safe to run more than once.

-- Pipeline times: one row per study per Orthanc (lab or cloud), upserted by the
-- plugin's batch sync (POST /audit/pipeline).
CREATE TABLE IF NOT EXISTS public.study_pipeline_audit (
    study_id              varchar(128) NOT NULL,              -- StudyInstanceUID
    pacs                  varchar(100) NOT NULL DEFAULT '',   -- orthanc.json "Name" of the sender
    lab_id                integer      NOT NULL,              -- from the service token's realm
    lab_name              varchar(200),
    orthanc_study_id      varchar(64),
    pushed_at             timestamptz,
    push_completed_at     timestamptz,
    analysis_started_at   timestamptz,
    analysis_ended_at     timestamptz,
    analysis_seconds      numeric(10,1),
    analysis_status       varchar(20),                        -- done | incomplete | error | in_progress
    analysis_error        text,
    instances_total       integer,
    instances_analyzed    integer,
    instances_skipped     integer,
    instances_failed      integer,
    sent_to_cloud_at      timestamptz,
    report_started_at     timestamptz,
    report_generated_at   timestamptz,
    report_status         varchar(20),                        -- done | error | no_findings | in_progress
    report_error          text,
    audit_record          jsonb        NOT NULL,              -- the full auditLog as received
    record_read_at        timestamptz  NOT NULL,              -- when the plugin read it (ordering only)
    first_received_at     timestamptz  NOT NULL DEFAULT now(),
    updated_at            timestamptz  NOT NULL DEFAULT now(),
    PRIMARY KEY (study_id, pacs)
);
CREATE INDEX IF NOT EXISTS study_pipeline_audit_lab_pushed_idx ON public.study_pipeline_audit (lab_id, pushed_at DESC);
CREATE INDEX IF NOT EXISTS study_pipeline_audit_lab_report_idx ON public.study_pipeline_audit (lab_id, report_generated_at DESC);

-- User actions: one row per action, written by teleapp (POST /audit/events,
-- POST /audit/review, and the report routes).
CREATE TABLE IF NOT EXISTS public.study_user_events (
    id           bigserial    PRIMARY KEY,
    event_id     uuid         NOT NULL UNIQUE,                -- client-generated: a retried request is stored once
    study_id     varchar(128) NOT NULL,
    lab_id       integer      NOT NULL,
    user_id      varchar(64)  NOT NULL,                       -- Keycloak sub
    user_name    varchar(200),                                -- token name at the time, for "Accepted by Dr. …"
    event_type   varchar(30)  NOT NULL CHECK (event_type IN (
                   'radiologist_viewed','radiologist_accepted','radiologist_rejected',
                   'report_edited','report_finalised','report_amended')),
    event_time   timestamptz  NOT NULL DEFAULT now(),         -- server time
    details      jsonb        NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS study_user_events_study_idx ON public.study_user_events (study_id, event_time);
CREATE INDEX IF NOT EXISTS study_user_events_lab_idx   ON public.study_user_events (lab_id, event_time DESC);

-- Repairs for tables created by hand or from an older copy of this file
-- (CREATE TABLE IF NOT EXISTS leaves an existing table as it is).
ALTER TABLE public.study_user_events ADD COLUMN IF NOT EXISTS user_name varchar(200);
ALTER TABLE public.study_user_events ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS study_user_events_event_id_key ON public.study_user_events (event_id);
CREATE UNIQUE INDEX IF NOT EXISTS study_pipeline_audit_study_pacs_key ON public.study_pipeline_audit (study_id, pacs);
