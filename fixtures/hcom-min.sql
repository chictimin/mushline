-- fixtures/hcom-min.sql — O-4 전용 최소 hcom DB 사본 스키마
--
-- 출처: ~/.hcom/hcom.db 실측 (2026-09-22, hcom via homebrew).
-- 정본 매핑표: vault Projects/mushline/SCHEMA-mushline-boundary.md 부록 A rev4.
--
-- 목적: O-4("DB에 INSERT → DOM 반영" 지연)를 실 hcom 없이 재기 위한 사본.
-- 실 DB에는 events_fts* (FTS5 전문검색), kv, notify_endpoints, process_bindings,
-- session_bindings, claude_actor_capabilities 가 더 있으나 mushline은 읽지 않으므로 뺐다.
--
-- 사용:
--   sqlite3 /tmp/mushline-fixture.db < fixtures/hcom-min.sql
--   bun run src/server.ts --db-path /tmp/mushline-fixture.db
--
-- 절대로 ~/.hcom/hcom.db 를 대상으로 실행하지 않는다.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    type      TEXT NOT NULL,   -- 실측 분포: status / message / life / bundle
    instance  TEXT NOT NULL,   -- 에이전트 이름 (4-letter CVCV)
    data      TEXT NOT NULL    -- JSON. 아래 events_v가 json_extract로 편다
);

CREATE INDEX IF NOT EXISTS idx_timestamp     ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_type          ON events(type);
CREATE INDEX IF NOT EXISTS idx_instance      ON events(instance);
CREATE INDEX IF NOT EXISTS idx_type_instance ON events(type, instance);

-- 실 DB의 events_v 정의를 그대로 옮긴 것이다. 컬럼을 빼거나 이름을 바꾸지 않는다 —
-- 이 뷰가 실물과 달라지는 순간 O-4는 "제품이 아닌 fixture"를 측정하게 된다.
CREATE VIEW IF NOT EXISTS events_v AS
SELECT
    id, timestamp, type, instance, data,
    json_extract(data, '$.from')             AS msg_from,
    json_extract(data, '$.text')             AS msg_text,
    json_extract(data, '$.scope')            AS msg_scope,
    json_extract(data, '$.sender_kind')      AS msg_sender_kind,
    json_extract(data, '$.delivered_to')     AS msg_delivered_to,
    json_extract(data, '$.mentions')         AS msg_mentions,
    json_extract(data, '$.intent')           AS msg_intent,
    json_extract(data, '$.thread')           AS msg_thread,
    json_extract(data, '$.reply_to')         AS msg_reply_to,
    json_extract(data, '$.reply_to_local')   AS msg_reply_to_local,
    json_extract(data, '$.bundle_id')        AS bundle_id,
    json_extract(data, '$.title')            AS bundle_title,
    json_extract(data, '$.description')      AS bundle_description,
    json_extract(data, '$.extends')          AS bundle_extends,
    json_extract(data, '$.refs.events')      AS bundle_events,
    json_extract(data, '$.refs.files')       AS bundle_files,
    json_extract(data, '$.refs.transcript')  AS bundle_transcript,
    json_extract(data, '$.created_by')       AS bundle_created_by,
    json_extract(data, '$.status')           AS status_val,
    json_extract(data, '$.context')          AS status_context,
    json_extract(data, '$.detail')           AS status_detail,
    json_extract(data, '$.action')           AS life_action,
    json_extract(data, '$.by')               AS life_by,
    json_extract(data, '$.batch_id')         AS life_batch_id,
    json_extract(data, '$.reason')           AS life_reason
FROM events;

-- 에이전트 상세는 평소 `hcom list --json`으로 읽지만, HCOM_BIN 실패 주입(O-8 ②)
-- 상황에서도 사본만으로 상태를 재현할 수 있어야 하므로 같이 둔다.
CREATE TABLE IF NOT EXISTS instances (
    name              TEXT PRIMARY KEY,
    session_id        TEXT UNIQUE,
    parent_session_id TEXT,
    parent_name       TEXT,
    tag               TEXT,
    last_event_id     INTEGER DEFAULT 0,
    status            TEXT    DEFAULT 'active',  -- active | listening | blocked | inactive
    status_time       INTEGER DEFAULT 0,
    last_seen         INTEGER DEFAULT 0,
    status_context    TEXT    DEFAULT '',
    status_detail     TEXT    DEFAULT '',
    last_stop         INTEGER DEFAULT 0,
    directory         TEXT,
    created_at        REAL    NOT NULL,
    tool              TEXT    DEFAULT 'claude',
    pid               INTEGER DEFAULT NULL
);

-- 최소 시드 — 매핑표 순번 1~6을 각각 한 번씩 때린다.
-- 순번 6(other)에 걸리는 것은 실측상 type='bundle' 뿐이며, 격리 큐 동작 확인용이다.
INSERT INTO instances (name, session_id, status, status_context, status_detail, created_at, tool)
VALUES
  ('lune', 'sess-lune', 'active',    'tool:Bash', 'bun run src/server.ts', 1758500000.0, 'claude'),
  ('nova', 'sess-nova', 'blocked',   'approval',  '',                      1758500001.0, 'claude'),
  ('sona', 'sess-sona', 'listening', '',          '',                      1758500002.0, 'opencode');

INSERT INTO events (timestamp, type, instance, data) VALUES
  -- 순번 1: life
  ('2026-09-22T06:00:00.000Z', 'life',    'lune', json('{"action":"ready","by":"hcom"}')),
  -- 순번 2: file (대문자 Write = Claude Code)
  ('2026-09-22T06:00:01.000Z', 'status',  'lune', json('{"status":"active","context":"tool:Write","detail":"/Users/x/src/server.ts"}')),
  -- 순번 2: file (소문자 write = OpenCode). 대소문자 무시 비교가 깨지면 이 행이 순번 4로 샌다.
  ('2026-09-22T06:00:02.000Z', 'status',  'sona', json('{"status":"active","context":"tool:write","detail":"/tmp/notes.md"}')),
  -- 순번 3: cmd
  ('2026-09-22T06:00:03.000Z', 'status',  'lune', json('{"status":"active","context":"tool:Bash","detail":"git rev-parse HEAD"}')),
  -- 순번 4: tool
  ('2026-09-22T06:00:04.000Z', 'status',  'sona', json('{"status":"active","context":"tool:send","detail":"@lune -- ok"}')),
  -- 순번 5: status (비-tool context)
  ('2026-09-22T06:00:05.000Z', 'status',  'nova', json('{"status":"blocked","context":"approval","detail":"Bash"}')),
  -- 순번 5: status (빈 context)
  ('2026-09-22T06:00:06.000Z', 'status',  'nova', json('{"status":"listening","context":"","detail":""}')),
  -- message
  ('2026-09-22T06:00:07.000Z', 'message', 'lune', json('{"from":"lune","text":"경계 스키마 rev4 올렸음","mentions":["nova"],"intent":"inform","thread":null}')),
  -- 순번 6: other → 격리 큐
  ('2026-09-22T06:00:08.000Z', 'bundle',  'lune', json('{"bundle_id":"b1","title":"handoff","created_by":"lune"}'));
