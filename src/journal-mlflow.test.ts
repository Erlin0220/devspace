import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MlflowJournalRunner } from "./journal-mlflow.js";

test("MLflow journal persists a main round and supervisor review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-mlflow-journal-"));
  const previousDb = process.env.DEVSPACE_MLFLOW_JOURNAL_DB;
  process.env.DEVSPACE_MLFLOW_JOURNAL_DB = join(root, "mlflow.db");
  t.after(async () => {
    if (previousDb === undefined) delete process.env.DEVSPACE_MLFLOW_JOURNAL_DB;
    else process.env.DEVSPACE_MLFLOW_JOURNAL_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  });

  const runner = new MlflowJournalRunner();
  const started = await runner.run("start_round", {
    project: "saas-agent-poc-test",
    direction: "verify journal round persistence",
    baseHead: "abc123",
    workspaceRoot: root,
  });
  const traceId = started.traceId;
  assert.equal(typeof traceId, "string");
  assert.equal(typeof started.roundId, "string");

  const event = await runner.run("record_event", {
    traceId,
    eventType: "test",
    summary: "journal smoke test passed",
    details: { suite: "journal-mlflow" },
    workspaceRoot: root,
  });
  assert.equal(event.traceId, traceId);
  assert.equal(typeof event.eventSpanId, "string");

  const completed = await runner.run("complete_round", {
    traceId,
    summary: "POC main round complete",
    result: "completed",
    nextCandidates: ["wire supervisor"],
    workspaceRoot: root,
  });
  assert.equal(completed.traceId, traceId);
  assert.equal(completed.role, "main");
  assert.equal(completed.status, "completed");
  assert.equal((completed.events as unknown[]).length, 1);

  const latestMain = await runner.run("get_latest_round", {
    project: "saas-agent-poc-test",
    role: "main",
    workspaceRoot: root,
  });
  assert.equal((latestMain.round as Record<string, unknown>).traceId, traceId);

  const reviewed = await runner.run("record_review", {
    project: "saas-agent-poc-test",
    reviewedTraceId: traceId,
    decision: "CONTINUE",
    summary: "Continue with the next verified candidate",
    top3: ["wire supervisor"],
    avoid: [],
    unknowns: [],
    workspaceRoot: root,
  });
  assert.equal(reviewed.role, "supervisor");
  assert.equal(reviewed.reviewedTraceId, traceId);
  assert.equal(reviewed.decision, "CONTINUE");

  const latestReview = await runner.run("get_latest_round", {
    project: "saas-agent-poc-test",
    role: "supervisor",
    workspaceRoot: root,
  });
  assert.equal(
    (latestReview.round as Record<string, unknown>).reviewedTraceId,
    traceId,
  );
});
