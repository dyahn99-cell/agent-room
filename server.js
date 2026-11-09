// Agent Room — 클로드·코덱스·오픈코드가 함께 있는 단톡방 서버
// 외부 패키지 없이 Node 기본 모듈만 사용합니다.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const APP_DIR = __dirname;
const CONFIG_PATH = process.env.AGENT_ROOM_CONFIG || path.join(APP_DIR, 'config.json');
const DATA = process.env.AGENT_ROOM_DATA || path.join(os.homedir(), '.agent-room');
const ROOMS_DIR = path.join(DATA, 'rooms');
const UPLOADS = path.join(DATA, 'uploads');
const SHADOW = path.join(DATA, 'shadow');
const AVATARS = path.join(DATA, 'avatars');
const VERSION = '0.3.0';
const PIDS_FILE = path.join(DATA, 'pids.json');
for (const d of [DATA, ROOMS_DIR, UPLOADS, SHADOW, AVATARS]) fs.mkdirSync(d, { recursive: true });

// 기본 설정(config.default.json, 저장소에 포함) 위에 내 설정(config.json, 업데이트해도 안 바뀜)을 덮어씀
function loadConfig() {
  const def = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'config.default.json'), 'utf8'));
  let mine = {};
  if (fs.existsSync(CONFIG_PATH)) mine = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const out = { ...def, ...mine, agents: { ...def.agents } };
  for (const [k, v] of Object.entries(mine.agents || {})) out.agents[k] = { ...(def.agents[k] || {}), ...v };
  return out;
}
const config = loadConfig();
const PORT = Number(process.env.AGENT_ROOM_PORT || config.port || 8777);
const AGENT_IDS = Object.keys(config.agents);

const ALIASES = {
  claude: ['클로드', 'claude', '클로'],
  codex: ['코덱스', 'codex', 'gpt', '지피티'],
  opencode: ['오픈코드', 'opencode', 'oc'],
  all: ['전체', 'all', '모두', 'everyone'],
};

// ---------- 토큰 ----------
const TOKEN_FILE = path.join(DATA, 'token');
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { }
if (!TOKEN) { TOKEN = crypto.randomBytes(24).toString('base64url'); fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 }); }

// ---------- 유틸 ----------
function josa(word, pair) {
  const [a, b] = pair.split('/'); // a: 받침 있을 때, b: 없을 때
  const c = String(word).charCodeAt(String(word).length - 1);
  if (c < 0xac00 || c > 0xd7a3) return word + b;
  const jong = (c - 0xac00) % 28;
  if (pair === '으로/로') return word + (jong === 0 || jong === 8 ? '로' : '으로');
  return word + (jong ? a : b);
}
const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const now = () => Date.now();
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: opts.timeout || 30000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const availability = {};
async function checkAgents() {
  for (const id of AGENT_IDS) {
    const r = await run('sh', ['-lc', `command -v ${JSON.stringify(config.agents[id].command)}`], { timeout: 5000 });
    availability[id] = r.ok && r.stdout.trim().length > 0;
  }
}

// ---------- 모델 목록 / 상태 점검 ----------
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
let modelCache = null;
async function loadModels() {
  const out = {
    claude: { models: [{ id: '', name: '기본' }, { id: 'fable', name: 'Fable' }, { id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'haiku', name: 'Haiku' }], efforts: CLAUDE_EFFORTS },
    codex: { models: [{ id: '', name: '기본' }], efforts: ['low', 'medium', 'high', 'xhigh'] },
    opencode: { models: [{ id: '', name: '기본' }], efforts: ['minimal', 'low', 'medium', 'high', 'max'] },
  };
  if (availability.codex) {
    const r = await run(config.agents.codex.command, ['debug', 'models'], { timeout: 30000 });
    try {
      const j = JSON.parse(r.stdout); const arr = j.models || j; const eff = new Set();
      for (const m of arr) if (m.visibility !== 'hide') {
        const levels = (m.supported_reasoning_levels || []).map((e) => e.effort || e);
        levels.forEach((e) => eff.add(e));
        out.codex.models.push({ id: m.slug, name: m.display_name || m.slug, efforts: levels });
      }
      if (eff.size) out.codex.efforts = [...eff];
    } catch { }
  }
  if (availability.opencode) {
    const r = await run(config.agents.opencode.command, ['models'], { timeout: 40000 });
    const ids = r.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:/-]+$/.test(l));
    const free = ids.filter((i) => /free|big-pickle/.test(i)), rest = ids.filter((i) => !free.includes(i));
    for (const i of [...free, ...rest].slice(0, 120)) out.opencode.models.push({ id: i, name: i.replace(/^opencode\//, '') + (free.includes(i) ? ' · 무료' : '') });
  }
  modelCache = { at: now(), data: out };
  return out;
}
let codexSandbox = null; // true/false/null(미확인)
function codexSandboxOK() {
  const mode = config.agents.codex.sandbox || 'auto';
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return codexSandbox !== false;
}
// 쓰기 차단을 CLI가 보장 못 하는 경우 → 항상 스냅샷을 떠서 바뀐 게 보이고 되돌릴 수 있게
function needsCheckpoint(room, agentId) {
  if (room.writer === agentId) return true;
  if (agentId === 'codex' && !codexSandboxOK()) return true;
  if (agentId === 'claude' && ac(room, 'claude').role === 'checker') return true;
  return false;
}
let updateCache = null;
async function checkUpdate(force) {
  if (!force && updateCache && now() - updateCache.at < 10 * 60000) return updateCache.data;
  if (!fs.existsSync(path.join(APP_DIR, '.git'))) return { git: false, version: VERSION };
  const f = await run('git', ['-C', APP_DIR, 'fetch', '--quiet', 'origin'], { timeout: 60000 });
  const cur = (await run('git', ['-C', APP_DIR, 'rev-parse', '--short', 'HEAD'])).stdout.trim();
  const up = (await run('git', ['-C', APP_DIR, 'rev-parse', '--short', '@{u}'])).stdout.trim();
  const behind = +((await run('git', ['-C', APP_DIR, 'rev-list', '--count', 'HEAD..@{u}'])).stdout.trim() || 0);
  const log = behind ? (await run('git', ['-C', APP_DIR, 'log', '--format=%s', '-n', '15', 'HEAD..@{u}'])).stdout.trim().split('\n').filter(Boolean) : [];
  const data = { git: true, version: VERSION, current: cur, latest: up, behind, notes: log, fetchOk: f.ok, error: f.ok ? null : clip((f.stderr || '').trim(), 200) };
  updateCache = { at: now(), data };
  return data;
}
let healthCache = null;
async function checkHealth(force) {
  if (!force && healthCache && now() - healthCache.at < 60000) return healthCache.data;
  await checkAgents();
  const h = {};
  for (const id of AGENT_IDS) {
    if (!availability[id]) { h[id] = { ok: false, text: '설치 안 됨' }; continue; }
    const cmd = config.agents[id].command;
    if (id === 'claude') {
      const r = await run(cmd, ['auth', 'status'], { timeout: 20000 });
      let li = null; try { li = JSON.parse(r.stdout).loggedIn; } catch { li = /logged in/i.test(r.stdout) && !/not logged/i.test(r.stdout); }
      h[id] = li ? { ok: true, text: '로그인됨' } : { ok: false, text: '로그인 필요 (우분투에서 claude)' };
    } else if (id === 'codex') {
      const r = await run(cmd, ['login', 'status'], { timeout: 20000 });
      const t = r.stdout + r.stderr;
      h[id] = /not logged in/i.test(t) ? { ok: false, text: '로그인 필요 (우분투에서 codex login)' } : /logged in/i.test(t) ? { ok: true, text: '로그인됨' } : { ok: null, text: '확인 불가' };
      if (codexSandbox === null) {
        const sb = await run(cmd, ['sandbox', '--', 'true'], { timeout: 20000, cwd: os.tmpdir() });
        codexSandbox = sb.ok;
        if (!sb.ok) console.log('코덱스 샌드박스를 쓸 수 없는 환경이라 끄고, 대신 매 작업 스냅샷으로 보호해요:', clip((sb.stderr || sb.stdout).trim(), 200));
      }
      if (h[id].ok && !codexSandboxOK()) h[id].text += ' · 샌드박스 꺼짐(되돌리기로 보호)';
    } else {
      h[id] = { ok: true, text: '사용 가능' };
    }
  }
  healthCache = { at: now(), data: h };
  return h;
}

// ---------- 방 저장 ----------
const rooms = new Map();
const saveTimers = new Map();

function loadRooms() {
  for (const f of fs.readdirSync(ROOMS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, f), 'utf8'));
      for (const m of r.messages) if (m.status === 'running') m.status = 'stopped';
      rooms.set(r.id, r);
    } catch (e) { console.error('방 불러오기 실패', f, e.message); }
  }
}

