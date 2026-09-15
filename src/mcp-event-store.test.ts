import assert from "node:assert/strict";
import test from "node:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { BoundedMcpEventStore } from "./mcp-event-store.js";

function message(id: number, value: string): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: { value },
  };
}

test("bounded MCP event store replays only later events from the same stream", async (t) => {
  const store = new BoundedMcpEventStore();
  t.after(() => store.close());

  const first = await store.storeEvent("stream-a", message(1, "first"));
  await store.storeEvent("stream-b", message(2, "other"));
  const second = await store.storeEvent("stream-a", message(3, "second"));
  const third = await store.storeEvent("stream-a", message(4, "third"));
  const replayed: Array<{ id: string; value: string }> = [];

  const streamId = await store.replayEventsAfter(first, {
    send: async (id, event) => {
      replayed.push({
        id,
        value: String((event as { result?: { value?: unknown } }).result?.value),
      });
    },
  });

  assert.equal(streamId, "stream-a");
  assert.deepEqual(replayed, [
    { id: second, value: "second" },
    { id: third, value: "third" },
  ]);
});

test("bounded MCP event store includes events appended while replay is in progress", async (t) => {
  const store = new BoundedMcpEventStore();
  t.after(() => store.close());

  const first = await store.storeEvent("stream-a", message(1, "first"));
  await store.storeEvent("stream-a", message(2, "second"));
  const replayed: string[] = [];

  await store.replayEventsAfter(first, {
    send: async (_id, event) => {
      const value = String((event as { result?: { value?: unknown } }).result?.value);
      replayed.push(value);
      if (value === "second") {
        await store.storeEvent("stream-a", message(3, "terminal"));
      }
    },
  });

  assert.deepEqual(replayed, ["second", "terminal"]);
});

test("bounded MCP event store looks up underscored stream ids directly", async (t) => {
  const store = new BoundedMcpEventStore();
  t.after(() => store.close());

  const eventId = await store.storeEvent("_GET_stream", message(1, "notification"));
  assert.equal(await store.getStreamIdForEventId(eventId), "_GET_stream");
});

test("bounded MCP event store expires idle streams after the retention window", async (t) => {
  let now = 1_000;
  const store = new BoundedMcpEventStore({
    ttlMs: 100,
    now: () => now,
  });
  t.after(() => store.close());

  const eventId = await store.storeEvent("stream-a", message(1, "value"));
  assert.equal(await store.getStreamIdForEventId(eventId), "stream-a");

  now += 101;
  assert.equal(await store.getStreamIdForEventId(eventId), undefined);
  await assert.rejects(
    store.replayEventsAfter(eventId, { send: async () => undefined }),
    /Unknown or expired MCP event ID/,
  );
});

test("bounded MCP event store refreshes a stream TTL when it is resumed", async (t) => {
  let now = 1_000;
  const store = new BoundedMcpEventStore({
    ttlMs: 100,
    now: () => now,
  });
  t.after(() => store.close());

  const first = await store.storeEvent("stream-a", message(1, "first"));
  await store.storeEvent("stream-a", message(2, "second"));
  now += 90;
  await store.replayEventsAfter(first, { send: async () => undefined });

  now += 90;
  assert.equal(await store.getStreamIdForEventId(first), "stream-a");
  now += 11;
  assert.equal(await store.getStreamIdForEventId(first), undefined);
});

test("bounded MCP event store evicts old streams before the active stream", async (t) => {
  const evictions: Array<{ streams: number; events: number; bytes: number }> = [];
  const store = new BoundedMcpEventStore({
    maxStreams: 2,
    maxEvents: 10,
    maxBytes: 1_000_000,
    onCapacityEviction: (details) => evictions.push(details),
  });
  t.after(() => store.close());

  const oldest = await store.storeEvent("stream-old", message(1, "old"));
  const middle = await store.storeEvent("stream-middle", message(2, "middle"));
  const newest = await store.storeEvent("stream-new", message(3, "new"));

  assert.equal(await store.getStreamIdForEventId(oldest), undefined);
  assert.equal(await store.getStreamIdForEventId(middle), "stream-middle");
  assert.equal(await store.getStreamIdForEventId(newest), "stream-new");
  assert.ok(evictions.some((entry) => entry.streams >= 1 && entry.events >= 1));
});

test("bounded MCP event store enforces the event cap without throwing", async (t) => {
  const store = new BoundedMcpEventStore({
    maxStreams: 10,
    maxEvents: 2,
    maxBytes: 1_000_000,
  });
  t.after(() => store.close());

  const first = await store.storeEvent("stream-a", message(1, "a".repeat(120)));
  const second = await store.storeEvent("stream-b", message(2, "b".repeat(120)));
  const third = await store.storeEvent("stream-c", message(3, "c".repeat(120)));

  assert.equal(await store.getStreamIdForEventId(first), undefined);
  assert.equal(await store.getStreamIdForEventId(second), "stream-b");
  assert.equal(await store.getStreamIdForEventId(third), "stream-c");
});

test("bounded MCP event store enforces the byte cap without throwing", async (t) => {
  const store = new BoundedMcpEventStore({
    maxStreams: 10,
    maxEvents: 10,
    maxBytes: 500,
  });
  t.after(() => store.close());

  const first = await store.storeEvent("stream-a", message(1, "a".repeat(120)));
  const second = await store.storeEvent("stream-b", message(2, "b".repeat(120)));

  assert.equal(await store.getStreamIdForEventId(first), undefined);
  assert.equal(await store.getStreamIdForEventId(second), "stream-b");
});

test("an oversized event degrades replay without failing the live tool response", async (t) => {
  const store = new BoundedMcpEventStore({
    maxStreams: 2,
    maxEvents: 2,
    maxBytes: 256,
  });
  t.after(() => store.close());

  const eventId = await store.storeEvent("stream-a", message(1, "x".repeat(1_000)));
  assert.equal(await store.getStreamIdForEventId(eventId), undefined);
});

test("bounded MCP event store clears retained messages when the session closes", async () => {
  const store = new BoundedMcpEventStore();
  const eventId = await store.storeEvent("stream-a", message(1, "value"));
  store.close();

  assert.equal(await store.getStreamIdForEventId(eventId), undefined);
  await assert.rejects(
    store.storeEvent("stream-b", message(2, "value")),
    /MCP event store is closed/,
  );
});
