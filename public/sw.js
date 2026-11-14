// 알림 표시 + 서버가 꺼져 있어도 앱 화면(껍데기)은 열리게 함. API 응답은 캐시하지 않아요.
const SHELL = 'ar-shell-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.mode !== 'navigate' || new URL(r.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(r);
      if (res.ok) { const c = await caches.open(SHELL); c.put('/shell', res.clone()).catch(() => {}); }
      return res;
    } catch {
      const hit = await caches.match('/shell');
      return hit || new Response('<meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:32px"><h2>서버가 꺼져 있어요</h2><p>홈 화면의 "AgentRoom 켜기"를 누르거나 Termux에서 <code>~/start.sh</code>를 실행해 주세요.</p>', { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => cs.length ? cs[0].focus() : self.clients.openWindow('/')));
});
