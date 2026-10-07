/**
 * mushline — 서버 (W1)
 *
 * 정본: vault `Projects/mushline/PRD-mushline.md` (rev3)
 *       vault `Projects/mushline/SCHEMA-mushline-boundary.md` (rev4)
 *
 * 빌드 없음 · 의존성 0 · 단일 진입점. `bun run src/server.ts` 한 줄로 뜬다.
 * 127.0.0.1:7377 고정 — 포트 탐색을 하지 않는다 (PRD §8).
 * hcom DB 는 읽기 전용으로만 연다 (SCHEMA §3-7).
 *
 * 주입 인터페이스 (PRD §7 — 측정 가능성의 전제)
 *   --db-path <path> / HCOM_DB    기본 ~/.hcom/hcom.db
 *   HCOM_BIN                      기본 hcom
 *   CMUX_BIN                      기본 cmux (선택 — 없으면 cmux 그룹 대신 directory 로 묶는다)
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 상수 ────────────────────────────────────────────────────────────────────
const SCHEMA_V = 1 as const;
const MIN_CLIENT_V = 1 as const;

const HOST = "127.0.0.1";
const PORT = 7377;

const POLL_MS = 200; // events_v 폴링 (PRD §7)
const AGENT_POLL_MS = 2000; // hcom list --json 호출
const HEARTBEAT_MS = 15_000; // SCHEMA §1 — 변화가 없어도 무조건 나간다
const CLI_TIMEOUT_MS = 5000;

const ACTIVITY_BUFFER_MAX = 200; // SCHEMA §3-9
const MESSAGE_BUFFER_MAX = 200;
/** 기동 시 메시지 seed 시간 창. 실측 최근 24h 메시지 212건 ≈ 버퍼 상한이라 사실상 하루치다. */
const MESSAGE_SEED_WINDOW_MS = 24 * 3600 * 1000;

/** 부록 A 순번 2 — 파일쓰기 화이트리스트. 비교는 대소문자 무시다.
 *  구분하면 `tool:write`(OpenCode, 실측 3383건)가 조용히 순번 4로 샌다. */
const FILE_TOOLS = new Set(["edit", "write", "notebookedit"]);

const AGENT_STATUSES = new Set(["active", "listening", "blocked", "inactive", "unknown"]);
const INTENTS = new Set(["request", "inform", "ack"]);

const REPO_ROOT = join(import.meta.dir, "..");
const UI_PATH = join(import.meta.dir, "ui.html"); // W2 소유. 서버는 읽어서 서빙만 한다.

// ── 타입 (SCHEMA §2) ────────────────────────────────────────────────────────
type AgentStatus = "active" | "listening" | "blocked" | "inactive" | "unknown";
type Kind = "tool" | "file" | "cmd" | "life" | "status" | "other";

interface Agent {
  name: string;
  tag: string | null;
  tool: string | null; // hcom tool 원문. 없으면 null (SCHEMA §2, UI 배치 #5)
  status: AgentStatus;
  statusContext: string | null;
  statusDetail: string | null;
  description: string | null;
  directory: string | null;
  /** 필터 키. cmux 그룹에 속한 워크스페이스에서 뜬 에이전트는 `cgroup:<그룹 이름>`, 아니면 `dir:<directory>`. 모르면 null. */
  workspace: string | null;
  workspaceLabel: string | null;
  unreadCount: number;
  lastEventAt: string | null;
  /** R6. pane_id 가 직전 poll 의 tree 에 surface 또는 workspace 로 있으면 true. */
  focusable: boolean;
}
interface Activity {
  id: string;
  ts: string;
  agent: string;
  kind: Kind;
  label: string;
  detail: string | null;
}
interface Message {
  id: string;
  ts: string;
  from: string;
  to: string[];
  intent: "request" | "inform" | "ack" | null;
  thread: string | null;
  text: string;
}
interface Health {
  ok: boolean;
  source: "db" | "cli" | "none";
  reason: string | null;
}

// ── 기동 인자 ───────────────────────────────────────────────────────────────
function parseDbPath(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--db-path") return argv[i + 1] ?? null;
    if (a.startsWith("--db-path=")) return a.slice("--db-path=".length);
  }
  return null;
}

const DB_PATH =
  parseDbPath(Bun.argv.slice(2)) ??
  process.env.HCOM_DB ??
  join(homedir(), ".hcom", "hcom.db");
const HCOM_BIN = process.env.HCOM_BIN ?? "hcom";
const CMUX_BIN = process.env.CMUX_BIN ?? "cmux";

const startedAt = new Date().toISOString();
let seq = 0;
const nextId = () => `${startedAt}-${++seq}`;
/** id 에서 seq 를 되꺼낸다. 재생 순서를 맞추는 데만 쓴다. */
const seqOf = (id: string) => Number(id.slice(startedAt.length + 1)) || 0;

// ── 상태 ────────────────────────────────────────────────────────────────────
let agents: Agent[] = [];
let agentsKey = ""; // 변화 감지용
const activities: Activity[] = [];
const messages: Message[] = [];

let dbError: string | null = null;
let cliError: string | null = null;
let health: Health = { ok: false, source: "none", reason: "기동 중" };

/** events_v 에서 마지막으로 본 행. */
let lastRowId = 0;
/** 에이전트별 마지막 이벤트 시각 (Agent.lastEventAt 계산용). DB 이벤트에서 온다. */
const lastEventAt = new Map<string, string>();
/** 부록 A 순번 6 격리 큐 (SCHEMA §3-12). 화면이 아니라 stderr 로 낸다. */
let isolatedCount = 0;

