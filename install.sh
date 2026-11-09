#!/data/data/com.termux/files/usr/bin/bash
# Agent Room 설치·이전 (Termux에서 실행). 이미 설치돼 있어도 다시 돌려도 안전해요.
#   공개 저장소:  bash install.sh
#   비공개 저장소: AGENT_ROOM_TOKEN=github토큰 bash install.sh
set -e
REPO="${AGENT_ROOM_REPO:-github.com/dyahn99-cell/agent-room}"
if [ -n "$AGENT_ROOM_TOKEN" ]; then URL="https://x-access-token:${AGENT_ROOM_TOKEN}@${REPO}.git"; else URL="https://${REPO}.git"; fi
# proot-distro는 Termux 경로를 PATH 뒤에 붙여서 Termux용 node가 잡힐 수 있어요. 우분투 경로만 쓰게 고정.
UPATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
mkdir -p "$HOME/.codex" "$HOME/.agent-room-share"

echo "▶ 1/4 Termux 패키지"
pkg update -y
pkg install -y proot-distro curl termux-tools

echo "▶ 2/4 우분투 설치 (이미 있으면 건너뜀)"
if ! proot-distro login ubuntu -- true 2>/dev/null; then
  proot-distro install ubuntu
fi

echo "▶ 3/4 우분투 안에 Node·git·세 AI 설치 (처음엔 몇 분 걸려요)"
proot-distro login ubuntu -- env PATH="$UPATH" bash -c '
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates
PLAT="$(/usr/bin/node -p process.platform 2>/dev/null || echo none)"
VER="$(/usr/bin/node -p "process.versions.node.split(\".\")[0]" 2>/dev/null || echo 0)"
if [ "$PLAT" != "linux" ] || [ "$VER" -lt 20 ]; then
  echo "  · 우분투용 Node 22 설치 (현재: $PLAT v$VER)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y --reinstall nodejs
fi
hash -r
if [ "$(/usr/bin/node -p process.platform)" != "linux" ]; then
  echo "❌ 우분투 node가 linux가 아니에요. 화면을 캡처해서 보내주세요:"; ls -la /usr/bin/node; uname -a; exit 1
fi
/usr/bin/npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai
'

echo "▶ 4/4 앱 받기 (git)"
proot-distro login ubuntu --bind "$HOME/.codex:/mnt/ar-codex" -- env PATH="$UPATH" AR_URL="$URL" bash -c '
set -e
cd /root
if [ -d agent-room/.git ]; then
  git -C agent-room remote set-url origin "$AR_URL"
  git -C agent-room pull --ff-only
  echo "  · 최신으로 업데이트했어요"
else
  rm -rf agent-room.new
  git clone --depth 50 "$AR_URL" agent-room.new
  # 예전 설치에서 내가 고친 설정은 그대로 가져옴
  [ -f agent-room/config.json ] && cp agent-room/config.json agent-room.new/config.json && echo "  · 기존 설정 유지"
  rm -rf agent-room.old; [ -d agent-room ] && mv agent-room agent-room.old
  mv agent-room.new agent-room
  echo "  · 앱을 받았어요 (대화방은 그대로 남아요)"
fi
if [ -f /mnt/ar-codex/auth.json ] && [ ! -f /root/.codex/auth.json ]; then
  mkdir -p /root/.codex && cp /mnt/ar-codex/auth.json /root/.codex/ && echo "  · Termux의 Codex 로그인 정보를 복사했어요"
fi
'
# start/stop 스크립트를 Termux 홈에 설치
proot-distro login ubuntu --bind "$HOME/.agent-room-share:/mnt/ar-share" -- bash -c 'cp /root/agent-room/start.sh /root/agent-room/stop.sh /mnt/ar-share/'
cp "$HOME/.agent-room-share/start.sh" "$HOME/.agent-room-share/stop.sh" "$HOME/" && chmod +x "$HOME/start.sh" "$HOME/stop.sh"
rm -f "$HOME/update.sh"

cat <<'MSG'

✅ 설치 끝!

처음 한 번만 로그인해 주세요 (이미 했으면 생략):
  proot-distro login ubuntu
  claude            # 안내대로 로그인 후 /exit
  codex login
  exit

켜기: ~/start.sh   끄기: ~/stop.sh
업데이트는 이제 앱 왼쪽 아래 버전 옆 "업데이트" 버튼으로 해요.
MSG
