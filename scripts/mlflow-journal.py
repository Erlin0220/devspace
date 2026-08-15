from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import mlflow
from mlflow import MlflowClient


def _tracking_uri() -> str:
    explicit = os.environ.get("DEVSPACE_MLFLOW_TRACKING_URI")
    if explicit:
        return explicit

    raw_db = os.environ.get("DEVSPACE_MLFLOW_JOURNAL_DB")
    db_path = Path(raw_db).expanduser() if raw_db else Path.home() / ".mlflow" / "saas-agent" / "mlflow.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{db_path.resolve().as_posix()}"


def _client() -> MlflowClient:
    tracking_uri = _tracking_uri()
    mlflow.set_tracking_uri(tracking_uri)
    return MlflowClient(tracking_uri=tracking_uri)


def _experiment_id(client: MlflowClient, project: str) -> str:
    experiment = client.get_experiment_by_name(project)
    if experiment is not None:
        return experiment.experiment_id
    try:
        return client.create_experiment(project)
    except Exception:
        experiment = client.get_experiment_by_name(project)
        if experiment is None:
            raise
        return experiment.experiment_id


def _root_span(trace: Any) -> Any:
    for span in trace.data.spans:
        if span.parent_id is None:
            return span
    raise RuntimeError(f"Trace {trace.info.trace_id} has no root span")


