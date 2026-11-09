#!/data/data/com.termux/files/usr/bin/bash
# Agent Room 끄기
pkill -f "agent-room/server.js" && echo "서버를 껐어요." || echo "켜져 있는 서버가 없어요."
termux-wake-unlock 2>/dev/null