function saveRoom(room, immediate) {
  clearTimeout(saveTimers.get(room.id));
  const write = () => {
    if (!rooms.has(room.id)) return; // 삭제된 방이 되살아나지 않게
    const p = path.join(ROOMS_DIR, room.id + '.json');
    fs.writeFileSync(p + '.tmp', JSON.stringify(room));
    fs.renameSync(p + '.tmp', p);
  };
  if (immediate) return write();
  saveTimers.set(room.id, setTimeout(write, 400));
}

function roomSummary(r) {
  const last = [...r.messages].reverse().find((m) => m.role !== 'system');
  return {
    id: r.id, title: r.title, cwd: r.cwd, writer: r.writer, autoTurns: r.autoTurns,
    defaultAgent: r.defaultAgent, updatedAt: r.updatedAt,
    agents: Object.fromEntries(AGENT_IDS.map((a) => [a, ac(r, a)])),
    queue: runtime(r.id).queue.map((q) => q.agent),
    busy: runtime(r.id).current ? runtime(r.id).current.agent : null,
    preview: last ? clip(last.text.replace(/\s+/g, ' '), 80) : '',
  };
}

// ---------- 실시간 이벤트 (SSE) ----------
const clients = new Set();
function broadcast(ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(data);
}
const msgTimers = new Map();
function pushMessage(room, msg, immediate) {
  room.updatedAt = now();
  saveRoom(room);
  const key = msg.id;
  if (immediate) {
    clearTimeout(msgTimers.get(key)); msgTimers.delete(key);
    broadcast({ type: 'message', roomId: room.id, message: msg });
    return;
  }
  if (msgTimers.has(key)) return;
  msgTimers.set(key, setTimeout(() => {
    msgTimers.delete(key);
    broadcast({ type: 'message', roomId: room.id, message: msg });
  }, 120));
}
function pushRoom(room) { broadcast({ type: 'room', room: roomSummary(room) }); }

// ---------- 스냅샷 (되돌리기용 그림자 git) ----------
const EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', 'dist/', 'build/', '.gradle/', '.next/', '*.apk', '.cache/',
  // 비밀·인증 파일은 스냅샷에 복사하지 않음
  '.ssh/', '.gnupg/', '.agent-room/', '.agent-room-share/', '.codex/', '.claude/', '.claude.json', '.config/', '.local/', '.npm/', '.opencode/',
  '.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'auth.json', 'credentials*', '.netrc', '.git-credentials'];
const cwdKey = (cwd) => crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 10);
function unsafeWriteDir(cwd) {
  const r = path.resolve(cwd);
  return r === '/' || r === path.resolve(os.homedir()) || r === '/root' || r === '/data/data/com.termux/files/home';
}
function gitEnv() {
  return { ...process.env, GIT_AUTHOR_NAME: 'agent-room', GIT_AUTHOR_EMAIL: 'room@local', GIT_COMMITTER_NAME: 'agent-room', GIT_COMMITTER_EMAIL: 'room@local' };
}
async function shadowGit(room, args, timeout = 30000, cwd = room.cwd) {
  const gd = path.join(SHADOW, room.id + '-' + cwdKey(cwd) + '.git');
  if (!fs.existsSync(gd)) {
    await run('git', ['init', '-q', '--bare', gd]);
    await run('git', ['--git-dir', gd, 'config', 'core.bare', 'false']);
    await run('git', ['--git-dir', gd, 'config', 'core.quotepath', 'false']);
    fs.mkdirSync(path.join(gd, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gd, 'info', 'exclude'), EXCLUDES.join('\n') + '\n');
  }
  fs.writeFileSync(path.join(gd, 'info', 'exclude'), EXCLUDES.join('\n') + '\n');
  return run('git', ['--git-dir', gd, '--work-tree', cwd, ...args], { env: gitEnv(), timeout, cwd });
}
async function snapshot(room, label) {
  if (process.env.AGENT_ROOM_TEST_SNAPSHOT_DELAY) await new Promise((r) => setTimeout(r, +process.env.AGENT_ROOM_TEST_SNAPSHOT_DELAY));
  const a = await shadowGit(room, ['add', '-A']);
  if (!a.ok) return null;
  await shadowGit(room, ['commit', '-q', '--allow-empty', '--no-verify', '-m', label]);
  const r = await shadowGit(room, ['rev-parse', 'HEAD']);
  return r.ok ? r.stdout.trim() : null;
}
async function changesSince(room, sha, cwd = room.cwd) {
  await shadowGit(room, ['add', '-A'], 30000, cwd);
  const ns = await shadowGit(room, ['diff', '--cached', '--numstat', sha], 30000, cwd);
  const st = await shadowGit(room, ['diff', '--cached', '--name-status', sha], 30000, cwd);
  const statusMap = {};
  for (const line of st.stdout.split('\n')) {
    const [s, ...rest] = line.split('\t');
    if (s && rest.length) statusMap[rest[rest.length - 1]] = s[0];
  }
  const files = [];
  for (const line of ns.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...p] = line.split('\t');
    const file = p.join('\t');
    files.push({ path: file, add: add === '-' ? 0 : +add, del: del === '-' ? 0 : +del, status: statusMap[file] || 'M' });
  }
  return files;
}
async function diffPatch(room, sha, cwd = room.cwd) {
  await shadowGit(room, ['add', '-A'], 30000, cwd);
  const r = await shadowGit(room, ['diff', '--cached', '--no-color', '-U3', sha], 30000, cwd);
  return clip(r.stdout, 300000);
}
async function revertTo(room, sha, cwd) {
  // 안전장치: 체크포인트를 만든 폴더와 지금 방 폴더가 같아야 하고, 그 체크포인트가 이 폴더 저장소에 있어야 함
  if (!cwd || path.resolve(cwd) !== path.resolve(room.cwd)) return { ok: false, error: '작업했던 폴더와 지금 방 폴더가 달라서 되돌릴 수 없어요.' };
  const exists = await shadowGit(room, ['cat-file', '-e', sha + '^{commit}'], 30000, cwd);
  if (!exists.ok) return { ok: false, error: '그 시점의 스냅샷을 찾을 수 없어요.' };
  // 되돌리기 직전 상태도 스냅샷으로 남겨서 되돌리기 자체를 취소할 수 있게
  const undo = await snapshot(room, 'before revert to ' + sha);
  if (!undo) return { ok: false, error: '현재 상태를 저장하지 못해서 되돌리기를 멈췄어요.' };
  const added = await shadowGit(room, ['diff', '--name-only', '--diff-filter=A', sha, undo], 30000, cwd);
  const root = path.resolve(cwd) + path.sep;
  for (const f of added.stdout.split('\n').filter(Boolean)) {
    const fp = path.resolve(cwd, f);
    if (!fp.startsWith(root)) continue;
    try { if (fs.lstatSync(fp).isFile() || fs.lstatSync(fp).isSymbolicLink()) fs.unlinkSync(fp); } catch { }
  }
  const r = await shadowGit(room, ['checkout', sha, '--', '.'], 30000, cwd);
  await shadowGit(room, ['add', '-A'], 30000, cwd);
  return r.ok ? { ok: true, undo } : { ok: false, error: '파일 복구에 실패했어요.' };
}

