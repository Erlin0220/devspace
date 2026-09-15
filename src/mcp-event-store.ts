import { randomUUID } from "node:crypto";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type {
  EventId,
  EventStore,
  StreamId,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_STREAMS = 64;
const DEFAULT_MAX_EVENTS = 256;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

interface StoredEvent {
  id: EventId;
  message: JSONRPCMessage;
  bytes: number;
  createdAt: number;
}

interface StoredStream {
  id: StreamId;
  events: StoredEvent[];
  bytes: number;
  touchedAt: number;
  expiresAt: number;
}

export interface BoundedMcpEventStoreOptions {
  ttlMs?: number;
  maxStreams?: number;
  maxEvents?: number;
  maxBytes?: number;
  now?: () => number;
  onCapacityEviction?: (details: {
    streams: number;
    events: number;
    bytes: number;
  }) => void;
}

export class BoundedMcpEventStore implements EventStore {
  private readonly streams = new Map<StreamId, StoredStream>();
  private readonly eventToStream = new Map<EventId, StreamId>();
  private readonly ttlMs: number;
  private readonly maxStreams: number;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly onCapacityEviction?: BoundedMcpEventStoreOptions["onCapacityEviction"];
  private cleanupTimer?: NodeJS.Timeout;
  private totalEvents = 0;
  private totalBytes = 0;
  private closed = false;

  constructor(options: BoundedMcpEventStoreOptions = {}) {
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS, "ttlMs");
    this.maxStreams = positiveInteger(options.maxStreams, DEFAULT_MAX_STREAMS, "maxStreams");
    this.maxEvents = positiveInteger(options.maxEvents, DEFAULT_MAX_EVENTS, "maxEvents");
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
    this.now = options.now ?? Date.now;
    this.onCapacityEviction = options.onCapacityEviction;
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    this.assertOpen();
    const now = this.now();
    this.pruneExpired(now);

    const event: StoredEvent = {
      id: randomUUID(),
      message,
      bytes: estimateEventBytes(streamId, message),
      createdAt: now,
    };

    let stream = this.streams.get(streamId);
    if (!stream) {
      stream = {
        id: streamId,
        events: [],
        bytes: 0,
        touchedAt: now,
        expiresAt: now + this.ttlMs,
      };
      this.streams.set(streamId, stream);
    }

    stream.events.push(event);
    stream.bytes += event.bytes;
    stream.touchedAt = now;
    stream.expiresAt = now + this.ttlMs;
    this.eventToStream.set(event.id, streamId);
    this.totalEvents += 1;
    this.totalBytes += event.bytes;

    const evicted = this.enforceCapacity(streamId);
    if (evicted.events > 0 || evicted.streams > 0) {
      this.onCapacityEviction?.(evicted);
    }
    this.scheduleCleanup();
    return event.id;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    if (this.closed) return undefined;
    this.pruneExpired(this.now());
    this.scheduleCleanup();
    return this.eventToStream.get(eventId);
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    this.assertOpen();
    const now = this.now();
    this.pruneExpired(now);

    const streamId = this.eventToStream.get(lastEventId);
    if (!streamId) throw new Error("Unknown or expired MCP event ID.");
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error("Unknown or expired MCP event stream.");

    const cursor = stream.events.findIndex((event) => event.id === lastEventId);
    if (cursor < 0) throw new Error("Unknown or expired MCP event ID.");

    stream.touchedAt = now;
    stream.expiresAt = now + this.ttlMs;
    this.scheduleCleanup();

    // Keep reading the live stream array rather than a fixed snapshot. A terminal
    // result can be persisted while an earlier event is being replayed, before
    // the SDK registers the successor response stream. Including newly appended
    // events here closes that narrow disconnect/replay race.
    for (let index = cursor + 1; index < stream.events.length; index += 1) {
      const event = stream.events[index];
      await send(event.id, event.message);
    }
    return streamId;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    this.streams.clear();
    this.eventToStream.clear();
    this.totalEvents = 0;
    this.totalBytes = 0;
  }

  private enforceCapacity(protectedStreamId: StreamId): {
    streams: number;
    events: number;
    bytes: number;
  } {
    const beforeStreams = this.streams.size;
    const beforeEvents = this.totalEvents;
    const beforeBytes = this.totalBytes;

    while (this.streams.size > this.maxStreams) {
      const candidate = this.oldestStream(protectedStreamId) ?? this.oldestStream();
      if (!candidate) break;
      this.removeStream(candidate.id);
    }

    while (this.totalEvents > this.maxEvents || this.totalBytes > this.maxBytes) {
      const candidate = this.oldestEvent(protectedStreamId) ?? this.oldestEvent();
      if (!candidate) break;
      this.removeEvent(candidate.streamId, candidate.eventId);
    }

    return {
      streams: Math.max(0, beforeStreams - this.streams.size),
      events: Math.max(0, beforeEvents - this.totalEvents),
      bytes: Math.max(0, beforeBytes - this.totalBytes),
    };
  }

  private oldestStream(excludedStreamId?: StreamId): StoredStream | undefined {
    let oldest: StoredStream | undefined;
    for (const stream of this.streams.values()) {
      if (stream.id === excludedStreamId) continue;
      if (!oldest || stream.touchedAt < oldest.touchedAt) oldest = stream;
    }
    return oldest;
  }

  private oldestEvent(excludedStreamId?: StreamId): { streamId: StreamId; eventId: EventId } | undefined {
    let candidate: { streamId: StreamId; event: StoredEvent } | undefined;
    for (const stream of this.streams.values()) {
      if (stream.id === excludedStreamId || stream.events.length === 0) continue;
      const event = stream.events[0];
      if (!candidate || event.createdAt < candidate.event.createdAt) {
        candidate = { streamId: stream.id, event };
      }
    }
    return candidate ? { streamId: candidate.streamId, eventId: candidate.event.id } : undefined;
  }

  private pruneExpired(now: number): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.expiresAt <= now) this.removeStream(stream.id);
    }
  }

  private removeEvent(streamId: StreamId, eventId: EventId): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    const index = stream.events.findIndex((event) => event.id === eventId);
    if (index < 0) return;

    const [event] = stream.events.splice(index, 1);
    stream.bytes -= event.bytes;
    this.eventToStream.delete(event.id);
    this.totalEvents -= 1;
    this.totalBytes -= event.bytes;
    if (stream.events.length === 0) this.streams.delete(streamId);
  }

  private removeStream(streamId: StreamId): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.streams.delete(streamId);
    for (const event of stream.events) this.eventToStream.delete(event.id);
    this.totalEvents -= stream.events.length;
    this.totalBytes -= stream.bytes;
  }

  private scheduleCleanup(): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    if (this.closed || this.streams.size === 0) return;

    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const stream of this.streams.values()) {
      nextExpiry = Math.min(nextExpiry, stream.expiresAt);
    }
    const delay = Math.max(1, nextExpiry - this.now());
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      this.pruneExpired(this.now());
      this.scheduleCleanup();
    }, delay);
    this.cleanupTimer.unref();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("MCP event store is closed.");
  }
}

function estimateEventBytes(streamId: StreamId, message: JSONRPCMessage): number {
  return Buffer.byteLength(streamId, "utf8")
    + Buffer.byteLength(JSON.stringify(message), "utf8")
    + 128;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return resolved;
}