// ── SSE ─────────────────────────────────────────────────────────────────────
const encoder = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function frame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function send(ctl: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown) {
  try {
    ctl.enqueue(frame(event, data));
  } catch {
    clients.delete(ctl);
  }
}
function broadcast(event: string, data: unknown) {
  const chunk = frame(event, data);
  for (const ctl of clients) {
    try {
      ctl.enqueue(chunk);
    } catch {
      clients.delete(ctl);
    }
  }
}

function snapshotPayload() {
  return { v: SCHEMA_V, ts: new Date().toISOString(), agents };
}
function healthPayload() {
  return { v: SCHEMA_V, ts: new Date().toISOString(), ...health };
}

function pushActivity(a: Activity) {
  activities.push(a);
  while (activities.length > ACTIVITY_BUFFER_MAX) activities.shift();
  broadcast("activity", { v: SCHEMA_V, ...a });
}
function pushMessage(m: Message) {
  messages.push(m);
  while (messages.length > MESSAGE_BUFFER_MAX) messages.shift();
  broadcast("message", { v: SCHEMA_V, ...m });
}

function setHealth(next: Health) {
  if (next.ok === health.ok && next.source === health.source && next.reason === health.reason) return;
  health = next;
  broadcast("health", healthPayload());
}
function recomputeHealth() {
  if (dbError && cliError) {
    setHealth({ ok: false, source: "none", reason: `db: ${dbError} / cli: ${cliError}` });
  } else if (dbError) {
    setHealth({ ok: false, source: "db", reason: dbError });
  } else if (cliError) {
    setHealth({ ok: false, source: "cli", reason: cliError });
  } else {
    setHealth({ ok: true, source: "db", reason: null });
  }
}

// ── DB (읽기 전용) ──────────────────────────────────────────────────────────
let db: Database | null = null;

const ROW_COLS = `id, timestamp, type, instance, data,
  status_val, status_context, status_detail, life_action,
  msg_from, msg_text, msg_mentions, msg_intent, msg_thread`;

type Row = {
  id: number;
  timestamp: string | number;
  type: string;
  instance: string;
  data: string | null;
  status_val: string | null;
  status_context: string | null;
  status_detail: string | null;
  life_action: string | null;
  msg_from: string | null;
  msg_text: string | null;
  msg_mentions: string | null;
  msg_intent: string | null;
  msg_thread: string | null;
};

function openDb(): boolean {
  try {
    // mode=ro — 쓰기 가능성을 URI 수준에서 닫는다 (SCHEMA §3-7).
    const handle = new Database(`file:${DB_PATH}?mode=ro`, { readonly: true });
    handle.query("SELECT 1 FROM events_v LIMIT 1").get(); // 열리는 것과 읽히는 것은 다르다
    db = handle;
    dbError = null;
    return true;
  } catch (e) {
    db = null;
    dbError = e instanceof Error ? e.message : String(e);
    return false;
  }
}

/** ISO-8601 UTC 로 정규화한다. 못 읽으면 원문을 그대로 흘리고 stderr 에 적는다. */
function iso(raw: string | number): string {
  const d = typeof raw === "number" ? new Date(raw * 1000) : new Date(raw);
  if (Number.isNaN(d.getTime())) {
    console.error(`[mushline] timestamp 파싱 실패, 원문 그대로 흘린다: ${String(raw)}`);
    return String(raw);
  }
  return d.toISOString();
}

function parseMentions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 부록 A rev4 — 위에서 아래로 첫 매치. */
function toActivity(row: Row): Activity {
  const base = { id: nextId(), ts: iso(row.timestamp), agent: row.instance };

  // 순번 1
  if (row.type === "life") {
    return { ...base, kind: "life", label: row.life_action ?? "life", detail: null };
  }

  if (row.type === "status") {
    const ctx = row.status_context ?? "";
    if (ctx.toLowerCase().startsWith("tool:")) {
      const tool = ctx.slice(5); // 원문 표기 그대로 label 에 쓴다
      const lower = tool.toLowerCase();
      // 순번 2 — 화이트리스트 비교는 대소문자 무시
      if (FILE_TOOLS.has(lower)) {
        return { ...base, kind: "file", label: tool, detail: row.status_detail ?? null };
      }
      // 순번 3
      if (lower === "bash") {
        return { ...base, kind: "cmd", label: "Bash", detail: row.status_detail ?? null };
      }
      // 순번 4
      return { ...base, kind: "tool", label: tool, detail: row.status_detail ?? null };
    }
    // 순번 5
    return { ...base, kind: "status", label: row.status_val ?? "", detail: row.status_detail ?? null };
  }

  // 순번 6 — 격리 큐 (SCHEMA §3-12). 즉시 실패로 처리하지 않는다.
  isolatedCount++;
  console.error(
    `[mushline][isolate] kind=other rows=${isolatedCount} id=${row.id} type=${row.type} instance=${row.instance} data=${row.data ?? ""}`,
  );
  return { ...base, kind: "other", label: row.type, detail: row.data ?? null };
}

function toMessage(row: Row): Message {
  const intent = row.msg_intent && INTENTS.has(row.msg_intent) ? (row.msg_intent as Message["intent"]) : null;
  return {
    id: nextId(),
    ts: iso(row.timestamp),
    from: row.msg_from ?? row.instance,
    to: parseMentions(row.msg_mentions),
    intent,
    thread: row.msg_thread ?? null,
    text: row.msg_text ?? "",
  };
}

