#!/bin/sh
# fixtures/fake-hcom.sh — M3 P2 + M4 V7용 HCOM_BIN 대역. `list --json`에만 응답한다.
# FAKE_HCOM_AGENTS가 가리키는 JSON 배열 파일을 그대로 낸다.
# M4 V7(stale-agent 재시도): FAKE_HCOM_FIRST가 가리키는 파일을 첫 `list` 1회에만
# 내고, 이후에는 FAKE_HCOM_AGENTS를 낸다. served 마커는 "$FAKE_HCOM_FIRST.served"
# 이며, V7 재실행 전에는 지운다.
if [ "$1" = "list" ]; then
  if [ -n "$FAKE_HCOM_FIRST" ] && [ ! -f "$FAKE_HCOM_FIRST.served" ]; then
    touch "$FAKE_HCOM_FIRST.served"
    cat "$FAKE_HCOM_FIRST"
    exit 0
  fi
  cat "$FAKE_HCOM_AGENTS"
  exit 0
fi
echo "fake-hcom: unsupported args $*" >&2
exit 1
