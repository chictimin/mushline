#!/bin/sh
# fixtures/fake-hcom.sh — M3 P2용 HCOM_BIN 대역. `list --json`에만 응답한다.
# FAKE_HCOM_AGENTS가 가리키는 JSON 배열 파일을 그대로 낸다.
if [ "$1" = "list" ]; then
  cat "$FAKE_HCOM_AGENTS"
  exit 0
fi
echo "fake-hcom: unsupported args $*" >&2
exit 1
