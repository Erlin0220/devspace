import runtimeCatalog from './runtime-catalog.json' with { type: 'json' };
import { DeviceTransport, FleetError, PROTOCOL_VERSIONS, parseDevices, sha256 } from './upstream.mjs';

const SESSION_TTL = 60 * 60_000;
const ROUTE_TTL = 7 * 24 * 60 * 60_000;
const MAX_REQUEST_BYTES = 512 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => ({ type: 'text', text: value });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});
const rpc = (id, result, headers) => json({ jsonrpc: '2.0', id, result }, 200, headers);
const rpcError = (id, code, message, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status);

export function fleetTools() {
  const descriptions = {
    open_workspace: 'Open a project on an explicitly selected device from list_devices. The returned workspaceId permanently selects that device; reuse it for subsequent work. No cross-device migration is supported.',
    read: 'Read a file in the workspace on its bound device. Follow the workspace instruction files before working under nested directories.',
    apply_patch: 'Apply a patch in the workspace on its bound device. Paths must be relative to that workspace.',
    exec_command: 'Run a command on the workspace’s bound device using its native shell. Reuse any returned opaque sessionId with write_stdin. A connection failure never authorizes replay or execution on another device.',
    write_stdin: 'Poll or write to the opaque process sessionId returned by exec_command, using the same workspaceId. The session cannot move between devices or workspaces.',
    codegraph_explore: 'Explore source and call relationships in the workspace on its bound device. Requires CodeGraph enabled on that device; failure never changes the target device.',
  };
  const tools = runtimeCatalog.map(source => {
    const tool = structuredClone(source);
    tool.description = descriptions[tool.name];
    if (tool.name === 'open_workspace') {
      tool.inputSchema.properties.deviceId = { type: 'string', description: 'Exact device id returned by list_devices.' };
      tool.inputSchema.required = [...tool.inputSchema.required, 'deviceId'];
      Object.assign(tool.outputSchema.properties, {
        deviceId: { type: 'string' }, deviceName: { type: 'string' }, platform: { enum: ['darwin', 'windows', 'linux'] },
      });
      tool.outputSchema.required.push('deviceId', 'deviceName', 'platform');
    }
    if (tool.inputSchema.properties.workspaceId) tool.inputSchema.properties.workspaceId.description = 'Opaque Fleet workspaceId returned by open_workspace; it fixes the target device.';
    if (tool.name === 'write_stdin') tool.inputSchema.properties.sessionId = { type: 'string', description: 'Opaque Fleet process sessionId from exec_command; never a raw number.' };
    if (['exec_command', 'write_stdin'].includes(tool.name)) tool.outputSchema.properties.sessionId = { type: 'string' };
    // MCP clients may validate structured errors after tools/list as well as
    // successful results. Keep routing failures part of the advertised contract.
    tool.outputSchema = { type: 'object', anyOf: [tool.outputSchema, {
      type: 'object', required: ['result', 'error'], additionalProperties: false,
      properties: { result: { type: 'string' }, error: { type: 'object', required: ['code'],
        properties: { code: { type: 'string' } }, additionalProperties: false } },
    }] };
    return tool;
  });
  return [{ name: 'list_devices', description: 'List registered devices and their current availability. Use an exact id when opening a workspace. Offline devices are never replaced with another device.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: { type: 'object', required: ['devices'], properties: { devices: { type: 'array', items: {
      type: 'object', required: ['id', 'name', 'platform', 'bindingId', 'online'], properties: {
        id: { type: 'string' }, name: { type: 'string' }, platform: { type: 'string' }, bindingId: { type: 'string' },
        online: { type: 'boolean' }, version: { type: 'string' }, reason: { type: 'string' },
      },
    } } } },
  }, ...tools];
}

