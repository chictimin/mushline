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
  status: AgentStatus;
  statusContext: string | null;
  statusDetail: string | null;
  description: string | null;
  directory: string | null;
  unreadCount: number;
  lastEventAt: string | null;
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

/** 기동 직후 버퍼를 채운다. 비어 있으면 FR-11(최근 이력 N줄)이 첫 화면에서 성립하지 않는다. */
function seedBuffers() {
  if (!db) return;
  try {
    const acts = db
      .query(`SELECT ${ROW_COLS} FROM events_v WHERE type != 'message' ORDER BY id DESC LIMIT ${ACTIVITY_BUFFER_MAX}`)
      .all() as Row[];
    const msgs = db
      .query(`SELECT ${ROW_COLS} FROM events_v WHERE type = 'message' ORDER BY id DESC LIMIT ${MESSAGE_BUFFER_MAX}`)
      .all() as Row[];
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

async function runCli(args: string[], timeoutMs = CLI_TIMEOUT_MS) {
  const proc = Bun.spawn([HCOM_BIN, ...args], { stdout: "pipe", stderr: "pipe" });
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

function agentsFromCli(raw: unknown[]): Agent[] {
  return raw.map((r) => {
    const a = r as Record<string, unknown>;
    // 키는 base_name 이다. events_v.instance 와 같은 값이라야 Activity.agent 가 Agent.name 을 가리킨다.
    const name = (nullable(a.base_name) ?? nullable(a.name) ?? "").trim();
    return {
      name,
      status: normStatus(a.status),
      statusContext: nullable(a.status_context),
      statusDetail: nullable(a.status_detail),
      description: nullable(a.description),
      directory: nullable(a.directory),
      unreadCount: typeof a.unread_count === "number" ? a.unread_count : 0,
      lastEventAt: deriveLastEventAt(name),
    };
  }).filter((a) => a.name.length > 0);
}

function agentsFromDb(): Agent[] {
  if (!db) return [];
  const rows = db
    .query("SELECT name, status, status_context, status_detail, directory FROM instances")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const name = String(r.name ?? "");
    return {
      name,
      status: normStatus(r.status),
      statusContext: nullable(r.status_context),
      statusDetail: nullable(r.status_detail),
      description: null, // instances 에는 없다. 모르면 null 이고 지어내지 않는다.
      directory: nullable(r.directory),
      unreadCount: 0,
      lastEventAt: deriveLastEventAt(name),
    };
  }).filter((a) => a.name.length > 0);
}

async function pollAgents() {
  let next: Agent[] | null = null;
  try {
    const { stdout, stderr, code } = await runCli(["list", "--json"]);
    if (code !== 0) throw new Error(`${HCOM_BIN} list --json exit=${code} ${stderr.trim()}`);
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error("hcom list --json 이 배열이 아니다");
    next = agentsFromCli(parsed);
    cliError = null;
  } catch (e) {
    cliError = e instanceof Error ? e.message : String(e);
    // CLI 가 죽어도 화면을 비우지 않는다. 다만 health.ok 는 false 로 남아 배너가 뜬다.
    next = db ? agentsFromDb() : agents;
  }

  const key = JSON.stringify(next);
  if (key !== agentsKey) {
    agentsKey = key;
    agents = next ?? [];
    broadcast("snapshot", snapshotPayload());
  }
  recomputeHealth();
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
  const url = new URL(req.url);
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
seedBuffers();
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
void pollAgents();

console.error(
  `[mushline] http://${HOST}:${PORT}  db=${DB_PATH}  hcom=${HCOM_BIN}  startedAt=${startedAt}`,
);
