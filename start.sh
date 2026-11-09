#!/data/data/com.termux/files/usr/bin/bash
# Agent Room 켜기 (Termux에서 실행)
SHARE="$HOME/.agent-room-share"
URLFILE="$SHARE/url.txt"
PORT=8777
UPATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
mkdir -p "$SHARE"

# 앱 업데이트로 start.sh/stop.sh가 바뀌었으면 스스로 갈아끼우고 다시 실행
for f in start.sh stop.sh; do
  if [ -f "$SHARE/$f" ] && ! cmp -s "$SHARE/$f" "$HOME/$f"; then
    cp "$SHARE/$f" "$HOME/$f" && chmod +x "$HOME/$f"
    [ "$f" = start.sh ] && exec bash "$HOME/start.sh" "$@"
  fi
done

# 화면이 꺼져도 Termux가 죽지 않게
termux-wake-lock 2>/dev/null

if curl -s -o /dev/null "http://127.0.0.1:$PORT/" && [ -f "$URLFILE" ]; then
  echo "이미 켜져 있어요."
else
  rm -f "$URLFILE"
  # 앱 안에서 업데이트하면 서버가 종료 코드 75로 끝나고, 이 반복문이 새 코드로 다시 켜요
  nohup proot-distro login ubuntu --shared-tmp --bind "$SHARE:/mnt/ar-share" -- \
    env PATH="$UPATH" AGENT_ROOM_URL_FILE=/mnt/ar-share/url.txt \
    bash -c 'cd /root/agent-room && while :; do node /root/agent-room/server.js; c=$?; [ $c -eq 75 ] || exit $c; sleep 1; done' > "$HOME/agent-room.log" 2>&1 &
  echo -n "서버 켜는 중"
  for i in $(seq 1 60); do
    [ -f "$URLFILE" ] && break
    echo -n "."; sleep 0.5
  done
  echo
fi

if [ -f "$URLFILE" ]; then
  URL="$(cat "$URLFILE")"
  echo "주소: $URL"
  termux-open-url "$URL" 2>/dev/null || echo "브라우저에서 위 주소를 열어주세요."
else
  echo "서버가 안 켜졌어요. 아래 로그를 캡처해서 보내주세요:"
  cat "$HOME/agent-room.log"
fi