// These captured runtime inputs use this bounded JSON Schema subset. Reject
// unknown arguments here, before a request can reach any local machine.
function validInput(schema, value) {
  if (schema.anyOf) return schema.anyOf.some(s => validInput(s, value));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') {
    if (!record(value)) return false;
    if ((schema.required ?? []).some(key => !(key in value))) return false;
    return Object.entries(value).every(([key, v]) => schema.properties?.[key] ? validInput(schema.properties[key], v) : schema.additionalProperties !== false);
  }
  if (schema.type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? MAX_REQUEST_BYTES);
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number' && Number.isFinite(value)
    && (schema.type !== 'integer' || Number.isInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value) && value.every(v => validInput(schema.items, v));
  if (schema.type === 'null') return value === null;
  return true;
}

async function requestBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  let size = 0, value = ''; const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return JSON.parse(value + decoder.decode());
      size += part.value.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new Error('Request too large');
      value += decoder.decode(part.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export class FleetGateway {
  constructor({ storage, clientToken, bindings, transport = new DeviceTransport(), now = Date.now, allowLoopback = false }) {
    if (typeof clientToken !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(clientToken)) throw new Error('Configure a private FLEET_CLIENT_TOKEN');
    this.storage = storage; this.clientTokenHash = sha256(clientToken); this.transport = transport; this.now = now;
    this.devices = new Map(parseDevices(bindings, { allowLoopback }).map(d => [d.id, d]));
    if ([...this.devices.values()].some(d => d.apiToken === clientToken)) throw new Error('Fleet and device credentials must be independent');
    this.tools = fleetTools(); this.connecting = new Map(); this.allocation = Promise.resolve();
    this.fingerprints = new Map([...this.devices.values()].map(d => [d.id, sha256(JSON.stringify([d.bindingId, d.endpoint, d.runtimeOwner, d.apiToken, d.platform]))]));
  }

  async authorized(request) {
    const token = /^Bearer ([\x21-\x7e]{32,4096})$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return false;
    const [actual, expected] = await Promise.all([sha256(token), this.clientTokenHash]);
    let difference = 0; for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
    return difference === 0;
  }

  async get(key) {
    const value = await this.storage.get(key);
    if (value?.expiresAt <= this.now()) { await this.storage.delete(key); return undefined; }
    return value;
  }

  async allocate(prefix, value, maximum) {
    const next = this.allocation.then(async () => {
      const entries = await this.storage.list({ prefix, limit: maximum + 1 });
      let active = 0;
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= this.now()) await this.storage.delete(key); else active++;
      }
      if (active >= maximum) throw new FleetError('FLEET_CAPACITY', 'Fleet handle capacity reached. Expired records are reclaimed; existing work is never moved.');
      const handle = prefix === 'm:' ? `fm_${crypto.randomUUID()}` : prefix === 'w:' ? `fw_${crypto.randomUUID()}` : `fp_${crypto.randomUUID()}`;
      await this.storage.put(prefix + handle, value); return handle;
    });
    this.allocation = next.catch(() => {}); return next;
  }

  device(id) {
    const device = this.devices.get(id);
    if (!device || !device.enabled) throw new FleetError('DEVICE_UNBOUND', 'The selected device is not bound or is disabled. Select a registered device; existing work cannot migrate.');
    return device;
  }

  async assertBinding(route) {
    const device = this.device(route.deviceId);
    if (route.binding !== await this.fingerprints.get(device.id)) throw new FleetError('DEVICE_REBOUND', 'This handle belongs to an earlier device binding. Open a new workspace explicitly; the existing operation cannot migrate.');
    return device;
  }

  async connection(device) {
    const fingerprint = await this.fingerprints.get(device.id);
    const saved = await this.storage.get('u:' + device.id);
    if (saved?.binding === fingerprint) return saved;
    if (!this.connecting.has(device.id)) {
      const pending = (async () => {
        const connection = { ...await this.transport.initialize(device), binding: fingerprint };
        await this.storage.put('u:' + device.id, connection); return connection;
      })().finally(() => this.connecting.delete(device.id));
      this.connecting.set(device.id, pending);
    }
    return this.connecting.get(device.id);
  }

  async call(device, connection, name, args, meta) {
    try {
      const response = await this.transport.rpc(device, connection, 'tools/call', {
        name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }),
      });
      const result = response.result;
      if (!record(result) || !Array.isArray(result.content)) throw new FleetError('OPERATION_OUTCOME_UNKNOWN', `Device ${device.id} returned an invalid tool result. Do not replay the operation blindly.`);
      if (result.isError) return { isError: true, content: result.content, structuredContent: {
        result: result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), error: { code: 'DEVICE_TOOL_ERROR' },
      } };
      // Personal Fleet intentionally exposes no upstream widgets/resources. A
      // device's local URLs and UI metadata are not valid gateway routes.
      return { content: result.content, ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }), ...(result.isError === undefined ? {} : { isError: result.isError }) };
    } catch (error) {
      if (error.code === 'DEVICE_SESSION_LOST') {
        const saved = await this.storage.get('u:' + device.id);
        if (saved?.sessionId === connection.sessionId) await this.storage.delete('u:' + device.id);
      }
      throw error;
    }
  }

  async listDevices() {
    const devices = await Promise.all([...this.devices.values()].map(async d => {
      const result = { id: d.id, name: d.name, platform: d.platform, bindingId: d.bindingId, online: false };
      if (!d.enabled) return { ...result, reason: 'DEVICE_DISABLED' };
      let connection;
      try {
        const health = await this.transport.health(d);
        connection = await this.connection(d);
        await this.transport.rpc(d, connection, 'ping', undefined, { readOnly: true });
        return { ...result, ...health, online: true };
      } catch (error) {
        if (connection && error.code === 'DEVICE_SESSION_LOST') {
          const saved = await this.storage.get('u:' + d.id);
          if (saved?.sessionId === connection.sessionId) await this.storage.delete('u:' + d.id);
        }
        return { ...result, reason: error.code ?? 'DEVICE_UNAVAILABLE' };
      }
    }));
    return { content: [text(JSON.stringify({ devices }))], structuredContent: { devices } };
  }

  async tool(name, args, meta) {
    const definition = this.tools.find(t => t.name === name);
    if (!definition || !validInput(definition.inputSchema, args)) throw new FleetError('INVALID_ARGUMENT', 'Unknown tool or invalid arguments. Use the advertised schema and opaque Fleet handles.');
    if (name === 'list_devices') return this.listDevices();
    if (name === 'open_workspace') {
      const device = this.device(args.deviceId);
      await this.transport.health(device);
      const connection = await this.connection(device);
      const { deviceId: _, ...remoteArgs } = args;
      // Reserve routing capacity before opening a worktree or starting work.
      const route = { deviceId: device.id, binding: await this.fingerprints.get(device.id), remoteId: null,
        upstreamSessionId: connection.sessionId, protocolVersion: connection.protocolVersion, expiresAt: this.now() + ROUTE_TTL };
      const handle = await this.allocate('w:', route, 4096);
      let result, raw;
      try {
        result = await this.call(device, connection, name, remoteArgs, meta);
        if (result.isError) { await this.storage.delete('w:' + handle).catch(() => {}); return result; }
        raw = result.structuredContent?.workspaceId;
        if (typeof raw !== 'string' || !raw || raw.length > 256) throw new FleetError('DEVICE_PROTOCOL_ERROR', 'The selected device did not return a workspace handle.');
        try { await this.storage.put('w:' + handle, { ...route, remoteId: raw }); }
        catch { throw new FleetError('OPERATION_OUTCOME_UNKNOWN', `The workspace operation on ${device.id} completed but its route could not be recorded. Inspect that device before repeating the operation.`); }
      } catch (error) { await this.storage.delete('w:' + handle).catch(() => {}); throw error; }
      result.content = result.content.map(c => c.type === 'text' ? { ...c, text: c.text.replaceAll(raw, handle) } : c);
      result.structuredContent = { ...result.structuredContent, workspaceId: handle, deviceId: device.id, deviceName: device.name, platform: device.platform,
        instruction: `This workspace is pinned to device ${device.id} (${device.platform}). Never move or replay its work on another device. ${String(result.structuredContent.instruction ?? '').replaceAll(raw, handle)}` };
      return result;
    }
    // deviceId is never a permitted override once a workspace has been opened.
    if ('deviceId' in args || typeof args.workspaceId !== 'string') throw new FleetError('INVALID_ARGUMENT', 'Use the workspaceId to route this call; device overrides are not allowed.');
    const workspace = await this.get('w:' + args.workspaceId);
    if (!workspace || typeof workspace.remoteId !== 'string') throw new FleetError('UNKNOWN_WORKSPACE', 'Unknown or expired Fleet workspaceId. Open a workspace on an explicit device.');
    const device = await this.assertBinding(workspace);
    const remoteArgs = { ...args, workspaceId: workspace.remoteId };
    let processHandle;
    if (name === 'write_stdin') {
      const process = typeof args.sessionId === 'string' ? await this.get('p:' + args.sessionId) : null;
      if (!process || process.workspaceId !== args.workspaceId || process.binding !== workspace.binding
        || process.upstreamSessionId !== workspace.upstreamSessionId) {
        throw new FleetError('SESSION_WORKSPACE_MISMATCH', 'This process session does not belong to this workspace and device. It cannot be transferred.');
      }
      remoteArgs.sessionId = process.remoteId; processHandle = args.sessionId;
    }
    await this.transport.health(device);
    const processRoute = { deviceId: device.id, workspaceId: args.workspaceId, binding: workspace.binding,
      upstreamSessionId: workspace.upstreamSessionId, remoteId: null, expiresAt: this.now() + ROUTE_TTL };
    let reserved;
    if (name === 'exec_command') reserved = await this.allocate('p:', processRoute, 8192);
    let result;
    try { result = await this.call(device, { sessionId: workspace.upstreamSessionId, protocolVersion: workspace.protocolVersion }, name, remoteArgs, meta); }
    catch (error) { if (reserved) await this.storage.delete('p:' + reserved).catch(() => {}); throw error; }
    if (result.isError || !['exec_command', 'write_stdin'].includes(name)) {
      if (reserved) await this.storage.delete('p:' + reserved).catch(() => {});
      return result;
    }
    const sessionId = result.structuredContent?.sessionId;
    if (sessionId !== undefined) {
      if (!Number.isSafeInteger(sessionId) || sessionId < 0) throw new FleetError('DEVICE_PROTOCOL_ERROR', 'The device returned an invalid process session identifier.');
      if (name === 'write_stdin' && sessionId !== remoteArgs.sessionId) throw new FleetError('DEVICE_PROTOCOL_ERROR', 'The device changed the process session identifier.');
      processHandle ??= reserved;
      if (reserved) {
        try { await this.storage.put('p:' + reserved, { ...processRoute, remoteId: sessionId }); }
        catch { throw new FleetError('OPERATION_OUTCOME_UNKNOWN', `The command on ${device.id} was dispatched but its process route could not be recorded. Do not repeat it blindly.`); }
      }
      const replaceStatus = value => value.replaceAll(`Process running with session ID ${sessionId}.`, `Process running with session ID ${processHandle}.`);
      result.content = result.content.map(c => c.type === 'text' ? { ...c, text: replaceStatus(c.text) } : c);
      result.structuredContent = { ...result.structuredContent, sessionId: processHandle,
        ...(typeof result.structuredContent.result === 'string' ? { result: replaceStatus(result.structuredContent.result) } : {}) };
    } else if (reserved) await this.storage.delete('p:' + reserved).catch(() => {});
    return result;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return json({ name: 'personal-devspace-fleet', version: '0.1.0' });
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    if (!await this.authorized(request)) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' } });
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return new Response('Forbidden origin', { status: 403 });
    if (!['POST', 'DELETE'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } });
    const handle = request.headers.get('mcp-session-id');
    const session = handle && /^fm_[a-f0-9-]{36}$/.test(handle) ? await this.get('m:' + handle) : undefined;
    if (request.method === 'DELETE') {
      if (!session) return rpcError(null, -32000, 'Unknown MCP session', 404);
      await this.storage.delete('m:' + handle); return new Response(null, { status: 204 });
    }
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return rpcError(null, -32600, 'Expected application/json', 415);
    let body;
    try { body = await requestBody(request); } catch { return rpcError(null, -32700, 'Invalid or oversized JSON request', 400); }
    if (!record(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || body.method.length > 100
      || ('id' in body && !(typeof body.id === 'string' && body.id.length <= 256 || typeof body.id === 'number' && Number.isFinite(body.id)))) return rpcError(null, -32600, 'Invalid JSON-RPC request', 400);
    if (body.method === 'initialize') {
      if (handle || !('id' in body) || !record(body.params)) return rpcError(body.id ?? null, -32600, 'Initialize without an existing session', 400);
      const version = PROTOCOL_VERSIONS.includes(body.params.protocolVersion) ? body.params.protocolVersion : PROTOCOL_VERSIONS[0];
      try {
        const id = await this.allocate('m:', { protocolVersion: version, expiresAt: this.now() + SESSION_TTL }, 256);
        return rpc(body.id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'personal-devspace-fleet', version: '0.1.0' },
          instructions: 'One Personal Fleet, several independent devices. Use list_devices, choose deviceId in open_workspace, and reuse its workspaceId. Process sessionId values are opaque and require the same workspace. Device bindings never migrate. Offline or uncertain operations are never replayed or sent elsewhere. Subagents, task scheduling, widgets and resource proxying are outside this minimal gateway.' }, { 'Mcp-Session-Id': id });
      } catch { return rpcError(body.id, -32000, 'MCP session capacity reached', 429); }
    }
    if (!session) return rpcError(body.id ?? null, -32000, 'Unknown or expired MCP session', 404);
    const version = request.headers.get('mcp-protocol-version');
    if (version && version !== session.protocolVersion) return rpcError(body.id ?? null, -32600, 'MCP protocol version mismatch', 400);
    if (session.expiresAt - this.now() < SESSION_TTL - 60_000) await this.storage.put('m:' + handle, { ...session, expiresAt: this.now() + SESSION_TTL });
    if (!('id' in body)) return new Response(null, { status: 202 });
    if (body.method === 'ping') return rpc(body.id, {});
    if (body.method === 'tools/list') return rpc(body.id, { tools: this.tools });
    if (['resources/list', 'resources/templates/list', 'prompts/list'].includes(body.method)) return rpc(body.id, body.method === 'prompts/list' ? { prompts: [] } : body.method === 'resources/templates/list' ? { resourceTemplates: [] } : { resources: [] });
    if (body.method !== 'tools/call') return rpcError(body.id, -32601, 'Method not found');
    try {
      const params = body.params;
      if (!record(params) || typeof params.name !== 'string' || !record(params.arguments ?? {})) throw new FleetError('INVALID_ARGUMENT', 'Invalid tool arguments');
      return rpc(body.id, await this.tool(params.name, params.arguments ?? {}, params._meta));
    } catch (error) {
      const code = error instanceof FleetError ? error.code : 'FLEET_INTERNAL_ERROR';
      const message = error instanceof FleetError ? error.message : 'Gateway request failed. No fallback or replay was attempted.';
      return rpc(body.id, { isError: true, content: [text(`${code}: ${message}`)], structuredContent: { result: message, error: { code } } });
    }
  }
}
