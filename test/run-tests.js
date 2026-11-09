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
cfg.agents.codex.sandbox = 'off'; cfg.port = 8791; cfg.notify = false;
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
  const srv = spawn('node', [path.join(ROOT, 'server.js')], { env: { ...process.env, AGENT_ROOM_CONFIG: path.join(TMP, 'config.json'), AGENT_ROOM_DATA: DATA, MOCK_LOG: LOG, AGENT_ROOM_TEST_SNAPSHOT_DELAY: '800', CODEX_HOME: path.join(TMP, 'codexhome') }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    // 8. 자동 호출: 본문 언급·인용은 안 부르고, '다음:' 줄만 부름
    { const d = W('call'); const rid = await newRoom('호출', d);
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 언급만 해봐' }) });
      let r = await idle(rid); let ag = r.messages.filter((x) => x.role === 'agent').map((x) => x.agent);
      check('본문에서 이름만 말하면 호출 안 함', ag.join() === 'claude', ag.join());
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 넘겨 봐' }) });
      r = await idle(rid); ag = r.messages.filter((x) => x.role === 'agent').map((x) => x.agent);
      check("'다음:' 줄은 다음 AI 호출", ag.slice(1).join() === 'claude,opencode', ag.join()); }
    // 9. 토론 모드: 순서·라운드·정리, 자동 호출 없음
    { const d = W('debate'); const rid = await newRoom('토론', d);
      await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ agents: { codex: { noSandbox: true } } }) });
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '핑퐁 주제로 토론', debate: { participants: ['claude', 'codex'], rounds: 2, summarizer: 'opencode' } }) });
      const r = await idle(rid); const ag = r.messages.filter((x) => x.role === 'agent');
      const seq = ag.map((x) => x.agent + (x.debate ? (x.debate.final ? ':정리' : ':' + x.debate.round) : '')).join(',');
      check('토론 순서 (클로드→코덱스 ×2, 오픈코드 정리)', seq === 'claude:1,codex:1,claude:2,codex:2,opencode:정리', seq); }
    // 10. 위험 명령 차단이 세 AI에 전달됨
    { const d = W('block'); const rid = await newRoom('차단', d); fs.writeFileSync(LOG, '');
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 안녕' }) }); await idle(rid);
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@오픈코드 안녕' }) }); await idle(rid);
      const log = fs.readFileSync(LOG, 'utf8');
      check('클로드에 git push 차단 전달', log.includes('Bash(git push:*)'), 'missing');
      check('오픈코드에 차단 권한 전달', /perm=\{"bash":\{"\*":"allow","git push":"deny"/.test(log), 'missing');
      const rules = path.join(TMP, 'codexhome', 'rules', 'agent-room.rules');
      check('코덱스 차단 규칙 파일 생성', fs.existsSync(rules) && fs.readFileSync(rules, 'utf8').includes('prefix_rule(pattern=["git","push"], decision="forbidden")'), 'no rules'); }
    // 11. 방 메모가 프롬프트에 들어감
    { const d = W('memo'); const rid = await newRoom('메모', d); fs.writeFileSync(LOG, '');
      await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ memo: 'slides 폴더 안에서만 작업' }) });
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 시작' }) }); await idle(rid);
      check('방 메모가 AI에게 전달', fs.readFileSync(LOG, 'utf8').includes('[방 메모 — 꼭 지킬 것] slides 폴더 안에서만 작업'), 'missing'); }
    // 12. 방 기억: AI가 정리 → 저장·본문에서 숨김·다음 프롬프트 전달·사용자 수정·이전 버전 복구
    { const d = W('mem'); const rid = await newRoom('기억', d); fs.writeFileSync(LOG, '');
      await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ agents: { codex: { noSandbox: true } } }) });
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 이거 기억해' }) });
      let r = await idle(rid); const m = r.messages.filter((x) => x.role === 'agent').pop();
      check('AI가 정리한 기억 저장', /슬라이드는 10장/.test(r.memory) && r.memoryBy === 'claude', r.memory);
      check('기억 블록은 메시지에서 숨김 + 정리 표시', !m.text.includes('<기억>') && m.memoryUpdate && m.memoryUpdate.added === 2, JSON.stringify(m.memoryUpdate));
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@코덱스 확인' }) }); await idle(rid);
      check('기억이 다른 AI에게 전달', /\[방 기억 — 지금까지 합의한 내용\]\n- claude 합의: 슬라이드는 10장/.test(fs.readFileSync(LOG, 'utf8')), 'missing');
      r = (await api(`/api/rooms/${rid}/memory`, { method: 'POST', body: JSON.stringify({ text: '- 슬라이드는 12장' }) })).body;
      check('사용자가 기억 수정', r.memory === '- 슬라이드는 12장' && r.memoryBy === 'user', r.memory);
      const idx = r.memoryHistory[r.memoryHistory.length - 1].i;
      r = (await api(`/api/rooms/${rid}/memory`, { method: 'POST', body: JSON.stringify({ restore: idx }) })).body;
      check('이전 버전으로 복구', /슬라이드는 10장/.test(r.memory), r.memory);
      const ex = await api(`/api/rooms/${rid}/memexport`, { method: 'POST' });
      check('DECISIONS.md 내보내기', ex.status === 200 && /슬라이드는 10장/.test(fs.readFileSync(path.join(d, 'DECISIONS.md'), 'utf8')), ex.status); }
    // 13. 코덱스 샌드박스가 안 되면 기본 거부, 허용하면 실행 + 스냅샷
    { const d = W('nosb'); const rid = await newRoom('샌드박스', d); fs.writeFileSync(LOG, '');
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@코덱스 안녕' }) });
      let r = await idle(rid); let m = r.messages.filter((x) => x.role === 'agent').pop();
      check('샌드박스 없으면 코덱스 실행 거부', m.status === 'error' && m.needsNoSandbox && !fs.readFileSync(LOG, 'utf8').includes('===== codex'), m.status);
      await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ agents: { codex: { noSandbox: true } } }) });
      await api(`/api/rooms/${rid}/retry`, { method: 'POST', body: JSON.stringify({ msgId: m.id }) });
      r = await idle(rid); m = r.messages.filter((x) => x.role === 'agent').pop();
      check('허용하면 실행 + 스냅샷 보호', m.status === 'done' && !!m.checkpoint && /danger-full-access/.test(fs.readFileSync(LOG, 'utf8')), m.status + ' cp=' + !!m.checkpoint); }
    // 14. 확정한 기억 줄은 AI가 정리하면서 빼도 다시 들어감
    { const d = W('appr'); const rid = await newRoom('확정', d);
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 이거 기억해' }) }); let r = await idle(rid);
      const line = r.memory.split('\n')[0];
      r = (await api(`/api/rooms/${rid}/memline`, { method: 'POST', body: JSON.stringify({ line, action: 'approve' }) })).body;
      check('기억 줄 확정', r.memoryMeta[line] && r.memoryMeta[line].approved, JSON.stringify(r.memoryMeta));
      fs.writeFileSync(LOG, '');
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 정리다시' }) }); r = await idle(rid);
      check('AI가 빼도 확정 줄은 유지', r.memory.includes(line) && r.memory.includes('새로 정한 것') && !r.memory.includes('색은 주황'), r.memory);
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 확인' }) }); await idle(rid);
      check('확정 줄은 [확정] 표시로 전달', fs.readFileSync(LOG, 'utf8').includes('[확정] ' + line), 'missing');
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 덧붙여' }) }); r = await idle(rid);
      const ls = r.memory.split('\n');
      check('확정 줄에 덧붙이면 원래 줄 + 새 줄로 분리', ls.filter((x) => x.startsWith(line.replace(/[.。]\s*$/, ''))).length === 1 && ls.includes(line) && ls.includes('- 그리고 덧붙임'), r.memory); }
    // 15. 아이디어 보관함
    { const d = W('idea'); const rid = await newRoom('아이디어', d);
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 아이디어줘' }) }); let r = await idle(rid);
      check('AI의 "아이디어:" 줄 수집', (r.ideas || []).some((i) => i.text === '다음엔 사례 영상도 넣자' && i.by === 'claude'), JSON.stringify(r.ideas));
      r = (await api(`/api/rooms/${rid}/ideas`, { method: 'POST', body: JSON.stringify({ text: '표지에 현장 사진' }) })).body;
      const it = r.ideas.find((i) => i.text === '표지에 현장 사진');
      r = (await api(`/api/rooms/${rid}/ideas`, { method: 'POST', body: JSON.stringify({ promote: it.id }) })).body;
      check('아이디어 → 확정 기억', r.memory.includes('- 표지에 현장 사진') && r.memoryMeta['- 표지에 현장 사진'].approved && !r.ideas.some((i) => i.id === it.id), r.memory); }
  } catch (e) { check('테스트 실행', false, e.stack); }
  srv.kill('SIGTERM'); await sleep(500);
  const fail = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  if (fail) console.log(srvOut.slice(-1500));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
