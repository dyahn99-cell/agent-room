#!/bin/bash
# 더블클릭하면 Agent Room을 켜고 크롬(기본 브라우저)에서 열어요. 이 창을 닫으면 서버도 꺼져요.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
APP="$HOME/agent-room"
cd "$APP" || { echo "~/agent-room 폴더가 없어요."; read -r; exit 1; }
URLF="$HOME/.agent-room/url.txt"
if curl -s -o /dev/null http://127.0.0.1:8777/; then
  echo "이미 켜져 있어요. 화면만 열게요."
  open "$(cat "$URLF")"; exit 0
fi
git pull -q 2>/dev/null && echo "최신 버전으로 맞췄어요."
( for i in $(seq 1 60); do sleep 0.5; curl -s -o /dev/null http://127.0.0.1:8777/ && [ -f "$URLF" ] && { open "$(cat "$URLF")"; break; }; done ) &
# 앱 안에서 업데이트하면 종료 코드 75로 끝나고, 여기서 새 코드로 다시 켜요
while :; do node server.js; c=$?; [ $c -eq 75 ] || break; sleep 1; done
echo "서버가 꺼졌어요. 창을 닫아도 돼요."
