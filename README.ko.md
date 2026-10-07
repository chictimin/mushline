# mushline

[English](README.md) | 한국어

병렬 AI 에이전트를 위한 모니터링 보드로, 좁은(277px) 사이드바에 상주시키는 용도이다.
위에는 메시지 스트림, 아래에는 에이전트 상태를 보여준다. 단일 Bun 서버(Bun + SSE)이며 빌드 과정이 없고 npm 의존성이 없다.
이름 클릭으로 포커스를 옮기는 기능만 예외이며 그 외에는 읽기 전용이다. Bun ≥ 1.3과 hcom CLI가 필요하며,
폴링과 포커스를 위해 hcom/cmux 서브프로세스를 호출한다.

![mushline 스크린샷](assets/screenshot.png)

## 요구 사항

- [Bun](https://bun.sh) ≥ 1.3
- [hcom](https://github.com/aannoo/hcom) — mushline이 읽어 오는 다중 에이전트 통신 계층이다.
  먼저 설치한다.

```bash
brew install aannoo/hcom/hcom
```

- `cmux`(선택 사항): 워크스페이스 그룹 묶음과 이름 클릭 포커스를 제공한다.
  없으면 디렉터리 기준으로 묶고 포커스 기능은 쓸 수 없다.
- `sqlite3` CLI(데모용 데이터베이스를 만들 때만 필요).

## 설치와 실행

```bash
git clone https://github.com/chictimin/mushline.git
cd mushline
bun run src/server.ts
open http://127.0.0.1:7377
```

서버는 로컬 hcom 상태(`~/.hcom/hcom.db`, 읽기 전용)와 `hcom` CLI를 폴링한다.
`hcom` CLI가 없어도 DB 인스턴스를 읽어 화면을 그리므로(CLI 실패 시 DB로 대체),
화면만 확인할 때는 아래 데모를 쓴다.

### hcom 없이 데모

```bash
rm -f /tmp/mushline-fixture.db
sqlite3 /tmp/mushline-fixture.db < fixtures/hcom-min.sql
bun run src/server.ts --db-path /tmp/mushline-fixture.db
```

같은 파일에 `sqlite3` 가져오기를 반복하면 시드 행이 중복되므로, 다시 넣기 전에 임시 DB를 지운다.

| 플래그 / 환경 변수 | 기본값 | 용도 |
|---|---|---|
| `--db-path` / `HCOM_DB` | `~/.hcom/hcom.db` | 데이터베이스 사본을 지정 |
| `HCOM_BIN` | `hcom` | hcom CLI 경로 |
| `CMUX_BIN` | `cmux` | 선택 사항. cmux 워크스페이스 그룹으로 에이전트를 묶고(없으면 디렉터리 기준), 이름 클릭 포커스를 제공한다. 없으면 이름이 흐리게 표시되고 `/focus`는 `no_cmux`를 돌려준다 |

## 터미널 지원

| 기능 | cmux | 그 밖의 hcom 터미널(kitty, WezTerm, tmux 등) | 터미널 연결 없음(데모 DB) |
|---|---|---|---|
| 메시지 스트림 + 에이전트 상태 | 지원 | 지원 | 지원(DB 행만) |
| 워크스페이스 그룹 필터 | cmux 워크스페이스 그룹 이름 기준 | 디렉터리 기준으로 대체 | 디렉터리 기준으로 대체 |
| 그룹 섹션 · Attention · 접기 | 지원(브라우저 UI 상태) | 지원 | 지원 |
| 이름 클릭 → 터미널 포커스 | 지원 — surface UUID 에이전트는 해당 탭으로, workspace UUID(`cmux` 프리셋) 에이전트는 해당 워크스페이스의 포커스된 pane으로만 이동 | 미지원 — 이름이 흐리게 표시되고 `/focus`는 `no_cmux`를 돌려준다 | 미지원 |

다른 백엔드의 터미널 포커스(WezTerm 백엔드, Windows Terminal — 목록 조회 API 없음)는 아직 지원하지 않는다.

## 시작 시 이력 채우기

실행하면 전체를 다시 재생하는 대신 hcom DB에서 버퍼를 채운다.

- **Activity**(Timeline 탭, 에이전트별 이력): 현재 살아 있는 에이전트만, 최신 200건.
- **Messages**(Log 탭): 살아 있는 에이전트가 관련된 메시지(발신인, `delivered_to`, 멘션 중 하나)
  또는 최근 24시간 이내에 온 메시지, 최신 200건.

시작 이후에 도착하는 이벤트는 그대로 스트리밍한다. 렌더링은 프레임당 한 번으로 묶으므로
초기 백로그가 이벤트마다 전체 다시 그리기를 일으키지 않는다.

## 워크스페이스 그룹 필터

**Agents** 헤더 옆의 선택 상자로 보드 전체를 한 그룹으로 좁힌다.
에이전트 목록, Log 탭, Timeline 탭이 모두 따라가며 선택은 브라우저마다 기억한다.

- **cmux 워크스페이스 그룹**에서 실행 중인 에이전트는 그룹 이름으로 묶인다.
  (`cmuxtab` 프리셋은 hcom의 `launch_context.pane_id`에 cmux **surface** UUID를 넣고,
  `cmux` 프리셋은 workspace UUID를 넣는다. 두 형태 모두
  `cmux --id-format both tree --all --json`의 워크스페이스와 `panes[].surfaces[].id`로 푼다.)
  서로 다른 그룹의 워크스페이스가 surface를 공유하면 공유 독으로 보고 디렉터리 기준으로 묶는다.
  그룹은 cmux 창 단위이며 서버를 띄운 창의 그룹만 보인다.
- cmux 그룹에 속하지 않거나 cmux에서 실행 중이 아닌 에이전트는 작업 디렉터리로 묶인다.
- 각 에이전트 카드에 작업 디렉터리를 보여주며(`~`로 줄임), Compact 보기에서는 숨긴다.
- 발신인이나 수신인 중 하나라도 선택한 그룹에 있으면 메시지를 보여준다.
  수신인이 없는 브로드캐스트는 모든 그룹에 나온다.
- 소속 그룹을 알 수 없는 에이전트(예: mushline 시작 전의 이력)는 **All**에서만 나온다.

cmux는 선택 사항이다. 없으면 디렉터리 기준으로 묶는다.
이름 클릭 포커스는 cmux 없이 쓸 수 없다(이름이 흐리게 표시되고 `/focus`는 `no_cmux`를 돌려준다).

## 에이전트 목록

헤더에는 **Agents (19)** 형태로 표시되며, 그룹을 선택하면 **Agents (5/19)** 형태가 된다.
헤더 오른쪽 끝의 톱니 버튼으로 목록 설정을 연다.

- **Sort**(기본 켜짐): blocked → pinned → active → listening → unknown → inactive 순이며,
  같은 등급 안에서는 최근 활동 순이다. 끄면 blocked와 pinned만 위로 올리고 서버 순서를 유지한다.
  포인터나 키보드 포커스가 목록 안에 있는 동안에는 자동 재정렬이 대기하고 상태 글자는 계속 바뀐다.
- **Compact**(기본 꺼짐): 디렉터리, 설명, 이력 줄을 숨긴다.
- **Clear pins**: 핀한 에이전트가 하나라도 있을 때만 나온다.

카드의 핀 버튼은 해당 에이전트를 위쪽에 고정하고, Log 탭에서 발신인·수신인 이름에 강조를 준다.
설정과 핀은 브라우저마다 기억하며, 사라진 에이전트의 핀은 버린다.

에이전트 이름을 클릭하거나 이름 위에서 Enter·Space를 누르면 해당 cmux 터미널로 포커스가 이동한다.
(`focus-window` → `select-workspace` → `focus-pane` 순서이며, 대상 pane에 surface가 2개 이상 있을 때만
`reorder-surface --focus`를 덧붙인다. 위치 지정은 이웃 `--after`/`--before`이며 `--index`는 쓰지 않는다.)
탭 순서는 실행 뒤에 다시 확인하며, 바뀌었으면 `order_changed`를 보고한다.
포커스에는 `focusable=true`가 필요하다(pane_id가 마지막 cmux 트리에 있어야 하며, 낡은 매핑은 한 번 다시 읽는다).
이미 활성 탭이면 cmux 명령 없이 끝나고, 동시에 누르면 대기열에 들어가 10초를 넘기면 503 `busy`를 돌려준다.
실패하면 카드에 짧은 사유를 2.5초간 보여준다
(`no_cmux`, `not_in_cmux`, `step:<단계>`, `not_selected`, `order_changed`, `busy`).
`cmux` 프리셋(workspace UUID) 에이전트는 특정 탭이 아니라 해당 워크스페이스의 포커스된 pane으로 이동한다.
cmux에서 실행 중이 아니라 흐리게 표시된 이름은 눌러도 아무 일도 일어나지 않는다.

All을 선택하고 그룹이 2개 이상이면 목록이 라벨이 붙은 구역으로 나뉜다.
Attention(blocked 또는 pinned)이 먼저 오고 그룹이 A–Z 순으로, Ungrouped가 마지막이다.
Attention 카드에는 이름 옆에 소속 그룹이 표시되며, 이 모드에서는 blocked 카드가 맨 위에 고정되지 않는다.
그룹 헤더는 색 띠이며(그룹마다 정해진 색, Ungrouped는 회색, Attention은 경고 색),
클릭이나 Enter·Space로 접었다 펼 수 있고 접힌 상태는 브라우저마다 기억한다. 접힌 헤더에는 대표 상태 아이콘 하나가 나온다.
구역 모드에는 All 선택과 2개 이상의 그룹이 필요하며(Ungrouped 포함), blocked·pinned 에이전트가 없으면
Attention 구역이 없고, 특정 그룹을 고르거나 그룹이 하나뿐이면 그냥 목록으로 나온다.
Sort를 끄면 구역 안에서도 엄격한 서버 순서를 유지한다.
접힌 헤더의 요약 아이콘은 active ▶ > listening ● > unknown ◦ > inactive ○ 순으로 정해진다.
Attention은 접히지 않는다.

## 참고

- **대체로 읽기 전용이다.** hcom DB는 읽기 전용으로 열며(`mode=ro`, `readonly: true`),
  이름 클릭으로 cmux 포커스 명령을 실행할 때만 바깥 상태를 건드린다. `/focus`는 Host가
  `127.0.0.1:7377`이나 `localhost:7377`일 때만 받고, Origin 헤더가 있으면 검사하며
  (Origin이 없고 cross-site `Sec-Fetch-Site`도 없으면 로컬 curl용으로 허용한다),
  본문은 1024바이트까지만 받는다. 실제 DB가 아니라 사본으로 시험한다.
  포커스 명령은 `focus-window` → `select-workspace` → `focus-pane` 순서이며,
  대상 pane에 surface가 2개 이상 있을 때만 `reorder-surface --focus`를 덧붙인다
  (이웃 `--after`/`--before`, `--index` 미사용).
  cmux 0.64.25에서 쟀으며, 이 버전에는 순수 surface 선택 명령이 없어
  `reorder-surface`를 no-op 용법으로 쓴다.
- **고정 포트.** `http://127.0.0.1:7377`이며 자동 탐색이 없다. 포트가 차 있으면 종료한다.
- **터미널 엔드포인트.** `GET /term/:name?n=20`은 최근 터미널 줄을 JSON으로 돌려주며
  (404 `not_found`, 503 `unavailable`), 호출하는 UI는 아직 없다.
- 라이선스: MIT.

## 변경 이력

### 2026-10-07 (그룹 헤더 색 띠 + 접기)

- 구역 헤더가 전폭 색 띠가 되었으며 그룹 색 실선이 3px 들어간다
  (그룹마다 정해진 색, Ungrouped는 회색, Attention은 경고 색).
  그룹 헤더는 클릭이나 Enter·Space로 접을 수 있고 접힌 상태를 브라우저마다 기억하며,
  접힌 동안 대표 상태 아이콘 하나를 보여준다. Attention은 접히지 않는다.

### 2026-10-07 (에이전트 그룹 구역)

- All을 선택하고 그룹이 2개 이상이면 에이전트 목록이 라벨이 붙은 구역으로 나뉜다.
  Attention(blocked 또는 pinned)이 먼저 오고 그룹이 A–Z 순으로, Ungrouped가 마지막이다.
  Attention 카드에는 이름 옆에 그룹 라벨이 붙고, 구역 모드에서는 blocked 카드가 고정되지 않는다.
  헤더에는 `<라벨> · <인원>` 형태가 나온다.

### 2026-10-07 (터미널 포커스)

- 에이전트 이름을 클릭하면 해당 cmux 터미널로 포커스가 이동한다
  (에이전트 이름으로 `POST /focus`를 보내고, 서버는 새 `cmux tree`에서
  window/workspace/pane/surface를 풀어 `focus-window` → `select-workspace` → `focus-pane` →
  대상 pane에 surface가 2개 이상 있을 때만 `reorder-surface --focus`를 실행한다.
  이웃 `--after`/`--before`이며 `--index`는 쓰지 않고, 실행 뒤에 트리를 다시 읽어 확인한다).
  탭 순서는 실행 뒤에 다시 확인하며 바뀌었으면 `order_changed`를 보고한다.
  cmux에서 실행 중이 아닌 에이전트는 이름이 흐리게 표시되며 눌러도 아무 일도 일어나지 않고,
  실패하면 카드에 짧은 사유가 나온다. 로컬 전용이며 `127.0.0.1`에서 Host·Origin을 검사한다.
  cmux 0.64.25에서 쟀으며, 이 버전에는 순수 surface 선택 명령이 없어
  `reorder-surface`를 no-op 용법으로 쓴다.

### 2026-10-07

- 그룹 판별이 surface UUID를 따른다(`cmux --id-format both tree --all --json`).
  그룹이 다른 워크스페이스가 공유하는 독 surface는 디렉터리 기준으로 묶는다.
  그룹은 cmux 창 단위이며 서버를 띄운 창의 그룹만 보인다.
  탭으로 띄운 에이전트(`cmuxtab` 프리셋)가 필터에서 워크스페이스 그룹에 들어간다.
- 활동순 정렬(기본 켜짐), Compact 보기, Clear pins를 Agents 헤더의 톱니 버튼 뒤에 두었다.
  카드는 제자리에서 바뀌며, 포인터나 포커스가 목록 안에 있으면 자동 재정렬만 멈춘다.
- 카드마다 핀 버튼(압정 아이콘)을 두었다. 핀한 에이전트는 blocked 다음 순위가 되며
  Log 탭에서 이름이 강조된다.
- 에이전트 수를 제목 옆으로 옮겼다(`Agents (19)` / `Agents (5/19)`).
  그룹 선택 상자에서는 수를 빼고 헤더 빈 너비를 채우며 긴 이름은 자른다(전체 이름은 호버로).
- Timeline 탭을 보고 있는 동안 도착한 Log 행은 Log 탭으로 돌아오면 잰다.
- hcom 없이 데모가 더는 죽지 않는다. `fixtures/hcom-min.sql`에 `launch_context`를 넣었고,
  DB 대체 읽기가 실패하면 종료하는 대신 마지막 에이전트 목록을 유지한다.
- 시험 도구: `fixtures/fake-cmux.sh` + `fixtures/fake-hcom.sh`,
  `fixtures/cmux-case-{match,shared}-{tree,group}.json`
  (`FAKE_CMUX_CASE=match|shared|fail`, `FAKE_HCOM_AGENTS`, `FAKE_CMUX_DIR`).

### 2026-09-29

- 시작 시 채우기를 살아 있는 에이전트(Activity)와 살아 있거나 최근 24시간 메시지(Messages)로 좁혔다.
- Agents 헤더에 워크스페이스 그룹 필터를 두었다. cmux 워크스페이스 그룹이 기준이며
  없으면 디렉터리 기준으로 묶는다. 에이전트, Log, Timeline에 모두 적용되며
  에이전트 카드에 작업 디렉터리가 나온다.
- 렌더 묶음 처리: 백로그 재생과 실시간 이벤트가 프레임당 최대 한 번만 다시 그린다.
- 선택 사항인 환경 변수 `CMUX_BIN`을 새로 두었다.
