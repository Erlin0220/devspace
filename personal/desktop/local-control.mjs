// Security/endpoint lifecycle snapshot: Team DevSpace 15ce088 client/local-control.mjs.
import { createServer } from 'node:http';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicJson, randomSecret, readJson, secureStateDirectory, stateHome, statePath } from '../state.mjs';

export const PREFERRED_PORT = 53683;
const validPort = value => Number.isInteger(value) && value >= 49152 && value <= 65535;
const assets = {
  '/': ['control.html', 'text/html; charset=utf-8'],
  '/control.css': ['control.css', 'text/css; charset=utf-8'],
  '/control.js': ['control.js', 'text/javascript; charset=utf-8'],
  '/personal-devspace-logo.png': ['../assets/personal-devspace-logo.png', 'image/png'],
  '/favicon.ico': ['../assets/personal-devspace.ico', 'image/x-icon'],
};
const actions = new Set(['check', 'suspend', 'resume', 'restart', 'repair', 'project-root', 'choose-folder', 'logs', 'update-check', 'update-prepare', 'update-apply']);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

async function readBody(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size <= 8192) chunks.push(chunk); }
  if (size > 8192) throw failure('请求过大', 413);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('无效 JSON'); }
}
export async function bindPort(server, port) {
  await new Promise((resolve, reject) => {
    const cleanup = () => { server.removeListener('error', failed); server.removeListener('listening', ready); };
    const failed = error => { cleanup(); reject(error); };
    const ready = () => { cleanup(); resolve(); };
    server.once('error', failed).once('listening', ready).listen(port, '127.0.0.1');
  });
}
const validCapability = value => value?.schema === 1 && /^[A-Za-z0-9_-]{43}$/.test(value.token ?? '') && (value.port === undefined || validPort(value.port));
export async function startLocalControl(controller, { home = stateHome(), preferredPort = PREFERRED_PORT, retryAttempts = 12, retryDelayMs = 250,
  chooseFallbackPort = () => randomInt(49152, 65536), openBrowser = async () => {} } = {}) {
  await secureStateDirectory(home);
  const path = statePath(home, 'controlCapability');
  let credential = await readJson(path, null);
  if (credential === null) {
    await atomicJson(path, { schema: 1, token: randomSecret() }, { createOnly: true });
    credential = await readJson(path);
  }
  if (!validCapability(credential)) throw new Error('本地控制凭据无效；拒绝启动控制页面');
  const requested = credential.port ?? preferredPort;
  let token = credential.token, authorization = Buffer.from(`Bearer ${token}`), origin;
  const instance = randomUUID();
  const loaded = new Map(await Promise.all(Object.entries(assets).map(async ([url, [file, type]]) => [url, { bytes: await readFile(new URL(file, import.meta.url)), type }])));
  const server = createServer(async (request, response) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      if (!response.writableEnded) response.writeHead(status, { 'Content-Type': type }).end(Buffer.isBuffer(value) ? value : JSON.stringify(value));
    };
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (!origin || request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') throw failure('拒绝跨站访问', 403);
      const asset = loaded.get(request.url);
      if (request.method === 'GET' && asset) return send(200, asset.bytes, asset.type);
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) throw failure('请从托盘重新打开控制中心', 401);
      if (request.method === 'GET' && request.url === '/api/state') return send(200, { ...controller.snapshot(), controlInstance: instance });
      if (request.method === 'GET' && request.url === '/api/diagnostics') return send(200, await controller.dispatch('diagnostics'));
      if (request.method !== 'POST' || request.url !== '/api/action') throw failure('未找到操作', 404);
      if (request.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw failure('只接受同源 JSON 操作', 403);
      const body = await readBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !actions.has(body.action) || Object.keys(body).some(key => !['action', 'projectRoot'].includes(key))) throw failure('未知控制操作');
      if (body.action === 'project-root' && (typeof body.projectRoot !== 'string' || !body.projectRoot.trim() || body.projectRoot.length > 4096 || /[\r\n\0]/.test(body.projectRoot))) throw failure('项目目录无效');
      if (['update-prepare', 'update-apply'].includes(body.action)) {
        if (controller.snapshot().busy) throw failure('已有操作正在进行', 409);
        // Acknowledge before lengthy Git/tests/install. Progress and the final error live in the controller.
        void controller.dispatch(body.action).catch(() => {});
        return send(202, { accepted: true });
      }
      const result = await controller.dispatch(body.action, { projectRoot: body.projectRoot });
      return send(200, { ok: true, ...(body.action === 'choose-folder' ? { projectRoot: result } : {}) });
    } catch (error) { send([400, 401, 403, 404, 409, 413].includes(error.status) ? error.status : 500, { error: error.message }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.on('clientError', (_error, socket) => socket.destroy());
  try {
    let lastError;
    for (let attempt = 0; attempt < retryAttempts; attempt++) {
      try { await bindPort(server, requested); break; }
      catch (error) { if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error; lastError = error;
        if (error.code === 'EACCES') break; if (attempt + 1 < retryAttempts) await sleep(retryDelayMs); }
    }
    for (let attempt = 0; !server.listening && attempt < 32; attempt++) {
      const port = chooseFallbackPort(); if (!validPort(port) || port === requested) continue;
      try { await bindPort(server, port); }
      catch (error) { if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error; lastError = error; }
    }
    if (!server.listening) throw lastError ?? new Error('无法绑定本地控制端口');
    const port = server.address().port;
    if (port !== requested || (credential.port !== undefined && port !== credential.port)) { token = randomSecret(); authorization = Buffer.from(`Bearer ${token}`); }
    // The capability file is the single durable endpoint owner.
    await atomicJson(path, { schema: 1, token, port });
    origin = `http://127.0.0.1:${port}`;
    return { port, origin, url: `${origin}/#${token}`, open: () => openBrowser(`${origin}/#${token}`),
      close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
  } catch (error) { if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } throw error; }
}