// ---------- 멘션 ----------
function parseMentions(text) {
  const found = [];
  const re = /@([^\s@,.!?:;()\[\]"'`]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const tok = m[1].toLowerCase();
    for (const [id, names] of Object.entries(ALIASES)) {
      if (names.some((n) => tok.startsWith(n.toLowerCase()))) { if (!found.includes(id)) found.push(id); break; }
    }
  }
  return found;
}

// ---------- 방별 AI 설정 ----------
const ROLES = {
  lead: { name: '판단', text: '판단·설계 담당이야. 방향을 정하고 다른 AI의 결과를 검토해서 최종 정리해. 직접 구현은 꼭 필요할 때만.' },
  builder: { name: '구현', text: '구현 담당이야. 실제로 코드를 짜고 고쳐. 끝나면 무엇을 바꿨는지 짧게 보고해.' },
  checker: { name: '확인', text: '확인 담당이야. 테스트·빌드·실행으로 결과가 맞는지 확인하고 증거(출력 요약, 스크린샷 파일 경로)를 보여줘. 코드는 고치지 마.' },
};
function ac(room, id) {
  const base = config.agents[id] || {};
  const o = (room.agents && room.agents[id]) || {};
  return { enabled: o.enabled !== false, role: o.role || '', model: o.model != null ? o.model : (base.model || ''), effort: o.effort || '' };
}
const enabledAgents = (room) => AGENT_IDS.filter((a) => ac(room, a).enabled);
function friendlyError(agentId, text) {
  const t = String(text || '');
  const n0 = config.agents[agentId]?.name || agentId; const n = n0;
  const login = { claude: 'claude', codex: 'codex login', opencode: 'opencode auth login' }[agentId];
  if (/401|unauthori[sz]ed|not logged in|login required|invalid api key|authentication|please run .*login|OAuth/i.test(t)) return `${n} 로그인이 필요해요. 우분투에서 \`${login}\` 실행 후 다시 시도해 주세요.`;
  if (/429|rate.?limit|usage limit|quota|too many requests/i.test(t)) return `${n} 사용량 한도에 걸렸어요. 잠시 뒤 다시 시도하거나 모델을 바꿔보세요.`;
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|network|getaddrinfo|socket hang up|fetch failed|tunnel/i.test(t)) return `${n} 네트워크 연결에 실패했어요. 인터넷 연결을 확인해 주세요.`;
  if (/model.*(not found|not exist|unknown|unsupported|invalid)|unknown model|does not exist/i.test(t)) return `${n} 모델 이름이 맞지 않아요. AI 설정에서 모델을 다시 골라주세요.`;
  if (/ENOENT|command not found|실행 실패/i.test(t)) return `${josa(n0, '을/를')} 실행하지 못했어요. 설치 상태를 확인해 주세요.`;
  return null;
}

// ---------- 프롬프트 ----------
function speaker(m) {
  if (m.role === 'user') return '사용자';
  if (m.role === 'agent') return config.agents[m.agent]?.name || m.agent;
  return '시스템';
}
function preamble(room, agentId) {
  const me = config.agents[agentId].name;
  const others = enabledAgents(room).filter((a) => a !== agentId).map((a) => '@' + config.agents[a].name).join(', ') || '(없음)';
  return [
    `너는 단톡방 "${room.title}"에 참여한 AI "${me}"야. 방에는 사용자와 다른 AI(${others})가 있어.`,
    `작업 폴더: ${room.cwd}`,
    '규칙:',
    '- 한국어로, 단톡방 말투로 짧고 분명하게 답해. 마지막에 쓴 답이 방에 그대로 올라가.',
    '- 파일 수정은 "작성 권한"이 있는 AI만 해. 권한이 없으면 읽기·검토·의견만 내.',
    `- 다른 AI에게 일을 넘기거나 의견을 물을 땐 답 안에 @이름(${others})을 써. 그러면 그 AI가 이어서 답해. 꼭 필요할 때만 불러.`,
    '- 막히거나 애매하면 먼저 다른 AI에게 물어봐. 사용자에게는 결정이 꼭 필요할 때만 물어봐.',
    '- 대화 기록에서 [이름] 표시는 누가 말했는지 알려주는 거야. 네 답에는 붙이지 마.',
  ].join('\n');
}
function buildPrompt(room, agentId, attachments) {
  const st = room.agentState[agentId] || (room.agentState[agentId] = {});
  const msgs = room.messages.filter((m) => m.role !== 'system' || m.forAgents);
  const startIdx = st.session ? (st.seen || 0) : Math.max(st.freshFrom || 0, msgs.length - 30);
  const fresh = msgs.slice(startIdx).filter((m) => !(m.role === 'agent' && (m.agent === agentId || m.status === 'error')) && m.status !== 'running');
  const lines = [];
  if (!st.session) lines.push(preamble(room, agentId), '', '[지금까지의 대화]');
  else lines.push('[새 메시지]');
  for (const m of fresh) {
    let t = `[${speaker(m)}] ${m.text.length > 6000 ? m.text.slice(0, 6000) + ` …(이하 ${m.text.length - 6000}자 생략)` : m.text}`;
    if (m.attachments && m.attachments.length) t += '\n(첨부 파일: ' + m.attachments.map((a) => a.path).join(', ') + ')';
    lines.push(t);
  }
  const writer = room.writer === agentId;
  lines.push('', `[시스템] 현재 작성 권한: ${writer ? '너에게 있음 (파일 수정 가능)' : (room.writer ? config.agents[room.writer].name + '에게 있음 — 너는 수정 금지, 검토·의견만' : '아무도 없음 — 파일 수정 금지')}.`);
  const role = ROLES[ac(room, agentId).role];
  if (role) lines.push(`[시스템] 네 역할: ${role.text}`);
  lines.push(`[시스템] 위 대화를 보고 ${config.agents[agentId].name}(으)로서 이어서 답해. 앞의 AI가 이미 한 말은 반복하지 말고 보태거나 반박할 것만 말해.`);
  const prevSeen = st.seen || 0;
  st.seen = msgs.length;
  return { prevSeen, text: lines.join('\n'), images: attachments.filter((a) => a.isImage).map((a) => a.path) };
}

