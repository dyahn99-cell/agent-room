#!/usr/bin/env node
// 테스트용 가짜 CLI: claude / codex / opencode 의 JSON 출력 형식을 흉내냅니다.
const fs = require('fs');
const path = require('path');
const kind = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

async function main() {
  if (kind === 'acpagent') return acpMain();
  // 상태 점검용 하위 명령은 바로 응답
  const sub = args[0];
  if (sub === 'auth') { out({ loggedIn: true }); return; }
  if (sub === 'login') { console.log('Logged in using ChatGPT'); return; }
  if (sub === 'sandbox') return;
  if (sub === 'debug') { console.log(JSON.stringify({ models: [] })); return; }
  if (sub === 'models') { console.log('opencode/big-pickle'); return; }
  let prompt = '';
  if (kind === 'claude') prompt = fs.readFileSync(0, 'utf8');
  else if (kind === 'opencode') prompt = args[args.length - 1];
  else prompt = fs.readFileSync(0, 'utf8');
  const joined = args.join(' ');
  const writer = kind === 'claude' ? joined.includes('acceptEdits') : kind === 'codex' ? joined.includes('workspace-write') : joined.includes('--agent build');
  const resumed = kind === 'claude' ? args.includes('--resume') : kind === 'codex' ? args.includes('resume') : args.includes('--session');
  if (process.env.MOCK_LOG) fs.appendFileSync(process.env.MOCK_LOG, `\n===== ${kind} writer=${writer} resumed=${resumed} perm=${process.env.OPENCODE_PERMISSION || ''} args=${JSON.stringify(args.filter((a) => a !== prompt))}\n${prompt}\n`);

  const lastUser = (prompt.match(/\[(사용자|클로드|코덱스|오픈코드)\][^\n]*/g) || []).pop() || '';
  const sid = kind + '-session-1';
  const names = { claude: '클로드', codex: '코덱스', opencode: '오픈코드' };
  let reply = `${names[kind]}입니다. "${lastUser.slice(0, 40)}" 확인했어요.${writer ? ' 파일을 수정했어요.' : ' 읽기만 했어요.'}\n\n- 첫째 포인트\n- 둘째 포인트 \`code\``;
  if (/핑퐁/.test(lastUser)) reply += kind === 'claude' ? '\n\n다음: @코덱스 이어서 봐줘' : '\n\n다음: @클로드 다시 봐줘';
  if (/넘겨/.test(lastUser) && kind === 'claude') reply += '\n\n다음: @오픈코드 의견 줘';
  if (/기억해/.test(lastUser)) reply += `\n\n<기억>\n- ${kind} 합의: 슬라이드는 10장\n- 색은 주황\n</기억>`;
  if (/정리다시/.test(lastUser)) reply += `\n\n<기억>\n- 새로 정한 것\n</기억>`;
  if (/덧붙여/.test(lastUser)) { const m = prompt.match(/\[확정\] (- [^\n]+)/); reply += `\n\n<기억>\n${m ? m[1].replace(/[.。]\s*$/, '') + '. 그리고 덧붙임' : '- x'}\n</기억>`; }
  if (/아이디어줘/.test(lastUser)) reply += `\n\n나중에 해볼 아이디어: 다음엔 사례 영상도 넣자`;
  if (/자료봐/.test(lastUser)) reply += '\n\n단가는 120원이야 [자료: 단가표.txt] 그리고 사양은 [자료: 사양서.docx, 없는파일.pdf]';
  if (/언급만/.test(lastUser) && kind === 'claude') reply += '\n\n@코덱스 말도 일리가 있어.\n> @오픈코드 인용';
  const slow = /느리게/.test(lastUser);
  if (/실패멘션/.test(lastUser)) { out(kind==='claude'?{ type: 'assistant', message: { content: [{ type: 'text', text: '반쯤 하다 망했어 @코덱스 도와줘' }] } }:{type:'x'}); process.stderr.write('boom\n'); process.exit(2); }
  if (/실패/.test(lastUser)) { process.stderr.write('API key invalid: 401 Unauthorized\n'); process.exit(1); }

  if (kind === 'claude') {
    out({ type: 'system', subtype: 'init', session_id: sid });
    await sleep(200);
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }] } });
    await sleep(300);
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '# readme' }] } });
    if (slow) await sleep(30000);
    if (writer && /페이지/.test(lastUser)) { fs.mkdirSync('slides', { recursive: true }); fs.writeFileSync('slides/index.html', '<h1>slides</h1>'); }
    if (writer) {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'hello-claude.txt' } }] } });
      fs.writeFileSync('hello-claude.txt', 'hello from claude\n' + Date.now() + '\n');
      try { fs.appendFileSync('README.md', '\n클로드가 추가한 줄\n'); } catch { }
      await sleep(300);
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } });
    }
    out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sid });
  } else if (kind === 'codex') {
    out({ type: 'thread.started', thread_id: sid });
    out({ type: 'turn.started' });
    await sleep(200);
    out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls -la', status: 'in_progress' } });
    await sleep(400);
    out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls -la', aggregated_output: 'README.md\n', exit_code: 0, status: 'completed' } });
    if (slow) await sleep(30000);
    if (writer) {
      fs.writeFileSync('hello-codex.txt', 'hello from codex\n');
      out({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'hello-codex.txt', kind: 'add' }], status: 'completed' } });
    }
    out({ type: 'item.completed', item: { id: 'i3', type: 'reasoning', text: '생각 중...' } });
    out({ type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: reply } });
    out({ type: 'turn.completed', usage: {} });
  } else {
    out({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } });
    await sleep(200);
    out({ type: 'tool_use', sessionID: sid, part: { id: 'p1', tool: 'grep', state: { status: 'completed', title: 'TODO', input: { pattern: 'TODO' }, output: '0 matches' } } });
    if (slow) await sleep(30000);
    if (writer) {
      fs.writeFileSync('hello-opencode.txt', 'hello from opencode\n');
      out({ type: 'tool_use', sessionID: sid, part: { id: 'p2', tool: 'write', state: { status: 'completed', title: 'hello-opencode.txt', input: {} } } });
    }
    await sleep(200);
    out({ type: 'text', sessionID: sid, part: { type: 'text', text: reply } });
    out({ type: 'step_finish', sessionID: sid, part: { type: 'step-finish' } });
  }
}
async function acpMain() {
  // ACP(Agent Client Protocol) 흉내: stdin으로 JSON-RPC를 받고 stdout으로 답함
  const rl = require('readline').createInterface({ input: process.stdin });
  const waiters = {}; let nextId = 100;
  const ask = (method, params) => new Promise((res) => { const id = nextId++; waiters[id] = res; out({ jsonrpc: '2.0', id, method, params }); });
  const note = (update) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update } });
  console.log('some startup banner that is not json');
  rl.on('line', async (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id != null && !m.method) { if (waiters[m.id]) waiters[m.id](m.result); return; }
    if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
    if (m.method === 'session/new') return out({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'acp-1' } });
    if (m.method === 'session/prompt') {
      const prompt = m.params.prompt.map((p) => p.text).join('');
      if (process.env.MOCK_LOG) fs.appendFileSync(process.env.MOCK_LOG, `\n===== acp args=${JSON.stringify(args)}\n${prompt}\n`);
      note({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read README.md', kind: 'read', status: 'in_progress' });
      note({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
      const perm = await ask('session/request_permission', { sessionId: 'acp-1', toolCall: { toolCallId: 'c2', title: 'Write notes.txt', kind: 'edit' }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
      const ok = perm && perm.outcome && perm.outcome.optionId === 'yes';
      if (ok) fs.writeFileSync('notes.txt', 'acp wrote\n');
      note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP 에이전트입니다. ' } });
      await sleep(100);
      note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ok ? '파일을 썼어요.' : '쓰기는 거절당했어요.' } });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    }
  });
}
main();
