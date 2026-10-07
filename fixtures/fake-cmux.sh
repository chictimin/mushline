#!/bin/sh
# fixtures/fake-cmux.sh — M3 P2 + M4 R7용 CMUX_BIN 대역. 읽기 전용, 쓰기·네트워크 없음.
#   FAKE_CMUX_CASE=match|shared  canned JSON을 낸다(M3 경로).
#   FAKE_CMUX_CASE=fail|미설정   exit 1 (cmux 실패 폴백용).
#   FAKE_CMUX_DIR               canned JSON 디렉토리(기본 fixtures).
# M4(R7): focus-window/select-workspace/focus-pane/reorder-surface 스텁.
#   FAKE_CMUX_LOG               호출 인자($*)를 1줄씩 append 하는 로그 파일.
#   FAKE_CMUX_FAIL_AT           focus-window|select-workspace|focus-pane|reorder-surface 중
#                               1개 — 해당 단계만 exit 1, 나머지는 exit 0.
#   FAKE_CMUX_PRE|FAKE_CMUX_POST tree 조회용 JSON. 로그에 포커스 단계 lines 가
#                               하나도 없으면 PRE, 하나라도 있으면 POST.
#                               (로그를 비우면 상태가 리셋된다. PRE만 있으면 항상 PRE,
#                               POST만 있으면 항상 POST.) fast-path·not_selected·
#                               reorder 케이스 지정용.
#   FAKE_CMUX_SLEEP             포커스 4단계 호출마다 sleep 초(V11 busy 재현용).
#                               단계 타임아웃(5초)보다 작게 둔다. 4단계 합이
#                               뮤텍스 대기 상한(10초)을 넘기면 다음 요청이 busy가 된다.
#   FAKE_CMUX_STRICT            기본 1(ON). 포커스 4단계에서 범위 지정
#                               (--workspace/--window, 단계별 요구 상이)이 없으면
#                               exit 1로 실패를 모사한다. 이번 결함(서버 env 범위
#                               의존)의 fake 재현·회귀 검출용. 0이면 검사 off.
#   FAKE_CMUX_ENV_LOG           설정 시 포커스 4단계 호출마다 자식 프로세스 env 의
#                               CMUX_WORKSPACE_ID/SURFACE_ID/PANEL_ID 값을 1줄씩
#                               append 한다(env strip 검증용).
may_sleep() {
  if [ -n "$FAKE_CMUX_SLEEP" ]; then sleep "$FAKE_CMUX_SLEEP"; fi
}
#   FAKE_CMUX_GROUP             workspace-group list 응답 JSON(미설정 시 CASE canned).
log_call() {
  if [ -n "$FAKE_CMUX_LOG" ]; then
    echo "$*" >> "$FAKE_CMUX_LOG"
  fi
}
focused_yet() {
  [ -n "$FAKE_CMUX_LOG" ] && [ -f "$FAKE_CMUX_LOG" ] && \
    grep -Eq '^(focus-window|select-workspace|focus-pane|reorder-surface)( |$)' "$FAKE_CMUX_LOG" 2>/dev/null
}
serve_tree() {
  if [ -n "$FAKE_CMUX_PRE" ] || [ -n "$FAKE_CMUX_POST" ]; then
    if focused_yet; then
      if [ -n "$FAKE_CMUX_POST" ]; then cat "$FAKE_CMUX_POST"; return 0; fi
      cat "$FAKE_CMUX_PRE"; return 0
    fi
    if [ -n "$FAKE_CMUX_PRE" ]; then cat "$FAKE_CMUX_PRE"; return 0; fi
    cat "$FAKE_CMUX_POST"; return 0
  fi
  DIR="${FAKE_CMUX_DIR:-fixtures}"
  if [ "$FAKE_CMUX_CASE" = "fail" ] || [ -z "$FAKE_CMUX_CASE" ]; then
    echo "fake-cmux: no cmux" >&2
    return 1
  fi
  cat "$DIR/cmux-case-$FAKE_CMUX_CASE-tree.json"
  return 0
}
fail_here() {
  [ "$FAKE_CMUX_FAIL_AT" = "$1" ]
}
strict_on() {
  [ "${FAKE_CMUX_STRICT:-1}" != "0" ]
}
has_flag() {
  case " $2 " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}
log_focus_env() {
  if [ -n "$FAKE_CMUX_ENV_LOG" ]; then
    echo "$1 CMUX_WORKSPACE_ID=${CMUX_WORKSPACE_ID:-} CMUX_SURFACE_ID=${CMUX_SURFACE_ID:-} CMUX_PANEL_ID=${CMUX_PANEL_ID:-}" >> "$FAKE_CMUX_ENV_LOG"
  fi
}
require_scope() {
  stage="$1"; joined="$2"; shift 2
  for flag in "$@"; do
    if ! has_flag "$flag" "$joined"; then
      echo "fake-cmux: $stage missing $flag (strict scope)" >&2
      return 1
    fi
  done
  return 0
}
if [ "$1" = "--id-format" ]; then
  log_call "$@"
  serve_tree
  exit $?
fi
if [ "$1" = "workspace-group" ]; then
  log_call "$@"
  DIR="${FAKE_CMUX_DIR:-fixtures}"
  if [ -n "$FAKE_CMUX_GROUP" ]; then cat "$FAKE_CMUX_GROUP"; exit 0; fi
  if [ "$FAKE_CMUX_CASE" = "fail" ] || [ -z "$FAKE_CMUX_CASE" ]; then
    echo "fake-cmux: no cmux" >&2
    exit 1
  fi
  cat "$DIR/cmux-case-$FAKE_CMUX_CASE-group.json"
  exit 0
fi
if [ "$1" = "focus-window" ]; then
  log_call "$@"
  log_focus_env "focus-window"
  if strict_on; then require_scope "focus-window" "$*" --window || exit 1; fi
  may_sleep
  if fail_here focus-window; then echo "fake-cmux: fail at focus-window" >&2; exit 1; fi
  exit 0
fi
if [ "$1" = "select-workspace" ]; then
  log_call "$@"
  log_focus_env "select-workspace"
  if strict_on; then require_scope "select-workspace" "$*" --workspace --window || exit 1; fi
  may_sleep
  if fail_here select-workspace; then echo "fake-cmux: fail at select-workspace" >&2; exit 1; fi
  exit 0
fi
if [ "$1" = "focus-pane" ]; then
  log_call "$@"
  log_focus_env "focus-pane"
  if strict_on; then require_scope "focus-pane" "$*" --pane --workspace --window || exit 1; fi
  may_sleep
  if fail_here focus-pane; then echo "fake-cmux: fail at focus-pane" >&2; exit 1; fi
  exit 0
fi
if [ "$1" = "reorder-surface" ]; then
  log_call "$@"
  log_focus_env "reorder-surface"
  if strict_on; then require_scope "reorder-surface" "$*" --surface --workspace --window || exit 1; fi
  may_sleep
  if fail_here reorder-surface; then echo "fake-cmux: fail at reorder-surface" >&2; exit 1; fi
  exit 0
fi
echo "fake-cmux: unsupported args $*" >&2
exit 1
