#!/usr/bin/env node
// Agent Room 자동 테스트 (가짜 AI 사용). 실행: node test/run-tests.js
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-test-'));
const BIN = path.join(TMP, 'bin'); fs.mkdirSync(BIN);
for (const k of ['claude', 'codex', 'opencode']) fs.symlinkSync(path.join(__dirname, 'mock-agent.js'), path.join(BIN, k));
fs.chmodSync(path.join(__dirname, 'mock-agent.js'), 0o755);
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json')));
for (const k in cfg.agents) cfg.agents[k].command = path.join(BIN, k);
cfg.agents.codex.sandbox = 'on'; cfg.port = 8791; cfg.notify = false;
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify(cfg));
const DATA = path.join(TMP, 'data'), LOG = path.join(TMP, 'mock.log');
const W = (n) => { const d = path.join(TMP, 'work', n); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'README.md'), '# 원본\n'); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let TOK, results = [];
const B = 'http://127.0.0.1:8791';
const api = async (p, o = {}) => { const r = await fetch(B + p, { ...o, headers: { 'x-token': TOK, 'content-type': 'application/json' } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const room = async (rid) => (await api('/api/rooms/' + rid)).body;
const idle = async (rid) => { for (let i = 0; i < 80; i++) { await sleep(150); const r = await room(rid); if (!r.busy && !r.queue.length) return r; } throw new Error('timeout'); };
const check = (name, ok, info = '') => { results.push([name, ok]); console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : '  → ' + info}`); };
const newRoom = async (title, cwd) => (await api('/api/rooms', { method: 'POST', body: JSON.stringify({ title, cwd }) })).body.id;

(async () => {
  const srv = spawn('node', [path.join(ROOT, 'server.js')], { env: { ...process.env, AGENT_ROOM_CONFIG: path.join(TMP, 'config.json'), AGENT_ROOM_DATA: DATA, MOCK_LOG: LOG, AGENT_ROOM_TEST_SNAPSHOT_DELAY: '800' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvOut = ''; srv.stdout.on('data', (d) => srvOut += d); srv.stderr.on('data', (d) => srvOut += d);
  for (let i = 0; i < 50 && !fs.existsSync(path.join(DATA, 'url.txt')); i++) await sleep(100);
  TOK = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim();
  try {
    // 1. 스냅샷 중 중지하면 AI가 실행되지 않음
    { const d = W('stop'); const rid = await newRoom('중지', d);
      await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ writer: 'claude' }) });
      fs.writeFileSync(LOG, '');
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 고쳐줘' }) });
      await sleep(300); await api(`/api/rooms/${rid}/stop`, { method: 'POST' });
      const r = await idle(rid); const m = r.messages.filter((x) => x.role === 'agent').pop();
      check('스냅샷 중 중지 → AI 실행 안 됨', m.status === 'stopped' && !fs.readFileSync(LOG, 'utf8').includes('=====') && !fs.existsSync(path.join(d, 'hello-claude.txt')), JSON.stringify(m.status)); }
    // 2. 폴더를 바꾸면 이전 체크포인트로 되돌리기 거부
    { const d = W('rv1'); const d2 = W('rv2'); const rid = await newRoom('되돌리기', d);
      await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ writer: 'claude' }) });
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 작업' }) });
      let r = await idle(rid); const m = r.messages.find((x) => x.checkpoint);
      check('작성 작업 후 변경 기록', m && m.changes && m.changes.length > 0, JSON.stringify(m && m.changes));
      await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ cwd: d2 }) });
      const bad = await api(`/api/rooms/${rid}/revert`, { method: 'POST', body: JSON.stringify({ checkpoint: m.checkpoint }) });
      check('다른 폴더에서는 되돌리기 거부', bad.status === 409 && fs.readFileSync(path.join(d2, 'README.md'), 'utf8') === '# 원본\n', bad.status);
      await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ cwd: d }) });
      const ok = await api(`/api/rooms/${rid}/revert`, { method: 'POST', body: JSON.stringify({ checkpoint: m.checkpoint }) });
      check('원래 폴더에서는 되돌리기 성공', ok.status === 200 && !fs.existsSync(path.join(d, 'hello-claude.txt')) && fs.readFileSync(path.join(d, 'README.md'), 'utf8') === '# 원본\n', ok.status);
      r = await room(rid); const sm = r.messages.filter((x) => x.undoCheckpoint).pop();
      const un = await api(`/api/rooms/${rid}/revert`, { method: 'POST', body: JSON.stringify({ checkpoint: sm.undoCheckpoint }) });
      check('되돌리기 취소', un.status === 200 && fs.existsSync(path.join(d, 'hello-claude.txt')), un.status);
      const fake = await api(`/api/rooms/${rid}/revert`, { method: 'POST', body: JSON.stringify({ checkpoint: 'abcdef1234' }) });
      check('방에 없는 체크포인트 거부', fake.status === 404, fake.status); }
    // 3. 실패한 AI의 @멘션은 다음 AI를 부르지 않음 + 읽음 위치 되돌림
    { const d = W('fail'); const rid = await newRoom('실패', d);
      fs.writeFileSync(LOG, '');
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 실패멘션 해봐' }) });
      let r = await idle(rid); const ag = r.messages.filter((x) => x.role === 'agent');
      check('실패하면 오류 처리 + 다음 AI 안 부름', ag.length === 1 && ag[0].status === 'error', JSON.stringify(ag.map((x) => x.agent + ':' + x.status)));
      fs.writeFileSync(LOG, '');
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 다시' }) });
      await idle(rid);
      check('실패 후 다음 요청에 이전 메시지 다시 포함', fs.readFileSync(LOG, 'utf8').includes('실패멘션 해봐'), 'prompt missing'); }
    // 4. 삭제한 방이 되살아나지 않음
    { const d = W('del'); const rid = await newRoom('삭제', d);
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 안녕' }) });
      await sleep(200); await api(`/api/rooms/${rid}`, { method: 'DELETE' }); await sleep(2500);
      check('삭제한 방 파일 안 살아남', !fs.existsSync(path.join(DATA, 'rooms', rid + '.json')) && !fs.existsSync(path.join(d, 'hello-claude.txt')), 'resurrected'); }
    // 5. 홈 폴더 작성 권한 차단
    { const rid = await newRoom('홈', os.homedir());
      const r = await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ writer: 'claude' }) });
      check('홈 폴더에는 작성 권한 거부', r.status === 400, r.status); }
    // 6. 비밀 파일은 스냅샷 제외
    { const d = W('secret'); fs.writeFileSync(path.join(d, '.env'), 'KEY=1'); fs.mkdirSync(path.join(d, '.ssh')); fs.writeFileSync(path.join(d, '.ssh', 'id_ed25519'), 'x');
      const rid = await newRoom('비밀', d);
      await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ writer: 'claude' }) });
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 작업' }) });
      await idle(rid);
      const gd = fs.readdirSync(path.join(DATA, 'shadow')).find((x) => x.startsWith(rid));
      const ls = require('child_process').execFileSync('git', ['--git-dir', path.join(DATA, 'shadow', gd), 'ls-tree', '-r', '--name-only', 'HEAD']).toString();
      check('.env·.ssh 스냅샷 제외', !/\.env|\.ssh/.test(ls), ls); }
    // 7. HTML 미리보기: 샌드박스 헤더, 상대 경로, 폴더 밖 차단, 토큰 필요
    { const d = W('html'); fs.mkdirSync(path.join(d, 'deck')); fs.writeFileSync(path.join(d, 'deck', 'index.html'), '<h1>슬라이드</h1>'); fs.writeFileSync(path.join(d, 'deck', 'a.css'), 'h1{}');
      const rid = await newRoom('html', d);
      const r1 = await fetch(`${B}/view/${rid}/${TOK}/deck/index.html`);
      check('HTML 미리보기 + 샌드박스', r1.status === 200 && /sandbox/.test(r1.headers.get('content-security-policy') || '') && /text\/html/.test(r1.headers.get('content-type')), r1.status);
      const r2 = await fetch(`${B}/view/${rid}/${TOK}/deck/a.css`);
      check('상대 경로 파일(css)도 열림', r2.status === 200, r2.status);
      const r3 = await fetch(`${B}/view/${rid}/${TOK}/..%2F..%2Fdata%2Ftoken`);
      check('폴더 밖 파일 차단', r3.status === 403 || r3.status === 404, r3.status);
      const r4 = await fetch(`${B}/view/${rid}/wrongtokenwrongtokenwrongtoken12/deck/index.html`);
      check('토큰 틀리면 거부', r4.status === 401, r4.status); }
  } catch (e) { check('테스트 실행', false, e.stack); }
  srv.kill('SIGTERM'); await sleep(500);
  const fail = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  if (fail) console.log(srvOut.slice(-1500));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
