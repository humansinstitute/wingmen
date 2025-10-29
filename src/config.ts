import { isAbsolute, normalize, resolve } from "node:path";

export type AgentType = "codex" | "claude" | "goose" | "opencode" | "gemini";

export interface AgentCommandContext {
  port: number;
  agent: AgentType;
  config: WingmanConfig;
}

export interface AgentDefinition {
  /** Build the command used to spawn the agent API subprocess. */
  command(ctx: AgentCommandContext): string[];
  /** Additional environment variables passed to the subprocess. */
  env?: Record<string, string>;
  /** Human readable label used in the UI. */
  label: string;
}

export interface WingmanConfig {
  port: number;
  agentPortStart: number;
  agentPortMax: number;
  defaultWorkingDirectory: string;
  allowedDirectories: string[];
  allowedOrigins: string;
  allowedHosts: string;
  tmuxBase: string;
  agents: Record<AgentType, AgentDefinition>;
}

const DEFAULT_PORT = 3600;
const DEFAULT_AGENT_PORTS = 3700;
const DEFAULT_AGENT_MAX = 10;
const DEFAULT_DIRECTORY = "~/code";
const DEFAULT_ALLOWED_ORIGINS = "*";
const DEFAULT_ALLOWED_HOSTS = "localhost,127.0.0.1,[::1]";

const sanitizeInteger = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const expandHomeDirectory = (input: string): string => {
  if (!input.startsWith("~")) return input;
  const home = Bun.env.HOME ?? "~";
  return input.replace("~", home);
};

const normaliseDirectory = (input: string, baseDirectory: string): string => {
  const expanded = expandHomeDirectory(input);
  const absolute = isAbsolute(expanded) ? expanded : resolve(baseDirectory, expanded);
  return normalize(absolute);
};

const agentMode = (Bun.env.AGENT_MODE ?? "").trim().toLowerCase();
const defaultAgentApiPath = agentMode === "tmux" ? "../out/agentapi-tmux" : "../out/agentapi";
const agentApiBinary = Bun.env.AGENTAPI_BIN ?? new URL(defaultAgentApiPath, import.meta.url).pathname;
const parseEnvironmentString = (input: string | undefined, fallback: string): string => {
  if (!input) return fallback;
  const trimmed = input.trim();
  if (trimmed.length === 0) return fallback;
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length > 1) {
    return trimmed.slice(1, -1).trim() || fallback;
  }
  return trimmed;
};

const tmuxBase = parseEnvironmentString(Bun.env.TMUX_BASE, "wingman-agents");

const isTmuxBinary = agentApiBinary.includes("agentapi-tmux");

const baseCommand = (ctx: AgentCommandContext) => {
  const args = [
    agentApiBinary,
    "server",
    "--port",
    String(ctx.port),
    "--allowed-origins",
    ctx.config.allowedOrigins,
    "--allowed-hosts",
    ctx.config.allowedHosts,
  ];
  if (isTmuxBinary || agentMode === "tmux") {
    args.push(`--tmux-session=${ctx.config.tmuxBase}`);
  }
  return args;
};

const withAgentCommand = (
  label: string,
  agentCli: string,
  options?: { type?: string; extraArgs?: string[] },
): AgentDefinition => ({
  label,
  command: (ctx) => {
    const args = baseCommand(ctx);
    if (options?.type) {
      args.push(`--type=${options.type}`);
    }
    args.push("--", agentCli);
    if (options?.extraArgs) {
      args.push(...options.extraArgs);
    }
    return args;
  },
});

const defaultAgents: Record<AgentType, AgentDefinition> = {
  codex: withAgentCommand("Codex", Bun.env.CODEX_CLI ?? "codex", { type: "codex" }),
  claude: withAgentCommand("Claude", Bun.env.CLAUDE_CLI ?? "claude"),
  goose: withAgentCommand("Goose", Bun.env.GOOSE_CLI ?? "goose"),
  opencode: withAgentCommand("OpenCode", Bun.env.OPENCODE_CLI ?? "opencode"),
  gemini: withAgentCommand("Gemini", Bun.env.GEMINI_CLI ?? "gemini"),
};

export const loadConfig = (): WingmanConfig => {
  const port = sanitizeInteger(Bun.env.PORT, DEFAULT_PORT);
  const agentPortStart = sanitizeInteger(Bun.env.AGENT_PORTS, DEFAULT_AGENT_PORTS);
  const agentPortMax = sanitizeInteger(Bun.env.AGENT_MAX, DEFAULT_AGENT_MAX);
  const defaultDirectoryInput = Bun.env.DIRECTORY_DEF ?? DEFAULT_DIRECTORY;
  const defaultWorkingDirectory = normaliseDirectory(defaultDirectoryInput, process.cwd());
  const allowedDirectoryInput = Bun.env.FOLDERACCESS;
  const configuredAllowedDirectories = allowedDirectoryInput
    ? allowedDirectoryInput
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => normaliseDirectory(value, defaultWorkingDirectory))
    : [];
  const allowedDirectories = Array.from(
    new Set([
      ...configuredAllowedDirectories,
      defaultWorkingDirectory,
    ]),
  );
  const allowedOrigins = Bun.env.AGENTAPI_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS;
  const allowedHosts = Bun.env.AGENTAPI_ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS;

  return {
    port,
    agentPortStart,
    agentPortMax,
    defaultWorkingDirectory,
    allowedDirectories,
    allowedOrigins,
    allowedHosts,
    tmuxBase,
    agents: defaultAgents,
  };
};

export type WingmanConfigSnapshot = ReturnType<typeof loadConfig>;