def _json_value(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        return json.loads(json.dumps(value, default=str))


def _request_time_ms(trace: Any) -> int | None:
    value = trace.info.request_time
    if isinstance(value, datetime):
        return int(value.timestamp() * 1000)
    if isinstance(value, (int, float)):
        return int(value)
    return None


def _request_time_value(trace: Any) -> Any:
    value = trace.info.request_time
    return value.isoformat() if isinstance(value, datetime) else value


def _trace_summary(trace: Any) -> dict[str, Any]:
    root = _root_span(trace)
    tags = dict(trace.info.tags or {})
    return {
        "traceId": trace.info.trace_id,
        "experimentId": trace.info.experiment_id,
        "requestTime": _request_time_value(trace),
        "executionDurationMs": trace.info.execution_duration,
        "state": str(trace.info.state),
        "project": tags.get("journal_project"),
        "role": tags.get("journal_role"),
        "event": tags.get("journal_event"),
        "roundId": tags.get("journal_round_id"),
        "direction": tags.get("journal_direction"),
        "baseHead": tags.get("journal_base_head"),
        "decision": tags.get("journal_decision"),
        "reviewedRoundId": tags.get("journal_reviewed_round_id"),
        "reviewedTraceId": tags.get("journal_reviewed_trace_id"),
        "workspaceRoot": tags.get("devspace_workspace_root"),
        "inputs": _json_value(root.inputs),
        "outputs": _json_value(root.outputs),
    }


def _search(
    client: MlflowClient,
    project: str,
    filter_string: str,
    *,
    max_results: int = 100,
) -> list[Any]:
    experiment = client.get_experiment_by_name(project)
    if experiment is None:
        return []
    return list(
        client.search_traces(
            experiment_ids=[experiment.experiment_id],
            filter_string=filter_string,
            max_results=max_results,
            order_by=["timestamp_ms DESC"],
            include_spans=True,
        )
    )


def _write_trace(
    client: MlflowClient,
    *,
    project: str,
    role: str,
    event: str,
    round_id: str,
    workspace_root: str,
    inputs: dict[str, Any],
    outputs: dict[str, Any],
    extra_tags: dict[str, str] | None = None,
) -> Any:
    tags = {
        "journal_project": project,
        "journal_role": role,
        "journal_event": event,
        "journal_round_id": round_id,
        "devspace_workspace_root": workspace_root,
        **(extra_tags or {}),
    }
    span = client.start_trace(
        name=f"{project} {role} {event}",
        span_type="AGENT" if role == "supervisor" else "TOOL",
        experiment_id=_experiment_id(client, project),
        inputs=inputs,
        tags=tags,
    )
    client.end_trace(span.trace_id, outputs=outputs)
    mlflow.flush_trace_async_logging()
    return client.get_trace(span.trace_id, display=False)


def _round_filter(round_id: str, event: str | None = None, role: str = "main") -> str:
    clauses = [f"tags.journal_role = '{role}'", f"tags.journal_round_id = '{round_id}'"]
    if event:
        clauses.append(f"tags.journal_event = '{event}'")
    return " AND ".join(clauses)


def _aggregate_main_round(client: MlflowClient, project: str, round_id: str) -> dict[str, Any]:
    traces = _search(client, project, _round_filter(round_id), max_results=100)
    if not traces:
        raise RuntimeError(f"Journal round not found: {round_id}")

    ordered = sorted(traces, key=lambda trace: _request_time_ms(trace) or 0)
    start = next((trace for trace in ordered if (trace.info.tags or {}).get("journal_event") == "round_start"), None)
    complete = next((trace for trace in reversed(ordered) if (trace.info.tags or {}).get("journal_event") == "round_complete"), None)
    if start is None:
        raise RuntimeError(f"Journal round {round_id} is missing round_start")

    start_tags = dict(start.info.tags or {})
    start_ms = _request_time_ms(start)
    end_ms = _request_time_ms(complete) if complete is not None else None
    complete_outputs = _json_value(_root_span(complete).outputs) if complete is not None else None
    events = []
    for trace in ordered:
        event = (trace.info.tags or {}).get("journal_event")
        if event in {"round_start", "round_complete"}:
            continue
        root = _root_span(trace)
        outputs = _json_value(root.outputs) or {}
        events.append(
            {
                "traceId": trace.info.trace_id,
                "eventType": event,
                "requestTime": _request_time_value(trace),
                "summary": outputs.get("summary") if isinstance(outputs, dict) else None,
                "details": outputs.get("details") if isinstance(outputs, dict) else None,
            }
        )

    return {
        "traceId": start.info.trace_id,
        "roundId": round_id,
        "role": "main",
        "status": "completed" if complete is not None else "running",
        "direction": start_tags.get("journal_direction"),
        "baseHead": start_tags.get("journal_base_head"),
        "workspaceRoot": start_tags.get("devspace_workspace_root"),
        "startedAt": _request_time_value(start),
        "endedAt": _request_time_value(complete) if complete is not None else None,
        "durationMinutes": round((end_ms - start_ms) / 60000, 2) if start_ms is not None and end_ms is not None else None,
        "startTraceId": start.info.trace_id,
        "completeTraceId": complete.info.trace_id if complete is not None else None,
        "summary": complete_outputs.get("summary") if isinstance(complete_outputs, dict) else None,
        "result": complete_outputs.get("result") if isinstance(complete_outputs, dict) else None,
        "nextCandidates": complete_outputs.get("nextCandidates", []) if isinstance(complete_outputs, dict) else [],
        "events": events,
    }


def _start_round(client: MlflowClient, payload: dict[str, Any]) -> dict[str, Any]:
    project = payload["project"]
    direction = payload["direction"]
    round_id = payload.get("roundId") or f"round-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:6]}"
    if _search(client, project, _round_filter(round_id, "round_start"), max_results=1):
        raise RuntimeError(f"Journal round already exists: {round_id}")

    extra_tags = {"journal_direction": direction}
    if payload.get("baseHead"):
        extra_tags["journal_base_head"] = payload["baseHead"]
    trace = _write_trace(
        client,
        project=project,
        role="main",
        event="round_start",
        round_id=round_id,
        workspace_root=payload["workspaceRoot"],
        inputs={"direction": direction, "baseHead": payload.get("baseHead")},
        outputs={"status": "running"},
        extra_tags=extra_tags,
    )
    return {"traceId": trace.info.trace_id, "roundId": round_id}


def _main_round_context(client: MlflowClient, payload: dict[str, Any]) -> tuple[str, str, str]:
    trace_id = payload.get("traceId")
    if trace_id:
        trace = client.get_trace(trace_id, display=False)
        tags = dict(trace.info.tags or {})
        if tags.get("journal_role") != "main" or tags.get("journal_event") != "round_start":
            raise RuntimeError(f"Trace is not a journal round start: {trace_id}")
        project = tags.get("journal_project")
        round_id = tags.get("journal_round_id")
        if not project or not round_id:
            raise RuntimeError(f"Trace is missing journal round metadata: {trace_id}")
        if payload.get("project") and payload["project"] != project:
            raise RuntimeError(f"Trace project mismatch: {payload['project']} != {project}")
        return project, round_id, trace_id

    project = payload["project"]
    round_id = payload["roundId"]
    starts = _search(client, project, _round_filter(round_id, "round_start"), max_results=1)
    if not starts:
        raise RuntimeError(f"Journal round not found: {round_id}")
    return project, round_id, starts[0].info.trace_id


def _record_event(client: MlflowClient, payload: dict[str, Any]) -> dict[str, Any]:
    project, round_id, root_trace_id = _main_round_context(client, payload)
    if _search(client, project, _round_filter(round_id, "round_complete"), max_results=1):
        raise RuntimeError(f"Journal round already completed: {round_id}")

    event_type = payload["eventType"]
    summary = payload["summary"]
    details = payload.get("details") or {}
    trace = _write_trace(
        client,
        project=project,
        role="main",
        event=event_type,
        round_id=round_id,
        workspace_root=payload["workspaceRoot"],
        inputs={"summary": summary},
        outputs={"summary": summary, "details": details},
    )
    return {
        "traceId": root_trace_id,
        "roundId": round_id,
        "eventSpanId": trace.info.trace_id,
        "eventType": event_type,
    }


def _complete_round(client: MlflowClient, payload: dict[str, Any]) -> dict[str, Any]:
    project, round_id, _root_trace_id = _main_round_context(client, payload)
    if _search(client, project, _round_filter(round_id, "round_complete"), max_results=1):
        raise RuntimeError(f"Journal round already completed: {round_id}")

    _write_trace(
        client,
        project=project,
        role="main",
        event="round_complete",
        round_id=round_id,
        workspace_root=payload["workspaceRoot"],
        inputs={"result": payload["result"]},
        outputs={
            "summary": payload["summary"],
            "result": payload["result"],
            "nextCandidates": payload.get("nextCandidates") or [],
        },
    )
    return _aggregate_main_round(client, project, round_id)


def _latest(client: MlflowClient, payload: dict[str, Any]) -> dict[str, Any]:
    project = payload["project"]
    role = payload.get("role") or "main"
    if role == "main":
        completed = _search(
            client,
            project,
            "tags.journal_role = 'main' AND tags.journal_event = 'round_complete'",
            max_results=1,
        )
        if not completed:
            return {"round": None}
        round_id = (completed[0].info.tags or {}).get("journal_round_id")
        return {"round": _aggregate_main_round(client, project, round_id)}

    reviews = _search(
        client,
        project,
        "tags.journal_role = 'supervisor' AND tags.journal_event = 'review'",
        max_results=1,
    )
    return {"round": _trace_summary(reviews[0]) if reviews else None}


def _record_review(client: MlflowClient, payload: dict[str, Any]) -> dict[str, Any]:
    project = payload["project"]
    reviewed_trace_id = payload.get("reviewedTraceId")
    if reviewed_trace_id:
        reviewed_project, reviewed_round_id, _ = _main_round_context(
            client,
            {"traceId": reviewed_trace_id, "project": project},
        )
        project = reviewed_project
    else:
        reviewed_round_id = payload["reviewedRoundId"]
        starts = _search(client, project, _round_filter(reviewed_round_id, "round_start"), max_results=1)
        if not starts:
            raise RuntimeError(f"Reviewed round not found: {reviewed_round_id}")
        reviewed_trace_id = starts[0].info.trace_id

    if not _search(client, project, _round_filter(reviewed_round_id, "round_complete"), max_results=1):
        raise RuntimeError(f"Reviewed round is not completed: {reviewed_round_id}")

    review_id = payload.get("reviewId") or f"review-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:6]}"
    decision = payload["decision"]
    trace = _write_trace(
        client,
        project=project,
        role="supervisor",
        event="review",
        round_id=review_id,
        workspace_root=payload["workspaceRoot"],
        inputs={"reviewedRoundId": reviewed_round_id, "reviewedTraceId": reviewed_trace_id},
        outputs={
            "decision": decision,
            "summary": payload["summary"],
            "top3": payload.get("top3") or [],
            "avoid": payload.get("avoid") or [],
            "unknowns": payload.get("unknowns") or [],
        },
        extra_tags={
            "journal_decision": decision,
            "journal_reviewed_round_id": reviewed_round_id,
            "journal_reviewed_trace_id": reviewed_trace_id,
        },
    )
    return _trace_summary(trace)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: mlflow-journal.py <action>")
    action = sys.argv[1]
    payload = json.load(sys.stdin)
    client = _client()
    handlers = {
        "start_round": _start_round,
        "record_event": _record_event,
        "complete_round": _complete_round,
        "get_latest_round": _latest,
        "record_review": _record_review,
    }
    handler = handlers.get(action)
    if handler is None:
        raise RuntimeError(f"Unknown journal action: {action}")
    json.dump(handler(client, payload), sys.stdout, ensure_ascii=False, default=str)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        json.dump({"error": str(error)}, sys.stderr, ensure_ascii=False)
        raise
