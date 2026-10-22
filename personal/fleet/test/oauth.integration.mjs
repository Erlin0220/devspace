import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel, Response as MfResponse } from 'miniflare';
import { CLIENT_TOKEN, bindings, fakeDevices } from './fixtures.mjs';
import { sha256 } from '../upstream.mjs';
const ORIGIN = 'https://personal-devspace-fleet.568920429.xyz';
const OWNER_CODE = 'private-fixture-owner-code-never-a-real-credential';

test('OAuth in real workerd: owner consent, browser binding, PKCE, code replay, refresh and authenticated MCP', { timeout: 30_000 }, async t => {
  const backend = fakeDevices();
  const worker = new Miniflare({ name: 'personal-fleet-oauth-test', modules: true,
    scriptPath: fileURLToPath(new URL('../.build/worker.js', import.meta.url)), compatibilityDate: '2026-07-30',
    bindings: { FLEET_CLIENT_TOKEN: CLIENT_TOKEN, FLEET_DEVICE_BINDINGS: JSON.stringify(bindings()), FLEET_OAUTH_OWNER_HASH: await sha256(OWNER_CODE) },
    kvNamespaces: ['OAUTH_KV'], durableObjects: { FLEET: { className: 'PersonalFleet', useSQLite: true } },
    log: new Log(LogLevel.NONE), cf: false,
    outboundService: async req => { const r = await backend.fetch(req.url, { method: req.method, headers: req.headers,
      ...(req.method === 'POST' ? { body: await req.text() } : {}) }); return new MfResponse(await r.arrayBuffer(), { status: r.status, headers: r.headers }); },
  });
  t.after(() => worker.dispose()); await worker.ready;
  const fetch = (path, init = {}) => worker.dispatchFetch(ORIGIN + path, { redirect: 'manual', ...init });
  const postJson = (path, value, extra = {}) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(value) });
  const unauthorized = await postJson('/mcp', {}); assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate'), /resource_metadata/); await unauthorized.arrayBuffer();
  const metadata = await (await fetch('/.well-known/oauth-authorization-server')).json();
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  assert.equal(metadata.registration_endpoint, ORIGIN + '/oauth/register');
  const resource = await (await fetch('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(resource.resource, ORIGIN + '/mcp');
  const deniedClient = await postJson('/oauth/register', { client_name: 'Untrusted', redirect_uris: ['https://attacker.invalid/callback'], token_endpoint_auth_method: 'none' });
  assert.equal(deniedClient.status, 400); await deniedClient.arrayBuffer();
  const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const registered = await postJson('/oauth/register', { client_name: '<script>hostile-name</script>', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  assert.equal(registered.status, 201); const client = await registered.json();
  const verifier = 'fixture-PKCE-verifier-with-at-least-43-characters-001';
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: callback, response_type: 'code', resource: ORIGIN + '/mcp', scope: 'devspace offline_access', state: 'fixture-state',
    code_challenge: Buffer.from(await sha256(verifier), 'hex').toString('base64url'), code_challenge_method: 'S256' });
  const missingPkce = new URLSearchParams(query); missingPkce.delete('code_challenge');
  const bad = await fetch('/authorize?' + missingPkce); assert.ok(bad.status >= 300); await bad.arrayBuffer();
  const consent = await fetch('/authorize?' + query); assert.equal(consent.status, 200);
  const cookie = consent.headers.get('set-cookie').split(';')[0], page = await consent.text();
  assert.ok(!page.includes('<script>hostile-name</script>')); assert.match(page, /chatgpt.com/);
  assert.match(consent.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(consent.headers.get('content-security-policy'), /form-action 'self' https:\/\/chatgpt.com\/connector_platform_oauth_redirect;/);
  assert.equal(consent.headers.get('referrer-policy'), 'same-origin');
  const handle = page.match(/name="handle" value="([^"]+)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const form = (owner, origin = ORIGIN, cookies = cookie) => fetch('/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Cookie: cookies }, body: new URLSearchParams({ handle, decision: 'approve', owner_code: owner }) });
  const wrong = await form('wrong-owner-code'); assert.equal(wrong.status, 403); await wrong.arrayBuffer();
  const crossOrigin = await form(OWNER_CODE, 'https://attacker.invalid'); assert.equal(crossOrigin.status, 403); await crossOrigin.arrayBuffer();
  const otherBrowser = await form(OWNER_CODE, ORIGIN, ''); assert.equal(otherBrowser.status, 400); await otherBrowser.arrayBuffer();
  const approval = await form(OWNER_CODE); assert.equal(approval.status, 302);
  const redirect = new URL(approval.headers.get('location')); assert.equal(redirect.origin, 'https://chatgpt.com'); assert.equal(redirect.searchParams.get('state'), 'fixture-state');
  const repeated = await form(OWNER_CODE); assert.equal(repeated.status, 400); await repeated.arrayBuffer();
  const tokenBody = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: callback, code: redirect.searchParams.get('code'), code_verifier: verifier, resource: ORIGIN + '/mcp' };
  const tokenRequest = value => fetch('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(value) });
  const exchanged = await tokenRequest(tokenBody); assert.equal(exchanged.status, 200); const token = await exchanged.json(); assert.ok(token.access_token); assert.ok(token.refresh_token);
  const mcp = await postJson('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'oauth-fixture', version: '1' } } }, { Authorization: `Bearer ${token.access_token}` });
  assert.equal(mcp.status, 200, JSON.stringify({ challenge: mcp.headers.get('www-authenticate'), body: await mcp.clone().text() })); assert.ok(mcp.headers.get('mcp-session-id')); await mcp.arrayBuffer();
  const refreshed = await tokenRequest({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token.refresh_token, resource: ORIGIN + '/mcp' });
  assert.equal(refreshed.status, 200); const renewed = await refreshed.json(); assert.notEqual(renewed.refresh_token, token.refresh_token);
  const wrongAudience = await tokenRequest({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: renewed.refresh_token, resource: 'https://attacker.invalid/mcp' });
  assert.equal(wrongAudience.status, 400); await wrongAudience.arrayBuffer();
  // Reusing an authorization code revokes its grant as well as rejecting the
  // replay, so exercise it after verifying the originally issued credentials.
  const replay = await tokenRequest(tokenBody); assert.equal(replay.status, 400); await replay.arrayBuffer();
});
