import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AgentDefinition, AgentType, WingmanConfig } from "../config";

const MAX_LOG_LINES = 500;
const TMUX_SESSION_NAME = "wingman-agents";
const TMUX_CONTROLLER_WINDOW = "controller";
const TMUX_MIN_VERSION = [3, 2] as const;
const LOG_ROOT = new URL("../../tmp/tmux-logs", import.meta.url).pathname;
const TMUX_KEEPALIVE_SCRIPT = "while :; do sleep 3600; done";

const TMUX_EXIT_MARKER = "__WINGMAN_EXIT__=";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const needsQuoting = (value: string) => !/^[a-zA-Z0-9_@%+=:,./-]+$/.test(value);

const quoteForShell = (value: string) => {
  if (!needsQuoting(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

const shellescape = (argv: string[]) => argv.map((arg) => quoteForShell(arg)).join(" ");

export type SessionStatus = "starting" | "running" | "stopped" | "error";

export interface SessionSnapshot {
  id: string;
  agent: AgentType;
  port: number;
  status: SessionStatus;
  startedAt: string;
  pid?: number;
  command: string[];
  workingDirectory: string;
  exitCode?: number;
  logs: string[];
  tmuxPane?: string;
  tmuxWindow?: string;
}

type SessionEvent =
  | { type: "session-started"; session: SessionSnapshot }
  | { type: "session-updated"; session: SessionSnapshot }
  | { type: "session-stopped"; session: SessionSnapshot };

interface AgentSession {
  id: string;
  agent: AgentType;
  port: number;
  status: SessionStatus;
  startedAt: Date;
  definition: AgentDefinition;
  workingDirectory: string;
  command: string[];
  logs: string[];
  tmuxPane?: string;
  tmuxWindow?: string;
  logFile?: string;
  tailProcess?: Bun.Subprocess | null;
  pid?: number;
  cleanedUp?: boolean;
  exitCode?: number;
}

export class ProcessManager {
  private readonly config: WingmanConfig;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly allocatedPorts = new Set<number>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly ready: Promise<void>;
  private readonly logDirectory = LOG_ROOT;

  constructor(config: WingmanConfig) {
    this.config = config;
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    await mkdir(this.logDirectory, { recursive: true });
    this.ensureTmuxAvailable();
    const sessionState = this.ensureControllerSession();
    const message =
      sessionState === "created"
        ? `[tmux] created session "${TMUX_SESSION_NAME}" with controller window`
        : `[tmux] reused existing session "${TMUX_SESSION_NAME}"`;
    console.log(message);
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

  async createSession(agent: AgentType, workingDirectory?: string): Promise<SessionSnapshot> {
    await this.ready;

    const definition = this.config.agents[agent];
    if (!definition) {
      throw new Error(`Unknown agent: ${agent}`);
    }

    const port = this.allocatePort();
    const id = crypto.randomUUID();
    const command = definition.command({ port, agent, config: this.config });
    const sessionWorkingDirectory =
      typeof workingDirectory === "string" && workingDirectory.length > 0
        ? workingDirectory
        : this.config.defaultWorkingDirectory;

    const session: AgentSession = {
      id,
      agent,
      port,
      status: "starting",
      startedAt: new Date(),
      definition,
      workingDirectory: sessionWorkingDirectory,
      command,
      logs: [],
    };

    session.tmuxWindow = this.buildWindowName(session);
    session.logFile = join(this.logDirectory, `${session.id}.log`);

    this.sessions.set(id, session);
    this.emit({ type: "session-started", session: this.toSnapshot(session) });

    try {
      await writeFile(session.logFile, "", { flag: "w" });
      session.tmuxPane = this.createAgentWindow(session);
      this.startLogCapture(session);
      await this.monitorSession(session);
      session.status = "running";
      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
      void this.trackPane(session);
    } catch (error) {
      session.status = "error";
      this.appendLog(session, `failed to launch session: ${(error as Error).message}`, "manager");
      await this.cleanupSession(session);
      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
      throw error;
    }

    return this.toSnapshot(session);
  }

  async stopSession(id: string): Promise<SessionSnapshot | undefined> {
    await this.ready;

    const session = this.sessions.get(id);
    if (!session) return undefined;

    if (session.status === "stopped" || session.status === "error") {
      return this.toSnapshot(session);
    }

    const paneId = session.tmuxPane;
    const pid = session.pid ?? (paneId ? this.getPanePid(paneId) : undefined);
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process may have already exited.
      }
      await this.waitForProcessExit(pid, 5_000);
    }

    if (session.tmuxWindow) {
      this.runTmux(["kill-window", "-t", this.resolveWindowTarget(session.tmuxWindow)], { throwOnError: false });
    }

    session.status = "stopped";
    await this.cleanupSession(session);
    this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
    return this.toSnapshot(session);
  }

  async deleteSession(id: string): Promise<boolean> {
    await this.ready;

    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    if (session.status === "starting" || session.status === "running") {
      throw new Error("Cannot delete a running session");
    }

    await this.cleanupSession(session);
    this.sessions.delete(id);
    return true;
  }

  private buildWindowName(session: AgentSession): string {
    return `${session.agent}:${session.id.slice(0, 8)}`;
  }

  private buildEnvironment(session: AgentSession): Record<string, string> {
    return {
      SESSION_ID: session.id,
      SESSION_AGENT: session.agent,
      SESSION_PORT: session.port.toString(),
      SESSION_DIRECTORY: session.workingDirectory,
      ...(session.definition.env ?? {}),
    };
  }

  private createAgentWindow(session: AgentSession): string {
    const env = this.buildEnvironment(session);
    const envArgs: string[] = [];

    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") {
        envArgs.push("-e", `${key}=${value}`);
      }
    }

    const commandString = shellescape(session.command);
    const scriptParts = [
      "set -o pipefail",
      commandString,
      "exit_code=$?",
      `printf '${TMUX_EXIT_MARKER}%s\\n' \"$exit_code\"`,
      "exit \"$exit_code\"",
    ];
    const script = scriptParts.join("; ");

    const result = this.runTmux(
      [
        "new-window",
        "-P",
        "-F",
        "#{pane_id}",
        "-d",
        "-t",
        this.resolveSessionTarget(),
        "-n",
        session.tmuxWindow ?? this.buildWindowName(session),
        "-c",
        session.workingDirectory,
        ...envArgs,
        "--",
        "bash",
        "-lc",
        script,
      ],
      { throwOnError: false },
    );

    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || "tmux new-window failed";
      throw new Error(message);
    }

    const paneId = result.stdout.trim();
    if (!paneId) {
      throw new Error("Failed to resolve tmux pane id");
    }
    return paneId;
  }

  private startLogCapture(session: AgentSession) {
    if (!session.tmuxPane || !session.logFile) {
      return;
    }

    const quotedLogPath = quoteForShell(session.logFile);
    const pipe = this.runTmux(["pipe-pane", "-o", "-t", session.tmuxPane, `cat >> ${quotedLogPath}`], {
      throwOnError: false,
    });

    if (pipe.exitCode !== 0) {
      const message = pipe.stderr.trim() || pipe.stdout.trim() || "failed to attach tmux pipe-pane";
      throw new Error(message);
    }

    const tail = Bun.spawn(["tail", "-n", "+1", "-F", session.logFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    session.tailProcess = tail;

    if (tail.stdout) {
      this.captureTailStream(tail.stdout, session);
    }
    if (tail.stderr) {
      this.captureStream(tail.stderr, session, "tail-stderr");
    }

    tail.exited
      .then((code) => {
        if (!session.cleanedUp && (code ?? 0) !== 0) {
          this.appendLog(session, `log tail exited with code ${code}`, "manager");
        }
      })
      .catch((error) => {
        if (!session.cleanedUp) {
          this.appendLog(session, `log tail monitoring failed: ${(error as Error).message}`, "manager");
        }
      });
  }

  private async monitorSession(session: AgentSession): Promise<void> {
    if (!session.tmuxPane) {
      throw new Error("tmux pane is not set for session");
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const pid = this.getPanePid(session.tmuxPane);
      if (pid) {
        session.pid = pid;
        return;
      }
      await delay(50);
    }

    throw new Error("Timed out waiting for agent process to start");
  }

  private async trackPane(session: AgentSession): Promise<void> {
    const paneId = session.tmuxPane;
    if (!paneId) return;

    try {
      await this.waitForPaneExit(paneId, session);
      if (session.cleanedUp) {
        return;
      }

      session.status = session.exitCode && session.exitCode !== 0 ? "error" : "stopped";
      await this.cleanupSession(session);
      this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
    } catch (error) {
      if (!session.cleanedUp) {
        this.appendLog(session, `tmux monitoring failed: ${(error as Error).message}`, "manager");
      }
    }
  }

  private async waitForPaneExit(paneId: string, session: AgentSession, timeoutMs = 0): Promise<void> {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
    while (true) {
      if (session.cleanedUp) return;

      const state = this.getPaneState(paneId);
      if (state === "dead" || state === "missing") {
        return;
      }

      if (deadline && Date.now() > deadline) {
        throw new Error("Timed out waiting for tmux pane to exit");
      }

      await delay(100);
    }
  }

  private getPaneState(paneId: string): "alive" | "dead" | "missing" {
    const result = this.runTmux(["display-message", "-p", "-t", paneId, "#{pane_dead}"], { throwOnError: false });
    if (result.exitCode !== 0) {
      return "missing";
    }
    return result.stdout.trim() === "1" ? "dead" : "alive";
  }

  private getPanePid(paneId: string): number | undefined {
    const result = this.runTmux(["display-message", "-p", "-t", paneId, "#{pane_pid}"], { throwOnError: false });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const value = result.stdout.trim();
    const pid = Number.parseInt(value, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  }

  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isProcessAlive(pid)) {
        return;
      }
      await delay(100);
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async cleanupSession(session: AgentSession): Promise<void> {
    if (session.cleanedUp) {
      return;
    }

    session.cleanedUp = true;

    if (session.tailProcess) {
      try {
        session.tailProcess.kill("SIGTERM");
      } catch {
        // ignoring shutdown errors
      }
      await session.tailProcess.exited.catch(() => undefined);
      session.tailProcess = null;
    }

    if (session.tmuxWindow) {
      this.runTmux(["kill-window", "-t", this.resolveWindowTarget(session.tmuxWindow)], { throwOnError: false });
    }

    if (session.logFile) {
      await rm(session.logFile, { force: true });
      session.logFile = undefined;
    }

    session.tmuxPane = undefined;
    session.tmuxWindow = undefined;
    session.pid = undefined;
    this.releasePort(session.port);
  }

  private captureStream(stream: ReadableStream<any> | null, session: AgentSession, label: string) {
    if (!stream) return;
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
        this.appendLog(session, buffer.trimEnd(), label);
      }
    })().catch((error) => {
      this.appendLog(session, `failed to read ${label}: ${(error as Error).message}`, "manager");
    });
  }

  private captureTailStream(stream: ReadableStream<any>, session: AgentSession) {
    const decoder = new TextDecoder();
    (async () => {
      const reader = stream.getReader();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = this.flushTailBuffer(buffer, session);
      }
      if (buffer.length > 0) {
        this.handleTailLine(session, buffer.trimEnd());
      }
    })().catch((error) => {
      this.appendLog(session, `failed to read agent output: ${(error as Error).message}`, "manager");
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
        this.appendLog(session, line, label);
      }
    }

    return lines[lines.length - 1] ?? "";
  }

  private flushTailBuffer(buffer: string, session: AgentSession): string {
    const lines = buffer.split(/\r?\n/);
    if (lines.length === 1) {
      return buffer;
    }

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (line) {
        this.handleTailLine(session, line);
      }
    }

    return lines[lines.length - 1] ?? "";
  }

  private handleTailLine(session: AgentSession, rawLine: string) {
    const line = rawLine.trimEnd();
    if (!line) return;

    if (line.startsWith(TMUX_EXIT_MARKER)) {
      const value = line.slice(TMUX_EXIT_MARKER.length);
      const exitCode = Number.parseInt(value, 10);
      if (Number.isFinite(exitCode)) {
        session.exitCode = exitCode;
      }
      return;
    }

    this.appendLog(session, line, "agent");
  }

  private appendLog(session: AgentSession, entry: string, label?: string) {
    const message = label ? `[${label}] ${entry}` : entry;
    session.logs.push(message);
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

  private resolveSessionTarget(): string {
    return `${TMUX_SESSION_NAME}:`;
  }

  private resolveWindowTarget(windowName: string): string {
    return `${TMUX_SESSION_NAME}:${windowName}`;
  }

  private toSnapshot(session: AgentSession): SessionSnapshot {
    return {
      id: session.id,
      agent: session.agent,
      port: session.port,
      status: session.status,
      startedAt: session.startedAt.toISOString(),
      pid: session.pid,
      command: session.command,
      workingDirectory: session.workingDirectory,
      exitCode: session.exitCode,
      logs: session.logs.slice(-50),
      tmuxPane: session.tmuxPane,
      tmuxWindow: session.tmuxWindow,
    };
  }

  private emit(event: SessionEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private ensureTmuxAvailable() {
    const result = Bun.spawnSync(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr ?? new Uint8Array()).trim();
      throw new Error(
        stderr.length > 0
          ? `Wingman requires tmux >= ${TMUX_MIN_VERSION.join(".")}: ${stderr}`
          : `Wingman requires tmux >= ${TMUX_MIN_VERSION.join(".")}`,
      );
    }

    const stdout = new TextDecoder().decode(result.stdout ?? new Uint8Array()).trim();
    const match = stdout.match(/(\d+)\.(\d+)/);
    if (!match) {
      throw new Error(`Unable to parse tmux version from "${stdout}"`);
    }

    const major = Number.parseInt(match[1] ?? "0", 10);
    const minor = Number.parseInt(match[2] ?? "0", 10);
    const [requiredMajor, requiredMinor] = TMUX_MIN_VERSION;

    if (major < requiredMajor || (major === requiredMajor && minor < requiredMinor)) {
      throw new Error(`Wingman requires tmux >= ${TMUX_MIN_VERSION.join(".")}. Detected ${major}.${minor}.`);
    }
  }

  private ensureControllerSession(): "created" | "existing" {
    const hasSession = this.runTmux(["has-session", "-t", TMUX_SESSION_NAME], { throwOnError: false });
    let state: "created" | "existing";
    if (hasSession.exitCode !== 0) {
      const created = this.runTmux(
        [
          "new-session",
          "-Ad",
          "-s",
          TMUX_SESSION_NAME,
          "-n",
          TMUX_CONTROLLER_WINDOW,
          "--",
          "bash",
          "-lc",
          TMUX_KEEPALIVE_SCRIPT,
        ],
        { throwOnError: false },
      );
      if (created.exitCode !== 0) {
        const message = created.stderr.trim() || created.stdout.trim() || "failed to create tmux controller session";
        throw new Error(message);
      }
      state = "created";
    } else {
      state = "existing";
    }

    this.runTmux(["set-option", "-t", TMUX_SESSION_NAME, "destroy-unattached", "off"], { throwOnError: false });

    // Ensure the controller window exists so the session stays alive.
    this.runTmux(
      [
        "new-window",
        "-t",
        this.resolveSessionTarget(),
        "-n",
        TMUX_CONTROLLER_WINDOW,
        "-d",
        "--",
        "bash",
        "-lc",
        TMUX_KEEPALIVE_SCRIPT,
      ],
      { throwOnError: false },
    );

    this.verifyControllerSession();
    return state;
  }

  private verifyControllerSession() {
    const verify = this.runTmux(["has-session", "-t", TMUX_SESSION_NAME], { throwOnError: false });
    if (verify.exitCode === 0) {
      return;
    }

    const list = this.runTmux(["list-sessions", "-F", "#{session_name}"], { throwOnError: false });
    const message = list.stderr.trim() || list.stdout.trim() || "tmux did not report any sessions";
    throw new Error(
      `Wingman expected tmux session "${TMUX_SESSION_NAME}" to exist, but verification failed: ${message}`,
    );
  }

  private runTmux(
    args: string[],
    options: { throwOnError?: boolean } = {},
  ): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
    const stdout = new TextDecoder().decode(result.stdout ?? new Uint8Array());
    const stderr = new TextDecoder().decode(result.stderr ?? new Uint8Array());

    if (options.throwOnError ?? true) {
      if ((result.exitCode ?? 1) !== 0) {
        throw new Error(stderr.trim() || stdout.trim() || `tmux ${args[0] ?? ""} failed`);
      }
    }

    return {
      exitCode: result.exitCode ?? 0,
      stdout,
      stderr,
    };
  }
}
