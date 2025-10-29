import type { AgentDefinition, AgentType, WingmanConfig } from "../config";
import { getAuthenticatedNpub } from "../auth/request-context";

const MAX_LOG_LINES = 500;

export type SessionStatus = "starting" | "running" | "stopped" | "error";

export interface SessionSnapshot {
  id: string;
  agent: AgentType;
  port: number;
  name: string;
  status: SessionStatus;
  startedAt: string;
  npub?: string;
  pid?: number;
  command: string[];
  workingDirectory: string;
  tmuxSession?: string;
  tmuxWindow?: string;
  exitCode?: number;
  logs: string[];
}

type SessionEvent =
  | { type: "session-started"; session: SessionSnapshot }
  | { type: "session-updated"; session: SessionSnapshot }
  | { type: "session-stopped"; session: SessionSnapshot };

export interface RehydrateSessionInput {
  id: string;
  agent: AgentType;
  port: number;
  name: string;
  startedAt: string;
  workingDirectory: string;
  command?: string[];
  tmuxSession?: string;
  tmuxWindow?: string;
  pid?: number;
  logs?: string[];
  npub?: string;
}

interface AgentSession {
  id: string;
  agent: AgentType;
  port: number;
  name: string;
  status: SessionStatus;
  startedAt: Date;
  process: Bun.Subprocess | null;
  definition: AgentDefinition;
  workingDirectory: string;
  command: string[];
  logs: string[];
  exitCode?: number;
  tmuxSession?: string;
  tmuxWindow?: string;
  detachedPid?: number;
  npub?: string;
}

export class ProcessManager {
  private readonly config: WingmanConfig;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly allocatedPorts = new Set<number>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();

  constructor(config: WingmanConfig) {
    this.config = config;
  }

  on(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listSessions(): SessionSnapshot[] {
    return Array.from(this.sessions.values()).map((session) => this.toSnapshot(session));
  }

  getSession(id: string): SessionSnapshot | undefined {
    const session = this.sessions.get(id);
    return session ? this.toSnapshot(session) : undefined;
  }

  getLogs(id: string): string[] | undefined {
    return this.sessions.get(id)?.logs.slice();
  }

  async createSession(agent: AgentType, workingDirectory?: string, name?: string): Promise<SessionSnapshot> {
    const definition = this.config.agents[agent];
    if (!definition) {
      throw new Error(`Unknown agent: ${agent}`);
    }

    const port = this.allocatePort();
    const id = crypto.randomUUID();
    const sessionName = this.normaliseSessionName(name, agent, port);
    const command = definition.command({ port, agent, config: this.config });
    const sessionWorkingDirectory =
      typeof workingDirectory === "string" && workingDirectory.length > 0
        ? workingDirectory
        : this.config.defaultWorkingDirectory;
    const tmuxSession = this.config.tmuxBase?.trim().length ? this.config.tmuxBase : undefined;
    const tmuxWindow = this.deriveTmuxWindowName(agent, id);

    console.log(`[manager] launching ${definition.label} with command: ${command.join(" ")}`);
    const session: AgentSession = {
      id,
      agent,
      port,
      name: sessionName,
      status: "starting",
      startedAt: new Date(),
      process: null,
      definition,
      workingDirectory: sessionWorkingDirectory,
      command,
      logs: [],
      tmuxSession,
      tmuxWindow,
      detachedPid: undefined,
      npub: getAuthenticatedNpub() ?? undefined,
    };

    this.sessions.set(id, session);
    this.emit({ type: "session-started", session: this.toSnapshot(session) });

    try {
      session.process = this.spawnAgentProcess(session);
      await this.monitorSession(session);
      session.status = "running";
      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
    } catch (error) {
      session.status = "error";
      this.appendLog(session, `[manager] failed to launch session: ${(error as Error).message}`);
      this.releasePort(session.port);
      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
      throw error;
    }

    return this.toSnapshot(session);
  }

  rehydrateSession(input: RehydrateSessionInput): SessionSnapshot | null {
    const definition = this.config.agents[input.agent];
    if (!definition) {
      return null;
    }

    if (this.sessions.has(input.id)) {
      return this.toSnapshot(this.sessions.get(input.id)!);
    }

    if (this.allocatedPorts.has(input.port)) {
      return null;
    }

    const command =
      Array.isArray(input.command) && input.command.length > 0
        ? input.command
        : definition.command({ port: input.port, agent: input.agent, config: this.config });

    const session: AgentSession = {
      id: input.id,
      agent: input.agent,
      port: input.port,
      name: input.name,
      status: "running",
      startedAt: new Date(input.startedAt),
      process: null,
      definition,
      workingDirectory: input.workingDirectory,
      command,
      logs: input.logs ?? [],
      tmuxSession: input.tmuxSession,
      tmuxWindow: input.tmuxWindow,
      detachedPid: typeof input.pid === "number" ? input.pid : undefined,
      npub: input.npub ?? undefined,
    };

    this.sessions.set(session.id, session);
    this.allocatedPorts.add(session.port);
    return this.toSnapshot(session);
  }

  async stopSession(id: string): Promise<SessionSnapshot | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    if (session.process) {
      session.process.kill("SIGTERM");
      await session.process.exited;
      session.process = null;
    } else if (typeof session.detachedPid === "number" && session.detachedPid > 0) {
      try {
        process.kill(session.detachedPid, "SIGTERM");
      } catch {
        // ignore failures when the process already exited or cannot be signalled
      }
      session.detachedPid = undefined;
    }

    session.status = "stopped";
    this.releasePort(session.port);
    this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
    return this.toSnapshot(session);
  }

  deleteSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    if (session.status === "starting" || session.status === "running") {
      throw new Error("Cannot delete a running session");
    }

    if (session.process) {
      try {
        session.process.kill("SIGTERM");
      } catch {
        // best effort; process should already be exited
      }
      session.process = null;
    }

    this.releasePort(session.port);
    this.sessions.delete(id);
    return true;
  }

  private spawnAgentProcess(session: AgentSession): Bun.Subprocess {
    const env = {
      ...Bun.env,
      SESSION_ID: session.id,
      SESSION_AGENT: session.agent,
      SESSION_PORT: session.port.toString(),
      SESSION_DIRECTORY: session.workingDirectory,
      SESSION_NAME: session.name,
      TMUX_BASE: this.config.tmuxBase,
      ...(session.definition.env ?? {}),
    };

    const process = Bun.spawn(session.command, {
      cwd: session.workingDirectory,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof process.pid === "number" && process.pid > 0) {
      session.detachedPid = process.pid;
    }

    if (process.stdout) {
      this.captureStream(process.stdout, session, "stdout");
    }

    if (process.stderr) {
      this.captureStream(process.stderr, session, "stderr");
    }

    process.exited.then((code) => {
      session.exitCode = code ?? undefined;
      session.detachedPid = undefined;
      if (session.status === "running") {
        session.status = code === 0 ? "stopped" : "error";
        this.releasePort(session.port);
        this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
      }
    }).catch((error) => {
      session.exitCode = undefined;
      session.status = "error";
      this.appendLog(session, `[manager] spawn monitoring failed: ${(error as Error).message}`);
      this.releasePort(session.port);
      this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
    });

    return process;
  }

  private async monitorSession(session: AgentSession): Promise<void> {
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!session.process) return;
        // Consider the process "running" as soon as we can observe a PID.
        if (typeof session.process.pid === "number" && session.process.pid > 0) {
          session.detachedPid = session.process.pid;
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
    });
  }

  private captureStream(stream: ReadableStream<any>, session: AgentSession, label: "stdout" | "stderr") {
    const decoder = new TextDecoder();
    (async () => {
      const reader = stream.getReader();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = this.flushBuffer(buffer, session, label);
      }
      if (buffer.length > 0) {
        this.appendLog(session, `[${label}] ${buffer.trimEnd()}`);
      }
    })().catch((error) => {
      this.appendLog(session, `[manager] failed to read ${label}: ${(error as Error).message}`);
    });
  }

  private flushBuffer(buffer: string, session: AgentSession, label: string): string {
    const lines = buffer.split(/\r?\n/);
    if (lines.length === 1) {
      return buffer;
    }

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]?.trimEnd();
      if (line) {
        this.appendLog(session, `[${label}] ${line}`);
      }
    }

    return lines[lines.length - 1] ?? "";
  }

  private appendLog(session: AgentSession, entry: string) {
    session.logs.push(entry);
    if (session.logs.length > MAX_LOG_LINES) {
      session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
    }
    this.emit({ type: "session-updated", session: this.toSnapshot(session) });
  }

  private allocatePort(): number {
    const { agentPortStart, agentPortMax } = this.config;
    for (let offset = 0; offset < agentPortMax; offset += 1) {
      const candidate = agentPortStart + offset;
      if (!this.allocatedPorts.has(candidate)) {
        this.allocatedPorts.add(candidate);
        return candidate;
      }
    }
    throw new Error("No available agent ports. Increase AGENT_MAX or free sessions.");
  }

  private releasePort(port: number) {
    this.allocatedPorts.delete(port);
  }

  private toSnapshot(session: AgentSession): SessionSnapshot {
    return {
      id: session.id,
      agent: session.agent,
      port: session.port,
      name: session.name,
      status: session.status,
      startedAt: session.startedAt.toISOString(),
      npub: session.npub,
      pid: session.process?.pid ?? session.detachedPid,
      command: session.command,
      workingDirectory: session.workingDirectory,
      tmuxSession: session.tmuxSession,
      tmuxWindow: session.tmuxWindow,
      exitCode: session.exitCode,
      logs: session.logs.slice(-50),
    };
  }

  private normaliseSessionName(name: string | undefined, agent: AgentType, port: number): string {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed.length > 0) {
      return trimmed;
    }
    return `${agent} :${port}`;
  }

  private emit(event: SessionEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private deriveTmuxWindowName(agent: AgentType, sessionId: string): string | undefined {
    if (!this.config.tmuxBase || this.config.tmuxBase.trim().length === 0) {
      return undefined;
    }
    const sanitizedId = sessionId.replace(/[^a-z0-9]/gi, "").slice(0, 8);
    const suffix = sanitizedId.length > 0 ? sanitizedId : sessionId.slice(0, 8);
    return `${agent}:${suffix}`;
  }
}
