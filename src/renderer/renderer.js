const state = {
  codexHome: '',
  sessions: [],
  selected: new Set(),
  filter: 'all',
  search: '',
  plan: null,
  deleting: false,
  deletingIds: new Set(),
  deleteProgress: null,
  collapsedGroups: new Set(),
};

const $ = (id) => document.getElementById(id);

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function setStatus(text, error = false) {
  const status = $('status');
  const statusText = $('statusText');
  if (statusText) statusText.textContent = text;
  else status.textContent = text;
  status.classList.toggle('error', error);
}

function setBusyControls() {
  const disabled = state.deleting;
  for (const id of ['scanButton', 'chooseHome', 'clearSelection', 'searchInput', 'vacuumInput']) {
    const element = $(id);
    if (element) element.disabled = disabled;
  }
  document.querySelectorAll('.filter').forEach((button) => {
    button.disabled = disabled;
  });
}

function visibleSessions() {
  const query = state.search.trim().toLowerCase();
  return state.sessions.filter((item) => {
    if (state.filter !== 'all' && item.location !== state.filter) return false;
    if (!query) return true;
    return [item.title, item.firstUserMessage, item.cwd, item.id, item.relativePath]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
}

function workspaceKeyFor(item) {
  return item.cwd ? `cwd:${item.cwd}` : 'cwd:__none__';
}

function workspaceNameFor(item) {
  if (!item.cwd) return '无工作区';
  const clean = String(item.cwd).replace(/[\\/]+$/, '');
  const name = clean.split(/[\\/]/).filter(Boolean).pop();
  return name || clean || '无工作区';
}

function buildTreeGroups(sessions) {
  const groups = new Map();
  for (const item of sessions) {
    const key = workspaceKeyFor(item);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name: workspaceNameFor(item),
        cwd: item.cwd || '',
        sessions: [],
        size: 0,
        latest: item.updatedAt || item.createdAt || '',
      });
    }
    const group = groups.get(key);
    group.sessions.push(item);
    group.size += Number(item.size || 0);
    const currentTime = new Date(item.updatedAt || item.createdAt || 0).getTime();
    const latestTime = new Date(group.latest || 0).getTime();
    if (currentTime > latestTime) group.latest = item.updatedAt || item.createdAt || group.latest;
  }

  return [...groups.values()].sort((a, b) => {
    const timeDiff = new Date(b.latest || 0).getTime() - new Date(a.latest || 0).getTime();
    if (timeDiff) return timeDiff;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

function schedulePlanRefresh() {
  if (state.deleting) return;
  window.clearTimeout(window.__planTimer);
  window.__planTimer = window.setTimeout(refreshPlan, 180);
}

function folderIconSvg() {
  return `
    <svg class="folder-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4.1l1.9 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    </svg>
  `;
}

function renderStats() {
  const totalSize = state.sessions.reduce((sum, item) => sum + Number(item.size || 0), 0);
  $('totalCount').textContent = String(state.sessions.length);
  $('selectedCount').textContent = String(state.selected.size);
  $('storageSize').textContent = formatBytes(totalSize);
}

function renderDeleteButton() {
  const button = $('deleteButton');
  const text = $('deleteButtonText');
  if (!button) return;
  button.disabled = state.deleting || !state.plan;
  button.classList.toggle('loading', state.deleting);
  if (text) text.textContent = state.deleting ? '正在删除...' : '永久删除选中会话';
}

function renderProgress() {
  const box = $('deleteProgress');
  if (!box) return;
  const show = state.deleting && state.deleteProgress;
  box.classList.toggle('hidden', !show);
  if (!show) return;

  const progress = state.deleteProgress;
  const current = Number(progress.current || 0);
  const total = Number(progress.total || 0);
  $('deleteProgressText').textContent = progress.message || '正在处理...';
  $('deleteProgressCount').textContent = total ? `${Math.min(current, total)}/${total}` : '';
  const width = total ? Math.min(100, Math.max(5, Math.round((current / total) * 100))) : 35;
  $('deleteProgressBar').style.width = `${width}%`;
}

function renderList() {
  const list = $('sessionList');
  const sessions = visibleSessions();
  list.innerHTML = '';
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <svg class="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
      <p>${state.sessions.length ? '当前筛选条件下没有会话。' : '还没有扫描到会话。'}</p>
    `;
    list.appendChild(empty);
    renderStats();
    renderPlan();
    setBusyControls();
    return;
  }

  const groups = buildTreeGroups(sessions);
  const forceExpanded = Boolean(state.search.trim());

  for (const group of groups) {
    const isCollapsed = state.collapsedGroups.has(group.key) && !forceExpanded;
    const selectedInGroup = group.sessions.filter((item) => state.selected.has(item.id)).length;
    const allSelected = selectedInGroup === group.sessions.length;
    const partlySelected = selectedInGroup > 0 && !allSelected;
    const groupNode = document.createElement('section');
    groupNode.className = `tree-group ${isCollapsed ? 'collapsed' : ''} ${selectedInGroup ? 'has-selection' : ''}`;

    const header = document.createElement('div');
    header.className = 'tree-group-header';

    const selectLabel = document.createElement('label');
    selectLabel.className = 'tree-select custom-checkbox';
    selectLabel.title = allSelected ? '取消选择该目录下的会话' : '选择该目录下的全部会话';
    const selectInput = document.createElement('input');
    selectInput.type = 'checkbox';
    selectInput.checked = allSelected;
    selectInput.indeterminate = partlySelected;
    selectInput.disabled = state.deleting;
    selectInput.addEventListener('change', (event) => {
      event.stopPropagation();
      if (selectInput.checked) {
        for (const item of group.sessions) state.selected.add(item.id);
      } else {
        for (const item of group.sessions) state.selected.delete(item.id);
      }
      state.plan = null;
      renderList();
      schedulePlanRefresh();
    });
    const selectMark = document.createElement('span');
    selectMark.className = 'checkmark';
    const selectText = document.createElement('span');
    selectText.className = 'tree-select-text';
    selectText.textContent = allSelected ? '取消' : '全选';
    selectLabel.appendChild(selectInput);
    selectLabel.appendChild(selectMark);
    selectLabel.appendChild(selectText);
    header.appendChild(selectLabel);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle';
    toggle.disabled = state.deleting;
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
    toggle.innerHTML = `
      <span class="tree-chevron" aria-hidden="true"></span>
      ${folderIconSvg()}
      <span class="tree-name"></span>
      <span class="tree-count"></span>
      <span class="tree-selected"></span>
      <span class="tree-size"></span>
    `;
    toggle.querySelector('.tree-name').textContent = group.name;
    toggle.querySelector('.tree-count').textContent = `${group.sessions.length} 条`;
    toggle.querySelector('.tree-selected').textContent = selectedInGroup ? `已选 ${selectedInGroup}` : '';
    toggle.querySelector('.tree-selected').classList.toggle('hidden', !selectedInGroup);
    toggle.querySelector('.tree-size').textContent = formatBytes(group.size);
    toggle.title = group.cwd || '没有记录工作区路径';
    toggle.addEventListener('click', () => {
      if (state.deleting) return;
      if (state.collapsedGroups.has(group.key)) state.collapsedGroups.delete(group.key);
      else state.collapsedGroups.add(group.key);
      renderList();
    });
    header.appendChild(toggle);
    groupNode.appendChild(header);

    if (!isCollapsed) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      for (const item of group.sessions) {
        children.appendChild(renderSessionCard(item));
      }
      groupNode.appendChild(children);
    }

    list.appendChild(groupNode);
  }
  renderStats();
  renderPlan();
  setBusyControls();
}

function renderSessionCard(item) {
    const isDeleting = state.deletingIds.has(item.id);
    const card = document.createElement('label');
    card.className = `session-card ${item.location === 'archived' ? 'archived' : ''} ${state.selected.has(item.id) ? 'selected' : ''} ${isDeleting ? 'deleting' : ''}`;

    const checkboxWrapper = document.createElement('div');
    checkboxWrapper.className = 'custom-checkbox card-checkbox';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(item.id);
    checkbox.disabled = state.deleting;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(item.id);
      else state.selected.delete(item.id);
      state.plan = null;
      renderList();
      schedulePlanRefresh();
    });

    const checkmark = document.createElement('span');
    checkmark.className = 'checkmark';

    checkboxWrapper.appendChild(checkbox);
    checkboxWrapper.appendChild(checkmark);

    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.title || item.id;
    body.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const fields = [
      isDeleting ? '正在删除' : (item.location === 'archived' ? '已归档' : '未归档'),
      formatDate(item.updatedAt || item.createdAt),
      item.cwd || '无工作区',
      item.id,
    ];
    for (const field of fields) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = field;
      meta.appendChild(pill);
    }
    body.appendChild(meta);

    const filePath = document.createElement('div');
    filePath.className = 'path';
    filePath.textContent = item.relativePath;
    body.appendChild(filePath);

    const size = document.createElement('div');
    size.className = 'size';
    size.textContent = formatBytes(item.size);

    card.appendChild(checkboxWrapper);
    card.appendChild(body);
    card.appendChild(size);
    return card;
}

async function refreshPlan() {
  if (state.deleting) return;
  if (!state.selected.size) {
    state.plan = null;
    renderPlan();
    return;
  }
  try {
    setStatus('正在生成删除清单...');
    state.plan = await window.codexManager.planDelete({
      codexHome: state.codexHome,
      ids: [...state.selected],
    });
    setStatus(`已生成 ${state.selected.size} 条会话的删除清单。`);
  } catch (error) {
    state.plan = null;
    setStatus(error.message, true);
  }
  renderPlan();
}

function renderPlan() {
  const hasSelection = state.selected.size > 0;
  $('emptyPlan').classList.toggle('hidden', hasSelection);
  $('planView').classList.toggle('hidden', !hasSelection);
  renderDeleteButton();
  renderProgress();

  if (!hasSelection) return;
  if (!state.plan) {
    $('planCount').textContent = String(state.selected.size);
    $('planFiles').textContent = '-';
    $('planIndex').textContent = '-';
    $('planLogs').textContent = '-';
    $('selectedList').innerHTML = '<div class="selected-item muted-row">正在计算删除清单...</div>';
    return;
  }

  $('planCount').textContent = String(state.plan.ids.length);
  $('planFiles').textContent = String(state.plan.files.length);
  $('planIndex').textContent = String(state.plan.indexEntries);
  $('planLogs').textContent = String(state.plan.sqlite?.logs?.logs ?? 0);

  const selected = $('selectedList');
  selected.innerHTML = '';
  for (const file of state.plan.files) {
    const item = state.sessions.find((session) => session.id === file.id);
    const row = document.createElement('div');
    row.className = 'selected-item';
    row.innerHTML = `<strong></strong><span></span>`;
    row.querySelector('strong').textContent = item?.title || file.id;
    row.querySelector('span').textContent = file.relativePath;
    selected.appendChild(row);
  }
}

async function scan(options = {}) {
  try {
    if (!options.silent) setStatus('正在扫描本地 Codex 记录...');
    state.codexHome = $('codexHome').value.trim();
    const result = await window.codexManager.scan(state.codexHome);
    state.codexHome = result.codexHome;
    $('codexHome').value = result.codexHome;
    state.sessions = result.sessions;
    state.selected.clear();
    state.plan = null;
    const sqliteText = result.sqliteAvailable ? 'SQLite 清理可用' : `SQLite 不可用：${result.sqliteError}`;
    setStatus(`扫描完成：找到 ${result.sessions.length} 条会话。${sqliteText}`);
    renderList();
  } catch (error) {
    setStatus(error.message, true);
    state.sessions = [];
    state.selected.clear();
    state.plan = null;
    renderList();
  }
}

async function refreshAfterDelete() {
  try {
    const result = await window.codexManager.scan(state.codexHome);
    state.sessions = result.sessions;
    state.selected.clear();
    state.plan = null;
    const sqliteText = result.sqliteAvailable ? 'SQLite 清理可用' : `SQLite 不可用：${result.sqliteError}`;
    setStatus(`列表已刷新：当前还有 ${result.sessions.length} 条会话。${sqliteText}`);
    renderList();
  } catch (error) {
    setStatus(`删除已完成，但刷新列表失败：${error.message}`, true);
  }
}

async function deleteSelected() {
  if (state.deleting || !state.plan || !state.selected.size) return;
  const selectedIds = [...state.selected];
  const phrase = `DELETE ${selectedIds.length}`;
  try {
    state.deleting = true;
    state.deletingIds = new Set(selectedIds);
    state.deleteProgress = {
      step: 'start',
      message: `正在删除 ${selectedIds.length} 条会话...`,
      current: 0,
      total: selectedIds.length,
    };
    setStatus(state.deleteProgress.message);
    renderList();
    await nextPaint();

    const result = await window.codexManager.deleteSessions({
      codexHome: state.codexHome,
      ids: selectedIds,
      confirmText: phrase,
      vacuum: $('vacuumInput').checked,
    });

    const deleted = new Set(result.deletedIds);
    state.sessions = state.sessions.filter((session) => !deleted.has(session.id));
    state.selected.clear();
    state.plan = null;
    state.deleting = false;
    state.deletingIds.clear();
    state.deleteProgress = null;
    renderList();
    setStatus(`已删除 ${result.deletedIds.length} 条会话和 ${result.deletedFiles.length} 个 JSONL 文件，并移除 ${result.index.removed} 条索引记录。正在后台刷新列表...`);
    await nextPaint();
    void refreshAfterDelete();
  } catch (error) {
    state.deleting = false;
    state.deletingIds.clear();
    state.deleteProgress = null;
    renderList();
    setStatus(error.message, true);
  }
}

function bindEvents() {
  $('scanButton').addEventListener('click', scan);
  $('chooseHome').addEventListener('click', async () => {
    const selected = await window.codexManager.chooseHome();
    if (selected) {
      $('codexHome').value = selected;
      await scan();
    }
  });
  $('clearSelection').addEventListener('click', () => {
    if (state.deleting) return;
    state.selected.clear();
    state.plan = null;
    renderList();
  });
  $('searchInput').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderList();
  });
  $('deleteButton').addEventListener('click', deleteSelected);
  for (const button of document.querySelectorAll('.filter')) {
    button.addEventListener('click', () => {
      if (state.deleting) return;
      state.filter = button.dataset.filter;
      document.querySelectorAll('.filter').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      renderList();
    });
  }
  $('sessionList').addEventListener('change', () => {
    if (state.deleting) return;
    schedulePlanRefresh();
  });
}

function bindProgressEvents() {
  if (!window.codexManager.onDeleteProgress) return;
  window.codexManager.onDeleteProgress((progress) => {
    if (!state.deleting) return;
    state.deleteProgress = progress;
    setStatus(progress.message || '正在删除...');
    renderProgress();
  });
}

async function boot() {
  bindEvents();
  bindProgressEvents();
  $('codexHome').value = await window.codexManager.getDefaultHome();
  await scan();
}

boot();