// ---------- 에이전트 어댑터 ----------
function stepTitle(name, input) {
  input = input || {};
  const p = input.file_path || input.filePath || input.path || input.pattern || input.url || input.query || input.command || input.description || '';
  return p ? `${name} · ${clip(String(p), 120)}` : name;
}

const adapters = {
  claude: {
    build(room, prompt, st, writer) {
      const c = ac(room, 'claude');
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompts', 'none'];
      if (writer) args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Bash Read Edit Write Glob Grep WebSearch WebFetch TodoWrite');
      else args.push('--permission-mode', 'dontAsk', '--allowedTools', 'Read Glob Grep WebSearch WebFetch' + (c.role === 'checker' ? ' Bash' : ''));
      if (st.session) args.push('--resume', st.session);
      if (c.model) args.push('--model', c.model);
      if (c.effort) args.push('--effort', c.effort);
      return { args, stdin: prompt.text };
    },
    handle(ev, ctx) {
      if (ev.type === 'stream_event') {
        const e = ev.event || {};
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) ctx.live(e.delta.text);
        return;
      }
      if (ev.type === 'system' && ev.session_id) ctx.session(ev.session_id);
      else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) {
          if (b.type === 'text' && b.text) ctx.text(b.text, true);
          else if (b.type === 'tool_use') ctx.step({ id: b.id, kind: kindOf(b.name), title: stepTitle(b.name, b.input), status: 'running' });
          else if (b.type === 'thinking' && b.thinking) ctx.think(b.thinking);
        }
      } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) if (b.type === 'tool_result') {
          const out = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : String(b.content || '');
          ctx.stepDone(b.tool_use_id, b.is_error ? 'error' : 'done', out);
        }
      } else if (ev.type === 'result') {
        if (ev.session_id) ctx.session(ev.session_id);
        if (ev.is_error) ctx.error(ev.result || ev.error || '실패했어요');
        else if (typeof ev.result === 'string' && ev.result.trim()) ctx.final(ev.result);
      }
    },
  },
  codex: {
    build(room, prompt, st, writer) {
      const c = ac(room, 'codex');
      const sandbox = !codexSandboxOK() ? 'danger-full-access' : writer ? (config.agents.codex.writeSandbox || 'workspace-write') : 'read-only';
      const args = ['exec'];
      if (st.session) args.push('resume');
      args.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"');
      if (c.model) args.push('-m', c.model);
      if (c.effort) args.push('-c', `model_reasoning_effort="${c.effort}"`);
      if (st.session) args.push(st.session);
      args.push('-');
      // -i 는 값을 여러 개 받을 수 있어서 맨 뒤에 둬야 프롬프트를 이미지로 오해하지 않아요
      for (const img of prompt.images) args.push('-i', img);
      return { args, stdin: prompt.text };
    },
    handle(ev, ctx) {
      if (ev.type === 'thread.started' && ev.thread_id) return ctx.session(ev.thread_id);
      if (ev.type === 'error' || ev.type === 'turn.failed') return ctx.error((ev.error && ev.error.message) || ev.message || '실패했어요');
      const it = ev.item;
      if (it && /^item\./.test(ev.type)) {
        const done = ev.type === 'item.completed';
        switch (it.type) {
          case 'agent_message': if (done && it.text) ctx.text(it.text, true); break;
          case 'reasoning': if (done && it.text) ctx.think(it.text); break;
          case 'command_execution':
            if (!done) ctx.step({ id: it.id, kind: 'cmd', title: '명령 · ' + clip(it.command || '', 120), status: 'running' });
            else { ctx.step({ id: it.id, kind: 'cmd', title: '명령 · ' + clip(it.command || '', 120), status: 'running' }); ctx.stepDone(it.id, it.exit_code === 0 || it.status === 'completed' ? 'done' : 'error', it.aggregated_output || ''); }
            break;
          case 'file_change': {
            const files = (it.changes || []).map((c) => c.path).join(', ');
            ctx.step({ id: it.id, kind: 'edit', title: '파일 수정 · ' + clip(files, 120), status: 'running' });
            if (done) ctx.stepDone(it.id, it.status === 'failed' ? 'error' : 'done', '');
            break;
          }
          case 'mcp_tool_call': ctx.step({ id: it.id, kind: 'tool', title: `${it.server || ''} ${it.tool || ''}`.trim(), status: 'running' }); if (done) ctx.stepDone(it.id, 'done', ''); break;
          case 'web_search': ctx.step({ id: it.id, kind: 'web', title: '웹 검색 · ' + clip(it.query || '', 100), status: 'running' }); if (done) ctx.stepDone(it.id, 'done', ''); break;
          case 'error': ctx.error(it.message || '오류'); break;
        }
        return;
      }
      if (ev.msg && ev.msg.type === 'agent_message' && ev.msg.message) ctx.text(ev.msg.message, true);
    },
  },
  opencode: {
    build(room, prompt, st, writer) {
      const c = ac(room, 'opencode');
      const args = ['run', '--format', 'json', '--agent', writer ? 'build' : 'plan'];
      if (writer) args.push('--auto');
      if (c.model) args.push('--model', c.model);
      if (c.effort) args.push('--variant', c.effort);
      if (st.session) args.push('--session', st.session);
      args.push(prompt.text.replace(/^-+/, ''));
      return { args };
    },
    handle(ev, ctx) {
      if (ev.sessionID) ctx.session(ev.sessionID);
      const p = ev.part || {};
      if (ev.type === 'text' && p.text) ctx.text(p.text, true);
      else if (ev.type === 'reasoning' && p.text) ctx.think(p.text);
      else if (ev.type === 'tool_use') {
        const s = p.state || {};
        const id = p.id || p.callID || uid();
        ctx.step({ id, kind: kindOf(p.tool || ''), title: s.title ? `${p.tool} · ${clip(s.title, 120)}` : stepTitle(p.tool || '도구', s.input), status: 'running' });
        ctx.stepDone(id, s.status === 'error' ? 'error' : 'done', s.error || s.output || '');
      } else if (ev.type === 'error') {
        const e = ev.error || {};
        ctx.error((e.data && e.data.message) || e.message || e.name || '실패했어요');
      }
    },
  },
};
function kindOf(name) {
  const n = String(name).toLowerCase();
  if (/bash|shell|exec|command/.test(n)) return 'cmd';
  if (/edit|write|patch|multiedit/.test(n)) return 'edit';
  if (/read|glob|grep|list|ls/.test(n)) return 'read';
  if (/web|fetch|search/.test(n)) return 'web';
  return 'tool';
}

// ---------- 방별 실행 큐 ----------
const runtimes = new Map();
function runtime(id) {
  if (!runtimes.has(id)) runtimes.set(id, { queue: [], current: null });
  return runtimes.get(id);
}

