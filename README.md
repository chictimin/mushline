# mushline

A read-only monitoring board for parallel AI agents, meant to stay docked in a narrow (277px) sidebar.
Top: message stream. Bottom: agent status. Single process (Bun + SSE), no build, zero dependencies.

![mushline screenshot](assets/screenshot.png)

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- [hcom](https://github.com/aannoo/hcom) — the multi-agent communication layer mushline reads from.
  Install first:

```bash
brew install aannoo/hcom/hcom
```

## Install & run

```bash
git clone https://github.com/chictimin/mushline.git
cd mushline
bun run src/server.ts
open http://127.0.0.1:7377
```

The server polls the local hcom state (`~/.hcom/hcom.db`, read-only) and the `hcom` CLI.
Without hcom, use the demo below for a screen-only check.

### Demo without hcom

```bash
sqlite3 /tmp/mushline-fixture.db < fixtures/hcom-min.sql
bun run src/server.ts --db-path /tmp/mushline-fixture.db
```

| Flag / env | Default | Purpose |
|---|---|---|
| `--db-path` / `HCOM_DB` | `~/.hcom/hcom.db` | Point at a database copy |
| `HCOM_BIN` | `hcom` | Path to the hcom CLI |
| `CMUX_BIN` | `cmux` | Optional. Groups agents by cmux workspace group; falls back to directory |

## Startup history

On launch mushline seeds its buffers from the hcom DB instead of replaying everything:

- **Activity** (Timeline tab, per-agent history): only agents that are currently alive, newest 200.
- **Messages** (Log tab): any message that involves a live agent (sender, `delivered_to` or mentions)
  **or** was sent within the last 24 hours, newest 200.

Events that arrive after startup are streamed as usual. Rendering is batched to one pass per frame,
so the initial backlog no longer triggers a full re-render per event.

## Workspace group filter

The select next to the **Agents** header narrows the whole board to one group:
the agent list, the Log tab and the Timeline tab all follow it. The choice is remembered per browser.

- Agents launched in a **cmux workspace group** are grouped by that group's name
  (hcom's `launch_context.pane_id` is the cmux workspace UUID).
- Agents outside a cmux group, or not running in cmux, are grouped by their working directory.
- Each agent card shows its working directory (`~`-shortened).
- A message is shown when its sender or any recipient is in the selected group.
  Broadcasts (no recipients) are shown in every group.
- Agents whose group is unknown (e.g. history from before mushline started) appear only under **All**.

cmux is optional. Without it, grouping falls back to directories and nothing else changes.

## Notes

- **Read-only.** Never writes to `~/.hcom/hcom.db`. Test against a copy, not the live DB.
- **Fixed port.** `http://127.0.0.1:7377`, no auto-discovery — exits if occupied.
- License: MIT.

## Changelog

### 2026-09-29

- Startup seeding limited to live agents (activity) and live-agent-or-last-24h (messages).
- Workspace group filter in the Agents header — cmux workspace groups, directory fallback.
  Applies to agents, Log and Timeline. Agent cards show the working directory.
- Render batching: backlog replay and live events re-render at most once per frame.
- New optional env `CMUX_BIN`.
