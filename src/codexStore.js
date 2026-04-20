const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SESSION_DIRS = ['sessions', 'archived_sessions'];
const INDEX_FILE = 'session_index.jsonl';

function defaultCodexHome() {
  return path.join(os.homedir(), '.codex');
}

function normalizePath(inputPath) {
  return path.resolve(String(inputPath || '').replace(/^\\\\\?\\/, ''));
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function validateCodexHome(codexHome) {
  const root = normalizePath(codexHome);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error('Codex Home 不是目录');
  }
  const markers = ['sessions', 'archived_sessions', INDEX_FILE, 'state_5.sqlite', 'logs_2.sqlite'];
  const present = [];
  for (const marker of markers) {
    if (await exists(path.join(root, marker))) present.push(marker);
  }
  if (!present.includes('sessions') && !present.includes('archived_sessions')) {
    throw new Error('没有找到 sessions 或 archived_sessions，路径不像 Codex Home');
  }
  return { root, present };
}

async function walkJsonl(dir) {
  if (!(await exists(dir))) return [];
  const found = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await walkJsonl(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      found.push(full);
    }
  }
  return found;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function idFromFilename(filePath) {
  const base = path.basename(filePath, '.jsonl');
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : '';
}

async function readSessionPreview(filePath) {
  const stat = await fs.stat(filePath);
  const out = {
    id: idFromFilename(filePath),
    createdAt: '',
    updatedAt: stat.mtime.toISOString(),
    cwd: '',
    title: '',
    firstUserMessage: '',
    messageCount: 0,
    size: stat.size,
    path: filePath,
  };

  const bytesToRead = Math.min(stat.size, 768 * 1024);
  const handle = await fs.open(filePath, 'r');
  let text = '';
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }

  let linesSeen = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    linesSeen += 1;
    const item = parseJsonLine(line);
    if (item?.type === 'session_meta') {
      out.id = item.payload?.id || out.id;
      out.createdAt = item.payload?.timestamp || item.timestamp || out.createdAt;
      out.cwd = item.payload?.cwd || out.cwd;
    }
    if (item?.type === 'response_item' && item.payload?.type === 'message') {
      out.messageCount += 1;
      if (!out.firstUserMessage && item.payload.role === 'user') {
        const textContent = (item.payload.content || [])
          .map((part) => part.text || part.input_text || '')
          .join('\n')
          .trim();
        if (textContent && !textContent.startsWith('<environment_context>') && !textContent.startsWith('# AGENTS.md')) {
          out.firstUserMessage = textContent.slice(0, 500);
        }
      }
    }
    if (linesSeen >= 300 && out.id && out.firstUserMessage) break;
  }
  if (!out.createdAt) {
    const match = path.basename(filePath).match(/rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
    if (match) out.createdAt = match[1].replace('T', ' ').replaceAll('-', ':').replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3 ');
  }
  out.title = out.firstUserMessage || path.basename(filePath);
  return out;
}

async function readIndex(codexHome) {
  const indexPath = path.join(codexHome, INDEX_FILE);
  const map = new Map();
  if (!(await exists(indexPath))) return map;
  const text = await fs.readFile(indexPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = parseJsonLine(line);
    if (item?.id) map.set(item.id, item);
  }
  return map;
}

function runPythonWorker(args, timeoutMs = 30000) {
  const script = path.resolve(__dirname, '..', 'scripts', 'sqlite_worker.py');
  const candidates = process.platform === 'win32'
    ? [
        { cmd: 'python', args: [script, ...args] },
        { cmd: 'py', args: ['-3', script, ...args] },
      ]
    : [{ cmd: 'python3', args: [script, ...args] }, { cmd: 'python', args: [script, ...args] }];

  return new Promise((resolve) => {
    let index = 0;
    const tryNext = () => {
      if (index >= candidates.length) {
        resolve({ ok: false, error: '没有找到可用的 Python 3，SQLite 清理不可用' });
        return;
      }
      const current = candidates[index++];
      const child = spawn(current.cmd, current.args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve({ ok: false, error: 'Python SQLite 操作超时' });
      }, timeoutMs);
      child.stdout.on('data', (data) => { stdout += data.toString('utf8'); });
      child.stderr.on('data', (data) => { stderr += data.toString('utf8'); });
      child.on('error', () => {
        clearTimeout(timer);
        tryNext();
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve({ ok: false, error: stderr || stdout || `Python 退出码 ${code}` });
          return;
        }
        try {
          resolve({ ok: true, data: JSON.parse(stdout || '{}') });
        } catch (error) {
          resolve({ ok: false, error: `SQLite 输出无法解析：${error.message}` });
        }
      });
    };
    tryNext();
  });
}

function reportProgress(onProgress, step, message, extra = {}) {
  if (typeof onProgress === 'function') {
    onProgress({ step, message, ...extra });
  }
}

async function scanCodexHome(codexHome = defaultCodexHome()) {
  const { root, present } = await validateCodexHome(codexHome);
  const index = await readIndex(root);
  const files = [];
  for (const dir of SESSION_DIRS) {
    const base = path.join(root, dir);
    const filePaths = await walkJsonl(base);
    for (const filePath of filePaths) {
      const item = await readSessionPreview(filePath);
      item.location = dir === 'archived_sessions' ? 'archived' : 'active';
      item.relativePath = path.relative(root, filePath);
      const indexed = index.get(item.id);
      if (indexed?.thread_name && !indexed.thread_name.includes('�')) {
        item.title = indexed.thread_name;
      }
      if (indexed?.updated_at) item.updatedAt = indexed.updated_at;
      files.push(item);
    }
  }

  const threadPreview = await runPythonWorker(['preview', '--codex-home', root, '--ids', files.map((item) => item.id).join(',')], 30000);
  return {
    codexHome: root,
    present,
    sessions: files.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
    sqliteAvailable: threadPreview.ok,
    sqliteError: threadPreview.ok ? '' : threadPreview.error,
  };
}