function systemMsg(room, text) {
  const m = { id: uid(), role: 'system', text, ts: now() };
  room.messages.push(m);
  pushMessage(room, m, true);
  return m;
}

function enqueue(room, agentId, depth, attachments = []) {
  const rt = runtime(room.id);
  if (!config.agents[agentId]) return;
  if (rt.queue.some((q) => q.agent === agentId)) return;
  rt.queue.push({ agent: agentId, depth, attachments });
  pushRoom(room);
  pump(room);
}

function orderAgents(room, ids) {
  return [...ids].sort((a, b) => (a === room.writer ? -1 : b === room.writer ? 1 : AGENT_IDS.indexOf(a) - AGENT_IDS.indexOf(b)));
}

async function pump(room) {
  const rt = runtime(room.id);
  if (rt.current || rt.queue.length === 0) return;
  const job = rt.queue.shift();
  rt.current = { agent: job.agent, proc: null, stopped: false };
  pushRoom(room);
  try { await runAgent(room, job, rt.current); }
  catch (e) { systemMsg(room, '실행 중 오류: ' + e.message); }
  rt.current = null;
  pushRoom(room);
  if (rt.queue.length === 0) notifyIdle(room);
  setImmediate(() => pump(room));
}

async function runAgent(room, job, cur) {
  const agentId = job.agent;
  const a = config.agents[agentId];
  const st = room.agentState[agentId] || (room.agentState[agentId] = {});
  const writer = room.writer === agentId;

  const msg = { id: uid(), role: 'agent', agent: agentId, text: '', status: 'running', ts: now(), steps: [], writer };
  room.messages.push(msg);
  pushMessage(room, msg, true);

  if (!availability[agentId]) {
    msg.status = 'error'; msg.errorHint = `${josa(a.name, '이/가')} 설치되어 있지 않아요. (명령: ${a.command})`; msg.text = '⚠️ ' + msg.errorHint;
    pushMessage(room, msg, true); return;
  }
  if (!fs.existsSync(room.cwd)) {
    msg.status = 'error'; msg.errorHint = `작업 폴더가 없어요: ${room.cwd}`; msg.text = '⚠️ ' + msg.errorHint;
    pushMessage(room, msg, true); return;
  }

  if (!healthCache || now() - healthCache.at > 300000) { try { await checkHealth(true); } catch { } }
  const h = healthCache && healthCache.data[agentId];
  if (h && h.ok === false) {
    msg.status = 'error'; msg.errorHint = `${a.name}: ${h.text}`; msg.text = '⚠️ ' + msg.errorHint;
    pushMessage(room, msg, true); return;
  }
  if (writer && unsafeWriteDir(room.cwd)) {
    msg.status = 'error'; msg.errorHint = '홈 폴더나 최상위 폴더에서는 작성 권한을 쓸 수 없어요. 방 설정에서 프로젝트 폴더를 골라주세요.'; msg.text = '⚠️ ' + msg.errorHint;
    pushMessage(room, msg, true); return;
  }
  if (needsCheckpoint(room, agentId) && !unsafeWriteDir(room.cwd)) {
    msg.checkpoint = await snapshot(room, `before ${agentId} ${msg.id}`);
    msg.checkpointCwd = room.cwd;
    if (!msg.checkpoint) msg.snapshotFailed = true;
  }
  // 준비하는 사이에 중지됐거나 방이 지워졌으면 실행하지 않음
  if (cur.stopped || !rooms.has(room.id)) {
    msg.status = 'stopped'; msg.text = '(중지됨)'; pushMessage(room, msg, true); return;
  }

  const prompt = buildPrompt(room, agentId, job.attachments || []);
  const { args, stdin } = adapters[agentId].build(room, prompt, st, writer);

  const texts = [];
  let finalText = null, errorText = null;
  const ctx = {
    session: (s) => { if (s && st.session !== s) { st.session = s; saveRoom(room); } },
    text: (t) => { texts.push(t); msg.text = texts.join('\n\n'); msg.live = ''; pushMessage(room, msg); },
    live: (d) => { msg.live = (msg.live || '') + d; pushMessage(room, msg); },
    final: (t) => { finalText = t; },
    think: (t) => { msg.thinking = clip(t, 400); pushMessage(room, msg); },
    step: (s) => {
      if (s.title) s.title = s.title.split(room.cwd.replace(/\/$/, '') + '/').join('');
      const ex = msg.steps.find((x) => x.id === s.id);
      if (ex) Object.assign(ex, { title: s.title || ex.title });
      else { msg.steps.push({ ...s, ts: now() }); if (msg.steps.length > 200) msg.steps.shift(); }
      pushMessage(room, msg);
    },
    stepDone: (id, status, out) => {
      const s = msg.steps.find((x) => x.id === id);
      if (s) { s.status = status; if (out) s.output = clip(String(out), 1500); }
      pushMessage(room, msg);
    },
    error: (e) => { errorText = typeof e === 'string' ? e : JSON.stringify(e); },
  };

  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' };
  const proc = spawn(a.command, args, { cwd: room.cwd, env, detached: true, stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  cur.proc = proc;
  trackPid(proc.pid, true);
  if (stdin != null) { proc.stdin.on('error', () => { }); proc.stdin.end(stdin); }

  let buf = '', stderr = '';
  const idleMs = (config.idleTimeoutSec || 600) * 1000;
  let lastOut = now(); let timedOut = false;
  const watchdog = setInterval(() => {
    if (now() - lastOut > idleMs) {
      timedOut = true; clearInterval(watchdog);
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch { } }
    }
  }, 5000);
  proc.stdout.on('data', (d) => {
    lastOut = now();
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      try { adapters[agentId].handle(ev, ctx); } catch (e) { console.error('이벤트 처리 오류', e); }
    }
  });
  proc.stderr.on('data', (d) => { stderr = clip(stderr + d.toString('utf8'), 8000); });

  const code = await new Promise((resolve) => {
    proc.on('error', (e) => { errorText = errorText || ('실행 실패: ' + e.message); resolve(-1); });
    proc.on('close', (c) => resolve(c));
  });
  clearInterval(watchdog);
  trackPid(proc.pid, false);
  if (timedOut && !errorText) errorText = `${Math.round(idleMs / 60000)}분 동안 아무 응답이 없어서 멈췄어요. 로그인·네트워크 상태를 확인해 주세요.`;

  for (const s of msg.steps) if (s.status === 'running') s.status = cur.stopped ? 'stopped' : 'done';
  if (finalText && finalText.trim()) msg.text = finalText.trim();
  delete msg.thinking;
  delete msg.live;

  if (cur.stopped) {
    msg.status = 'stopped';
    if (!msg.text) msg.text = '(중지됨)';
  } else if (errorText || code !== 0) {
    msg.status = 'error';
    const detail = errorText || clip(stderr.trim().split('\n').slice(-6).join('\n'), 800) || `종료 코드 ${code}`;
    msg.errorHint = friendlyError(agentId, detail + '\n' + stderr) || null;
    msg.errorDetail = clip(detail, 1500);
    msg.text = (msg.text ? msg.text + '\n\n' : '') + '⚠️ ' + (msg.errorHint || clip(detail, 400));
  } else {
    msg.status = 'done';
    if (!msg.text) msg.text = '(답변 없음)';
  }

  if (msg.status !== 'done') { st.seen = prompt.prevSeen; } // 실패하면 다음에 같은 메시지를 다시 보여줌
  if (msg.checkpoint) {
    try { msg.changes = await changesSince(room, msg.checkpoint, msg.checkpointCwd); } catch { }
    if (!writer && msg.changes && msg.changes.length) msg.unexpected = true; // 읽기 전용인데 파일이 바뀜
  }
  msg.doneAt = now();
  pushMessage(room, msg, true);

  // 다른 AI 호출 (자동 턴)
  if (msg.status === 'done') {
    const targets = parseMentions(msg.text).filter((t) => t !== 'all' && t !== agentId && ac(room, t).enabled);
    if (targets.length) {
      if (job.depth + 1 > room.autoTurns) {
        systemMsg(room, `AI끼리 자동으로 ${room.autoTurns}번 주고받아서 멈췄어요. 이어가려면 직접 불러주세요.`);
      } else {
        for (const t of orderAgents(room, targets)) enqueue(room, t, job.depth + 1);
      }
    }
  }
}

