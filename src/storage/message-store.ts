import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface ReplaceMessageInput {
  role: string;
  content: string;
  createdAt: string;
}

export interface SessionRecordInput {
  id: string;
  agent: string;
  startedAt: string;
  name?: string;
  npub?: string;
  port?: number;
  pid?: number;
  tmuxSession?: string;
  tmuxWindow?: string;
  workingDirectory?: string;
  command?: string[];
}

export interface StoredSessionRecord {
  id: string;
  agent: string;
  startedAt: string;
  name: string | null;
  npub: string | null;
  port: number | null;
  pid: number | null;
  tmuxSession: string | null;
  tmuxWindow: string | null;
  workingDirectory: string | null;
  command: string | null;
}

export const databaseFile = new URL("../../data/wingman.db", import.meta.url).pathname;

export class MessageStore {
  private readonly db: Database;

  private readonly insertSession: ReturnType<MessageStore["prepareInsertSession"]>;
  private readonly deleteSession: ReturnType<MessageStore["prepareDeleteSession"]>;
  private readonly listSessionsStmt: ReturnType<MessageStore["prepareListSessions"]>;
  private readonly clearMessages: ReturnType<MessageStore["prepareClearMessages"]>;
  private readonly insertMessage: ReturnType<MessageStore["prepareInsertMessage"]>;
  private readonly listMessages: ReturnType<MessageStore["prepareListMessages"]>;
  private readonly countMessages: ReturnType<MessageStore["prepareCountMessages"]>;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.initialise();
    this.insertSession = this.prepareInsertSession();
    this.deleteSession = this.prepareDeleteSession();
    this.listSessionsStmt = this.prepareListSessions();
    this.clearMessages = this.prepareClearMessages();
    this.insertMessage = this.prepareInsertMessage();
    this.listMessages = this.prepareListMessages();
    this.countMessages = this.prepareCountMessages();
  }

  recordSession(session: SessionRecordInput) {
    this.insertSession.run(
      session.id,
      session.agent,
      session.startedAt,
      session.name ?? null,
      session.npub ?? null,
      typeof session.port === "number" ? session.port : null,
      typeof session.pid === "number" ? session.pid : null,
      session.tmuxSession ?? null,
      session.tmuxWindow ?? null,
      session.workingDirectory ?? null,
      Array.isArray(session.command) ? JSON.stringify(session.command) : null,
    );
  }

  removeSession(sessionId: string) {
    this.deleteSession.run(sessionId);
  }

  replaceMessages(sessionId: string, messages: ReplaceMessageInput[]) {
    const tx = this.db.transaction(() => {
      this.clearMessages.run(sessionId);
      for (const message of messages) {
        const role = message.role?.trim() ?? "";
        const content = message.content?.trim() ?? "";
        if (!content) {
          // Skip blank payloads.
          continue;
        }
        const createdAt = message.createdAt ?? new Date().toISOString();
        this.insertMessage.run(randomUUID(), sessionId, role || "assistant", content, createdAt);
      }
    });
    tx();
  }

  listSessionMessages(sessionId: string): StoredMessage[] {
    return this.listMessages.all(sessionId) as StoredMessage[];
  }

  hasMessages(sessionId: string): boolean {
    const row = this.countMessages.get(sessionId) as { count: number } | undefined;
    return Boolean(row?.count && row.count > 0);
  }

  listSessions(): StoredSessionRecord[] {
    return this.listSessionsStmt.all() as StoredSessionRecord[];
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        started_at TEXT NOT NULL,
        name TEXT,
        port INTEGER,
        pid INTEGER,
        tmux_session TEXT,
        tmux_window TEXT,
        working_directory TEXT,
        command TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    `);

    const sessionColumns = this.db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
    const ensureColumn = (name: string, definition: string) => {
      const exists = sessionColumns.some((column) => column.name === name);
      if (!exists) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
      }
    };

    ensureColumn("name", "TEXT");
    ensureColumn("port", "INTEGER");
    ensureColumn("pid", "INTEGER");
    ensureColumn("tmux_session", "TEXT");
    ensureColumn("tmux_window", "TEXT");
    ensureColumn("working_directory", "TEXT");
    ensureColumn("command", "TEXT");
    ensureColumn("npub", "TEXT");
  }

  private prepareInsertSession() {
    return this.db.prepare(
      `INSERT INTO sessions (id, agent, started_at, name, npub, port, pid, tmux_session, tmux_window, working_directory, command)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(id) DO UPDATE SET
         agent = excluded.agent,
         started_at = excluded.started_at,
         name = excluded.name,
         npub = excluded.npub,
         port = excluded.port,
         pid = excluded.pid,
         tmux_session = excluded.tmux_session,
         tmux_window = excluded.tmux_window,
         working_directory = excluded.working_directory,
         command = excluded.command`,
    );
  }

  private prepareDeleteSession() {
    return this.db.prepare(`DELETE FROM sessions WHERE id = ?1`);
  }

  private prepareListSessions() {
    return this.db.prepare(
      `SELECT
         id,
         agent,
         started_at as startedAt,
         name,
         npub,
         port,
         pid,
         tmux_session as tmuxSession,
         tmux_window as tmuxWindow,
         working_directory as workingDirectory,
         command
       FROM sessions`,
    );
  }

  private prepareClearMessages() {
    return this.db.prepare(`DELETE FROM messages WHERE session_id = ?1`);
  }

  private prepareInsertMessage() {
    return this.db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    );
  }

  private prepareListMessages() {
    return this.db.prepare(
      `SELECT id, session_id as sessionId, role, content, created_at as createdAt
       FROM messages
       WHERE session_id = ?1
       ORDER BY datetime(created_at), rowid`,
    );
  }

  private prepareCountMessages() {
    return this.db.prepare(
      `SELECT COUNT(1) as count
       FROM messages
       WHERE session_id = ?1`,
    );
  }
}

export const messageStore = new MessageStore(databaseFile);