function ingest(row: Row, push: boolean) {
  if (row.instance) {
    const at = iso(row.timestamp);
    const prev = lastEventAt.get(row.instance);
    if (!prev || prev < at) lastEventAt.set(row.instance, at);
  }
  if (row.type === "message") {
    const m = toMessage(row);
    if (push) pushMessage(m);
    else {
      messages.push(m);
      while (messages.length > MESSAGE_BUFFER_MAX) messages.shift();
    }
    return;
  }
  const a = toActivity(row);
  if (push) pushActivity(a);
  else {
    activities.push(a);
    while (activities.length > ACTIVITY_BUFFER_MAX) activities.shift();
  }
}

/**
 * 기동 직후 버퍼를 채운다. 비어 있으면 FR-11(최근 이력 N줄)이 첫 화면에서 성립하지 않는다.
 *
 * activity 는 **살아 있는 에이전트의 이력만** 싣는다. 전체 최근 200건을 실으면 실측상 발신자 22명 중
 * 살아 있는 건 2명이라, 첫 화면 대부분이 이미 끝난 에이전트의 로그였다.
 * 메시지는 보낸 쪽이나 받은 쪽(delivered_to·mentions) 중 하나라도 살아 있거나, **최근 24시간** 안이면
 * 싣는다. 살아 있는 에이전트끼리 대화가 없으면 로그 탭이 통째로 비기 때문이다.
 */
function seedBuffers(alive: Set<string>) {
  if (!db) return;
  try {
    const names = [...alive];
    const ph = names.map(() => "?").join(",");
    const inJson = (col: string) =>
      `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${col}) THEN ${col} ELSE '[]' END) WHERE value IN (${ph}))`;
    // timestamp 는 ISO 문자열(+00:00)이라 초 단위 접두 비교로 충분하다.
    const since = new Date(Date.now() - MESSAGE_SEED_WINDOW_MS).toISOString().slice(0, 19);
    const acts =
      names.length === 0
        ? []
        : (db
            .query(
              `SELECT ${ROW_COLS} FROM events_v WHERE type != 'message' AND instance IN (${ph})
               ORDER BY id DESC LIMIT ${ACTIVITY_BUFFER_MAX}`,
            )
            .all(...names) as Row[]);
    const related =
      names.length === 0
        ? ""
        : ` OR msg_from IN (${ph}) OR ${inJson("msg_delivered_to")} OR ${inJson("msg_mentions")}`;
    const msgs = db
      .query(
        `SELECT ${ROW_COLS} FROM events_v WHERE type = 'message'
           AND (timestamp >= ?${related})
         ORDER BY id DESC LIMIT ${MESSAGE_BUFFER_MAX}`,
      )
      .all(since, ...(names.length === 0 ? [] : [...names, ...names, ...names])) as Row[];
    for (const r of [...acts, ...msgs].sort((a, b) => a.id - b.id)) ingest(r, false);
    const max = db.query("SELECT MAX(id) AS m FROM events_v").get() as { m: number | null };
    lastRowId = max?.m ?? 0;
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }
}

function pollDb() {
  if (!db && !openDb()) {
    recomputeHealth();
    return;
  }
  try {
    const rows = db!
      .query(`SELECT ${ROW_COLS} FROM events_v WHERE id > ? ORDER BY id LIMIT 500`)
      .all(lastRowId) as Row[];
    for (const r of rows) {
      lastRowId = Math.max(lastRowId, r.id);
      ingest(r, true);
    }
    dbError = null;
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
    try {
      db?.close();
    } catch {}
    db = null; // 다음 틱에 재개방을 시도한다
  }
  recomputeHealth();
}

