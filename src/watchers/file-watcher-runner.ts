import { realpathSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rm, stat, realpath } from "node:fs/promises";
import { basename, join, normalize, relative, resolve, sep, isAbsolute } from "node:path";
import { homedir } from "node:os";

import type { ProcessManager } from "../agents/process-manager";
import type { AgentType, WingmanConfig } from "../config";
import type { FileWatcherRecord, JsonValue } from "../storage/file-watcher-store";
import { fileWatcherStore } from "../storage/file-watcher-store";
import { messageStore } from "../storage/message-store";
import {
  fetchAgentMessages,
  normaliseHostForUrl,
  parseAllowedHosts,
  pickAgentHost,
  sendAgentMessage,
  waitForAgentReady,
} from "../agents/agent-client";

type CleanupStrategy = "delete" | "none";

interface ActiveWatcher {
  record: FileWatcherRecord;
  directory: string;
  matcher: RegExp;
  fsWatcher: FSWatcher;
  signature: string;
}

interface PendingKey {
  watcherId: string;
  filePath: string;
}

const pointerSeparator = "/";

const escapeForRegex = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const determineHomeDirectory = () => {
  const fromEnv = Bun.env.HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return homedir();
  } catch {
    return "";
  }
};

const expandUserPath = (input: string): string => {
  if (!input.startsWith("~")) {
    return input;
  }
  const home = determineHomeDirectory();
  if (!home) {
    return input;
  }
  return input.replace(/^~(?=\/|$)/, home);
};

const resolveWatcherRoot = (providedRoot: string): string => {
  const override = Bun.env.WINGMAN_WATCHER_ROOT?.trim();
  const base = override && override.length > 0 ? expandUserPath(override) : (() => {
    const home = determineHomeDirectory();
    if (home) {
      return join(home, ".wingmen");
    }
    return providedRoot;
  })();

  const expanded = expandUserPath(base);
  try {
    return normalize(realpathSync(expanded));
  } catch {
    return normalize(resolve(expanded));
  }
};

