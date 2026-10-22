import { DurableObject } from 'cloudflare:workers';
import { FleetGateway } from './gateway.mjs';

export class PersonalFleet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.gateway = new FleetGateway({ storage: ctx.storage,
      clientToken: env.FLEET_CLIENT_TOKEN, bindings: env.FLEET_DEVICE_BINDINGS });
  }
  fetch(request) { return this.gateway.fetch(request); }
}

export default {
  async fetch(request, env) {
    // A single-owner Personal deployment has one atom of coordination. This
    // namespace is independent of Team, Windows MCP and every local Runtime.
    try { return await env.FLEET.get(env.FLEET.idFromName('personal-owner-v1')).fetch(request); }
    catch { return new Response('Personal Fleet is not configured or temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
  },
};