// ── 에이전트 (hcom list --json, 실패 시 DB instances 폴백) ──────────────────
function normStatus(s: unknown): AgentStatus {
  return typeof s === "string" && AGENT_STATUSES.has(s) ? (s as AgentStatus) : "unknown";
}
/** null 과 "" 를 구분한다 (SCHEMA §3-6). undefined 만 null 로 접는다. */
function nullable(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

async function runCli(
  args: string[],
  timeoutMs = CLI_TIMEOUT_MS,
  bin = HCOM_BIN,
  env?: Record<string, string | undefined>,
) {
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(env !== undefined ? { env } : {}),
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * M4 fix: 포커스 4단계 전용 cmux 실행. 호출자 셸의 CMUX_* 범위 env
 * (CMUX_WORKSPACE_ID/SURFACE_ID/PANEL_ID)를 제거하고 실행해 서버를 띄운
 * 창 문맥에 의존하지 않는다. tree/workspace-group 조회는 호출자 창 범위가
 * 결과 자체라(M3 동작 보존) 기존 env를 유지하고, 포커스 4단계에만 적용한다.
 */
function strippedCmuxEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CMUX_WORKSPACE_ID;
  delete env.CMUX_SURFACE_ID;
  delete env.CMUX_PANEL_ID;
  return env;
}

async function runCmuxFocusStep(args: string[]) {
  return runCli(args, CLI_TIMEOUT_MS, CMUX_BIN, strippedCmuxEnv());
}

/**
 * Agent.lastEventAt 은 **DB 이벤트에서만** 온다. 이벤트가 없으면 null 이다.
 *
 * 처음에는 `hcom list --json` 의 `status_age_seconds` 로 역산했는데, 그 값이 매 폴링마다
 * 흔들려 **변화가 없는데도 snapshot 이 계속 나갔다**(실측: 22초에 6건 중 3건이 이 흔들림).
 * 역산값은 "마지막 행동 시각"이 아니라 "지금으로부터 얼마 전"의 재구성이므로, 모르면
 * 지어내지 않고 null 을 낸다 (SCHEMA §3-6).
 */
function deriveLastEventAt(name: string): string | null {
  return lastEventAt.get(name) ?? null;
}

/**
 * cmux workspace UUID → 소속 그룹 이름, 그리고 각 워크스페이스의
 * panes[].surfaces[].id (surface UUID) → 소속 그룹 이름. hcom cmuxtab 프리셋으로
 * 뜬 에이전트의 `launch_context.pane_id` 는 workspace UUID 가 아니라 surface UUID다(실측).
 * 그룹 목록은 워크스페이스를 ref(`workspace:N`)로만 주므로 `tree` 의 UUID↔ref 로 잇는다.
 * 같은 surface UUID 가 서로 다른 그룹의 워크스페이스에 나오면 공유 dock 으로 보고
 * 맵에서 제외한다. 같은 그룹 안에서의 중복은 유지한다.
 * 워크스페이스 제목은 쓰지 않는다 — 에이전트 상태에 따라 계속 바뀐다.
 * cmux 는 선택 의존이라 없거나 실패하면 빈 맵이고 health 에 넣지 않는다.
 * 덤으로 tree 안의 surface·workspace id 집합도 같이 낸다(R6 focusable 근거).
 */
/** cmux tree 1회 읽기의 결과. focusable(R6)과 /focus 해석(R2)이 함께 쓴다. */
interface CmuxSnap {
  groups: Map<string, string>;
  surfaces: Set<string>;
  workspaces: Set<string>;
}

/** /focus 해석용. 이름 → launch_context.pane_id. pollAgents 가 전량 갱신한다. */
let agentPaneIds = new Map<string, string | null>();

async function cmuxSnapshot(): Promise<CmuxSnap> {
  const out = new Map<string, string>();
  const surfaces = new Set<string>();
  const workspaces = new Set<string>();
  const snap = (): CmuxSnap => ({ groups: out, surfaces, workspaces });
  try {
    const [treeRes, groupRes] = await Promise.all([
      runCli(["--id-format", "both", "tree", "--all", "--json"], CLI_TIMEOUT_MS, CMUX_BIN),
      runCli(["workspace-group", "list", "--json"], CLI_TIMEOUT_MS, CMUX_BIN),
    ]);
    if (treeRes.code !== 0 || groupRes.code !== 0) return snap();
    const tree = JSON.parse(treeRes.stdout) as { windows?: Array<{ workspaces?: Array<Record<string, unknown>> }> };
    const idOfRef = new Map<string, string>();
    const wsById = new Map<string, Record<string, unknown>>();
    for (const win of tree.windows ?? []) {
      for (const ws of win.workspaces ?? []) {
        const id = nullable(ws.id), ref = nullable(ws.ref);
        if (id && ref) idOfRef.set(ref, id);
        if (id) {
          wsById.set(id, ws);
          workspaces.add(id);
        }
        if (ws && Array.isArray(ws.panes)) {
          for (const pane of ws.panes as Array<Record<string, unknown>>) {
            if (!pane || !Array.isArray(pane.surfaces)) continue;
            for (const s of pane.surfaces as Array<Record<string, unknown>>) {
              const sid = nullable(s.id);
              if (sid) surfaces.add(sid);
            }
          }
        }
      }
    }
    const groups = JSON.parse(groupRes.stdout) as { groups?: Array<Record<string, unknown>> };
    const wsGroup = new Map<string, string>();
    for (const g of groups.groups ?? []) {
      const name = nullable(g.name);
      if (!name || !Array.isArray(g.member_workspace_refs)) continue;
      for (const ref of g.member_workspace_refs) {
        const id = typeof ref === "string" ? idOfRef.get(ref) : undefined;
        if (id) {
          out.set(id, name);
          wsGroup.set(id, name);
        }
      }
    }
    const surfaceGroups = new Map<string, Set<string>>();
    for (const [wsId, name] of wsGroup) {
      const ws = wsById.get(wsId);
      if (!ws || !Array.isArray(ws.panes)) continue;
      for (const pane of ws.panes as Array<Record<string, unknown>>) {
        if (!pane || !Array.isArray(pane.surfaces)) continue;
        for (const s of pane.surfaces as Array<Record<string, unknown>>) {
          const sid = nullable(s.id);
          if (!sid) continue;
          let owners = surfaceGroups.get(sid);
          if (!owners) {
            owners = new Set<string>();
            surfaceGroups.set(sid, owners);
          }
          owners.add(name);
        }
      }
    }
    for (const [sid, owners] of surfaceGroups) {
      if (owners.size === 1) {
        for (const name of owners) out.set(sid, name);
      } else {
        out.delete(sid);
      }
    }
  } catch {}
  return snap();
}

const HOME = homedir();
/** 표시용 경로. 홈은 ~ 로 줄인다. */
function shortPath(dir: string): string {
  return dir === HOME || dir.startsWith(HOME + "/") ? "~" + dir.slice(HOME.length) : dir;
}

function launchPaneId(raw: unknown): string | null {
  let ctx = raw;
  if (typeof ctx === "string") {
    try {
      ctx = JSON.parse(ctx);
    } catch {
      return null;
    }
  }
  return ctx && typeof ctx === "object" ? nullable((ctx as Record<string, unknown>).pane_id) : null;
}

/** cmux 그룹 우선, 없으면 directory 경로. 둘 다 없으면 미분류(null). */
function resolveWorkspace(paneId: string | null, directory: string | null, groups: Map<string, string>) {
  const group = paneId ? groups.get(paneId) : undefined;
  if (group) return { workspace: `cgroup:${group}`, workspaceLabel: group };
  if (directory) return { workspace: `dir:${directory}`, workspaceLabel: shortPath(directory) };
  return { workspace: null, workspaceLabel: null };
}

/** R6. pane_id 가 직전 poll 의 tree 에 surface 또는 workspace 로 있으면 true. */
function isFocusable(paneId: string | null, cmux: CmuxSnap): boolean {
  return paneId !== null && (cmux.surfaces.has(paneId) || cmux.workspaces.has(paneId));
}

function agentsFromCli(raw: unknown[], cmux: CmuxSnap): Agent[] {
  const paneIds = new Map<string, string | null>();
  const list = raw.map((r) => {
    const a = r as Record<string, unknown>;
    // 키는 base_name 이다. events_v.instance 와 같은 값이라야 Activity.agent 가 Agent.name 을 가리킨다.
    const name = (nullable(a.base_name) ?? nullable(a.name) ?? "").trim();
    const pid = launchPaneId(a.launch_context);
    if (name.length > 0) paneIds.set(name, pid);
    return {
      name,
      tag: nullable(a.tag),
      tool: nullable(a.tool),
      status: normStatus(a.status),
      statusContext: nullable(a.status_context),
      statusDetail: nullable(a.status_detail),
      description: nullable(a.description),
      directory: nullable(a.directory),
      ...resolveWorkspace(pid, nullable(a.directory), cmux.groups),
      unreadCount: typeof a.unread_count === "number" ? a.unread_count : 0,
      lastEventAt: deriveLastEventAt(name),
      focusable: isFocusable(pid, cmux),
    };
  }).filter((a) => a.name.length > 0);
  agentPaneIds = paneIds;
  return list;
}

function agentsFromDb(cmux: CmuxSnap): Agent[] {
  if (!db) return [];
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .query("SELECT name, tag, tool, status, status_context, status_detail, directory, launch_context FROM instances")
      .all() as Array<Record<string, unknown>>;
  } catch {
    // 구스키마 DB(fixtures/hcom-min.sql 원형)에는 launch_context 가 없다 — 나머지 컬럼만 읽는다.
    rows = db
      .query("SELECT name, tag, tool, status, status_context, status_detail, directory FROM instances")
      .all() as Array<Record<string, unknown>>;
  }
  const paneIds = new Map<string, string | null>();
  const list = rows.map((r) => {
    const name = String(r.name ?? "");
    const pid = launchPaneId(r.launch_context);
    if (name.length > 0) paneIds.set(name, pid);
    return {
      name,
      tag: nullable(r.tag),
      tool: nullable(r.tool),
      status: normStatus(r.status),
      statusContext: nullable(r.status_context),
      statusDetail: nullable(r.status_detail),
      description: null, // instances 에는 없다. 모르면 null 이고 지어내지 않는다.
      directory: nullable(r.directory),
      ...resolveWorkspace(pid, nullable(r.directory), cmux.groups),
      unreadCount: 0,
      lastEventAt: deriveLastEventAt(name),
      focusable: isFocusable(pid, cmux),
    };
  }).filter((a) => a.name.length > 0);
  agentPaneIds = paneIds;
  return list;
}