async function buildDeletePlan(codexHome, ids) {
  const { root } = await validateCodexHome(codexHome);
  const wanted = new Set(ids);
  const scan = await scanCodexHome(root);
  const sessions = scan.sessions.filter((item) => wanted.has(item.id));
  const missing = ids.filter((id) => !sessions.some((item) => item.id === id));
  const indexPath = path.join(root, INDEX_FILE);
  let indexEntries = 0;
  if (await exists(indexPath)) {
    const text = await fs.readFile(indexPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const item = parseJsonLine(line);
      if (item?.id && wanted.has(item.id)) indexEntries += 1;
    }
  }
  const sqlite = await runPythonWorker(['preview', '--codex-home', root, '--ids', ids.join(',')], 30000);
  return {
    codexHome: root,
    ids,
    missing,
    files: sessions.map((item) => ({ id: item.id, path: item.path, relativePath: item.relativePath, size: item.size })),
    indexEntries,
    sqlite: sqlite.ok ? sqlite.data : null,
    sqliteError: sqlite.ok ? '' : sqlite.error,
    warning: '建议先关闭 Codex Desktop；本工具会直接删除本地文件并清理 SQLite，不进入回收站。',
  };
}

async function rewriteIndex(codexHome, ids) {
  const indexPath = path.join(codexHome, INDEX_FILE);
  if (!(await exists(indexPath))) return { removed: 0 };
  const wanted = new Set(ids);
  const text = await fs.readFile(indexPath, 'utf8');
  const kept = [];
  let removed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = parseJsonLine(line);
    if (item?.id && wanted.has(item.id)) {
      removed += 1;
    } else {
      kept.push(line);
    }
  }
  await fs.writeFile(indexPath, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
  return { removed };
}

async function pruneEmptyDirs(codexHome, filePaths) {
  const roots = SESSION_DIRS.map((dir) => path.join(codexHome, dir));
  const removed = [];
  const dirs = [...new Set(filePaths.map((filePath) => path.dirname(filePath)))].sort((a, b) => b.length - a.length);
  for (const start of dirs) {
    let current = start;
    while (roots.some((root) => isInside(root, current)) && !roots.includes(current)) {
      try {
        const entries = await fs.readdir(current);
        if (entries.length) break;
        await fs.rmdir(current);
        removed.push(current);
        current = path.dirname(current);
      } catch {
        break;
      }
    }
  }
  return removed;
}

async function deleteSessions({ codexHome, ids, confirmText, vacuum = true, onProgress }) {
  const root = normalizePath(codexHome);
  const expected = `DELETE ${ids.length}`;
  if (confirmText !== expected) {
    throw new Error(`确认文本不匹配，需要输入 ${expected}`);
  }
  reportProgress(onProgress, 'planning', `正在核对 ${ids.length} 条会话...`, {
    current: 0,
    total: ids.length,
  });
  const plan = await buildDeletePlan(root, ids);
  for (const file of plan.files) {
    const resolved = normalizePath(file.path);
    if (!isInside(root, resolved)) {
      throw new Error(`拒绝删除 Codex Home 外的文件：${resolved}`);
    }
  }

  reportProgress(onProgress, 'sqlite', '正在清理 SQLite 记录...', {
    current: 0,
    total: plan.files.length,
  });
  const sqlite = await runPythonWorker([
    'cleanup',
    '--codex-home', root,
    '--ids', ids.join(','),
    ...(vacuum ? ['--vacuum'] : []),
  ], 120000);
  if (!sqlite.ok) {
    throw new Error(`SQLite 清理失败：${sqlite.error}`);
  }

  reportProgress(onProgress, 'index', '正在更新会话索引...', {
    current: 0,
    total: plan.files.length,
  });
  const indexResult = await rewriteIndex(root, ids);
  const deletedFiles = [];
  let deletedCount = 0;
  for (const file of plan.files) {
    reportProgress(onProgress, 'files', `正在删除 JSONL 文件 ${deletedCount + 1}/${plan.files.length}...`, {
      current: deletedCount,
      total: plan.files.length,
    });
    await fs.rm(file.path, { force: true });
    deletedFiles.push(file.path);
    deletedCount += 1;
    reportProgress(onProgress, 'files', `已删除 JSONL 文件 ${deletedCount}/${plan.files.length}。`, {
      current: deletedCount,
      total: plan.files.length,
    });
  }
  reportProgress(onProgress, 'prune', '正在清理空目录...', {
    current: deletedCount,
    total: plan.files.length,
  });
  const prunedDirs = await pruneEmptyDirs(root, deletedFiles);
  reportProgress(onProgress, 'done', '删除完成，正在刷新列表...', {
    current: deletedCount,
    total: plan.files.length,
  });
  return {
    deletedIds: ids,
    deletedFiles,
    prunedDirs,
    index: indexResult,
    sqlite: sqlite.data,
  };
}

module.exports = {
  defaultCodexHome,
  scanCodexHome,
  buildDeletePlan,
  deleteSessions,
  validateCodexHome,
};