const TERMUX_NOTIFY = '/data/data/com.termux/files/usr/bin/termux-notification';
function notifyIdle(room) {
  const last = [...room.messages].reverse().find((m) => m.role === 'agent');
  if (!last) return;
  const name = config.agents[last.agent]?.name || last.agent;
  const body = `${name}: ${clip((last.status === 'error' ? (last.errorHint || '실패') : last.text).replace(/\s+/g, ' '), 140)}`;
  broadcast({ type: 'idle', roomId: room.id, title: room.title, body });
  if (config.notify === false || !fs.existsSync(TERMUX_NOTIFY)) return;
  const link = `http://127.0.0.1:${PORT}/#${TOKEN}`;
  const env = { ...process.env, PATH: '/data/data/com.termux/files/usr/bin:' + process.env.PATH };
  delete env.LD_PRELOAD;
  execFile(TERMUX_NOTIFY, ['--id', 'agentroom-' + room.id, '--title', room.title, '--content', body, '--action', `termux-open-url ${link}`], { env, timeout: 10000 }, () => { });
}

const livePids = new Set();
function trackPid(pid, add) {
  if (!pid) return;
  add ? livePids.add(pid) : livePids.delete(pid);
  try { fs.writeFileSync(PIDS_FILE, JSON.stringify([...livePids])); } catch { }
}
function reapOrphans() {
  let pids = [];
  try { pids = JSON.parse(fs.readFileSync(PIDS_FILE, 'utf8')); } catch { }
  for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { } try { process.kill(pid, 'SIGKILL'); } catch { } }
  if (pids.length) console.log(`지난번에 남은 AI 프로세스 ${pids.length}개를 정리했어요`);
  try { fs.writeFileSync(PIDS_FILE, '[]'); } catch { }
}

function stopRoom(room) {
  const rt = runtime(room.id);
  rt.queue = [];
  if (rt.current) rt.current.stopped = true;
  if (rt.current && rt.current.proc) {
    const pid = rt.current.proc.pid;
    try { process.kill(-pid, 'SIGTERM'); } catch { try { rt.current.proc.kill('SIGTERM'); } catch { } }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { } }, 3000);
  }
}

// ---------- 사용자 메시지 ----------
function postUser(room, text, attachIds) {
  const attachments = (attachIds || []).map((id) => (room.uploads || []).find((u) => u.id === id)).filter(Boolean);
  const m = { id: uid(), role: 'user', text, ts: now(), attachments };
  room.messages.push(m);
  pushMessage(room, m, true);
  let targets = parseMentions(text);
  const on = enabledAgents(room);
  if (targets.includes('all')) targets = on.filter((a) => availability[a]);
  const off = targets.filter((t) => !on.includes(t));
  if (off.length) systemMsg(room, josa(off.map((t) => config.agents[t].name).join(', '), '은/는') + ' 이 방에서 빠져 있어요. AI 설정에서 켜주세요.');
  targets = targets.filter((t) => on.includes(t));
  if (!targets.length && !parseMentions(text).length) {
    const pick = [room.lastAgent, room.defaultAgent, ...on].find((a) => a && on.includes(a));
    if (pick) targets = [pick];
  }
  room.lastAgent = targets[targets.length - 1];
  for (const t of orderAgents(room, targets)) enqueue(room, t, 0, attachments);
  pushRoom(room);
}