async function pollAgents() {
  let next: Agent[] | null = null;
  const cmux = await cmuxSnapshot();
  try {
    const { stdout, stderr, code } = await runCli(["list", "--json"]);
    if (code !== 0) throw new Error(`${HCOM_BIN} list --json exit=${code} ${stderr.trim()}`);
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error("hcom list --json 이 배열이 아니다");
    next = agentsFromCli(parsed, cmux);
    cliError = null;
  } catch (e) {
    cliError = e instanceof Error ? e.message : String(e);
    // CLI 가 죽어도 화면을 비우지 않는다. 다만 health.ok 는 false 로 남아 배너가 뜬다.
    // DB 폴백도 실패하면 예외를 밖으로 내지 않고 기존 agents 를 유지한다.
    if (db) {
      try {
        next = agentsFromDb(cmux);
      } catch (fallbackError) {
        const reason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        cliError = `${cliError} / db fallback: ${reason}`;
        next = agents;
      }
    } else {
      next = agents;
    }
  }

  const key = JSON.stringify(next);
  if (key !== agentsKey) {
    agentsKey = key;
    agents = next ?? [];
    broadcast("snapshot", snapshotPayload());
  }
  recomputeHealth();
}

// ── POST /focus (M4: 카드 이름 클릭 → cmux 터미널 포커스) ───────────────────
// 읽기 전용 원칙의 예외는 cmux UI 포커스뿐이다. hcom DB 에는 쓰지 않는다.
// cmux 에 순수 surface 선택 명령은 없다(0.64.25 기준). reorder-surface 의 no-op
// 용법(--focus true, 위치 지정은 index 가 아니라 이웃 id)으로 선택한다.
const FOCUS_BODY_MAX = 1024; // R4(e). 바이트 기준.
const FOCUS_WAIT_MS = 10_000; // R5. 뮤텍스 대기 상한. 초과 시 503 busy.

/** R5. /focus 직렬화용 줄. 절대 reject 되지 않는다(release 호출로만 해소). */
let focusTail: Promise<void> = Promise.resolve();

/** 줄을 서서 차례를 기다린다. 대기 상한을 넘기면 줄에서 빠져 null 을 낸다. */
function acquireFocusSlot(waitMs: number): Promise<(() => void) | null> {
  let release!: () => void;
  const turn = new Promise<void>((res) => {
    release = res;
  });
  const prev = focusTail;
  focusTail = prev.then(() => turn);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((res) => {
    timer = setTimeout(() => res(null), waitMs);
  });
  return Promise.race([
    prev.then(() => {
      if (timer !== undefined) clearTimeout(timer);
      return release;
    }),
    timeout,
  ]).then((v) => {
    if (v === null) release(); // 차례가 와도 쓰지 않으므로 줄을 비운다
    return v;
  });
}

