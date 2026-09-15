const $ = id => document.getElementById(id);
const fragment = location.hash.slice(1);
if (/^[A-Za-z0-9_-]{43}$/.test(fragment)) { sessionStorage.setItem('personal-control', fragment); history.replaceState(null, '', location.pathname); }
const capability = sessionStorage.getItem('personal-control');
let current, requestPending = false, shownVersion, stopped = false, rootDraft = false;
const titles = { overview: '概览', settings: '本机设置', updates: '软件更新', diagnostics: '诊断与修复' };
function feedback(message, error = false) { $('feedback').textContent = message ?? ''; $('feedback').hidden = !message; $('feedback').dataset.error = String(error); }
async function api(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${capability ?? ''}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(body?.action === 'choose-folder' ? 300000 : 15000) });
  const value = await response.json();
  if (!response.ok) { if (response.status === 401) stopped = true; throw new Error(value.error ?? `请求失败 (${response.status})`); }
  return value;
}
function render(state) {
  current = state; document.body.dataset.state = state.status;
  $('status-title').textContent = ({ ready: 'Runtime 正常运行', suspended: '服务已暂停', busy: '正在处理操作', partial: '需要检查服务', stopped: '服务已停止' })[state.status] ?? '正在读取状态';
  $('summary').textContent = state.paused ? '暂停状态会在重启与升级后保留' : state.running ? '个人 DevSpace 独立运行' : '诊断与修复仍可使用';
  $('checked-at').textContent = state.checkedAt ? `最近检查 ${new Date(state.checkedAt).toLocaleTimeString()}` : '';
  $('project-root').textContent = state.projectRoot ?? '沿用 upstream 已配置目录';
  if (!rootDraft && document.activeElement !== $('root-input')) $('root-input').value = state.projectRoot ?? '';
  $('version').textContent = state.version ? `${state.version} stable + Personal Overlay` : '—';
  $('runtime-url').textContent = state.endpoint ?? '';
  $('extensions').textContent = `API Token：${state.apiTokenConfigured ? '已配置' : '未配置'} · CodeGraph：${state.codegraphEnabled ? '已启用' : '已关闭'}`;
  $('auth-status').textContent = state.apiTokenConfigured ? '个人 API Token 已配置' : '使用 upstream OAuth';
  $('toggle-service').textContent = state.paused || !state.running ? '恢复服务' : '暂停服务';
  $('toggle-service').dataset.action = state.paused || !state.running ? 'resume' : 'suspend';
  for (const button of document.querySelectorAll('[data-action]')) button.disabled = state.busy || requestPending;
  $('prepare-update').disabled = state.busy || requestPending || !state.updates?.available;
  const candidateReady = state.candidate?.status === 'tested-awaiting-review';
  $('candidate-panel').hidden = !candidateReady;
  $('candidate-summary').textContent = candidateReady ? `${state.candidate.version} · ${state.candidate.branch}。请先审查候选目录中的 range-diff 与测试报告。` : '';
  const install = state.installation;
  $('installation-status').textContent = install ? ({ queued: '安装任务已提交', staging: '正在准备独立安装目录，当前服务继续运行', switching: '正在切换并验证 Runtime', installed: '安装已完成', failed: `安装失败：${install.error ?? '查看诊断信息'}` })[install.status] ?? '' : '';
  feedback(state.alert ?? state.activity ?? state.notice, Boolean(state.alert));
  if (state.updates) {
    $('update-title').textContent = state.updates.available ? `发现 stable ${state.updates.version}` : '当前已是最新正式稳定版';
    $('update-summary').textContent = 'GitHub 正式发布与 npm latest 已交叉确认。';
    $('release-notes').textContent = state.updates.notes || '官方未提供版本说明。';
    if (state.updates.available && shownVersion !== state.updates.version) {
      shownVersion = state.updates.version; $('dialog-version').textContent = `Upstream ${shownVersion}`;
      $('dialog-notes').textContent = state.updates.notes || '官方未提供版本说明。'; $('update-dialog').showModal();
    }
  }
}
function view(name) {
  if (!titles[name]) return;
  $('page-title').textContent = titles[name];
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  for (const button of document.querySelectorAll('.nav-item')) button.setAttribute('aria-current', button.dataset.view === name ? 'page' : 'false');
}
async function action(name, input = {}) {
  if (requestPending) return;
  if (['suspend', 'restart', 'project-root'].includes(name) && !confirm('该操作可能中断正在执行的任务。确认当前任务已结束后继续。')) return;
  if (name === 'update-apply' && !confirm('确认已审查候选分支、range-diff 和测试报告。安装会重启个人 Runtime，保留认证、目录及暂停状态；是否继续？')) return;
  requestPending = true; if (current) render(current); feedback('正在处理…');
  try { const result = await api('/api/action', { action: name, ...input });
    if (name === 'choose-folder' && result.projectRoot) { $('root-input').value = result.projectRoot; rootDraft = true; }
    if (name === 'project-root') rootDraft = false;
    if (name === 'update-prepare') $('update-dialog').close();
    render(await api('/api/state'));
  } catch (error) { feedback(error.message, true); }
  finally { requestPending = false; if (current) for (const button of document.querySelectorAll('[data-action]')) button.disabled = current.busy;
    $('prepare-update').disabled = current?.busy || !current?.updates?.available; }
}
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.view) view(button.dataset.view);
  if (button.dataset.action) void action(button.dataset.action);
});
$('close-dialog').addEventListener('click', () => $('update-dialog').close());
$('root-input').addEventListener('input', () => { rootDraft = true; });
$('root-form').addEventListener('submit', event => { event.preventDefault(); void action('project-root', { projectRoot: $('root-input').value }); });
$('diagnostics-button').addEventListener('click', async () => {
  try { $('diagnostics-output').textContent = JSON.stringify(await api('/api/diagnostics'), null, 2); $('diagnostics-output').hidden = false; }
  catch (error) { feedback(error.message, true); }
});
async function poll() {
  try { if (!stopped) render(await api('/api/state')); }
  catch (error) { feedback(stopped ? error.message : '控制中心暂时断开，正在等待服务恢复…', true); }
  finally { if (!stopped) setTimeout(poll, document.hidden ? 5000 : 1500); }
}
void poll();
