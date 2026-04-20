const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { scanCodexHome, buildDeletePlan, deleteSessions, pythonWorkerScriptPath } = require('../src/codexStore');

function runPython(code, cwd) {
  execFileSync('python', ['-X', 'utf8', '-c', code], { cwd, stdio: 'pipe' });
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-manager-'));
  const codexHome = path.join(root, '.codex');
  const sessionDir = path.join(codexHome, 'sessions', '2026', '04', '20');
  const archivedDir = path.join(codexHome, 'archived_sessions');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(archivedDir, { recursive: true });
  const id = '019daaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
  const filePath = path.join(sessionDir, `rollout-2026-04-20T10-00-00-${id}.jsonl`);
  const lines = [
    {
      timestamp: '2026-04-20T02:00:00.000Z',
      type: 'session_meta',
      payload: { id, timestamp: '2026-04-20T02:00:00.000Z', cwd: 'C:\\work\\demo' },
    },
    {
      timestamp: '2026-04-20T02:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '删除测试会话' }] },
    },
  ];
  await fs.writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  await fs.writeFile(
    path.join(codexHome, 'session_index.jsonl'),
    `${JSON.stringify({ id, thread_name: '删除测试会话', updated_at: '2026-04-20T02:00:01.000Z' })}\n`,
    'utf8',
  );

  const script = `
import sqlite3, pathlib
root = pathlib.Path(r'''${codexHome.replaceAll('\\', '\\\\')}''')
state = sqlite3.connect(root / 'state_5.sqlite')
state.execute('create table threads(id text primary key, rollout_path text, created_at integer, updated_at integer, source text, model_provider text, cwd text, title text, sandbox_policy text, approval_mode text, tokens_used integer, has_user_event integer, archived integer, archived_at integer, git_sha text, git_branch text, git_origin_url text, cli_version text, first_user_message text, agent_nickname text, agent_role text, memory_mode text, model text, reasoning_effort text, agent_path text, created_at_ms integer, updated_at_ms integer)')
state.execute('create table thread_dynamic_tools(thread_id text, position integer, name text, description text, input_schema text, defer_loading integer)')
state.execute('create table thread_spawn_edges(parent_thread_id text, child_thread_id text, status text)')
state.execute('create table stage1_outputs(thread_id text, source_updated_at integer, raw_memory text, rollout_summary text, generated_at integer, rollout_slug text, usage_count integer, last_usage integer, selected_for_phase2 integer, selected_for_phase2_source_updated_at integer)')
state.execute('insert into threads(id, rollout_path, title, first_user_message, archived) values(?,?,?,?,0)', ('${id}', r'''${filePath.replaceAll('\\', '\\\\')}''', '删除测试会话', '删除测试会话'))
state.execute('insert into thread_dynamic_tools(thread_id, position, name) values(?,?,?)', ('${id}', 0, 'tool'))
state.commit()
state.close()
logs = sqlite3.connect(root / 'logs_2.sqlite')
logs.execute('create table logs(id integer primary key autoincrement, ts integer, ts_nanos integer, level text, target text, feedback_log_body text, module_path text, file text, line integer, thread_id text, process_uuid text, estimated_bytes integer)')
logs.execute('insert into logs(ts, level, thread_id) values(?,?,?)', (1, 'INFO', '${id}'))
logs.commit()
logs.close()
`;
  runPython(script, root);
  return { root, codexHome, id, filePath };
}

test('scan and permanently delete a Codex session fixture', async () => {
  const fixture = await makeFixture();
  try {
    const scan = await scanCodexHome(fixture.codexHome);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0].id, fixture.id);
    assert.equal(scan.sessions[0].title, '删除测试会话');

    const plan = await buildDeletePlan(fixture.codexHome, [fixture.id]);
    assert.equal(plan.files.length, 1);
    assert.equal(plan.indexEntries, 1);
    assert.equal(plan.sqlite.state.threads, 1);
    assert.equal(plan.sqlite.logs.logs, 1);

    const progressEvents = [];
    const result = await deleteSessions({
      codexHome: fixture.codexHome,
      ids: [fixture.id],
      confirmText: 'DELETE 1',
      vacuum: false,
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(result.deletedFiles.length, 1);
    assert.ok(progressEvents.some((event) => event.step === 'sqlite'));
    assert.ok(progressEvents.some((event) => event.step === 'done'));
    await assert.rejects(fs.stat(fixture.filePath));

    const indexText = await fs.readFile(path.join(fixture.codexHome, 'session_index.jsonl'), 'utf8');
    assert.equal(indexText, '');

    const after = await buildDeletePlan(fixture.codexHome, [fixture.id]);
    assert.equal(after.files.length, 0);
    assert.equal(after.indexEntries, 0);
    assert.equal(after.sqlite.state.threads, 0);
    assert.equal(after.sqlite.logs.logs, 0);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('resolve python worker script path in development', async () => {
  const scriptPath = pythonWorkerScriptPath();
  assert.match(scriptPath, /scripts[\\/]+sqlite_worker\.py$/);
  await fs.access(scriptPath);
});