/** 본문을 상한까지만 읽는다. 초과하면 null. */
async function readCappedBody(req: Request, limit: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {}
        return null;
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

interface SurfaceHit {
  win: string;
  ws: string;
  pane: string;
  /** 그 pane 의 surface id 순서(pre-tree 비교 기준). 같은 배열 참조를 공유한다. */
  ids: string[];
  selected: boolean;
}
interface WsHit {
  win: string;
  selected: boolean;
  /** 그 workspace 의 focused pane. 없으면( pane 0개 포함) null. */
  pane: string | null;
}
interface FocusIndex {
  surfaces: Map<string, SurfaceHit>;
  workspaces: Map<string, WsHit>;
  panes: Map<string, string[]>;
  active: { window: string; workspace: string; pane: string; surface: string } | null;
}

/** tree 1회 읽기. cmux 부재·실패·파싱 실패는 null. */
async function readFocusTree(): Promise<FocusIndex | null> {
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await runCli(["--id-format", "both", "tree", "--all", "--json"], CLI_TIMEOUT_MS, CMUX_BIN);
  } catch {
    return null; // CMUX_BIN 미존재(Bun.spawn throw) → no_cmux 경로로 합류 (R5)
  }
  if (res.code !== 0) return null;
  try {
    const tree = JSON.parse(res.stdout) as Record<string, unknown>;
    const surfaces = new Map<string, SurfaceHit>();
    const workspaces = new Map<string, WsHit>();
    const panes = new Map<string, string[]>();
    const wins = Array.isArray(tree.windows) ? (tree.windows as Array<Record<string, unknown>>) : [];
    for (const w of wins) {
      const winId = nullable(w.id);
      if (!winId) continue;
      const wss = Array.isArray(w.workspaces) ? (w.workspaces as Array<Record<string, unknown>>) : [];
      for (const ws of wss) {
        const wsId = nullable(ws.id);
        if (!wsId) continue;
        let focusedPane: string | null = null;
        const ps = Array.isArray(ws.panes) ? (ws.panes as Array<Record<string, unknown>>) : [];
        for (const p of ps) {
          const paneId = nullable(p.id);
          if (!paneId) continue;
          if (p.focused === true && focusedPane === null) focusedPane = paneId;
          const ss = Array.isArray(p.surfaces) ? (p.surfaces as Array<Record<string, unknown>>) : [];
          const ids: string[] = [];
          for (const s of ss) {
            const sid = nullable(s.id);
            if (!sid) continue;
            ids.push(sid);
            surfaces.set(sid, { win: winId, ws: wsId, pane: paneId, ids, selected: s.selected === true });
          }
          panes.set(paneId, ids);
        }
        workspaces.set(wsId, { win: winId, selected: ws.selected === true, pane: focusedPane });
      }
    }
    let active: FocusIndex["active"] = null;
    const raw = tree.active as Record<string, unknown> | null | undefined;
    if (raw && typeof raw === "object") {
      const window = nullable(raw.window_id), workspace = nullable(raw.workspace_id);
      const pane = nullable(raw.pane_id), surface = nullable(raw.surface_id);
      if (window && workspace && pane && surface) active = { window, workspace, pane, surface };
    }
    return { surfaces, workspaces, panes, active };
  } catch {
    return null;
  }
}

function sameIdSeq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 서버 메모리 agents 에 이름이 있으면 pane_id, 없으면 undefined. */
function lookupPaneId(name: string): string | null | undefined {
  if (!agents.some((a) => a.name === name)) return undefined;
  return agentPaneIds.get(name) ?? null;
}

async function handleFocus(req: Request): Promise<Response> {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // R4(a). Host 검사. 누락(HTTP/1.0 무Host 포함)도 거부.
  const host = req.headers.get("host");
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) {
    return json({ ok: false, reason: "forbidden" }, 403);
  }
  // R4(b). POST 만. 그 외 405 + Allow.
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, reason: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", Allow: "POST" },
    });
  }
  // R4(c). essence(대소문자 무시, `;` 이후 무시)가 application/json.
  const essence = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (essence !== "application/json") {
    return json({ ok: false, reason: "unsupported_media_type" }, 415);
  }
  // R4(d). Origin 이 있으면 자기 origin 만. 없고 Sec-Fetch-Site 가 cross-site 면 거부.
  // 둘 다 없으면 허용 — JSON POST 에 Origin 을 보내는 현대 브라우저를 가정하고
  // both-missing 은 로컬 curl 디버깅용이다(로컬 프로세스 남용은 threat model 밖).
  const origin = req.headers.get("origin");
  if (origin !== null) {
    if (origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) {
      return json({ ok: false, reason: "forbidden" }, 403);
    }
  } else {
    const sfs = req.headers.get("sec-fetch-site");
    if (sfs !== null && sfs.toLowerCase() === "cross-site") {
      return json({ ok: false, reason: "forbidden" }, 403);
    }
  }
  // R4(e). Content-Length 선검사 + 상한까지만 읽기. 바이트 기준.
  const cl = req.headers.get("content-length");
  if (cl !== null && cl !== "" && (!/^\d+$/.test(cl.trim()) || Number(cl) > FOCUS_BODY_MAX)) {
    return json({ ok: false, reason: "body_too_large" }, 413);
  }
  const rawBody = await readCappedBody(req, FOCUS_BODY_MAX);
  if (rawBody === null) return json({ ok: false, reason: "body_too_large" }, 413);
  // R4(f). 파싱 실패 또는 name 비문자열 → 400.
  let name: unknown;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
    name =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).name
        : undefined;
  } catch {
    return json({ ok: false, reason: "bad_json" }, 400);
  }
  if (typeof name !== "string") return json({ ok: false, reason: "bad_json" }, 400);

  // R5. 동시 요청은 대기-큐로 직렬화. 10초 초과 시 503 busy.
  const slot = await acquireFocusSlot(FOCUS_WAIT_MS);
  if (!slot) return json({ ok: false, reason: "busy" }, 503);
  try {
    return await runFocusForName(name, json);
  } catch (e) {
    console.error(`[mushline] /focus 내부 오류: ${e instanceof Error ? e.message : String(e)}`);
    return json({ ok: false, reason: "internal" }, 200);
  } finally {
    slot();
  }
}