const globToRegExp = (pattern: string): RegExp => {
  const escaped = escapeForRegex(pattern);
  const converted = escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${converted}$`, "i");
};

const isRecord = (value: unknown): value is Record<string, JsonValue> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const resolvePointer = (value: JsonValue, pointer: string): JsonValue | undefined => {
  if (!pointer || pointer === pointerSeparator) {
    return value;
  }

  if (!pointer.startsWith(pointerSeparator)) {
    throw new Error(`Invalid JSON pointer "${pointer}"`);
  }

  const segments = pointer
    .split(pointerSeparator)
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: JsonValue = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (Number.isNaN(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      const next = current[index];
      if (next === undefined) {
        return undefined;
      }
      current = next;
      continue;
    }

    if (!isRecord(current)) {
      return undefined;
    }

    if (!(segment in current)) {
      return undefined;
    }

    const next = current[segment];
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }

  return current;
};

const matchesExpectedPayload = (candidate: JsonValue | undefined, expected: JsonValue): boolean => {
  if (candidate === undefined) {
    return false;
  }

  if (isRecord(expected)) {
    if (!isRecord(candidate)) {
      return false;
    }
    return Object.entries(expected).every(([key, expectedValue]) =>
      matchesExpectedPayload(candidate[key] ?? undefined, expectedValue),
    );
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(candidate) || expected.length !== candidate.length) {
      return false;
    }
    return expected.every((value, index) => matchesExpectedPayload(candidate[index], value));
  }

  return candidate === expected;
};

const normaliseCleanupStrategy = (value: unknown): CleanupStrategy => {
  if (value === "none") {
    return "none";
  }
  return "delete";
};

const isAgentType = (value: string): value is AgentType => {
  return ["codex", "claude", "goose", "opencode"].includes(value);
};

interface StartSessionOptions {
  agentPointer: string;
  directoryPointer: string;
  namePointer: string;
  messagePointer: string;
  cleanupStrategy: CleanupStrategy;
}

const toStartSessionOptions = (options: JsonValue | undefined): StartSessionOptions => {
  if (!isRecord(options)) {
    return {
      agentPointer: "/agent",
      directoryPointer: "/directory",
      namePointer: "/name",
      messagePointer: "/message",
      cleanupStrategy: "delete",
    };
  }

  return {
    agentPointer:
      typeof options.agentPointer === "string" && options.agentPointer.trim().length > 0
        ? options.agentPointer.trim()
        : "/agent",
    directoryPointer:
      typeof options.directoryPointer === "string" && options.directoryPointer.trim().length > 0
        ? options.directoryPointer.trim()
        : "/directory",
    namePointer:
      typeof options.namePointer === "string" && options.namePointer.trim().length > 0
        ? options.namePointer.trim()
        : "/name",
    messagePointer:
      typeof options.messagePointer === "string" && options.messagePointer.trim().length > 0
        ? options.messagePointer.trim()
        : "/message",
    cleanupStrategy: normaliseCleanupStrategy(options.cleanupStrategy),
  };
};

const toPendingKey = ({ watcherId, filePath }: PendingKey) => `${watcherId}::${filePath}`;

export class FileWatcherRunner {
  private readonly manager: ProcessManager;
  private readonly config: WingmanConfig;
  private readonly agentHost: string;
  private readonly root: string;
  private readonly rootBoundary: string;
  private readonly refreshInterval: number;
  private readonly watchers = new Map<string, ActiveWatcher>();
  private readonly pending = new Set<string>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { root: string; manager: ProcessManager; config: WingmanConfig; refreshIntervalMs?: number }) {
    const watcherRoot = resolveWatcherRoot(options.root);
    this.root = watcherRoot;
    this.rootBoundary = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    this.manager = options.manager;
    this.config = options.config;
    const allowedHosts = parseAllowedHosts(this.config.allowedHosts);
    this.agentHost = normaliseHostForUrl(pickAgentHost(allowedHosts));
    this.refreshInterval = Math.max(2000, options.refreshIntervalMs ?? 10000);
  }

  async start() {
    await this.refreshWatchers();
    this.refreshTimer = setInterval(() => {
      void this.refreshWatchers();
    }, this.refreshInterval);
  }

  stop() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const active of this.watchers.values()) {
      active.fsWatcher.close();
    }
    this.watchers.clear();
  }

  private async refreshWatchers() {
    const enabled = fileWatcherStore.listEnabledWatchers();
    const seen = new Set<string>();

    for (const record of enabled) {
      seen.add(record.id);
      await this.ensureWatcher(record).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        fileWatcherStore.recordError(record.id, message);
        console.warn(`[watchers] failed to initialise watcher ${record.id}: ${message}`);
      });
    }

    for (const [id, active] of this.watchers.entries()) {
      if (!seen.has(id)) {
        active.fsWatcher.close();
        this.watchers.delete(id);
      }
    }
  }

  private async ensureWatcher(record: FileWatcherRecord) {
    const signature = JSON.stringify(record);
    const existing = this.watchers.get(record.id);
    if (existing && existing.signature === signature) {
      return;
    }

    if (existing) {
      existing.fsWatcher.close();
      this.watchers.delete(record.id);
    }

    const directory = await this.resolveDirectory(record.relativeDir);
    const matcher = globToRegExp(record.pattern);

    const fsWatcher = watch(directory, (eventType, filename) => {
      if (!filename) {
        return;
      }

      const candidateName = typeof filename === "string" ? filename : String(filename);
      if (!matcher.test(candidateName)) {
        return;
      }

      const filePath = join(directory, candidateName);
      this.queueFile(record.id, filePath);
    });

    this.watchers.set(record.id, {
      record,
      directory,
      matcher,
      fsWatcher,
      signature,
    });

    const relativePath = relative(this.root, directory) || ".";
    console.log(`[watchers] watching ${record.actionKey} in ${relativePath} (${record.pattern})`);
  }

  private queueFile(watcherId: string, filePath: string) {
    const key = toPendingKey({ watcherId, filePath });
    if (this.pending.has(key)) {
      return;
    }

    this.pending.add(key);
    const relativePath = relative(this.root, filePath);
    console.log(
      `[watchers] detected ${relativePath || basename(filePath)} for watcher ${watcherId}`,
    );
    void this.handleFile(watcherId, filePath).finally(() => {
      this.pending.delete(key);
    });
  }

  private async handleFile(watcherId: string, filePath: string) {
    const active = this.watchers.get(watcherId);
    if (!active) {
      return;
    }

    const { record } = active;
    try {
      await this.delay(50);

      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat || !fileStat.isFile()) {
        return;
      }

      const raw = await readFile(filePath, "utf8");
      let payload: JsonValue;
      try {
        payload = JSON.parse(raw) as JsonValue;
      } catch {
        throw new Error(`Invalid JSON in ${basename(filePath)}`);
      }

      const candidate = resolvePointer(payload, record.payloadPointer);
      if (candidate === undefined) {
        return;
      }

      if (!matchesExpectedPayload(candidate, record.expectedPayload)) {
        return;
      }

      await this.performAction(record, payload, filePath);

      fileWatcherStore.markTriggered(record.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fileWatcherStore.recordError(record.id, message);
      console.warn(`[watchers] failed to handle ${basename(filePath)} for ${watcherId}: ${message}`);
    }
  }

  private async performAction(record: FileWatcherRecord, payload: JsonValue, filePath: string) {
    switch (record.actionKey) {
      case "stop-session":
        await this.handleStopSession(record, payload, filePath);
        break;
      case "start-session":
        await this.handleStartSession(record, payload, filePath);
        break;
      default:
        throw new Error(`Unsupported action ${record.actionKey}`);
    }
  }

  private async handleStopSession(record: FileWatcherRecord, payload: JsonValue, filePath: string) {
    if (!isRecord(payload)) {
      throw new Error("Stop session trigger payload must be an object");
    }

    const options = isRecord(record.options) ? record.options : {};
    const sessionPointer = typeof options.sessionPointer === "string" ? options.sessionPointer : "/session";
    const cleanupStrategy = normaliseCleanupStrategy(options.cleanupStrategy);

    const sessionId = resolvePointer(payload, sessionPointer);
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      throw new Error(`Session id missing via pointer ${sessionPointer}`);
    }

    const session = await this.manager.stopSession(sessionId.trim());
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    console.log(`[watchers] stopped session ${sessionId} via ${record.id}`);

    if (cleanupStrategy === "delete") {
      await rm(filePath).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[watchers] failed to remove trigger ${basename(filePath)}: ${message}`);
      });
    }
  }

  private async handleStartSession(record: FileWatcherRecord, payload: JsonValue, filePath: string) {
    if (!isRecord(payload)) {
      throw new Error("Start session trigger payload must be an object");
    }

    const options = toStartSessionOptions(record.options);
    const cleanupStrategy = options.cleanupStrategy;

    const agentCandidate = resolvePointer(payload, options.agentPointer);
    if (typeof agentCandidate !== "string" || agentCandidate.trim().length === 0) {
      throw new Error(`Agent missing via pointer ${options.agentPointer}`);
    }

    const agent = agentCandidate.trim().toLowerCase();
    if (!isAgentType(agent)) {
      throw new Error(`Unsupported agent "${agent}"`);
    }

    const directoryCandidate = resolvePointer(payload, options.directoryPointer);
    const directoryInput =
      typeof directoryCandidate === "string" && directoryCandidate.trim().length > 0
        ? directoryCandidate.trim()
        : undefined;
    const workingDirectory = await this.ensureDirectory(directoryInput);

    const nameCandidate = resolvePointer(payload, options.namePointer);
    const sessionName =
      typeof nameCandidate === "string" && nameCandidate.trim().length > 0 ? nameCandidate.trim() : undefined;

    const session = await this.manager.createSession(agent, workingDirectory, sessionName);
    messageStore.recordSession({
      id: session.id,
      agent: session.agent,
      startedAt: session.startedAt,
      name: session.name,
      npub: session.npub,
      port: session.port,
      pid: session.pid,
      tmuxSession: session.tmuxSession,
      tmuxWindow: session.tmuxWindow,
      workingDirectory: session.workingDirectory,
      command: session.command,
    });

    try {
      await waitForAgentReady(this.agentHost, session.port, session.agent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[watchers] failed to confirm readiness for ${session.id}: ${message}`);
    }

    const firstMessage = this.extractMessageContent(resolvePointer(payload, options.messagePointer));
    if (firstMessage) {
      try {
        await sendAgentMessage(this.agentHost, session.port, firstMessage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[watchers] failed to send initial message for ${session.id}: ${message}`);
      }
    }

    await this.syncSessionMessages(session.id, session.port);

    console.log(`[watchers] started session ${session.id} via ${record.id}`);

    if (cleanupStrategy === "delete") {
      await rm(filePath).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[watchers] failed to remove trigger ${basename(filePath)}: ${message}`);
      });
    }
  }

  private extractMessageContent(value: JsonValue | undefined): string | null {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (isRecord(value)) {
      const content = value.content;
      if (typeof content === "string") {
        const trimmed = content.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
    }

    return null;
  }

  private async syncSessionMessages(sessionId: string, port: number) {
    try {
      const messages = await fetchAgentMessages(this.agentHost, port);
      messageStore.replaceMessages(
        sessionId,
        messages.map((entry) => ({
          role: entry.role,
          content: entry.content,
          createdAt: entry.createdAt,
        })),
      );
    } catch (error) {
      console.warn(`[watchers] failed to synchronise messages for ${sessionId}: ${(error as Error).message}`);
    }
  }

  private async ensureDirectory(input: string | undefined): Promise<string> {
    const candidate = input && input.length > 0 ? input : this.config.defaultWorkingDirectory;
    const expanded =
      candidate.startsWith("~") && (Bun.env.HOME ?? "").length > 0 ? candidate.replace("~", Bun.env.HOME ?? "") : candidate;
    const absolute = isAbsolute(expanded) ? expanded : resolve(this.config.defaultWorkingDirectory, expanded);

    let resolvedPath = normalize(absolute);
    this.assertWithinAllowedDirectories(resolvedPath);
    try {
      resolvedPath = normalize(await realpath(resolvedPath));
    } catch {
      // Use normalised path if realpath fails (likely missing directory)
    }
    this.assertWithinAllowedDirectories(resolvedPath);

    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(resolvedPath);
    } catch {
      throw new Error(`Directory not found: ${resolvedPath}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolvedPath}`);
    }

    return resolvedPath;
  }

  private async resolveDirectory(relativeDir: string): Promise<string> {
    const target = resolve(this.root, relativeDir);
    if (target !== this.root && !target.startsWith(this.rootBoundary)) {
      throw new Error(`Watcher directory ${relativeDir} escapes root`);
    }

    await mkdir(target, { recursive: true });
    return target;
  }

  private assertWithinAllowedDirectories(candidate: string) {
    const allowed = this.config.allowedDirectories;
    if (!allowed.length) {
      return;
    }

    const normalised = normalize(candidate);
    for (const base of allowed) {
      const boundary = base.endsWith(sep) ? base : `${base}${sep}`;
      if (normalised === base || normalised.startsWith(boundary)) {
        return;
      }
    }

    throw new Error(`Directory outside permitted locations: ${normalised}`);
  }

  private async delay(ms: number) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  }
}
