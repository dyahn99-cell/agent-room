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
const newRoom = async (title, cwd, teamId) => (await api('/api/rooms', { method: 'POST', body: JSON.stringify({ title, cwd, teamId }) })).body.id;

(async () => {
  // 관리자 우편함 테스트용 로컬 원격 저장소 (inbox 브랜치)
  const { execFileSync } = require('child_process');
  const BARE = path.join(TMP, 'remote.git'); execFileSync('git', ['init', '-q', '--bare', BARE]);
  const SEED = path.join(TMP, 'seed'); execFileSync('git', ['init', '-q', '-b', 'inbox', SEED]);
  fs.mkdirSync(path.join(SEED, 'replies')); fs.writeFileSync(path.join(SEED, 'replies', '.keep'), '');
  const G = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString();
  G(SEED, 'add', '-A'); G(SEED, 'commit', '-qm', 'init'); G(SEED, 'push', '-q', BARE, 'inbox');
  const srv = spawn('node', [path.join(ROOT, 'server.js')], { env: { ...process.env, AGENT_ROOM_NO_APT: '1', AGENT_ROOM_INBOX_REMOTE: BARE, AGENT_ROOM_CONFIG: path.join(TMP, 'config.json'), AGENT_ROOM_DATA: DATA, MOCK_LOG: LOG, AGENT_ROOM_TEST_SNAPSHOT_DELAY: '800', CODEX_HOME: path.join(TMP, 'codexhome') }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    // 16. 관리자 우편함: 보내기 → 원격에 파일 → 답장 push → 방에 관리자 메시지
    { const d = W('mgr'); const rid = await newRoom('관리자', d);
      await api(`/api/rooms/${rid}/memory`, { method: 'POST', body: JSON.stringify({ text: '- 5번부터 만들기' }) });
      const sres = await api(`/api/rooms/${rid}/manager`, { method: 'POST', body: JSON.stringify({ note: '2단계 부탁해' }) });
      const id = sres.body.id;
      G(SEED, 'pull', '-q', BARE, 'inbox');
      const doc = fs.existsSync(path.join(SEED, 'inbox', id + '.md')) ? fs.readFileSync(path.join(SEED, 'inbox', id + '.md'), 'utf8') : '';
      check('관리자에게 보내기 (우편함에 파일 생성)', sres.status === 200 && /2단계 부탁해/.test(doc) && /\[확정\] - 5번부터 만들기/.test(doc), sres.status + ' ' + JSON.stringify(sres.body));
      fs.writeFileSync(path.join(SEED, 'replies', id + '.md'), '# 반영했어요\n- v0.9.0에 5번 넣음');
      G(SEED, 'add', '-A'); G(SEED, 'commit', '-qm', 'reply'); G(SEED, 'push', '-q', BARE, 'HEAD:inbox');
      await api(`/api/rooms/${rid}/managercheck`, { method: 'POST' });
      const r = await room(rid); const mm = r.messages.find((x) => x.role === 'manager');
      check('관리자 답장이 방에 표시 (AI에게도 전달)', mm && /v0\.9\.0에 5번 넣음/.test(mm.text) && mm.forAgents && r.managerSent[0].replied, JSON.stringify(r.managerSent));
      fs.writeFileSync(LOG, '');
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 관리자가 뭐래?' }) }); await idle(rid);
      check('AI가 관리자 답장을 봄', /\[관리자\] # 반영했어요/.test(fs.readFileSync(LOG, 'utf8')), 'missing'); }
    // 17. 이어가기
    { const d = W('cont'); const rid = await newRoom('원래 방', d);
      await api(`/api/rooms/${rid}/memory`, { method: 'POST', body: JSON.stringify({ text: '- 12장\n- 주황' }) });
      await api(`/api/rooms/${rid}/ideas`, { method: 'POST', body: JSON.stringify({ text: '영상 넣기' }) });
      const nr = (await api(`/api/rooms/${rid}/continue`, { method: 'POST', body: JSON.stringify({ title: '이어진 방' }) })).body;
      const full = await room(nr.id);
      check('기억·아이디어 가지고 이어가기', full.title === '이어진 방' && full.memory.includes('- 12장') && full.memoryMeta['- 12장'].approved && full.ideas.length === 1 && full.messages[0].forAgents, JSON.stringify({ m: full.memory, i: full.ideas.length })); }
    // 18. 갤러리·성적표·브리핑
    { const d = W('gal'); const rid = await newRoom('갤러리', d);
      await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ writer: 'claude' }) });
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@클로드 페이지 만들어' }) }); await idle(rid);
      const g = (await api('/api/gallery')).body;
      check('갤러리에 HTML 결과물', g.some((x) => x.roomId === rid && x.path === 'slides/index.html' && x.kind === 'html'), JSON.stringify(g.slice(0, 3)));
      const st = (await api('/api/stats?days=7')).body;
      check('성적표 집계', st.agents.claude.turns > 5 && st.agents.claude.error >= 1 && st.agents.claude.approved >= 0, JSON.stringify(st.agents.claude));
      const b = (await api('/api/briefings', { method: 'POST', body: JSON.stringify({ kind: 'daily' }) })).body;
      check('브리핑 생성', /AI가 \d+번 답했어요/.test(b.text) && /클로드: 답/.test(b.text), b.text); }
    // 19. 전문가(페르소나): 만든 전문가가 이름으로 불리고, 엔진·지시문·모델이 그대로 적용
    { const st = (await api('/api/state')).body;
      check('기본 패널·전문가 준비', st.teams.some((t) => t.id === 'panel4') && ['marcus', 'hunter', 'sage', 'ledger', 'claude', 'codex', 'opencode'].every((id) => st.agents.some((a) => a.id === id)), JSON.stringify(st.agents.map((a) => a.id)));
      const pr = (await api('/api/personas', { method: 'POST', body: JSON.stringify({ name: '뮤즈', emoji: '🎨', color: '#DB2777', engine: 'opencode', model: 'meta/muse-spark', description: '아이디어 발산', systemPrompt: '너는 뮤즈, 엉뚱한 아이디어 담당이야.' }) })).body;
      const d = W('persona'); const rid = await newRoom('전문가', d);
      await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ members: ['claude', pr.id] }) });
      fs.writeFileSync(LOG, '');
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@뮤즈 아이디어 하나' }) });
      const r = await idle(rid); const m = r.messages.filter((x) => x.role === 'agent').pop();
      const log = fs.readFileSync(LOG, 'utf8');
      check('이름으로 부르면 그 전문가가 답함 (엔진=오픈코드)', m.agent === pr.id && log.includes('===== opencode') && log.includes('meta/muse-spark'), m.agent);
      check('전문가 지시문이 전달', log.includes('너는 뮤즈, 엉뚱한 아이디어 담당이야.') && log.includes('"뮤즈"'), 'missing');
      check('방 멤버 표시', JSON.stringify(r.members) === JSON.stringify(['claude', pr.id]), JSON.stringify(r.members));
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@코덱스 안녕' }) });
      const r2 = await idle(rid);
      check('방에 없는 멤버는 안 부름', !r2.messages.some((x) => x.role === 'agent' && x.agent === 'codex') && r2.messages.some((x) => x.role === 'system' && /방에 없거나/.test(x.text)), 'called'); }
    // 20. 같은 엔진 전문가 둘은 대화 기록을 따로 가짐
    { const d = W('twins'); const rid = await newRoom('같은엔진', d, 'panel4');
      const r0 = await room(rid);
      check('패널로 방 만들기', JSON.stringify(r0.members) === JSON.stringify(['marcus', 'hunter', 'sage', 'ledger']) && r0.teamName === '4인 전문가 패널', JSON.stringify(r0.members));
      await api(`/api/rooms/${rid}`, { method: 'PATCH', body: JSON.stringify({ agents: { sage: { noSandbox: true } } }) });
      fs.writeFileSync(LOG, '');
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@마커스 시작' }) }); await idle(rid);
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@레저 숫자' }) }); await idle(rid);
      const log = fs.readFileSync(LOG, 'utf8').split('===== ').filter(Boolean);
      const lg = log.find((x) => x.includes('너는 레저'));
      check('같은 엔진이어도 새 세션 + 패널 규칙 전달', lg && /resumed=false/.test(lg) && lg.includes('[이 패널의 공통 규칙]'), lg ? lg.slice(0, 120) : 'no ledger run'); }
    // 21. 작업 기록장
    { const a = (await api('/api/activity?limit=500')).body;
      check('작업 기록장에 실행·승인·되돌리기 기록', a.some((x) => x.type === 'turn') && a.some((x) => x.type === 'revert') && a.some((x) => x.type === 'files') && a.some((x) => x.type === 'members'), [...new Set(a.map((x) => x.type))].join(',')); }
    // 22. 자료 폴더: 전문가별 참고 자료
    { const d = W('know'); const rid = await newRoom('자료', d, 'panel4');
      const up = (pid, name, body) => fetch(B + `/api/knowledge/${pid}?name=` + encodeURIComponent(name), { method: 'POST', headers: { 'x-token': TOK }, body }).then((r) => r.json());
      await up('ledger', '단가표.txt', 'AMS20 단가 120원\n');
      const docx = path.join(TMP, 'spec.docx');
      let office = true;
      try { execFileSync('python3', ['-c', `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w')\nz.writestr('word/document.xml','<w:document><w:body><w:p><w:r><w:t>정격 압력 0.7MPa</w:t></w:r></w:p><w:p><w:r><w:t>IO-Link 지원</w:t></w:r></w:p></w:body></w:document>')\nz.close()`, docx]); } catch { office = false; }
      if (office) await up('ledger', '사양서.docx', fs.readFileSync(docx));
      await up('ledger', '../../../evil name?.txt', 'x');
      let k; for (let i = 0; i < 30; i++) { await sleep(150); k = (await api('/api/knowledge/ledger')).body; if (!k.files.some((f) => f.text === 'pending' || f.text === 'none')) break; }
      check('자료 올리기 + 위험한 파일 이름 정리', k.files.some((f) => f.name === '단가표.txt') && k.files.every((f) => !/[\/?]/.test(f.name) && !f.name.startsWith('.')) && !fs.existsSync(path.join(TMP, 'evil name?.txt')) && k.files.length === (office ? 3 : 2), JSON.stringify(k.files));
      if (office && k.tools.zip) {
        const t = (await api('/api/knowledge/ledger/text?name=' + encodeURIComponent('사양서.docx'))).body;
        check('워드 파일에서 글자 추출', /정격 압력 0\.7MPa\nIO-Link 지원/.test(t.text) && k.files.find((f) => f.name === '사양서.docx').text === 'ok', JSON.stringify(t));
      }
      const st0 = (await api('/api/state')).body;
      check('전문가 카드에 자료 개수', st0.agents.find((a) => a.id === 'ledger').know === (office ? 3 : 2) && st0.agents.find((a) => a.id === 'marcus').know === 0, 'count');
      fs.writeFileSync(LOG, '');
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@레저 자료봐' }) }); const r = await idle(rid);
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@마커스 자료봐' }) }); const r2 = await idle(rid);
      const log = fs.readFileSync(LOG, 'utf8').split('===== ').filter(Boolean);
      const lg = log.find((x) => x.includes('너는 레저')) || '', mk = log.find((x) => x.includes('너는 마커스')) || '';
      const kd = path.join(DATA, 'knowledge', 'ledger');
      check('자료 폴더가 그 전문가에게만 전달', lg.includes('[자료 폴더') && lg.includes('단가표.txt') && lg.includes('"--add-dir","' + kd + '"') && !mk.includes('[자료 폴더') && !mk.includes('--add-dir'), lg.slice(0, 200));
      if (office && k.tools.zip) check('추출본 안내가 프롬프트에', lg.includes('"사양서.docx.txt"에서 읽어'), 'no hint');
      const m = r.messages.filter((x) => x.role === 'agent' && x.agent === 'ledger').pop();
      const m2 = r2.messages.filter((x) => x.role === 'agent' && x.agent === 'marcus').pop();
      check('출처 표시: 있는 파일만 확인됨', m.cites && m.cites.find((c) => c.name === '단가표.txt').ok && m.cites.find((c) => c.name === '없는파일.pdf').ok === false && !m2.cites, JSON.stringify(m.cites));
      fs.writeFileSync(LOG, '');
      await api('/api/personas', { method: 'POST', body: JSON.stringify({ id: 'hunter', name: '헌터', engine: 'opencode', systemPrompt: '너는 헌터' }) });
      await up('hunter', '고객.md', '# 고객');
      await api(`/api/rooms/${rid}/messages`, { method: 'POST', body: JSON.stringify({ text: '@헌터 봐줘' }) }); await idle(rid);
      const hl = fs.readFileSync(LOG, 'utf8');
      check('오픈코드에는 자료 폴더 읽기 허용이 전달', hl.includes('external_directory') && hl.includes(path.join(DATA, 'knowledge', 'hunter')), hl.slice(0, 300));
      await fetch(B + '/api/knowledge/ledger?name=' + encodeURIComponent('단가표.txt'), { method: 'DELETE', headers: { 'x-token': TOK } });
      const k2 = (await api('/api/knowledge/ledger')).body;
      check('자료 빼기', !k2.files.some((f) => f.name === '단가표.txt'), JSON.stringify(k2.files)); }
  } catch (e) { check('테스트 실행', false, e.stack); }
  srv.kill('SIGTERM'); await sleep(500);
  const fail = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  if (fail) console.log(srvOut.slice(-1500));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