async function runFocusForName(
  name: string,
  json: (body: unknown, status: number) => Response,
): Promise<Response> {
  // R2. 해석은 서버가 한다. 매핑 실패 시 pollAgents 1회 즉시 재수행 후 1회만 재시도.
  let paneId = lookupPaneId(name);
  if (paneId === undefined || paneId === null) {
    await pollAgents();
    paneId = lookupPaneId(name);
  }
  // R4(g). 재시도 후에도 없으면 404.
  if (paneId === undefined) return json({ ok: false, reason: "unknown_agent" }, 404);
  if (paneId === null) return json({ ok: false, reason: "not_in_cmux" }, 200);

  // R4(h). cmux 인자는 아래 pre-tree 에서 얻은 값만 쓴다. 요청 문자열은 인자로 쓰지 않는다.
  const pre = await readFocusTree();
  if (!pre) return json({ ok: false, reason: "no_cmux" }, 200);
  const surf = pre.surfaces.get(paneId);
  const wsHit = surf === undefined ? pre.workspaces.get(paneId) : undefined;
  if (surf === undefined && wsHit === undefined) return json({ ok: false, reason: "not_in_cmux" }, 200);

  let win: string;
  let ws: string;
  let pane: string;
  let targetSurface: string | null = null;
  let surfIds: string[] | null = null;
  if (surf !== undefined) {
    win = surf.win;
    ws = surf.ws;
    pane = surf.pane;
    targetSurface = paneId;
    surfIds = surf.ids;
  } else {
    win = wsHit!.win;
    ws = paneId;
    if (wsHit!.pane === null) return json({ ok: false, reason: "not_in_cmux" }, 200);
    pane = wsHit!.pane;
  }

  // R3 fast-path. surface 경로이고 pre-tree 의 active 경로(window/workspace/pane/
  // surface)가 대상과 모두 같으면 cmux 명령 0건으로 ok. workspace 경로는 pane 에
  // surface 가 1개여도 선택 단계가 멱등이라 항상 실행한다(V5: 각 1회 + reorder 0건).
  const act = pre.active;
  if (
    targetSurface !== null &&
    act &&
    act.window === win &&
    act.workspace === ws &&
    act.pane === pane &&
    act.surface === targetSurface
  ) {
    return json({ ok: true, reason: null }, 200);
  }

  // R3 실행. 순서: focus-window → select-workspace → focus-pane → reorder-surface.
  // reorder 는 surface 경로이고 그 pane 에 surface 가 2개 이상일 때만. 위치 지정은
  // index 가 아니라 이웃 id(바로 앞 있으면 --after, 없으면 --before).
  const steps: Array<{ stage: string; args: string[] }> = [
    { stage: "focus-window", args: ["focus-window", "--window", win] },
    { stage: "select-workspace", args: ["select-workspace", "--workspace", ws, "--window", win] },
    { stage: "focus-pane", args: ["focus-pane", "--pane", pane, "--workspace", ws, "--window", win] },
  ];
  if (targetSurface !== null && surfIds !== null && surfIds.length >= 2) {
    const idx = surfIds.indexOf(targetSurface);
    if (idx > 0) {
      steps.push({
        stage: "reorder-surface",
        args: ["reorder-surface", "--surface", targetSurface, "--after", surfIds[idx - 1]!, "--focus", "true", "--workspace", ws, "--window", win],
      });
    } else if (idx === 0) {
      steps.push({
        stage: "reorder-surface",
        args: ["reorder-surface", "--surface", targetSurface, "--before", surfIds[1]!, "--focus", "true", "--workspace", ws, "--window", win],
      });
    }
  }
  for (const s of steps) {
    const r = await runCmuxFocusStep(s.args);
    if (r.code !== 0) return json({ ok: false, reason: `step:${s.stage}` }, 200);
  }

  // R3 post-tree 재조회. 되돌리기는 하지 않는다.
  const post = await readFocusTree();
  if (!post) return json({ ok: false, reason: "no_cmux" }, 200);
  if (targetSurface !== null) {
    const hit = post.surfaces.get(targetSurface);
    if (!hit || hit.pane !== pane || !hit.selected) {
      return json({ ok: false, reason: "not_selected" }, 200);
    }
    if (!sameIdSeq(pre.panes.get(pane) ?? [], post.panes.get(pane) ?? [])) {
      return json({ ok: false, reason: "order_changed" }, 200);
    }
    return json({ ok: true, reason: null }, 200);
  }
  const whit = post.workspaces.get(ws);
  if (!whit || !whit.selected) return json({ ok: false, reason: "not_selected" }, 200);
  if (!sameIdSeq(pre.panes.get(pane) ?? [], post.panes.get(pane) ?? [])) {
    return json({ ok: false, reason: "order_changed" }, 200);
  }
  return json({ ok: true, reason: null }, 200);
}

