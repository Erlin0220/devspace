export const CLIENT_TOKEN = 'fleet-client-fixture-not-a-real-secret-0000';
export const OWNER_A = 'a'.repeat(20), OWNER_B = 'b'.repeat(20);

export class MemoryStorage {
  constructor() { this.entries = new Map(); }
  async get(key) { return structuredClone(this.entries.get(key)); }
  async put(key, value) { this.entries.set(key, structuredClone(value)); }
  async delete(key) { return this.entries.delete(key); }
  async list({ prefix = '', limit = Infinity } = {}) { return new Map([...this.entries].filter(([key]) => key.startsWith(prefix)).sort().slice(0, limit).map(([k, v]) => [k, structuredClone(v)])); }
}

export function bindings() {
  return [
    { id: 'macmini', name: 'Mac mini', platform: 'darwin', bindingId: 'binding_macmini_001', runtimeOwner: OWNER_A, endpoint: 'https://mac.fixture.invalid/mcp', apiToken: 'device-mac-private-fixture-token-0000000' },
    { id: 'lecoo', name: 'Lecoo', platform: 'windows', bindingId: 'binding_lecoo_00001', runtimeOwner: OWNER_B, endpoint: 'https://lecoo.fixture.invalid/mcp', apiToken: 'device-lecoo-private-fixture-token-00000' },
  ];
}

export function fakeDevices() {
  const devices = bindings().map(binding => ({ ...binding, offline: false, lostSession: false, ownerMismatch: false,
    posts: [], commands: 0, outcomeUnknown: false, unauthorized: false, redirect: false }));
  const fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const device = devices.find(d => new URL(d.endpoint).hostname === url.hostname);
    if (!device) throw Error('Unexpected target');
    if (device.offline) throw Error('Offline');
    if (url.pathname === '/personal-healthz') return Response.json({ name: 'personal-devspace', owner: device.ownerMismatch ? 'c'.repeat(20) : device.runtimeOwner, version: '1.0.8' });
    if (init.redirect !== 'manual') throw Error('Redirects must not be followed');
    const headers = new Headers(init.headers);
    if (headers.get('authorization') !== `Bearer ${device.apiToken}`) return new Response('Unauthorized', { status: 401 });
    if (device.unauthorized) return new Response('Private token: ' + device.apiToken, { status: 401 });
    if (device.redirect) return new Response(null, { status: 302, headers: { Location: 'https://evil.invalid/' } });
    const message = JSON.parse(init.body); device.posts.push(message);
    if (device.lostSession && headers.has('mcp-session-id')) return new Response('Unknown session', { status: 404 });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const respond = result => Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers: { 'Mcp-Session-Id': 'same-remote-session' } });
    if (message.method === 'initialize') return respond({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
    if (message.method === 'ping') return respond({});
    if (message.method !== 'tools/call') throw Error('Unexpected method');
    const { name, arguments: args } = message.params;
    if (name === 'open_workspace') return respond({ content: [{ type: 'text', text: 'Opened workspace ws_same' }], structuredContent: { workspaceId: 'ws_same', root: args.path, mode: args.mode ?? 'checkout', instruction: 'Use ws_same' } });
    if (args.workspaceId !== 'ws_same') throw Error('Gateway did not unwrap workspace');
    if (name === 'exec_command') {
      device.commands++;
      if (device.outcomeUnknown) throw Error('Disconnected after execution');
    }
    if (['exec_command', 'write_stdin'].includes(name)) {
      if (name === 'write_stdin' && args.sessionId !== 7) throw Error('Gateway did not unwrap process session');
      const result = `${device.id}: output 7 remains untouched\nProcess running with session ID 7.`;
      return respond({ content: [{ type: 'text', text: result }], structuredContent: { result, sessionId: 7, running: true, wallTimeMs: 1, outputTruncated: false }, _meta: { private: device.endpoint } });
    }
    return respond({ content: [{ type: 'text', text: device.id }], structuredContent: { result: device.id } });
  };
  return { devices, fetch };
}
