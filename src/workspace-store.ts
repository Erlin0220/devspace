import { openDatabase, type DatabaseHandle } from "./db/client.js";

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceConversationBinding {
  conversationScopeId: string;
  targetKey: string;
  workspaceSessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  touchSession(id: string): void;
  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined;
  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding;
  touchConversationBinding(conversationScopeId: string, targetKey: string): void;
  deleteConversationBinding(conversationScopeId: string, targetKey: string): void;
  close?(): void;
}

interface WorkspaceSessionRow {
  id: string;
  root: string;
  status: string;
  mode: string;
  source_root: string | null;
  base_ref: string | null;
  base_sha: string | null;
  managed: string;
  created_at: string;
  last_used_at: string;
}

interface WorkspaceConversationBindingRow {
  conversation_scope_id: string;
  target_key: string;
  workspace_session_id: string;
  created_at: string;
  last_used_at: string;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.sqlite.prepare(
      `insert into workspace_sessions (
        id, root, status, mode, source_root, base_ref, base_sha, managed, created_at, last_used_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      session.root,
      session.status,
      session.mode,
      session.sourceRoot ?? null,
      session.baseRef ?? null,
      session.baseSha ?? null,
      String(session.managed),
      session.createdAt,
      session.lastUsedAt,
    );

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.sqlite
      .prepare("select * from workspace_sessions where id = ? limit 1")
      .get(id) as WorkspaceSessionRow | undefined;

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  touchSession(id: string): void {
    this.database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(new Date().toISOString(), id);
  }

  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined {
    const row = this.database.sqlite.prepare(
      `select * from workspace_conversation_bindings
       where conversation_scope_id = ? and target_key = ?
       limit 1`,
    ).get(conversationScopeId, targetKey) as WorkspaceConversationBindingRow | undefined;

    return row ? rowToWorkspaceConversationBinding(row) : undefined;
  }

  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding {
    const now = new Date().toISOString();
    const row = this.database.sqlite.prepare(
      `insert into workspace_conversation_bindings (
        conversation_scope_id, target_key, workspace_session_id, created_at, last_used_at
      ) values (?, ?, ?, ?, ?)
      on conflict(conversation_scope_id, target_key) do update set
        workspace_session_id = excluded.workspace_session_id,
        last_used_at = excluded.last_used_at
      returning *`,
    ).get(
      input.conversationScopeId,
      input.targetKey,
      input.workspaceSessionId,
      now,
      now,
    ) as WorkspaceConversationBindingRow | undefined;

    if (!row) {
      throw new Error("Conversation workspace binding upsert returned no row.");
    }

    return rowToWorkspaceConversationBinding(row);
  }

  touchConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.sqlite.prepare(
      `update workspace_conversation_bindings
       set last_used_at = ?
       where conversation_scope_id = ? and target_key = ?`,
    ).run(new Date().toISOString(), conversationScopeId, targetKey);
  }

  deleteConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.sqlite.prepare(
      `delete from workspace_conversation_bindings
       where conversation_scope_id = ? and target_key = ?`,
    ).run(conversationScopeId, targetKey);
  }

  close(): void {
    this.database.close();
  }

}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.source_root ?? undefined,
    baseRef: row.base_ref ?? undefined,
    baseSha: row.base_sha ?? undefined,
    managed: row.managed === "true",
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function rowToWorkspaceConversationBinding(
  row: WorkspaceConversationBindingRow,
): WorkspaceConversationBinding {
  return {
    conversationScopeId: row.conversation_scope_id,
    targetKey: row.target_key,
    workspaceSessionId: row.workspace_session_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}