// ── /version (PRD §6-3 증거 binding의 한쪽 출처) ────────────────────────────
async function gitCommit(): Promise<string> {
  try {
    const head = Bun.spawnSync(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"]);
    if (head.exitCode !== 0) return "unknown";
    const hash = head.stdout.toString().trim();
    const dirty = Bun.spawnSync(["git", "-C", REPO_ROOT, "status", "--porcelain"]);
    const isDirty = dirty.exitCode === 0 && dirty.stdout.toString().trim().length > 0;
    return isDirty ? `${hash}-dirty` : hash;
  } catch {
    return "unknown";
  }
}

// ── /term/:name ─────────────────────────────────────────────────────────────
async function termResponse(name: string, n: number): Promise<Response> {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  let out: { stdout: string; stderr: string; code: number };
  try {
    out = await runCli(["term", name, "--json"]);
  } catch (e) {
    return json({ error: "unavailable", reason: e instanceof Error ? e.message : String(e) }, 503);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    // hcom 은 없는 에이전트에도 평문을 낸다. JSON 이 아니면 그 평문이 사유다.
    const reason = (out.stdout + out.stderr).trim() || `exit=${out.code}`;
    const notFound = /no inject port|not running|unknown|not found/i.test(reason);
    return json({ error: notFound ? "not_found" : "unavailable", reason }, notFound ? 404 : 503);
  }

  const allLines = Array.isArray(parsed.lines) ? parsed.lines.map((l) => String(l)) : [];
  const size = Array.isArray(parsed.size) ? parsed.size : [];
  const lines = allLines.slice(-n);
  return json(
    {
      name,
      rows: typeof size[0] === "number" ? size[0] : lines.length,
      cols: typeof size[1] === "number" ? size[1] : 0,
      lines,
      truncated: lines.length < allLines.length,
    },
    200,
  );
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function eventsResponse(): Response {
  let self: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      self = ctl;
      clients.add(ctl);
      // SCHEMA §1 — 연결 직후 snapshot 1건. 클라이언트는 별도 요청을 하지 않는다.
      send(ctl, "snapshot", snapshotPayload());
      send(ctl, "health", healthPayload());
      // 버퍼 재생. 재연결한 클라이언트는 id 로 중복을 배제한다 (SCHEMA §3-4).
      const backlog = [
        ...activities.map((a) => ["activity", a] as const),
        ...messages.map((m) => ["message", m] as const),
      ].sort((x, y) => seqOf(x[1].id) - seqOf(y[1].id));
      for (const [event, payload] of backlog) send(ctl, event, { v: SCHEMA_V, ...payload });
    },
    cancel() {
      clients.delete(self);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function handle(req: Request): Promise<Response> {
  // URL 파싱 실패(Host 없는 HTTP/1.0 포함)는 게이트 이전에 닫는다. R4(a).
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return new Response(JSON.stringify({ ok: false, reason: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  const path = url.pathname;

  if (path === "/events") return eventsResponse();

  if (path === "/version") {
    const body = {
      commit: await gitCommit(),
      schemaV: SCHEMA_V,
      minClientV: MIN_CLIENT_V,
      startedAt,
    };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  if (path.startsWith("/term/")) {
    const name = decodeURIComponent(path.slice("/term/".length));
    if (!name) {
      return new Response(JSON.stringify({ error: "not_found", reason: "에이전트 이름이 비었다" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const raw = Number(url.searchParams.get("n") ?? 20);
    const n = Math.min(200, Math.max(1, Number.isFinite(raw) ? Math.trunc(raw) : 20));
    return termResponse(name, n);
  }

  if (path === "/focus") return handleFocus(req);

  if (path === "/") {
    const file = Bun.file(UI_PATH);
    if (!(await file.exists())) {
      // ui.html 은 W2 소유다. 없다고 서버가 죽지 않고, 없다는 사실을 그대로 말한다.
      return new Response(`src/ui.html 이 없다 (W2 소유). 경로: ${UI_PATH}`, {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(file, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  return new Response("not found", { status: 404 });
}

// ── 기동 ────────────────────────────────────────────────────────────────────
openDb();
// seed 전에 에이전트를 먼저 받아 "살아 있는" 집합을 만든다. instances 이름을 합치는 것은
// --db-path 로 사본·픽스처를 볼 때 CLI 목록(실제 hcom)과 DB 가 다르기 때문이다.
await pollAgents();
const alive = new Set(agents.map((a) => a.name));
try {
  for (const r of (db?.query("SELECT name FROM instances").all() ?? []) as Array<{ name: unknown }>) {
    if (typeof r.name === "string" && r.name) alive.add(r.name);
  }
} catch {}
seedBuffers(alive);
recomputeHealth();

try {
  Bun.serve({ hostname: HOST, port: PORT, fetch: handle, idleTimeout: 0 });
} catch (e) {
  const reason = e instanceof Error ? e.message : String(e);
  // PRD §8 / FR-6 — 다른 포트를 찾지 않는다. 사유를 stderr 에 적고 비정상 종료한다.
  console.error(`[mushline] ${HOST}:${PORT} 바인딩 실패 — 포트 탐색을 하지 않는다. 사유: ${reason}`);
  process.exit(1);
}

setInterval(pollDb, POLL_MS);
setInterval(() => void pollAgents(), AGENT_POLL_MS);
setInterval(() => broadcast("heartbeat", { v: SCHEMA_V, ts: new Date().toISOString() }), HEARTBEAT_MS);

console.error(
  `[mushline] http://${HOST}:${PORT}  db=${DB_PATH}  hcom=${HCOM_BIN}  startedAt=${startedAt}`,
);
