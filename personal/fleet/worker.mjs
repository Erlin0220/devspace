import { DurableObject } from 'cloudflare:workers';
import { FleetGateway } from './gateway.mjs';
import { forwardGateway, matchesHash, oauthProvider } from './oauth.mjs';
import { sha256 } from './upstream.mjs';

export class PersonalFleet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.gateway = new FleetGateway({ storage: ctx.storage,
      clientToken: env.FLEET_CLIENT_TOKEN, bindings: env.FLEET_DEVICE_BINDINGS });
  }
  fetch(request) { return this.gateway.fetch(request); }
  async allowOAuthAttempt(kind) {
    if (!['login', 'register'].includes(kind)) return false;
    return this.ctx.storage.transaction(async tx => {
      const key = 'oauth-rate:' + kind, bucket = Math.floor(Date.now() / 60_000);
      const old = await tx.get(key), count = old?.bucket === bucket ? old.count + 1 : 1;
      await tx.put(key, { bucket, count }); return count <= (kind === 'login' ? 12 : 20);
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    // A single-owner Personal deployment has one atom of coordination. This
    // namespace is independent of Team, Windows MCP and every local Runtime.
    try {
      // The existing private operator key remains useful for deployment probes.
      // OAuth tokens never reach or replace either device's private credential.
      const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      if (new URL(request.url).pathname === '/mcp' && token && typeof env.FLEET_CLIENT_TOKEN === 'string'
        && await matchesHash(token, await sha256(env.FLEET_CLIENT_TOKEN))) return forwardGateway(request, env);
      if (!env.OAUTH_KV) return forwardGateway(request, env);
      if (new URL(request.url).pathname === '/oauth/register' && request.method === 'POST'
        && !await env.FLEET.get(env.FLEET.idFromName('personal-owner-v1')).allowOAuthAttempt('register')) return new Response('Too many registrations', { status: 429 });
      return await oauthProvider.fetch(request, env, ctx);
    }
    catch { return new Response('Personal Fleet is not configured or temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
  },
};
