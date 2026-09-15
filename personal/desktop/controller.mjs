// One-time adaptation of Team DevSpace 15ce088 client/desktop-controller.mjs.
// Presentation observes operations; no remote authorization or independent lifecycle state.
const activityText = { suspend: '正在暂停服务…', resume: '正在恢复服务…', restart: '正在重启服务…',
  repair: '正在修复桌面入口…', 'project-root': '正在切换项目目录…',
  'update-check': '正在检查官方稳定版…', 'update-prepare': '正在重放个人定制并验证候选版本…', 'update-apply': '正在交给独立安装器…' };
const optional = (listener, value) => { try { Promise.resolve(listener(value)).catch(() => {}); } catch {} };

export function createDesktopController(operations, { intervalMs = 5000, noticeTtl = 6000 } = {}) {
  let facts = {}, activity, alert, probeAlert, notice, checkedAt, pending, refreshing, revision = 0, disposed = false, closing = false, timer, noticeTimer;
  let updates = null;
  const listeners = new Set();
  const utilities = new Map();
  const abort = new AbortController();
  const snapshot = () => ({ ...facts, status: closing ? 'stopped' : pending ? 'busy' : facts.paused ? 'suspended' : facts.running ? 'ready' : 'partial',
    busy: Boolean(pending) || closing, activity, alert: alert ?? probeAlert, notice, checkedAt, updates });
  const publish = () => { if (!disposed) for (const listener of listeners) optional(listener, snapshot()); };
  const setNotice = message => {
    clearTimeout(noticeTimer); notice = message;
    if (message) { noticeTimer = setTimeout(() => { notice = undefined; publish(); }, noticeTtl); noticeTimer.unref?.(); }
  };
  const refresh = () => {
    if (pending || closing || disposed) return Promise.resolve(snapshot());
    if (refreshing) return refreshing;
    const generation = revision;
    refreshing = Promise.resolve().then(() => operations.status()).then(value => {
      if (generation === revision && !disposed) { facts = value; probeAlert = undefined; checkedAt = new Date().toISOString(); }
    }, error => { if (generation === revision && !disposed) probeAlert = error.message; })
      .finally(() => { refreshing = undefined; publish(); });
    return refreshing;
  };
  const dispatch = async (action, input = {}) => {
    if (disposed || closing) throw Object.assign(new Error('控制中心正在退出'), { status: 409 });
    if (action === 'check') { await refresh(); return snapshot(); }
    if (action === 'exit') {
      closing = true; revision++; activity = '正在停止服务并退出…'; publish(); abort.abort();
      try { await pending?.catch(() => {}); await operations.exit(); return { stopped: true }; }
      catch (error) { closing = false; activity = undefined; alert = error.message; publish(); throw error; }
    }
    if (['diagnostics', 'logs', 'choose-folder'].includes(action)) {
      if (!operations[action]) throw new Error('不支持的操作');
      if (!utilities.has(action)) utilities.set(action, Promise.resolve().then(() => operations[action]({ ...input, signal: abort.signal }))
        .finally(() => utilities.delete(action)));
      return utilities.get(action);
    }
    if (!Object.hasOwn(activityText, action) || !operations[action]) throw Object.assign(new Error('未知控制操作'), { status: 400 });
    if (pending) throw Object.assign(new Error('已有操作正在进行'), { status: 409 });
    revision++; alert = undefined; setNotice(undefined); activity = activityText[action];
    pending = Promise.resolve().then(async () => {
      const result = await operations[action]({ ...input, signal: abort.signal, onProgress: message => { activity = message; publish(); } });
      if (action === 'update-check') updates = result;
      // A failed UI/status projection cannot turn a committed operation into a failed transaction.
      try { facts = await operations.status(); checkedAt = new Date().toISOString(); }
      catch (error) { alert = `操作已完成，但状态暂时不可用：${error.message}`; }
      setNotice(action === 'update-prepare' ? '候选版本已生成并通过测试；审核前不会替换当前运行版本' : '操作已完成');
      return result;
    }).catch(error => { alert = error.message; throw error; })
      .finally(() => { pending = undefined; if (!closing) activity = undefined; publish(); });
    publish();
    return pending;
  };
  return {
    snapshot, dispatch,
    subscribe(listener) { listeners.add(listener); optional(listener, snapshot()); return () => listeners.delete(listener); },
    start() { if (timer || disposed) return; void refresh(); timer = setInterval(() => void refresh(), intervalMs); timer.unref?.(); },
    async dispose() { disposed = true; clearInterval(timer); clearTimeout(noticeTimer); abort.abort(); listeners.clear(); await pending?.catch(() => {}); },
  };
}
