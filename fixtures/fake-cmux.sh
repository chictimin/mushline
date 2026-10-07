#!/bin/sh
# fixtures/fake-cmux.sh — M3 P2용 CMUX_BIN 대역. 읽기 전용, 쓰기·네트워크 없음.
#   FAKE_CMUX_CASE=match|shared  canned JSON을 낸다.
#   FAKE_CMUX_CASE=fail|미설정   exit 1 (cmux 실패 폴백용).
#   FAKE_CMUX_DIR               canned JSON 디렉토리(기본 fixtures).
if [ "$FAKE_CMUX_CASE" = "fail" ] || [ -z "$FAKE_CMUX_CASE" ]; then
  echo "fake-cmux: no cmux" >&2
  exit 1
fi
DIR="${FAKE_CMUX_DIR:-fixtures}"
if [ "$1" = "--id-format" ]; then
  cat "$DIR/cmux-case-$FAKE_CMUX_CASE-tree.json"
  exit 0
fi
if [ "$1" = "workspace-group" ]; then
  cat "$DIR/cmux-case-$FAKE_CMUX_CASE-group.json"
  exit 0
fi
echo "fake-cmux: unsupported args $*" >&2
exit 1
