# mushline

A **read-only monitoring board for parallel agents**, meant to stay docked in a narrow (277px) sidebar.
Top: hcom message stream. Bottom: agent status.

## Requirements

- Bun ≥ 1.3
- hcom CLI + `~/.hcom/hcom.db` (currently the only data source, hcom-only).
  Without hcom, use the Demo(fixtures) below for a screen-only check.

## Run

```
bun run src/server.ts
```

### Demo without hcom (fixtures)

```bash
sqlite3 /tmp/mushline-fixture.db < fixtures/hcom-min.sql
bun run src/server.ts --db-path /tmp/mushline-fixture.db
# or in the browser: ?fixture=fixtures/oracle-set.json
```

- `http://127.0.0.1:7377` fixed. **No port auto-discovery** — exits immediately if occupied.
- **No build · zero dependencies · single entrypoint.** Needing `bun install` is itself a defect.

### Injection interface (precondition for acceptance)

| Name | Default | Purpose |
|---|---|---|
| `--db-path` / `HCOM_DB` | `~/.hcom/hcom.db` | O-4 measurement, O-8 ① |
| `HCOM_BIN` | `hcom` | O-8 ② (CLI failure-path injection) |

Not a convenience feature. Without it, O-4·O-8 cannot be measured.

## Docs live elsewhere

The canonical PRD and boundary schema live in a private Obsidian vault (`Projects/mushline/`) and are **not duplicated** in this repo.

| Doc | Role |
|---|---|
| `PRD-mushline` | Requirements (FR-1~21), acceptance criteria (O-1~10), milestones |
| `SCHEMA-mushline-boundary` | **The only contract between W1 (server) and W2 (frontend).** Types, invariants, ownership, `kind` mapping |

To change the schema, **edit the vault doc first**, then the code. Code-first changes are defects.

## File ownership

| Path | Owner | Role |
|---|---|---|
| `src/server.ts` | **W1** | Entrypoint. HTTP·SSE·polling·buffer·`/version`·`/term` |
| `src/ui.html` | **W2** | Screen. Inline CSS·JS, served by the server |
| `fixtures/*` | shared | Created by W1, consumed by both |

Do not edit the other owner's file. If it needs changing, **request a vault doc change**.

## The hcom DB is read-only

**Never write to** `~/.hcom/hcom.db`. Test injection goes to a copy, not the live DB (`fixtures/hcom-min.sql`).
Corrupting the hcom DB loses every session.
