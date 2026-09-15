import { randomUUID } from 'node:crypto';
import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

interface Entry { owner: string; stream: string; sequence: number; json: string; bytes: number; expires: number }

// Only storage is customized. MCP framing, reconnection and replay remain SDK-owned.
// One bounded pool per runtime, separate capabilities per MCP session. No disk,
// background timer, retry loop, or process re-execution is introduced here.
export class ReplayPool {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private sequence = 0;
  constructor(private limits = { bytes: 8 * 1024 * 1024, events: 4096, ttlMs: 300_000 }, private now = () => performance.now()) {}

  private remove(id: string) {
    const entry = this.entries.get(id);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(id); }
  }
  private prune() {
    for (const [id, entry] of this.entries) {
      if (entry.expires > this.now() && this.bytes <= this.limits.bytes && this.entries.size <= this.limits.events) break;
      this.remove(id);
    }
  }
  get size() { this.prune(); return { bytes: this.bytes, events: this.entries.size }; }
  close() { this.entries.clear(); this.bytes = 0; }

  createStore(): EventStore & { close(): void } {
    const owner = randomUUID();
    let closed = false;
    const find = (id: string) => { this.prune(); const value = this.entries.get(id); return !closed && value?.owner === owner ? value : undefined; };
    return {
      storeEvent: async (stream, message) => {
        const id = randomUUID();
        if (closed) return id;
        const json = JSON.stringify(message);
        const bytes = json.length * 2 + 512;
        // Oversize responses still deliver normally; their cursor cannot be replayed.
        if (bytes <= this.limits.bytes) {
          this.entries.set(id, { owner, stream, json, bytes, sequence: ++this.sequence, expires: this.now() + this.limits.ttlMs });
          this.bytes += bytes;
        } else {
          // Do not replay a partial stream across an unrecorded response.
          for (const [eventId, entry] of this.entries) if (entry.owner === owner && entry.stream === stream) this.remove(eventId);
        }
        this.prune(); return id;
      },
      getStreamIdForEventId: async id => find(id)?.stream,
      replayEventsAfter: async (id, { send }) => {
        const cursor = find(id);
        if (!cursor) throw new Error('Response cursor expired or belongs to another MCP session');
        const pending = [...this.entries].filter(([, entry]) => entry.owner === owner && entry.stream === cursor.stream && entry.sequence > cursor.sequence);
        for (const [eventId, entry] of pending) await send(eventId, JSON.parse(entry.json) as JSONRPCMessage);
        return cursor.stream;
      },
      close: () => { closed = true; for (const [id, entry] of this.entries) if (entry.owner === owner) this.remove(id); },
    };
  }
}
