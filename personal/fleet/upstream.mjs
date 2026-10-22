const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

export class FleetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('');
}

export function parseDevices(value, { allowLoopback = false } = {}) {
  let input;
  try { input = JSON.parse(value); } catch { throw new Error('Invalid FLEET_DEVICE_BINDINGS'); }
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) throw new Error('Configure 1..8 device bindings');
  const ids = new Set(), endpoints = new Set(), tokens = new Set(), bindings = new Set();
  return input.map(d => {
    if (!d || !/^[a-z][a-z0-9-]{0,47}$/.test(d.id ?? '') || ids.has(d.id)
      || typeof d.name !== 'string' || !d.name.trim() || d.name.length > 80
      || !['darwin', 'windows', 'linux'].includes(d.platform)
      || !/^[a-zA-Z0-9_-]{16,80}$/.test(d.bindingId ?? '')
      || !/^[a-f0-9]{20}$/.test(d.runtimeOwner ?? '')
      || typeof d.apiToken !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(d.apiToken)) {
      throw new Error('Invalid device binding');
    }
    let endpoint;
    try { endpoint = new URL(d.endpoint); } catch { throw new Error('Invalid device endpoint'); }
    const local = allowLoopback && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (!(endpoint.protocol === 'https:' || (local && endpoint.protocol === 'http:'))
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/mcp'
      || (!allowLoopback && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
      throw new Error('Device endpoint must be an HTTPS /mcp URL without credentials or query');
    }
    if (endpoints.has(endpoint.href) || tokens.has(d.apiToken) || bindings.has(d.bindingId)) throw new Error('Device bindings must have independent endpoints, credentials and binding ids');
    ids.add(d.id); endpoints.add(endpoint.href); tokens.add(d.apiToken); bindings.add(d.bindingId);
    return { id: d.id, name: d.name, platform: d.platform, bindingId: d.bindingId,
      runtimeOwner: d.runtimeOwner, apiToken: d.apiToken, endpoint: endpoint.href,
      enabled: d.enabled !== false };
  });
}

async function readLimited(response, limit = MAX_RESPONSE_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const decoder = new TextDecoder(); let text = '', size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new Error('Response limit exceeded');
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
}

async function readRpc(response, id) {
  if (response.headers.get('content-type')?.includes('application/json')) {
    return JSON.parse(await readLimited(response));
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Invalid MCP response type');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty MCP stream');
  const decoder = new TextDecoder(); let pending = '', size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('MCP stream ended without a response');
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Response limit exceeded');
      pending = (pending + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n');
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const event = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const message = JSON.parse(data);
        if (message.id === id && ('result' in message || 'error' in message)) return message;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export class DeviceTransport {
  constructor({ fetch: fetchImpl = fetch, timeoutMs = 90_000, healthTimeoutMs = 3_000 } = {}) {
    // Workers' native fetch must not receive a DeviceTransport as its receiver.
    this.fetch = (input, init) => fetchImpl(input, init);
    this.timeoutMs = timeoutMs; this.healthTimeoutMs = healthTimeoutMs;
  }

  async health(device) {
    let response, health;
    try {
      response = await this.fetch(new URL('/personal-healthz', device.endpoint), {
        redirect: 'manual', signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Not healthy'); }
      health = JSON.parse(await readLimited(response, 16 * 1024));
    } catch { throw new FleetError('DEVICE_OFFLINE', `Device ${device.id} is offline or unavailable. No other device was used.`); }
    if (health?.name !== 'personal-devspace' || health.owner !== device.runtimeOwner) {
      throw new FleetError('DEVICE_BINDING_MISMATCH', `Device ${device.id} no longer matches its registered Runtime. Rebind it explicitly; existing work cannot migrate.`);
    }
    return { version: typeof health.version === 'string' ? health.version.slice(0, 40) : undefined };
  }

  async rpc(device, connection, method, params, { notification = false, readOnly = false } = {}) {
    const id = crypto.randomUUID();
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${device.apiToken}` };
    if (connection) { headers['Mcp-Session-Id'] = connection.sessionId; headers['MCP-Protocol-Version'] = connection.protocolVersion; }
    let response;
    try {
      response = await this.fetch(device.endpoint, {
        method: 'POST', redirect: 'manual', headers, signal: AbortSignal.timeout(readOnly ? Math.min(this.timeoutMs, this.healthTimeoutMs) : this.timeoutMs),
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
      });
      if (response.status === 404 && connection) {
        await response.body?.cancel();
        throw new FleetError('DEVICE_SESSION_LOST', `The MCP session on ${device.id} ended. Open a new workspace on that device. The operation was not replayed or moved.`);
      }
      if ([401, 403].includes(response.status)) {
        await response.body?.cancel();
        throw new FleetError('DEVICE_AUTH_FAILED', `Device ${device.id} rejected its registered credential. No fallback or replay was attempted.`);
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('Upstream HTTP failure'); }
      if (notification) { await response.body?.cancel(); return {}; }
      const message = await readRpc(response, id);
      if (message?.jsonrpc !== '2.0' || message.id !== id || (!('result' in message) && !message.error)) throw new Error('Invalid JSON-RPC response');
      if (message.error) throw new FleetError('DEVICE_RPC_ERROR', `Device ${device.id} rejected the MCP request (${Number(message.error.code) || -32603}).`);
      return { result: message.result, sessionId: response.headers.get('mcp-session-id') };
    } catch (error) {
      if (error instanceof FleetError) throw error;
      throw new FleetError(readOnly ? 'DEVICE_UNAVAILABLE' : 'OPERATION_OUTCOME_UNKNOWN', readOnly
        ? `Device ${device.id} could not complete the request. No fallback was attempted.`
        : `The result on ${device.id} is unknown after dispatch. Do not repeat the operation blindly; inspect the same device. No replay or migration was attempted.`);
    }
  }

  async initialize(device) {
    const { result, sessionId } = await this.rpc(device, null, 'initialize', {
      protocolVersion: PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'personal-devspace-fleet', version: '0.1.0' },
    }, { readOnly: true });
    if (typeof sessionId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(sessionId)
      || !PROTOCOL_VERSIONS.includes(result?.protocolVersion)) throw new FleetError('DEVICE_PROTOCOL_ERROR', `Device ${device.id} did not establish a compatible stateful MCP session.`);
    const connection = { sessionId, protocolVersion: result.protocolVersion };
    await this.rpc(device, connection, 'notifications/initialized', undefined, { notification: true, readOnly: true });
    return connection;
  }
}
