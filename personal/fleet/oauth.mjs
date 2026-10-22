import OAuthProvider, { AuthorizationError, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { sha256 } from './upstream.mjs';

export const FLEET_ORIGIN = 'https://personal-devspace-fleet.568920429.xyz';
const RESOURCE = FLEET_ORIGIN + '/mcp';
const escape = v => String(v).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' };
export async function matchesHash(value, expected) {
  if (typeof value !== 'string' || value.length > 4096 || !/^[a-f0-9]{64}$/.test(expected ?? '')) return false;
  const actual = await sha256(value); let difference = 0;
  for (let i = 0; i < 64; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}
export function fleetStub(env) { return env.FLEET.get(env.FLEET.idFromName('personal-owner-v1')); }
export function forwardGateway(request, env, authenticated = false) {
  if (!authenticated) return fleetStub(env).fetch(request);
  const headers = new Headers(request.headers); headers.set('Authorization', `Bearer ${env.FLEET_CLIENT_TOKEN}`);
  return fleetStub(env).fetch(new Request(request, { headers }));
}

async function formBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new Error('Expected form');
  const reader = request.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > 16_384) throw new Error('Form too large'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

const authorizationHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/authorize') return forwardGateway(request, env);
    if (url.origin !== FLEET_ORIGIN || !/^[a-f0-9]{64}$/.test(env.FLEET_OAUTH_OWNER_HASH ?? '')) return new Response('Authorization is not configured', { status: 503, headers: noStore });
    const oauth = env.OAUTH_PROVIDER;
    try {
      if (request.method === 'GET') {
        const auth = await oauth.parseAuthRequest(request);
        if (url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('code_challenge')) return new Response('PKCE S256 is required', { status: 400, headers: noStore });
        if (!auth.scope.includes('devspace') || auth.scope.some(s => !['devspace', 'offline_access'].includes(s))) return new Response('Request the devspace scope', { status: 400, headers: noStore });
        const details = await oauth.describeConsent(auth);
        const consent = await oauth.beginConsent(auth);
        consent.headers.set('Content-Type', 'text/html; charset=utf-8');
        // Preserve the Origin on this page's same-origin form POST. no-referrer
        // makes real Chromium form navigations send Origin: null.
        consent.headers.set('Referrer-Policy', 'same-origin');
        consent.headers.set('Content-Security-Policy', "default-src 'none'; form-action 'self' https://chatgpt.com/connector_platform_oauth_redirect; frame-ancestors 'none'; base-uri 'none'");
        return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>P DevSpace 授权</title><h1>P DevSpace 授权</h1><p>应用：${escape(details.clientName)}（客户端自行注册，名称未经验证）</p><p>授权回调：<strong>${escape(details.redirectHost)}</strong></p><p>权限：读取与编辑文件、执行命令。应用可访问已绑定的 Mac mini 和 Lecoo；每个 Workspace 始终固定在原设备。Shell 使用该设备本地用户的权限。</p><p>范围：${details.scope.map(escape).join(', ')}</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}"><p><label>单人专用授权码 <input type="password" name="owner_code" autocomplete="off" maxlength="128"></label></p><button name="decision" value="approve">授权此应用</button> <button name="decision" value="deny">拒绝</button></form></html>`, { headers: consent.headers });
      }
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
      if (request.headers.get('origin') !== FLEET_ORIGIN) return new Response('Forbidden origin', { status: 403, headers: noStore });
      const form = await formBody(request), handle = form.get('handle');
      if (form.get('decision') === 'deny') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      if (form.get('decision') !== 'approve') return new Response('Invalid decision', { status: 400, headers: noStore });
      if (!await fleetStub(env).allowOAuthAttempt('login')) return new Response('Too many authorization attempts; wait one minute', { status: 429, headers: noStore });
      if (!await matchesHash(form.get('owner_code'), env.FLEET_OAUTH_OWNER_HASH)) return new Response('Authorization code rejected. Start the connection again.', { status: 403, headers: noStore });
      const approved = await oauth.approveConsent(request, handle);
      const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: 'personal-owner', metadata: {},
        scope: approved.request.scope, props: { userId: 'personal-owner' } });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo && request.method === 'GET') return Response.redirect(error.redirectTo, 302);
      return new Response('Authorization request expired, was invalid, or could not be completed. Start again from your client.', { status: 400, headers: noStore });
    }
  },
};

export const oauthProvider = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: { async fetch(request, env, ctx) {
    if (ctx.props?.userId !== 'personal-owner') return new Response('Forbidden', { status: 403, headers: noStore });
    if (!ctx.auth.scope.includes('devspace')) return insufficientScope(ctx.auth, ['devspace']);
    return forwardGateway(request, env, true);
  } },
  defaultHandler: authorizationHandler,
  authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: ['devspace', 'offline_access'], requiredScopes: ['devspace'],
  resourceMetadata: { resource: RESOURCE, authorization_servers: [FLEET_ORIGIN] },
  clientIdMetadataDocumentEnabled: false,
  accessTokenTTL: 3600, refreshTokenTTL: 30 * 24 * 3600, clientRegistrationTTL: 30 * 24 * 3600,
  clientRegistrationCallback({ clientMetadata }) {
    const redirects = clientMetadata.redirect_uris;
    if (!Array.isArray(redirects) || !redirects.length || redirects.some(value => {
      try { const u = new URL(value); return u.protocol !== 'https:' || u.hostname !== 'chatgpt.com' || u.pathname !== '/connector_platform_oauth_redirect' || u.username || u.password || u.search || u.hash || u.port; }
      catch { return true; }
    })) return { description: 'This Personal deployment accepts only ChatGPT OAuth callbacks' };
  },
  onError() { /* Expected OAuth failures contain no logged token/request data. */ },
});