// ---------- HTTP ----------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function authed(req, url) {
  const t = req.headers['x-token'] || url.searchParams.get('token');
  if (!t) return false;
  const a = Buffer.from(String(t)), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newRoom({ title, cwd }) {
  const room = {
    id: uid(), title: (title || '').trim() || '새 방', cwd: cwd || os.homedir(),
    writer: null, autoTurns: config.autoTurns ?? 3, defaultAgent: config.defaultAgent || AGENT_IDS[0],
    createdAt: now(), updatedAt: now(), messages: [], agentState: {}, uploads: [],
  };
  rooms.set(room.id, room);
  saveRoom(room, true);
  return room;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname;
  try {
    if (!p.startsWith('/api/') && !p.startsWith('/view/')) {
      let f = p === '/' ? '/index.html' : p;
      const fp = path.normalize(path.join(APP_DIR, 'public', f));
      if (!fp.startsWith(path.join(APP_DIR, 'public'))) return send(res, 403, 'forbidden', 'text/plain');
      if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(fp), MIME[path.extname(fp)] || 'application/octet-stream');
    }
    const vm = p.match(/^\/view\/([a-z0-9]+)\/([A-Za-z0-9_-]+)\/(.+)$/);
    if (vm) {
      const t = Buffer.from(vm[2]), k = Buffer.from(TOKEN);
      if (t.length !== k.length || !crypto.timingSafeEqual(t, k)) return send(res, 401, { error: '인증이 필요해요' });
      req.headers['x-token'] = TOKEN;
      url.pathname = `/api/rooms/${vm[1]}/file`; url.searchParams.set('path', decodeURIComponent(vm[3]));
      p = url.pathname;
    }
    if (!authed(req, url)) return send(res, 401, { error: '인증이 필요해요' });

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      const ka = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }
    if (p === '/api/state' && req.method === 'GET') {
      await checkAgents();
      return send(res, 200, {
        home: os.homedir(),
        version: VERSION,
        agents: AGENT_IDS.map((id) => { const f = path.join(AVATARS, id); return { id, name: config.agents[id].name, color: config.agents[id].color, model: config.agents[id].model || '', available: !!availability[id], avatar: fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0 }; }),
        rooms: [...rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(roomSummary),
      });
    }
    if (p === '/api/models' && req.method === 'GET') {
      if (!modelCache || url.searchParams.get('refresh')) await loadModels();
      return send(res, 200, modelCache.data);
    }
    if (p === '/api/health' && req.method === 'GET') {
      return send(res, 200, await checkHealth(!!url.searchParams.get('force')));
    }
    const av = p.match(/^\/api\/avatar\/([a-z]+)$/);
    if (av && config.agents[av[1]]) {
      const f = path.join(AVATARS, av[1]);
      if (req.method === 'GET') {
        if (!fs.existsSync(f)) return send(res, 404, { error: 'none' });
        const buf = fs.readFileSync(f);
        const type = buf.slice(0, 4).toString('hex') === '89504e47' ? 'image/png' : buf.slice(0, 2).toString('hex') === 'ffd8' ? 'image/jpeg' : buf.slice(0, 4).toString() === 'RIFF' ? 'image/webp' : /<svg/i.test(buf.slice(0, 200).toString()) ? 'image/svg+xml' : 'application/octet-stream';
        return send(res, 200, buf, type);
      }
      if (req.method === 'POST') { fs.writeFileSync(f, await readBody(req, 3 * 1024 * 1024)); return send(res, 200, { ok: true }); }
      if (req.method === 'DELETE') { try { fs.unlinkSync(f); } catch { } return send(res, 200, { ok: true }); }
    }
    if (p === '/api/update' && req.method === 'GET') {
      return send(res, 200, await checkUpdate(!!url.searchParams.get('force')));
    }
    if (p === '/api/update' && req.method === 'POST') {
      const busy = [...rooms.values()].some((r) => runtime(r.id).current || runtime(r.id).queue.length);
      if (busy) return send(res, 409, { error: 'AI가 작업 중이에요. 끝나거나 중지한 뒤에 업데이트해 주세요.' });
      const pull = await run('git', ['-C', APP_DIR, 'pull', '--ff-only'], { timeout: 120000 });
      if (!pull.ok) return send(res, 500, { error: '받기 실패: ' + clip((pull.stderr || pull.stdout).trim(), 300) });
      send(res, 200, { ok: true, restarting: true });
      broadcast({ type: 'restarting' });
      setTimeout(() => { for (const r of rooms.values()) saveRoom(r, true); process.exit(75); }, 400); // 75 = start.sh가 다시 켜줌
      return;
    }
    if (p === '/api/fs' && req.method === 'GET') {
      const dir = path.resolve(url.searchParams.get('path') || os.homedir());
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name).sort((a, b) => a.localeCompare(b));
      } catch (e) { return send(res, 400, { error: '폴더를 열 수 없어요' }); }
      return send(res, 200, { path: dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, dirs: entries });
    }
    if (p === '/api/fs/mkdir' && req.method === 'POST') {
      const b = await readJSON(req);
      const dir = path.resolve(b.path || '');
      fs.mkdirSync(dir, { recursive: true });
      return send(res, 200, { path: dir });
    }
    if (p === '/api/rooms' && req.method === 'POST') {
      const b = await readJSON(req);
      const room = newRoom(b);
      pushRoom(room);
      return send(res, 200, roomSummary(room));
    }
    const m = p.match(/^\/api\/rooms\/([a-z0-9]+)(\/[a-z]+)?$/);
    if (m) {
      const room = rooms.get(m[1]);
      if (!room) return send(res, 404, { error: '방이 없어요' });
      const sub = m[2] || '';
      if (!sub && req.method === 'GET') return send(res, 200, { ...roomSummary(room), messages: room.messages });
      if (!sub && req.method === 'PATCH') {
        const b = await readJSON(req);
        if (typeof b.title === 'string' && b.title.trim()) room.title = b.title.trim();
        if (typeof b.cwd === 'string' && b.cwd) { room.cwd = b.cwd; if (unsafeWriteDir(room.cwd) && room.writer) { room.writer = null; systemMsg(room, '홈 폴더에서는 작성 권한을 쓸 수 없어서 거뒀어요.'); } }
        if ('writer' in b && (b.writer === null || config.agents[b.writer])) {
          if (b.writer && unsafeWriteDir(room.cwd)) return send(res, 400, { error: '홈 폴더나 최상위 폴더에서는 작성 권한을 줄 수 없어요. 프로젝트 폴더로 방 폴더를 바꿔주세요.' });
          if (room.writer !== b.writer) {
            room.writer = b.writer;
            const sm = systemMsg(room, b.writer ? `${config.agents[b.writer].name}에게 작성 권한을 줬어요.` : '작성 권한을 거뒀어요. 지금은 모두 읽기만 해요.');
            sm.forAgents = true;
          }
        }
        if (Number.isInteger(b.autoTurns) && b.autoTurns >= 0 && b.autoTurns <= 10) room.autoTurns = b.autoTurns;
        if (b.defaultAgent && config.agents[b.defaultAgent]) room.defaultAgent = b.defaultAgent;
        if (b.agents && typeof b.agents === 'object') {
          room.agents = room.agents || {};
          for (const [id, v] of Object.entries(b.agents)) {
            if (!config.agents[id] || !v) continue;
            const before = ac(room, id);
            const cur = room.agents[id] || (room.agents[id] = {});
            if (typeof v.enabled === 'boolean') cur.enabled = v.enabled;
            if (typeof v.role === 'string' && (v.role === '' || ROLES[v.role])) cur.role = v.role;
            if (typeof v.model === 'string') cur.model = v.model.trim();
            if (typeof v.effort === 'string') cur.effort = v.effort;
            const after = ac(room, id);
            const nm = config.agents[id].name;
            if (before.model !== after.model || before.effort !== after.effort) {
              const st = room.agentState[id] || (room.agentState[id] = {});
              st.session = null; // 새 모델로 새로 시작하되, 방 대화는 다시 넘겨줘서 맥락 유지
              systemMsg(room, `${nm} 모델을 ${josa((after.model || '기본 모델') + (after.effort ? ' · ' + after.effort : ''), '으로/로')} 바꿨어요. 지금까지 대화는 이어서 넘겨줘요.`);
            }
            if (before.enabled !== after.enabled) systemMsg(room, `${josa(nm, '이/가')} 방에서 ${after.enabled ? '다시 참여해요' : '빠졌어요'}.`);
            if (before.role !== after.role) { const sm = systemMsg(room, `${nm} 역할: ${after.role ? ROLES[after.role].name : '없음'}`); sm.forAgents = true; }
            if (!after.enabled && room.writer === id) room.writer = null;
          }
        }
        room.updatedAt = now(); saveRoom(room); pushRoom(room);
        return send(res, 200, roomSummary(room));
      }
      if (!sub && req.method === 'DELETE') {
        stopRoom(room); rooms.delete(room.id); clearTimeout(saveTimers.get(room.id));
        try { fs.unlinkSync(path.join(ROOMS_DIR, room.id + '.json')); } catch { }
        try { fs.rmSync(path.join(SHADOW, room.id + '.git'), { recursive: true, force: true }); } catch { }
        try { fs.rmSync(path.join(UPLOADS, room.id), { recursive: true, force: true }); } catch { }
        broadcast({ type: 'roomDeleted', roomId: room.id });
        return send(res, 200, { ok: true });
      }
      if (sub === '/messages' && req.method === 'POST') {
        const b = await readJSON(req);
        const text = String(b.text || '').trim();
        if (!text && !(b.attachments || []).length) return send(res, 400, { error: '내용이 없어요' });
        postUser(room, text || '(첨부 파일)', b.attachments);
        return send(res, 200, { ok: true });
      }
      if (sub === '/stop' && req.method === 'POST') { stopRoom(room); return send(res, 200, { ok: true }); }
      if (sub === '/dequeue' && req.method === 'POST') {
        const b = await readJSON(req);
        const rt = runtime(room.id);
        rt.queue = rt.queue.filter((q) => q.agent !== b.agent);
        pushRoom(room);
        return send(res, 200, { ok: true });
      }
      if (sub === '/retry' && req.method === 'POST') {
        const b = await readJSON(req);
        const m0 = room.messages.find((x) => x.id === b.msgId && x.role === 'agent');
        if (!m0) return send(res, 404, { error: '메시지가 없어요' });
        if (!ac(room, m0.agent).enabled) return send(res, 400, { error: '이 방에서 빠져 있는 AI예요' });
        healthCache = null; await checkAgents();
        enqueue(room, m0.agent, 0);
        return send(res, 200, { ok: true });
      }
      if (sub === '/reset' && req.method === 'POST') {
        const b = await readJSON(req);
        if (!config.agents[b.agent]) return send(res, 400, { error: '알 수 없는 AI' });
        const st = room.agentState[b.agent] || (room.agentState[b.agent] = {});
        st.session = null;
        st.freshFrom = room.messages.filter((m) => m.role !== 'system' || m.forAgents).length;
        systemMsg(room, `${config.agents[b.agent].name}의 기억을 지웠어요. 다음부터 새로 시작해요.`);
        return send(res, 200, { ok: true });
      }
      if (sub === '/review' && req.method === 'POST') {
        const b = await readJSON(req);
        const m0 = room.messages.find((x) => x.id === b.msgId && x.role === 'agent');
        if (!m0) return send(res, 404, { error: '메시지가 없어요' });
        const nm = config.agents[m0.agent].name;
        if (b.verdict === 'approve') {
          m0.review = 'approved'; pushMessage(room, m0, true);
          const sm = systemMsg(room, `${nm}의 작업을 승인했어요.`); sm.forAgents = true;
        } else if (b.verdict === 'reject') {
          m0.review = 'rejected'; pushMessage(room, m0, true);
          const reason = String(b.reason || '').trim() || '다시 해줘';
          postUser(room, `@${nm} 반려: ${reason}`, []);
        } else return send(res, 400, { error: '잘못된 요청' });
        return send(res, 200, { ok: true });
      }
      if (sub === '/file' && req.method === 'GET') {
        const rel = url.searchParams.get('path') || '';
        const fp = path.resolve(room.cwd, rel);
        if (!fp.startsWith(path.resolve(room.cwd) + path.sep)) return send(res, 403, { error: 'forbidden' });
        if (!fs.existsSync(fp) || fs.statSync(fp).size > 15 * 1024 * 1024) return send(res, 404, { error: '파일이 없어요' });
        const ext = path.extname(fp).toLowerCase();
        const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8' };
        // AI가 만든 HTML은 앱과 분리된 샌드박스로 열어서 앱의 접속 토큰에 손대지 못하게
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-forms allow-modals', 'X-Content-Type-Options': 'nosniff' });
        return res.end(fs.readFileSync(fp));
      }
      if (sub === '/upload' && req.method === 'POST') {
        const name = path.basename(url.searchParams.get('name') || 'file').replace(/[^\w.\-가-힣]/g, '_').slice(-80);
        const body = await readBody(req, 30 * 1024 * 1024);
        const dir = path.join(UPLOADS, room.id); fs.mkdirSync(dir, { recursive: true });
        const fp = path.join(dir, Date.now().toString(36) + '-' + name);
        fs.writeFileSync(fp, body);
        const u = { id: uid(), name, path: fp, size: body.length, isImage: /\.(png|jpe?g|gif|webp)$/i.test(name) };
        (room.uploads || (room.uploads = [])).push(u); saveRoom(room);
        return send(res, 200, u);
      }
      if (sub === '/changes' && req.method === 'GET') {
        const sha = url.searchParams.get('since');
        if (!/^[0-9a-f]{7,40}$/.test(sha || '')) return send(res, 400, { error: '잘못된 체크포인트' });
        const owner = room.messages.find((x) => x.checkpoint === sha || x.undoCheckpoint === sha);
        const cwd = (owner && (owner.checkpointCwd || owner.undoCwd)) || room.cwd;
        if (path.resolve(cwd) !== path.resolve(room.cwd)) return send(res, 409, { error: '작업했던 폴더와 지금 방 폴더가 달라요.' });
        const files = await changesSince(room, sha, cwd);
        const patch = await diffPatch(room, sha, cwd);
        return send(res, 200, { files, patch });
      }
      if (sub === '/revert' && req.method === 'POST') {
        const b = await readJSON(req);
        if (!/^[0-9a-f]{7,40}$/.test(b.checkpoint || '')) return send(res, 400, { error: '잘못된 체크포인트' });
        if (runtime(room.id).current) return send(res, 409, { error: '작업 중에는 되돌릴 수 없어요. 먼저 중지해 주세요.' });
        // 체크포인트는 이 방 메시지에 기록된 것만 허용
        const owner = room.messages.find((x) => x.checkpoint === b.checkpoint || x.undoCheckpoint === b.checkpoint);
        if (!owner) return send(res, 404, { error: '이 방의 체크포인트가 아니에요.' });
        const cwd = owner.checkpoint === b.checkpoint ? owner.checkpointCwd : owner.undoCwd;
        const r = await revertTo(room, b.checkpoint, cwd || (owner.checkpoint === b.checkpoint && !owner.checkpointCwd ? room.cwd : null));
        if (!r.ok) { systemMsg(room, '되돌리기 실패: ' + r.error); return send(res, 409, { error: r.error }); }
        const sm = systemMsg(room, owner.undoCheckpoint === b.checkpoint ? '되돌리기를 취소했어요.' : '파일을 그 작업 전 상태로 되돌렸어요.');
        sm.forAgents = true; sm.undoCheckpoint = r.undo; sm.undoCwd = room.cwd; pushMessage(room, sm, true);
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

reapOrphans();
loadRooms();
checkAgents().then(() => {
  checkHealth(true).catch(() => { });
  loadModels().catch(() => { });
  server.listen(PORT, '127.0.0.1', () => {
    const link = `http://127.0.0.1:${PORT}/#${TOKEN}`;
    fs.writeFileSync(path.join(DATA, 'url.txt'), link + '\n', { mode: 0o600 });
    if (process.env.AGENT_ROOM_URL_FILE) {
      const share = path.dirname(process.env.AGENT_ROOM_URL_FILE);
      for (const f of ['start.sh', 'stop.sh']) { try { fs.copyFileSync(path.join(APP_DIR, f), path.join(share, f)); } catch { } } try { fs.writeFileSync(process.env.AGENT_ROOM_URL_FILE, link + '\n', { mode: 0o600 }); } catch (e) { console.error('주소 파일 쓰기 실패', e.message); } }
    console.log('Agent Room 실행 중:', link);
    console.log('설치 확인:', AGENT_IDS.map((id) => `${config.agents[id].name} ${availability[id] ? 'O' : 'X'}`).join(' · '));
  });
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  for (const r of rooms.values()) { stopRoom(r); saveRoom(r, true); }
  // 자식 프로세스가 끝날 시간을 잠깐 주고, 남으면 강제 종료
  setTimeout(() => { for (const pid of livePids) { try { process.kill(-pid, 'SIGKILL'); } catch { } } process.exit(0); }, 1500);
});
