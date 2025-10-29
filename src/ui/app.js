import "/ace-builds/src-noconflict/ace.js";
import "/ace-builds/src-noconflict/mode-text.js";
import "/ace-builds/src-noconflict/theme-chrome.js";
import "/ace-builds/src-noconflict/theme-tomorrow_night.js";
import "./identity/index.js";

const ace = globalThis.ace;
if (!ace) {
  throw new Error("Ace editor failed to load");
}

const THEME_STORAGE_KEY = "wingman-theme";
const TABS_VISIBILITY_STORAGE_KEY = "wingman-tabs-visible";
const FILES_SHOW_HIDDEN_STORAGE_KEY = "wingman-files-show-hidden";
const SESSION_POLL_INTERVAL_MS = 2000;
const APPS_POLL_INTERVAL_MS = 5000;
const APP_LOG_PREVIEW_LINES = 5;

let sessionPollIntervalId = null;
let sessionPollInFlight = false;
let appsPollIntervalId = null;
let appsPollInFlight = false;

const state = {
  config: null,
  sessions: [],
  identitySummaries: [],
  sessionFilters: {
    npub: "all",
    options: [],
  },
  orchestratorPresets: [],
  orchestratorPresetsLoading: false,
  orchestratorPresetsLoaded: false,
  orchestratorPresetsError: null,
  logs: new Map(),
  conversations: new Map(),
  messageDrafts: new Map(),
  logPanelOpen: new Map(),
  activeSessionId: null,
  lastWorkingDirectory: null,
  lastActiveSessionId: null,
  // DOM references for incremental updates
  conversationContainers: new Map(), // sessionId -> DOM element
  logContainers: new Map(), // sessionId -> DOM element
  lastMessageCount: new Map(), // sessionId -> number of messages
  lastLogLength: new Map(), // sessionId -> length of logs
  apps: {
    items: [],
    loading: false,
    initialized: false,
    error: null,
  },
  system: {
    restart: {
      loading: false,
      inProgress: false,
      marker: null,
      outcome: null,
      error: null,
      submitting: false,
    },
  },
  appLogViewer: {
    appId: null,
    title: "",
    lines: [],
    loading: false,
    tail: 200,
  },
  files: {
    initialized: false,
    loading: false,
    error: null,
    currentPath: null,
    relativePath: null,
    displayPath: "~",
    parent: null,
    entries: [],
    git: null,
    previewPath: null,
    previewRelativePath: null,
    previewDisplayPath: "",
    previewName: null,
    previewContent: null,
    previewLoading: false,
    previewError: null,
    previewFormat: null,
    previewLanguage: null,
    previewLabel: null,
    showHidden: false,
    browserCollapsed: false,
    uploading: false,
    gitCommandPending: false,
    worktreeModal: {
      open: false,
      submitting: false,
      error: null,
      branch: "",
      startPoint: "",
    },
    transfer: {
      mode: null,
      sourcePath: null,
      sourceName: null,
      sourceDisplayPath: null,
      destinationPath: null,
      destinationDisplayPath: null,
      submitting: false,
      error: null,
      browser: {
        currentPath: "",
        parent: null,
        requestId: 0,
        selection: null,
      },
    },
  },
  fileEditor: {
    open: false,
    loading: false,
    saving: false,
    error: null,
    saveError: null,
    path: null,
    relativePath: null,
    displayPath: null,
    name: null,
    base64: null,
    content: "",
    initialContent: "",
    mtimeMs: null,
    dirty: false,
    requestId: 0,
  },
  identity: {
    method: "none",
    npub: null,
    expiresAt: null,
    authenticated: false,
  },
};

try {
  const storedShowHidden = localStorage.getItem(FILES_SHOW_HIDDEN_STORAGE_KEY);
  if (storedShowHidden === "true" || storedShowHidden === "false") {
    state.files.showHidden = storedShowHidden === "true";
  }
} catch {
  // Ignore storage errors (e.g., during private browsing)
}

const IDENTITY_STORAGE_KEY = "wingman-identity-state";
const IDENTITY_EVENT_NAMES = ["wingman:identity-state", "identity:state", "nostr-auth:state"];

const identityDomEntries = new Set();
const identityDomEntryByNode = new WeakMap();
const identityCopyFeedbackTimeouts = new WeakMap();
const identityButtonTimers = new WeakMap();
let identityCountdownIntervalId = null;

const clearButtonStateTimer = (button) => {
  if (!button) return;
  const timerId = identityButtonTimers.get(button);
  if (timerId) {
    window.clearTimeout(timerId);
    identityButtonTimers.delete(button);
  }
};

const ensureButtonOriginalLabel = (button) => {
  if (!button) return;
  if (!button.dataset.originalLabel) {
    button.dataset.originalLabel = button.textContent ?? "";
  }
};

const resetButtonState = (button) => {
  if (!button) return;
  clearButtonStateTimer(button);
  const originalLabel = button.dataset.originalLabel;
  if (typeof originalLabel === "string") {
    button.textContent = originalLabel;
  }
  delete button.dataset.state;
  button.removeAttribute("aria-busy");
};

const setButtonState = (button, options = {}) => {
  if (!button) return;
  ensureButtonOriginalLabel(button);
  const { state, label, disable, restoreAfterMs } = options;
  if (state) {
    button.dataset.state = state;
    if (state === "loading") {
      button.setAttribute("aria-busy", "true");
    } else {
      button.removeAttribute("aria-busy");
    }
  } else {
    delete button.dataset.state;
    button.removeAttribute("aria-busy");
  }
  if (typeof label === "string") {
    button.textContent = label;
  }
  if (typeof disable === "boolean") {
    button.disabled = disable;
  }
  if (restoreAfterMs && restoreAfterMs > 0) {
    clearButtonStateTimer(button);
    const timerId = window.setTimeout(() => {
      resetButtonState(button);
      identityButtonTimers.delete(button);
    }, restoreAfterMs);
    identityButtonTimers.set(button, timerId);
  }
};

const identityMethodLabels = {
  none: "Not signed in",
  nip07: "Browser extension",
  local_keys: "Local keys",
  bunker: "Bunker remote signer",
};

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

const toFiniteTimestamp = (value) => {
  if (isFiniteNumber(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }
  return null;
};

const abbreviateNpub = (npub) => {
  if (!npub || typeof npub !== "string") return "";
  if (npub.length <= 20) return npub;
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
};

const formatIdentityDuration = (ms) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 && parts.length < 3) parts.push(`${minutes}m`);
  if (parts.length < 3) parts.push(`${seconds}s`);
  return parts.join(" ");
};

const showIdentityCopyFeedback = (message, { error = false, entry } = {}) => {
  const targets = entry ? [entry] : Array.from(identityDomEntries);
  targets.forEach((target) => {
    const feedback = target.copyFeedback;
    if (!feedback) return;
    feedback.textContent = message;
    feedback.hidden = false;
    if (error) {
      feedback.dataset.state = "error";
    } else {
      feedback.dataset.state = "success";
    }
    const existingTimeout = identityCopyFeedbackTimeouts.get(target);
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
    }
    const timeoutId = window.setTimeout(() => {
      const currentFeedback = target.copyFeedback;
      if (!currentFeedback) return;
      currentFeedback.hidden = true;
      delete currentFeedback.dataset.state;
    }, 2000);
    identityCopyFeedbackTimeouts.set(target, timeoutId);
    if (target.copyButton) {
      setButtonState(target.copyButton, {
        state: error ? "error" : "success",
        label: error ? "Copy failed" : "Copied",
        disable: false,
        restoreAfterMs: error ? 2500 : 1500,
      });
    }
  });
};

const stopIdentityCountdown = () => {
  if (identityCountdownIntervalId !== null) {
    window.clearInterval(identityCountdownIntervalId);
    identityCountdownIntervalId = null;
  }
};

const updateIdentityCountdown = () => {
  pruneIdentityDomEntries();
  const expiresAt = state.identity.expiresAt;
  const authenticated = state.identity.authenticated;
  const expirationKnown = isFiniteNumber(expiresAt);
  identityDomEntries.forEach((entry) => {
    const expiry = entry.expiry;
    if (!expiry) return;
    if (!expirationKnown) {
      expiry.textContent = authenticated ? "Session expiry unknown" : "—";
      expiry.dataset.state = authenticated ? "unknown" : "inactive";
      expiry.title = "";
      return;
    }
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      expiry.textContent = "Session expired";
      expiry.dataset.state = "expired";
      expiry.title = new Date(expiresAt).toLocaleString();
      return;
    }
    expiry.textContent = `Expires in ${formatIdentityDuration(remaining)}`;
    expiry.dataset.state = "active";
    expiry.title = new Date(expiresAt).toLocaleString();
  });
  if (expirationKnown && expiresAt - Date.now() <= 0) {
    stopIdentityCountdown();
  }
};

const startIdentityCountdown = () => {
  stopIdentityCountdown();
  if (!state.identity.authenticated || !isFiniteNumber(state.identity.expiresAt)) {
    return;
  }
  const hasExpiryTarget = Array.from(identityDomEntries).some((entry) => Boolean(entry.expiry));
  if (!hasExpiryTarget) {
    return;
  }
  updateIdentityCountdown();
  identityCountdownIntervalId = window.setInterval(() => {
    updateIdentityCountdown();
  }, 1000);
};

const persistIdentityState = (identity) => {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    if (identity.npub) {
      const payload = {
        npub: identity.npub,
        method: identity.method,
        expiresAt: identity.expiresAt ?? null,
      };
      window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(payload));
    } else {
      window.localStorage.removeItem(IDENTITY_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
};

const syncIdentityDisplayForEntry = (entry) => {
  const { npub, method, authenticated, expiresAt } = state.identity;
  if (entry.root) {
    if (authenticated) {
      entry.root.dataset.authenticated = "true";
    } else {
      delete entry.root.dataset.authenticated;
    }
  }
  if (entry.npub) {
    if (npub) {
      entry.npub.textContent = abbreviateNpub(npub);
      entry.npub.title = npub;
    } else {
      entry.npub.textContent = "Not signed in";
      entry.npub.removeAttribute("title");
    }
  }
  if (entry.method) {
    entry.method.textContent = authenticated ? (identityMethodLabels[method] ?? method ?? "Unknown") : "—";
  }
  if (entry.copyButton) {
    if (!npub) {
      resetButtonState(entry.copyButton);
      entry.copyButton.disabled = true;
    } else {
      entry.copyButton.disabled = false;
    }
  }
  if (entry.logoutButton) {
    if (!authenticated) {
      resetButtonState(entry.logoutButton);
      entry.logoutButton.disabled = true;
    } else {
      entry.logoutButton.disabled = false;
    }
  }
  if (entry.copyFeedback && !npub) {
    entry.copyFeedback.hidden = true;
    delete entry.copyFeedback.dataset.state;
  }
  if (entry.expiry) {
    if (!authenticated) {
      entry.expiry.textContent = "—";
      entry.expiry.dataset.state = "inactive";
      entry.expiry.removeAttribute("title");
    } else if (!isFiniteNumber(expiresAt)) {
      entry.expiry.textContent = "Session expiry unknown";
      entry.expiry.dataset.state = "unknown";
      entry.expiry.removeAttribute("title");
    } else {
      updateIdentityCountdown();
    }
  }
};

const syncIdentityDisplay = () => {
  pruneIdentityDomEntries();
  identityDomEntries.forEach((entry) => {
    syncIdentityDisplayForEntry(entry);
  });
  if (state.identity.authenticated && isFiniteNumber(state.identity.expiresAt)) {
    startIdentityCountdown();
  } else {
    stopIdentityCountdown();
  }
};

const updateIdentityState = (partial, { persist = true, emit = true } = {}) => {
  if (!partial || typeof partial !== "object") {
    return state.identity;
  }
  const current = state.identity;
  const next = {
    method: current.method,
    npub: current.npub,
    expiresAt: current.expiresAt,
    authenticated: current.authenticated,
  };

  if ("isAuthenticated" in partial && partial.isAuthenticated === false) {
    next.method = "none";
    next.npub = null;
    next.expiresAt = null;
  }

  if ("method" in partial && typeof partial.method === "string" && partial.method.length > 0) {
    next.method = partial.method;
  }

  if ("npub" in partial) {
    if (typeof partial.npub === "string" && partial.npub.trim().length > 0) {
      next.npub = partial.npub.trim();
    } else if (partial.npub === null) {
      next.npub = null;
    }
  } else if (typeof partial.pubkey === "string" && partial.pubkey.trim().length > 0 && !next.npub) {
    next.npub = partial.pubkey.trim();
  }

  const expiryCandidate =
    "expiresAt" in partial
      ? partial.expiresAt
      : "sessionExpiresAt" in partial
        ? partial.sessionExpiresAt
        : "expiry" in partial
          ? partial.expiry
          : undefined;
  if (expiryCandidate !== undefined) {
    const timestamp = toFiniteTimestamp(expiryCandidate);
    next.expiresAt = timestamp;
  }

  if (!next.npub) {
    next.method = "none";
    next.expiresAt = null;
  }

  next.authenticated = Boolean(next.npub);

  const changed =
    next.method !== current.method ||
    next.npub !== current.npub ||
    next.expiresAt !== current.expiresAt ||
    next.authenticated !== current.authenticated;

  if (!changed) {
    return current;
  }

  state.identity = next;

  if (persist) {
    persistIdentityState(next);
  }

  syncIdentityDisplay();

  if (emit && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent("wingman:identity-ui-state", { detail: { ...next } }));
    } catch {
      // ignore dispatch errors
    }
  }

  return next;
};

const handleIdentityCopy = async (event, entryOverride) => {
  if (event?.preventDefault) {
    event.preventDefault();
  }
  const entry = entryOverride ?? (event?.currentTarget ? identityDomEntryByNode.get(event.currentTarget) : null);
  const npub = state.identity.npub;
  if (!npub) {
    if (entry?.copyButton) {
      resetButtonState(entry.copyButton);
    }
    return;
  }
  if (entry?.copyButton) {
    setButtonState(entry.copyButton, { state: "loading", label: "Copying…", disable: true });
  }
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(npub);
      showIdentityCopyFeedback("Copied", { entry });
      return;
    }
  } catch (error) {
    console.warn("[identity] clipboard write failed", error);
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = npub;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    const success = document.execCommand("copy");
    textarea.remove();
    if (success) {
      showIdentityCopyFeedback("Copied", { entry });
      return;
    }
  } catch (error) {
    console.warn("[identity] fallback copy failed", error);
  }

  showIdentityCopyFeedback("Copy failed", { error: true, entry });
};

const clearCachedIdentity = () => {
  try {
    globalThis.wingmanIdentity?.sessionCache?.clear?.();
  } catch (error) {
    console.warn("[identity] failed to clear session cache", error);
  }
  try {
    globalThis.wingmanIdentity?.passwordMeta?.clear?.();
  } catch (error) {
    console.warn("[identity] failed to clear password metadata", error);
  }
};

const forceIdentityLogoutState = () => {
  clearCachedIdentity();
  updateIdentityState({ npub: null, method: "none", expiresAt: null, isAuthenticated: false });
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent("wingman:identity-logout"));
    } catch {
      // ignore dispatch failures
    }
  }
};

const requestServerLogout = async () => {
  const response = await fetch("/api/auth/session", {
    method: "DELETE",
    credentials: "include",
    headers: { "cache-control": "no-store" },
  });
  if (!response.ok && response.status !== 204) {
    const data = await response.json().catch(() => ({}));
    const message =
      data && typeof data === "object" && typeof data.error === "string"
        ? data.error
        : `Failed to clear session (${response.status})`;
    throw new Error(message);
  }
};

const handleIdentityLogout = async (event, entryOverride) => {
  if (event?.preventDefault) {
    event.preventDefault();
  }
  identityDomEntries.forEach((entry) => {
    if (entry.logoutButton) {
      setButtonState(entry.logoutButton, { state: "loading", label: "Logging out…", disable: true });
    }
  });
  let logoutSuccessful = false;
  const sources = [globalThis.wingmanIdentity, globalThis.identity];
  for (const source of sources) {
    if (source && typeof source.logoutIdentity === "function") {
      try {
        await source.logoutIdentity();
        logoutSuccessful = true;
        break;
      } catch (error) {
        console.error("[identity] logout failed", error);
        const message = error instanceof Error ? error.message : "Failed to sign out";
        window.alert(message);
      }
    }
  }

  if (!logoutSuccessful) {
    try {
      await requestServerLogout();
      logoutSuccessful = true;
    } catch (error) {
      console.error("[identity] server logout failed", error);
      const message = error instanceof Error ? error.message : "Failed to clear session on server.";
      window.alert(message);
    }
  }

  if (logoutSuccessful) {
    forceIdentityLogoutState();
    identityDomEntries.forEach((entry) => {
      if (entry.logoutButton) {
        setButtonState(entry.logoutButton, {
          state: "success",
          label: "Logged out",
          disable: true,
          restoreAfterMs: 1500,
        });
      }
    });
  } else {
    identityDomEntries.forEach((entry) => {
      if (entry.logoutButton) {
        setButtonState(entry.logoutButton, {
          state: "error",
          label: "Retry logout",
          disable: false,
          restoreAfterMs: 2500,
        });
      }
    });
  }
};

const detachIdentityDomEntry = (entry) => {
  if (!entry) return;
  if (entry.copyButton && entry.copyHandler) {
    entry.copyButton.removeEventListener("click", entry.copyHandler);
    identityDomEntryByNode.delete(entry.copyButton);
    resetButtonState(entry.copyButton);
  }
  if (entry.logoutButton && entry.logoutHandler) {
    entry.logoutButton.removeEventListener("click", entry.logoutHandler);
    identityDomEntryByNode.delete(entry.logoutButton);
    resetButtonState(entry.logoutButton);
  }
  const timeoutId = identityCopyFeedbackTimeouts.get(entry);
  if (timeoutId) {
    window.clearTimeout(timeoutId);
    identityCopyFeedbackTimeouts.delete(entry);
  }
};

const pruneIdentityDomEntries = () => {
  const staleEntries = [];
  identityDomEntries.forEach((entry) => {
    if (!entry.root || !entry.root.isConnected) {
      staleEntries.push(entry);
    }
  });
  staleEntries.forEach((entry) => {
    detachIdentityDomEntry(entry);
    identityDomEntries.delete(entry);
  });
  if (staleEntries.length > 0 && identityDomEntries.size === 0) {
    stopIdentityCountdown();
  }
};

const registerIdentityDom = (root) => {
  if (!root) return;
  pruneIdentityDomEntries();
  let existingEntry = null;
  identityDomEntries.forEach((entry) => {
    if (entry.root === root) {
      existingEntry = entry;
    }
  });
  if (existingEntry) {
    detachIdentityDomEntry(existingEntry);
    identityDomEntries.delete(existingEntry);
  }

  const entry = {
    root,
    npub: root.querySelector('[data-role="identity-npub"]'),
    method: root.querySelector('[data-role="identity-method"]'),
    expiry: root.querySelector('[data-role="identity-expiry"]'),
    copyFeedback: root.querySelector('[data-role="identity-copy-feedback"]'),
    copyButton: root.querySelector('[data-action="copy-active-npub"]'),
    logoutButton: root.querySelector('[data-action="identity-logout"]'),
    copyHandler: null,
    logoutHandler: null,
  };

  if (entry.copyButton) {
    ensureButtonOriginalLabel(entry.copyButton);
    entry.copyHandler = (event) => {
      void handleIdentityCopy(event, entry);
    };
    entry.copyButton.addEventListener("click", entry.copyHandler);
    identityDomEntryByNode.set(entry.copyButton, entry);
  }

  if (entry.logoutButton) {
    ensureButtonOriginalLabel(entry.logoutButton);
    entry.logoutHandler = (event) => {
      void handleIdentityLogout(event, entry);
    };
    entry.logoutButton.addEventListener("click", entry.logoutHandler);
    identityDomEntryByNode.set(entry.logoutButton, entry);
  }

  identityDomEntries.add(entry);
  syncIdentityDisplayForEntry(entry);
};

const callIdentityWire = (names, element, ...extraArgs) => {
  const nameList = Array.isArray(names) ? names : [names];
  if (!element || typeof element !== "object") return false;
  if (typeof globalThis === "undefined") return false;
  const sources = [globalThis.wingmanIdentity, globalThis.identity, globalThis];
  for (const name of nameList) {
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      const candidate = source[name];
      if (typeof candidate === "function") {
        try {
          candidate(element, ...extraArgs);
          return true;
        } catch (error) {
          console.error(`[identity] Failed to wire ${name}:`, error);
          return true;
        }
      }
    }
  }
  return false;
};

let identityWiringContext = null;

const getIdentityWiringContext = () => {
  if (identityWiringContext) {
    return identityWiringContext;
  }
  identityWiringContext = {
    updateIdentityState,
    getIdentityState: () => ({ ...state.identity }),
    syncDisplay: syncIdentityDisplay,
    requestBinding: () => {
      pruneIdentityDomEntries();
      identityDomEntries.forEach((entry) => {
        if (entry.root && entry.root.isConnected) {
          bindIdentityFlows(entry.root);
        }
      });
    },
  };
  return identityWiringContext;
};

function bindIdentityFlows(root) {
  if (!root) return;
  const context = getIdentityWiringContext();
  const localPanel = root.querySelector('[data-identity-panel="local"]');
  if (localPanel) {
    callIdentityWire(["wireLocalIdentityPanel"], localPanel, context);
  }
  const nip07Panel = root.querySelector('[data-identity-panel="nip07"]');
  if (nip07Panel) {
    callIdentityWire(["wireNip07Login", "wireNip07Panel", "wireNip07"], nip07Panel, context);
  }
  const bunkerPanel = root.querySelector('[data-identity-panel="bunker"]');
  if (bunkerPanel) {
    callIdentityWire(["wireBunkerLogin"], bunkerPanel, context);
    callIdentityWire(
      ["wireBunkerQRScanner"],
      bunkerPanel,
      (uri) => {
        if (!uri) return;
        const textarea = bunkerPanel.querySelector('textarea[name="bunkerUri"]');
        if (!textarea) return;
        textarea.value = uri;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      },
      context,
    );
  }
}

const identityWireRequestHandler = () => {
  pruneIdentityDomEntries();
  identityDomEntries.forEach((entry) => {
    if (entry.root && entry.root.isConnected) {
      bindIdentityFlows(entry.root);
    }
  });
};

const handleIdentityEventPayload = (payload) => {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const next = {};
  if ("npub" in payload) {
    next.npub = typeof payload.npub === "string" ? payload.npub : payload.npub === null ? null : undefined;
  } else if (typeof payload.pubkey === "string") {
    next.npub = payload.pubkey;
  }
  if (typeof payload.method === "string") {
    next.method = payload.method;
  }
  if ("expiresAt" in payload || "sessionExpiresAt" in payload || "expiry" in payload) {
    const timestamp = toFiniteTimestamp(
      "expiresAt" in payload
        ? payload.expiresAt
        : "sessionExpiresAt" in payload
          ? payload.sessionExpiresAt
          : payload.expiry,
    );
    next.expiresAt = timestamp;
  }
  if ("isAuthenticated" in payload) {
    next.isAuthenticated = payload.isAuthenticated;
  }
  updateIdentityState(next);
};

const handleIdentityEvent = (event) => {
  if (!event) return;
  if ("detail" in event && event.detail) {
    handleIdentityEventPayload(event.detail);
    return;
  }
  handleIdentityEventPayload(event);
};

const setupIdentityEventBridges = () => {
  if (typeof window === "undefined") return;
  IDENTITY_EVENT_NAMES.forEach((name) => {
    window.addEventListener(name, handleIdentityEvent);
    document.addEventListener(name, handleIdentityEvent);
  });
  window.addEventListener("wingman:identity-refresh", () => {
    syncIdentityDisplay();
  });
  window.addEventListener("wingman:identity-wire-request", identityWireRequestHandler);
};

setupIdentityEventBridges();

const loadPersistedIdentityState = () => {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    const raw = window.localStorage.getItem(IDENTITY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    updateIdentityState(parsed, { persist: false, emit: false });
  } catch {
    // ignore parse errors
  }
};

loadPersistedIdentityState();

const handleIdentityStorageEvent = (event) => {
  if (!event) return;
  if (event.key !== IDENTITY_STORAGE_KEY) return;
  if (event.newValue) {
    try {
      const parsed = JSON.parse(event.newValue);
      updateIdentityState(parsed, { persist: false, emit: false });
    } catch {
      // ignore parse errors
    }
  } else {
    updateIdentityState({ npub: null, method: "none", expiresAt: null, isAuthenticated: false }, { persist: false, emit: false });
  }
};

if (typeof window !== "undefined") {
  window.addEventListener("storage", handleIdentityStorageEvent);
}

const attachIdentityUiApi = () => {
  if (typeof globalThis === "undefined") return;
  const existing =
    typeof globalThis.wingmanIdentityUI === "object" && globalThis.wingmanIdentityUI !== null
      ? globalThis.wingmanIdentityUI
      : {};
  const api = {
    ...existing,
    getState: () => ({ ...state.identity }),
    update: (partial, options) => updateIdentityState(partial, options),
    notify: (partial, options) => updateIdentityState(partial, options),
    bindPanels: () => {
      pruneIdentityDomEntries();
      identityDomEntries.forEach((entry) => {
        if (entry.root && entry.root.isConnected) {
          bindIdentityFlows(entry.root);
        }
      });
    },
    refreshDisplay: () => syncIdentityDisplay(),
  };
  globalThis.wingmanIdentityUI = api;
};

attachIdentityUiApi();

const textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: false }) : null;
const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

const decodeBase64ToUint8Array = (value) => {
  if (!value) return new Uint8Array(0);
  try {
    const binary = atob(value);
    const length = binary.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
};

const encodeUint8ArrayToBase64 = (bytes) => {
  if (!bytes || bytes.length === 0) return "";
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const decodeBytesToText = (bytes) => {
  if (!bytes || bytes.length === 0) return "";
  if (textDecoder) {
    try {
      return textDecoder.decode(bytes);
    } catch {
      // fall through to manual decoding
    }
  }
  let result = "";
  for (let i = 0; i < bytes.length; i += 1) {
    result += String.fromCharCode(bytes[i]);
  }
  return result;
};

const encodeTextToBytes = (text) => {
  if (!text || text.length === 0) return new Uint8Array(0);
  if (textEncoder) {
    try {
      return textEncoder.encode(text);
    } catch {
      // fall through to manual encoding
    }
  }
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
};

const readFileAsUint8Array = (file) =>
  new Promise((resolve, reject) => {
    if (!(file instanceof File)) {
      reject(new Error("Invalid file input"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      reader.abort();
      reject(new Error("Failed to read file"));
    };
    reader.onload = () => {
      const { result } = reader;
      if (result instanceof ArrayBuffer) {
        resolve(new Uint8Array(result));
        return;
      }
      if (ArrayBuffer.isView(result)) {
        resolve(new Uint8Array(result.buffer));
        return;
      }
      reject(new Error("Unsupported file result"));
    };
    reader.readAsArrayBuffer(file);
  });

const SVG_NS = "http://www.w3.org/2000/svg";

const createSvgShape = (tag, attributes = {}) => {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => {
    element.setAttribute(key, String(value));
  });
  if (!attributes.fill) {
    element.setAttribute("fill", "none");
  }
  if (!attributes.stroke) {
    element.setAttribute("stroke", "currentColor");
  }
  if (!attributes["stroke-width"]) {
    element.setAttribute("stroke-width", "1.8");
  }
  if ((tag === "path" || tag === "line" || tag === "polyline") && !attributes["stroke-linecap"]) {
    element.setAttribute("stroke-linecap", "round");
  }
  if ((tag === "path" || tag === "polyline") && !attributes["stroke-linejoin"]) {
    element.setAttribute("stroke-linejoin", "round");
  }
  if ((tag === "circle" || tag === "ellipse") && !attributes["stroke-linecap"]) {
    element.setAttribute("stroke-linecap", "round");
  }
  if ((tag === "circle" || tag === "ellipse") && !attributes["stroke-linejoin"]) {
    element.setAttribute("stroke-linejoin", "round");
  }
  return element;
};

const createIconSvg = (definition) => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("wm-icon");
  definition.forEach(([tag, attrs]) => {
    svg.append(createSvgShape(tag, attrs));
  });
  return svg;
};

const FILE_BROWSER_ICON_DEFS = {
  arrowUp: [
    ["line", { x1: 12, y1: 19, x2: 12, y2: 7 }],
    ["polyline", { points: "6 11 12 5 18 11" }],
  ],
  refresh: [
    ["polyline", { points: "23 4 23 10 17 10" }],
    ["path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36" }],
  ],
  eye: [
    ["ellipse", { cx: 12, cy: 12, rx: 9.5, ry: 6.5 }],
    ["circle", { cx: 12, cy: 12, r: 2.5 }],
  ],
  eyeOff: [
    ["ellipse", { cx: 12, cy: 12, rx: 9.5, ry: 6.5 }],
    ["circle", { cx: 12, cy: 12, r: 2.5 }],
    ["line", { x1: 4, y1: 4, x2: 20, y2: 20 }],
  ],
  folder: [
    ["path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }],
    ["path", { d: "M3 7h18" }],
  ],
  file: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
  ],
  fileText: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["line", { x1: 16, y1: 13, x2: 8, y2: 13 }],
    ["line", { x1: 16, y1: 17, x2: 8, y2: 17 }],
    ["path", { d: "M10 9h4" }],
  ],
  fileCode: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["polyline", { points: "10 13 8 15 10 17" }],
    ["polyline", { points: "14 17 16 15 14 13" }],
  ],
  ban: [
    ["circle", { cx: 12, cy: 12, r: 9 }],
    ["line", { x1: 5, y1: 19, x2: 19, y2: 5 }],
  ],
  folderPlus: [
    ["path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }],
    ["path", { d: "M12 11v4" }],
    ["path", { d: "M10 13h4" }],
  ],
  filePlus: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["path", { d: "M12 13v4" }],
    ["path", { d: "M10 15h4" }],
  ],
  upload: [
    ["path", { d: "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" }],
    ["polyline", { points: "16 6 12 2 8 6" }],
    ["line", { x1: 12, y1: 2, x2: 12, y2: 16 }],
  ],
  branchPlus: [
    ["circle", { cx: 6, cy: 6, r: 2.5 }],
    ["circle", { cx: 6, cy: 18, r: 2.5 }],
    ["circle", { cx: 18, cy: 12, r: 2.5 }],
    ["line", { x1: 6, y1: 8.5, x2: 6, y2: 15.5 }],
    ["path", { d: "M8.5 8.5a5 5 0 0 1 5.5 4.5" }],
    ["line", { x1: 18, y1: 14.5, x2: 18, y2: 20 }],
    ["line", { x1: 16, y1: 17, x2: 20, y2: 17 }],
  ],
};

const setIconButton = (button, iconKey, label) => {
  const definition = FILE_BROWSER_ICON_DEFS[iconKey];
  if (!definition) return;
  while (button.firstChild) {
    button.removeChild(button.firstChild);
  }
  button.append(createIconSvg(definition));
  if (label) {
    button.setAttribute("aria-label", label);
    button.title = label;
  } else {
    button.removeAttribute("aria-label");
    button.removeAttribute("title");
  }
};

let aceEditorInstance = null;

const getSessionDisplayName = (session) => {
  if (!session || typeof session !== "object") return "";
  const rawName = typeof session.name === "string" ? session.name.trim() : "";
  if (rawName.length > 0) return rawName;
  const agent = typeof session.agent === "string" ? session.agent : "agent";
  const port = typeof session.port === "number" ? session.port : "";
  return port ? `${agent} :${port}` : agent;
};

const truncateText = (value, maxLength = 31) => {
  if (typeof value !== "string") return "";
  if (value.length <= maxLength) return value;
  const safeLength = Math.max(0, maxLength - 3);
  return `${value.slice(0, safeLength)}...`;
};

const scrollConversationToBottom = (element) => {
  if (!element) return;
  requestAnimationFrame(() => {
    if (element === document.body || element === document.documentElement || element === document.scrollingElement) {
      const target = document.scrollingElement || document.documentElement || document.body;
      window.scrollTo(0, target.scrollHeight);
      return;
    }
    element.scrollTop = element.scrollHeight;
  });
};

const getConversationScrollElement = (sessionId) => {
  const container = state.conversationContainers.get(sessionId);
  if (!container) return null;
  return container.closest('.wm-live-conversation');
};

const scrollConversationAreaToBottom = (sessionId, options = {}) => {
  const { includeWindow = false } = options;
  const target =
    getConversationScrollElement(sessionId) ??
    document.querySelector('.wm-live-conversation');
  if (target) {
    scrollConversationToBottom(target);
  }
  if (includeWindow) {
    const fallback = document.scrollingElement || document.documentElement || document.body;
    if (fallback && fallback !== target) {
      scrollConversationToBottom(fallback);
    }
  }
};

const isMobileFilesLayout = () => {
  if (window.matchMedia) {
    try {
      return window.matchMedia("(max-width: 720px)").matches;
    } catch {
      // fall through to manual check
    }
  }
  return window.innerWidth <= 720;
};

const copyTextToClipboard = async (text) => {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "absolute";
    fallback.style.left = "-9999px";
    document.body.append(fallback);
    fallback.select();
    const success = document.execCommand("copy");
    fallback.remove();
    return success;
  } catch (error) {
    console.error("Failed to copy to clipboard", error);
    return false;
  }
};

const attachCopyButton = (bubble) => {
  if (!bubble || bubble.dataset.copyAttached === "true") return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-message-copy";
  button.setAttribute("aria-label", "Copy message");
  button.innerHTML =
    '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M15 3H7a2 2 0 0 0-2 2v10h2V5h8V3zm4 4h-8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zm0 12h-8V9h8v10z"/></svg>';
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const body = bubble.querySelector("pre");
    const text = body?.textContent ?? "";
    const copied = await copyTextToClipboard(text);
    if (copied) {
      bubble.dataset.copied = "true";
      setTimeout(() => {
        if (bubble.isConnected) {
          delete bubble.dataset.copied;
        }
      }, 1600);
    }
  });
  bubble.append(button);
  bubble.dataset.copyAttached = "true";
};

const copyConversationToClipboard = async (sessionId) => {
  const conversation = state.conversations.get(sessionId) ?? [];
  let textBlocks = conversation;
  if (textBlocks.length === 0) {
    const container = state.conversationContainers.get(sessionId);
    if (container) {
      const domMessages = container.querySelectorAll(".wm-message pre");
      textBlocks = Array.from(domMessages).map((node) => ({
        role: null,
        content: node.textContent ?? "",
      }));
    }
  }

  if (textBlocks.length === 0) return false;

  const formatted = textBlocks
    .map((message) => {
      const role = typeof message.role === "string" ? message.role : message.type;
      const labelSource = role ?? "assistant";
      const label = `${labelSource.charAt(0).toUpperCase()}${labelSource.slice(1)}`;
      const content = message.content ?? message.message ?? "";
      if (!content) return label;
      return `${label}:\n${content}`;
    })
    .join("\n\n")
    .trim();

  if (!formatted) return false;
  return copyTextToClipboard(formatted);
};

const escapeHtml = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const escapeAttribute = (value) => {
  if (value === null || value === undefined) return "#";
  const trimmed = String(value).trim();
  const allowed = /^(https?:\/\/|\/|#|mailto:|tel:)/i;
  const safe = allowed.test(trimmed) ? trimmed : "#";
  return escapeHtml(safe).replace(/"/g, "&quot;");
};

const sanitizeLanguageClass = (value) => {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "");
};

const renderInlineMarkdown = (text) => {
  if (!text) return "";
  let working = String(text);
  const placeholders = [];
  const createPlaceholder = (html) => {
    const token = `@@MD${placeholders.length}@@`;
    placeholders.push(html);
    return token;
  };

  working = working.replace(/`([^`]+)`/g, (_, code) =>
    createPlaceholder(`<code>${escapeHtml(code)}</code>`),
  );

  working = working.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const safeUrl = escapeAttribute(url);
    const safeLabel = escapeHtml(label);
    return createPlaceholder(
      `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`,
    );
  });

  working = working.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, (_, __, content) =>
    createPlaceholder(`<strong>${renderInlineMarkdown(content)}</strong>`),
  );

  working = working.replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, (_, __, content) =>
    createPlaceholder(`<em>${renderInlineMarkdown(content)}</em>`),
  );

  working = working.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_, content) =>
    createPlaceholder(`<del>${renderInlineMarkdown(content)}</del>`),
  );

  const escaped = escapeHtml(working);
  return escaped.replace(/@@MD(\d+)@@/g, (_, index) => placeholders[Number(index)] ?? "");
};

const renderMarkdownToHtml = (markdown) => {
  if (!markdown) return "";
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeBuffer = [];
  let listType = null;
  let listItems = [];
  let paragraph = "";
  let inBlockquote = false;

  const closeParagraph = () => {
    if (paragraph) {
      html += `<p>${paragraph.trim()}</p>`;
      paragraph = "";
    }
  };

  const closeList = () => {
    if (listType && listItems.length > 0) {
      html += `<${listType}>${listItems.join("")}</${listType}>`;
    }
    listType = null;
    listItems = [];
  };

  const closeBlockquote = () => {
    if (inBlockquote) {
      html += "</blockquote>";
      inBlockquote = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        const languageClass = sanitizeLanguageClass(codeLanguage);
        const classAttr = languageClass ? ` class="language-${languageClass}"` : "";
        html += `<pre><code${classAttr}>${escapeHtml(codeBuffer.join("\n"))}\n</code></pre>`;
        inCodeBlock = false;
        codeLanguage = "";
        codeBuffer = [];
      } else {
        closeParagraph();
        closeList();
        closeBlockquote();
        inCodeBlock = true;
        codeLanguage = line.slice(3).trim();
        codeBuffer = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(rawLine);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeParagraph();
      closeList();
      closeBlockquote();
      continue;
    }

    if (trimmed.startsWith(">")) {
      closeParagraph();
      closeList();
      if (!inBlockquote) {
        inBlockquote = true;
        html += "<blockquote>";
      }
      const quote = trimmed.replace(/^>\s?/, "");
      html += `<p>${renderInlineMarkdown(quote)}</p>`;
      continue;
    }

    if (inBlockquote) {
      closeBlockquote();
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeParagraph();
      closeList();
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      html += `<h${level}>${renderInlineMarkdown(text)}</h${level}>`;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeParagraph();
      closeList();
      html += "<hr />";
      continue;
    }

    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      closeParagraph();
      const content = renderInlineMarkdown(orderedMatch[2]);
      if (listType !== "ol") {
        closeList();
        listType = "ol";
      }
      listItems.push(`<li>${content}</li>`);
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      closeParagraph();
      const content = renderInlineMarkdown(unorderedMatch[1]);
      if (listType !== "ul") {
        closeList();
        listType = "ul";
      }
      listItems.push(`<li>${content}</li>`);
      continue;
    }

    closeList();
    if (paragraph) {
      paragraph += ` ${renderInlineMarkdown(trimmed)}`;
    } else {
      paragraph = renderInlineMarkdown(trimmed);
    }
  }

  if (inCodeBlock) {
    const languageClass = sanitizeLanguageClass(codeLanguage);
    const classAttr = languageClass ? ` class="language-${languageClass}"` : "";
    html += `<pre><code${classAttr}>${escapeHtml(codeBuffer.join("\n"))}\n</code></pre>`;
  }
  closeParagraph();
  closeList();
  closeBlockquote();
  return html.trim();
};

const resetFilesPreview = () => {
  state.files.previewPath = null;
  state.files.previewRelativePath = null;
  state.files.previewDisplayPath = "";
  state.files.previewName = null;
  state.files.previewContent = null;
  state.files.previewLoading = false;
  state.files.previewError = null;
  state.files.previewFormat = null;
  state.files.previewLanguage = null;
  state.files.previewLabel = null;
};

const CODE_KEYWORDS = {
  javascript: [
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
    "else", "export", "extends", "finally", "for", "from", "function", "if", "import", "in", "instanceof",
    "let", "new", "return", "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "yield", "await",
  ],
  typescript: [
    "abstract", "any", "as", "asserts", "async", "await", "boolean", "break", "case", "catch", "class", "const",
    "constructor", "continue", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "false",
    "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "infer", "instanceof", "interface",
    "is", "keyof", "let", "module", "namespace", "never", "new", "null", "number", "object", "package", "private", "protected",
    "public", "readonly", "require", "return", "set", "static", "string", "super", "switch", "symbol", "this", "throw", "true",
    "try", "type", "typeof", "undefined", "unique", "unknown", "var", "void", "while", "with", "yield",
  ],
  go: [
    "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go",
    "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
  ],
  json: ["true", "false", "null"],
  yaml: ["true", "false", "null", "yes", "no", "on", "off"],
  toml: ["true", "false"],
  ini: ["true", "false"],
  rust: [
    "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let",
    "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait",
    "true", "type", "unsafe", "use", "where", "while",
  ],
  python: [
    "and", "as", "assert", "break", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for",
    "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return",
    "True", "try", "while", "with", "yield",
  ],
  shell: [
    "if", "then", "else", "elif", "fi", "for", "while", "in", "do", "done", "case", "esac", "function", "select",
  ],
  css: ["@import", "@media", "@supports", "@keyframes", "from", "to"],
  html: ["doctype", "html", "head", "body", "div", "span", "script", "style", "link", "meta", "title"],
  plaintext: [],
};

const buildKeywordPattern = (keywords) => {
  if (!keywords || keywords.length === 0) return null;
  const escaped = keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "g");
};

const CODE_KEYWORD_PATTERNS = Object.fromEntries(
  Object.entries(CODE_KEYWORDS).map(([language, keywords]) => [language, buildKeywordPattern(keywords)]),
);

const renderCodeToHtml = (content, language = "plaintext") => {
  const normalizedLanguage = CODE_KEYWORDS[language] ? language : "plaintext";
  const escaped = escapeHtml(content ?? "");
  const replacements = [];
  const createToken = (html) => {
    const token = `__WM_TOKEN_${replacements.length}__`;
    replacements.push({ token, html });
    return token;
  };

  let working = escaped;

  if (normalizedLanguage === "json") {
    working = working.replace(/(&quot;[^&]*?&quot;)(?=\s*:)/g, (match) =>
      createToken(`<span class="token key">${match}</span>`),
    );
  } else if (normalizedLanguage === "yaml" || normalizedLanguage === "toml" || normalizedLanguage === "ini") {
    working = working.replace(/^(\s*)([^\s:#][^:]*)(?=\s*:)/gm, (full, indent, key) => {
      return `${indent}${createToken(`<span class="token key">${key}</span>`)}`;
    });
  }

  if (
    normalizedLanguage === "javascript" ||
    normalizedLanguage === "typescript" ||
    normalizedLanguage === "go" ||
    normalizedLanguage === "rust"
  ) {
    working = working.replace(/(\/\/[^\n]*)/g, (match) => createToken(`<span class="token comment">${match}</span>`));
    working = working.replace(/(\/\*[\s\S]*?\*\/)/g, (match) =>
      createToken(`<span class="token comment">${match}</span>`),
    );
  }

  if (
    normalizedLanguage === "python" ||
    normalizedLanguage === "shell" ||
    normalizedLanguage === "yaml" ||
    normalizedLanguage === "toml" ||
    normalizedLanguage === "ini"
  ) {
    working = working.replace(/(^|\s)(#[^\n]*)/gm, (full, prefix, comment) => {
      return `${prefix}${createToken(`<span class="token comment">${comment}</span>`)}`;
    });
  }

  working = working.replace(/(&quot;.*?&quot;)/g, (match) => createToken(`<span class="token string">${match}</span>`));
  working = working.replace(/(&#39;.*?&#39;)/g, (match) => createToken(`<span class="token string">${match}</span>`));
  working = working.replace(/`[^`]*`/g, (match) => createToken(`<span class="token string">${match}</span>`));

  working = working.replace(/\b(0x[a-fA-F0-9]+|\d+\.\d+|\d+)\b/g, '<span class="token number">$1</span>');

  const keywordPattern = CODE_KEYWORD_PATTERNS[normalizedLanguage];
  if (keywordPattern) {
    working = working.replace(keywordPattern, '<span class="token keyword">$1</span>');
  }

  replacements.forEach(({ token, html }) => {
    working = working.replaceAll(token, html);
  });

  return `<pre><code class="language-${normalizedLanguage}">${working}</code></pre>`;
};

const loadFilesTree = async (path) => {
  const files = state.files;
  const targetPath = typeof path === "string" && path.length > 0 ? path : files.currentPath;
  if (typeof path === "string" && path.length > 0 && path !== files.currentPath) {
    resetFilesPreview();
  }
  files.loading = true;
  files.error = null;

  try {
    const url = new URL("/api/docs/tree", window.location.origin);
    if (targetPath) {
      url.searchParams.set("path", targetPath);
    }
    if (files.showHidden) {
      url.searchParams.set("showHidden", "1");
    }
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      let message = response.statusText || "Failed to load directory";
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === "string") {
          message = payload.error;
        }
      } catch {
        // ignore json parsing error
      }
      throw new Error(message);
    }

    const data = await response.json();
    files.currentPath = data?.path ?? targetPath ?? files.currentPath;
    files.relativePath = data?.relativePath ?? "";
    files.displayPath = data?.displayPath ?? (files.relativePath ? `~/${files.relativePath}` : "~");
    files.parent = data?.parent ?? null;
    files.entries = Array.isArray(data?.entries) ? data.entries : [];
    files.git = data?.git ?? null;
    files.loading = false;
    files.error = null;

    if (files.previewPath) {
      const exists = files.entries.some((entry) => entry.path === files.previewPath);
      if (!exists) {
        resetFilesPreview();
      }
    }
  } catch (error) {
    files.loading = false;
    files.error = error instanceof Error ? error.message : String(error);
    files.entries = [];
    files.git = null;
    if (typeof path === "string" && path.length > 0) {
      files.currentPath = path;
    }
  } finally {
    if (currentRoute === "files") {
      render();
    }
  }
};

const loadFilesPreview = async (path) => {
  if (!path) return;
  const files = state.files;
  files.previewPath = path;
  files.previewRelativePath = "";
  files.previewDisplayPath = "";
  files.previewName = null;
  files.previewContent = null;
  files.previewError = null;
  files.previewLoading = true;
  files.previewFormat = null;
  files.previewLanguage = null;
  files.previewLabel = null;
  if (currentRoute === "files") {
    render();
  }

  try {
    const url = new URL("/api/docs/file", window.location.origin);
    url.searchParams.set("path", path);
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      let message = response.statusText || "Failed to load file";
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === "string") {
          message = payload.error;
        }
      } catch {
        // ignore json parse error
      }
      throw new Error(message);
    }

    const data = await response.json();
    files.previewPath = data?.path ?? path;
    files.previewRelativePath = data?.relativePath ?? "";
    files.previewDisplayPath = data?.displayPath ?? (files.previewRelativePath ? `~/${files.previewRelativePath}` : "");
    files.previewName = data?.name ?? null;
    files.previewContent = data?.content ?? "";
    files.previewFormat = data?.format ?? null;
    files.previewLanguage = data?.language ?? null;
    files.previewLabel = data?.label ?? null;
    files.previewLoading = false;
    files.previewError = null;
  } catch (error) {
    files.previewLoading = false;
    files.previewError = error instanceof Error ? error.message : String(error);
    files.previewContent = null;
  } finally {
    if (currentRoute === "files") {
      render();
    }
  }
};

const showFilesPreviewUnavailable = (entry) => {
  const files = state.files;
  files.previewPath = entry?.path ?? null;
  files.previewRelativePath = entry?.relativePath ?? "";
  files.previewDisplayPath = entry?.displayPath ?? "";
  files.previewName = entry?.name ?? null;
  files.previewFormat = null;
  files.previewLanguage = null;
  files.previewLabel = entry?.previewLabel ?? null;
  files.previewContent = null;
  files.previewLoading = false;
  files.previewError = "Preview not available for this file type.";
  if (currentRoute === "files") {
    render();
  }
};

const createFilesDirectory = async (parentPath, name) => {
  const response = await fetch("/api/docs/directory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: parentPath, name }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to create directory";
    throw new Error(message);
  }
  return response.json();
};

const createFilesTextFile = async (parentPath, name, content = "") => {
  const response = await fetch("/api/docs/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directory: parentPath, name, content }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to create file";
    throw new Error(message);
  }
  return response.json();
};

const uploadFilesBinary = async (parentPath, file) => {
  const bytes = await readFileAsUint8Array(file);
  const base64 = encodeUint8ArrayToBase64(bytes);
  const response = await fetch("/api/docs/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directory: parentPath, name: file.name, base64 }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to upload file";
    throw new Error(message);
  }
  return response.json();
};

const deleteFilesEntry = async (path) => {
  const response = await fetch("/api/docs/file", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to delete file";
    throw new Error(message);
  }
  return response.json();
};

const createDirectoryEntry = async (parent, name) => {
  const response = await fetch("/api/directories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent, name }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to create folder";
    throw new Error(message);
  }
  return response.json();
};

const copyFilesEntry = async (path, targetDirectory) => {
  const response = await fetch("/api/docs/file/copy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, targetDirectory }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to copy file";
    throw new Error(message);
  }
  return response.json();
};

const moveFilesEntry = async (path, targetDirectory) => {
  const response = await fetch("/api/docs/file/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, targetDirectory }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to move file";
    throw new Error(message);
  }
  return response.json();
};

const getWorktreeGitInfo = () => {
  const git = state.files.git;
  if (!git || typeof git !== "object") return null;
  return git;
};

const canCreateWorktree = () => {
  const git = getWorktreeGitInfo();
  if (!git) return false;
  return Boolean(git.isRepoRoot && git.hasGitMetadata);
};

const resetWorktreeModalState = (defaults = {}) => {
  const modal = state.files.worktreeModal;
  modal.branch = typeof defaults.branch === "string" ? defaults.branch : "";
  modal.startPoint = typeof defaults.startPoint === "string" ? defaults.startPoint : "";
  modal.error = null;
  modal.submitting = false;
};

const openWorktreeModal = () => {
  if (!canCreateWorktree()) return;
  const git = getWorktreeGitInfo();
  const modal = state.files.worktreeModal;
  resetWorktreeModalState({
    branch: "",
    startPoint: git?.currentBranch && git.currentBranch !== "HEAD" ? git.currentBranch : git?.headRef ?? "",
  });
  modal.open = true;
  renderWorktreeModal();
};

const closeWorktreeModal = () => {
  const modal = state.files.worktreeModal;
  if (!modal.open) return;
  modal.open = false;
  resetWorktreeModalState();
  renderWorktreeModal();
};

const requestCreateWorktree = async () => {
  const files = state.files;
  const git = getWorktreeGitInfo();
  if (!git) return;
  const modal = files.worktreeModal;
  const branch = modal.branch.trim();
  if (!branch) {
    modal.error = "Branch name is required";
    renderWorktreeModal();
    return;
  }

  modal.submitting = true;
  modal.error = null;
  renderWorktreeModal();

  try {
    const response = await fetch("/api/docs/worktrees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        directory: git.repoRoot ?? files.currentPath,
        branch,
        startPoint: modal.startPoint.trim() || null,
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = payload?.error ?? response.statusText ?? "Failed to create worktree";
      throw new Error(message);
    }
    const payload = await response.json().catch(() => ({}));
    if (payload?.repository) {
      files.git = payload.repository;
    } else {
      // Refresh to pick up latest git info when response lacks repository payload
      void loadFilesTree(files.currentPath);
    }
    modal.open = false;
    resetWorktreeModalState();
    renderWorktreeModal();
    await loadFilesTree(files.currentPath);
  } catch (error) {
    modal.submitting = false;
    modal.error = error instanceof Error ? error.message : "Failed to create worktree";
    renderWorktreeModal();
  }
};

const destroyAceEditor = () => {
  if (!aceEditorInstance) return;
  const container = aceEditorInstance.container;
  aceEditorInstance.destroy();
  if (container) {
    container.textContent = "";
  }
  aceEditorInstance = null;
};

const setFileEditorState = (updater) => {
  const editor = state.fileEditor;
  if (!editor) return;
  updater(editor);
};

const resetFileEditorState = () => {
  setFileEditorState((editor) => {
    editor.open = false;
    editor.loading = false;
    editor.saving = false;
    editor.error = null;
    editor.saveError = null;
    editor.path = null;
    editor.relativePath = null;
    editor.displayPath = null;
    editor.name = null;
    editor.base64 = null;
    editor.content = "";
    editor.initialContent = "";
    editor.mtimeMs = null;
    editor.dirty = false;
    editor.requestId += 1;
  });
  destroyAceEditor();
};

const closeFileEditor = () => {
  resetFileEditorState();
  render();
};

const requestFileEditorClose = () => {
  const editor = state.fileEditor;
  if (editor.saving) return;
  if (editor.dirty) {
    const confirmClose = window.confirm("Discard unsaved changes?");
    if (!confirmClose) {
      return;
    }
  }
  closeFileEditor();
};

const updateFileEditorControls = () => {
  const editor = state.fileEditor;
  const overlay = document.getElementById("wm-file-editor-overlay");
  if (!overlay || !editor.open) {
    return;
  }
  const saveButton = overlay.querySelector("#wm-file-editor-save");
  if (saveButton instanceof HTMLButtonElement) {
    saveButton.disabled = editor.saving || !editor.dirty;
  }
  const cancelButton = overlay.querySelector("#wm-file-editor-cancel");
  if (cancelButton instanceof HTMLButtonElement) {
    cancelButton.disabled = editor.saving;
  }
  const status = overlay.querySelector("#wm-file-editor-status");
  if (status instanceof HTMLElement) {
    if (editor.saveError) {
      status.textContent = editor.saveError;
      status.hidden = false;
    } else if (editor.saving) {
      status.textContent = "Saving…";
      status.hidden = false;
    } else {
      status.textContent = "";
      status.hidden = true;
    }
  }
};

const ensureAceEditorMounted = () => {
  const editor = state.fileEditor;
  if (!editor.open || editor.loading || editor.error) {
    destroyAceEditor();
    return;
  }

  const container = document.getElementById("wm-file-editor-ace");
  if (!container) {
    destroyAceEditor();
    return;
  }

  if (!aceEditorInstance) {
    aceEditorInstance = ace.edit(container);
    aceEditorInstance.session.setMode("ace/mode/text");
    aceEditorInstance.session.setUseWrapMode(true);
    aceEditorInstance.setOptions({
      useWorker: false,
      showPrintMargin: false,
      behavioursEnabled: false,
      highlightActiveLine: true,
      highlightSelectedWord: false,
      enableBasicAutocompletion: false,
      enableLiveAutocompletion: false,
      enableSnippets: false,
      wrap: true,
      fontSize: 14,
      tabSize: 2,
    });
    aceEditorInstance.renderer.setScrollMargin(8, 8, 8, 8);
    aceEditorInstance.on("change", () => {
      if (!aceEditorInstance) return;
      const value = aceEditorInstance.getValue();
      const editorState = state.fileEditor;
      editorState.content = value;
      editorState.dirty = value !== editorState.initialContent;
      updateFileEditorControls();
    });
  }

  applyAceTheme();
  const targetValue = editor.content ?? "";
  if (aceEditorInstance.getValue() !== targetValue) {
    const selection = aceEditorInstance.getSelectionRange();
    aceEditorInstance.setValue(targetValue, -1);
    if (!editor.loading) {
      aceEditorInstance.selection.setRange(selection, false);
    }
  }

  aceEditorInstance.resize(true);
  aceEditorInstance.focus();
  updateFileEditorControls();
};

const getFileEditorDisplayTitle = () => {
  const editor = state.fileEditor;
  if (editor.displayPath) {
    return editor.displayPath;
  }
  if (editor.name) {
    return editor.name;
  }
  if (editor.path) {
    return editor.path;
  }
  return "File Editor";
};

const openFileEditor = async (path, displayPath, name) => {
  if (!path) return;
  const editor = state.fileEditor;
  editor.open = true;
  editor.loading = true;
  editor.saving = false;
  editor.error = null;
  editor.saveError = null;
  editor.path = path;
  editor.displayPath = displayPath ?? null;
  editor.name = name ?? null;
  editor.content = "";
  editor.initialContent = "";
  editor.base64 = null;
  editor.dirty = false;
  editor.mtimeMs = null;
  editor.requestId += 1;
  const requestId = editor.requestId;
  render();

  try {
    const url = new URL("/api/docs/file/raw", window.location.origin);
    url.searchParams.set("path", path);
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      let message = response.statusText || "Failed to load file";
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === "string") {
          message = payload.error;
        }
      } catch {
        // ignore json parse error
      }
      throw new Error(message);
    }

    const data = await response.json();
    if (editor.requestId !== requestId) {
      return;
    }
    const base64 = typeof data?.base64 === "string" ? data.base64 : "";
    const bytes = decodeBase64ToUint8Array(base64);
    const content = decodeBytesToText(bytes);
    editor.open = true;
    editor.loading = false;
    editor.error = null;
    editor.saveError = null;
    editor.path = data?.path ?? path;
    editor.relativePath = data?.relativePath ?? null;
    editor.displayPath = data?.displayPath ?? displayPath ?? null;
    editor.name = data?.name ?? name ?? null;
    editor.base64 = base64;
    editor.content = content;
    editor.initialContent = content;
    editor.mtimeMs = typeof data?.mtimeMs === "number" ? data.mtimeMs : null;
    editor.dirty = false;
  } catch (error) {
    if (editor.requestId !== requestId) {
      return;
    }
    editor.loading = false;
    editor.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (editor.requestId === requestId) {
      render();
    }
  }
};

const saveFileEditor = async () => {
  const editor = state.fileEditor;
  if (!editor.open || editor.loading || editor.saving || !editor.path) {
    return;
  }
  editor.saving = true;
  editor.saveError = null;
  updateFileEditorControls();
  const content = aceEditorInstance ? aceEditorInstance.getValue() : editor.content;
  editor.content = content;
  editor.dirty = content !== editor.initialContent;
  const bytes = encodeTextToBytes(content);
  const base64 = encodeUint8ArrayToBase64(bytes);

  try {
    const response = await fetch("/api/docs/file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: editor.path,
        base64,
        expectedMtimeMs: editor.mtimeMs ?? undefined,
      }),
    });
    if (!response.ok) {
      let message = response.statusText || "Failed to save file";
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === "string") {
          message = payload.error;
        }
      } catch {
        // ignore json parse error
      }
      throw new Error(message);
    }

    const data = await response.json();
    editor.initialContent = content;
    editor.content = content;
    editor.base64 = base64;
    editor.mtimeMs = typeof data?.mtimeMs === "number" ? data.mtimeMs : editor.mtimeMs;
    editor.dirty = false;
    editor.saving = false;
    editor.saveError = null;
    if (state.files.previewPath === editor.path) {
      state.files.previewContent = content;
    }
    updateFileEditorControls();
  } catch (error) {
    editor.saving = false;
    editor.saveError = error instanceof Error ? error.message : String(error);
    editor.dirty = editor.content !== editor.initialContent;
    updateFileEditorControls();
  }
};

const renderFileEditorOverlay = () => {
  const existing = document.getElementById("wm-file-editor-overlay");
  if (existing) {
    existing.remove();
  }

  const editor = state.fileEditor;
  if (!editor.open) {
    destroyAceEditor();
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "wm-file-editor-overlay";
  overlay.className = "wm-file-editor";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      requestFileEditorClose();
    }
  });

  const dialog = document.createElement("div");
  dialog.className = "wm-file-editor__dialog";
  overlay.append(dialog);

  const header = document.createElement("div");
  header.className = "wm-file-editor__header";
  const heading = document.createElement("div");
  heading.className = "wm-file-editor__heading";
  const title = document.createElement("h2");
  title.textContent = editor.name ?? "Edit File";
  heading.append(title);

  const subtitleText = editor.name ? getFileEditorDisplayTitle() : editor.displayPath ?? editor.path ?? "";
  if (subtitleText) {
    const subtitle = document.createElement("p");
    subtitle.className = "wm-file-editor__subtitle";
    subtitle.textContent = subtitleText;
    heading.append(subtitle);
  }

  header.append(heading);
  dialog.append(header);

  const body = document.createElement("div");
  body.className = "wm-file-editor__body";
  dialog.append(body);

  if (editor.loading) {
    const message = document.createElement("p");
    message.className = "wm-file-editor__message";
    message.textContent = "Loading file…";
    body.append(message);
  } else if (editor.error) {
    const message = document.createElement("p");
    message.className = "wm-file-editor__message";
    message.textContent = editor.error;
    body.append(message);
  } else {
    const editorContainer = document.createElement("div");
    editorContainer.id = "wm-file-editor-ace";
    editorContainer.className = "wm-file-editor__editor";
    body.append(editorContainer);
  }

  const footer = document.createElement("div");
  footer.className = "wm-file-editor__footer";
  const status = document.createElement("div");
  status.id = "wm-file-editor-status";
  status.className = "wm-file-editor__status";
  status.hidden = true;
  footer.append(status);

  const actions = document.createElement("div");
  actions.className = "wm-file-editor__actions";

  const cancelButton = document.createElement("button");
  cancelButton.id = "wm-file-editor-cancel";
  cancelButton.type = "button";
  cancelButton.className = "wm-button secondary";
  cancelButton.textContent = editor.error ? "Close" : "Cancel";
  cancelButton.addEventListener("click", () => {
    requestFileEditorClose();
  });
  actions.append(cancelButton);

  if (editor.error && editor.path) {
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "wm-button";
    retryButton.textContent = "Retry";
    retryButton.addEventListener("click", () => {
      void openFileEditor(editor.path, editor.displayPath, editor.name);
    });
    actions.append(retryButton);
  } else if (!editor.loading) {
    const saveButton = document.createElement("button");
    saveButton.id = "wm-file-editor-save";
    saveButton.type = "button";
    saveButton.className = "wm-button";
    saveButton.textContent = "Save";
    saveButton.disabled = true;
    saveButton.addEventListener("click", () => {
      void saveFileEditor();
    });
    actions.append(saveButton);
  }

  footer.append(actions);
  dialog.append(footer);

  appRoot.append(overlay);

  updateFileEditorControls();

  if (!editor.loading && !editor.error) {
    requestAnimationFrame(() => {
      ensureAceEditorMounted();
    });
  } else {
    updateFileEditorControls();
  }
};

const renderWorktreeModal = () => {
  const existing = document.getElementById("wm-worktree-modal");
  if (existing) {
    existing.remove();
  }

  const modal = state.files.worktreeModal;
  if (!modal.open) {
    return;
  }

  const git = getWorktreeGitInfo();

  const overlay = document.createElement("div");
  overlay.id = "wm-worktree-modal";
  overlay.className = "wm-worktree-modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && !modal.submitting) {
      closeWorktreeModal();
    }
  });

  const dialog = document.createElement("div");
  dialog.className = "wm-worktree-modal__dialog";
  overlay.append(dialog);

  const header = document.createElement("div");
  header.className = "wm-worktree-modal__header";
  const title = document.createElement("h2");
  title.textContent = "Create Worktree";
  header.append(title);
  if (git?.repoRoot) {
    const subtitle = document.createElement("p");
    subtitle.className = "wm-worktree-modal__subtitle";
    subtitle.textContent = git.repoRoot;
    header.append(subtitle);
  }
  dialog.append(header);

  const body = document.createElement("div");
  body.className = "wm-worktree-modal__body";
  dialog.append(body);

  const description = document.createElement("p");
  description.className = "wm-worktree-modal__description";
  if (git?.worktreeBase) {
    description.textContent = `New worktrees are created under ${git.worktreeBase}/<branch>`;
  } else {
    description.textContent = "New worktrees are created under .worktrees/<branch> in this repository.";
  }
  body.append(description);

  if (git?.worktreeError) {
    const warning = document.createElement("p");
    warning.className = "wm-worktree-modal__warning";
    warning.textContent = git.worktreeError;
    body.append(warning);
  }

  const form = document.createElement("form");
  form.className = "wm-worktree-modal__form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (modal.submitting) return;
    void requestCreateWorktree();
  });

  const branchGroup = document.createElement("label");
  branchGroup.className = "wm-worktree-modal__field";
  const branchLabel = document.createElement("span");
  branchLabel.className = "wm-worktree-modal__label";
  branchLabel.textContent = "Feature branch";
  const branchInput = document.createElement("input");
  branchInput.type = "text";
  branchInput.required = true;
  branchInput.placeholder = "feature/amazing-update";
  branchInput.value = modal.branch;
  branchInput.disabled = modal.submitting;
  branchInput.addEventListener("input", (event) => {
    modal.branch = event.target.value;
  });
  branchGroup.append(branchLabel, branchInput);
  form.append(branchGroup);

  const startGroup = document.createElement("label");
  startGroup.className = "wm-worktree-modal__field";
  const startLabel = document.createElement("span");
  startLabel.className = "wm-worktree-modal__label";
  startLabel.textContent = "Start from (optional)";
  const startInput = document.createElement("input");
  startInput.type = "text";
  startInput.placeholder =
    git?.currentBranch && git.currentBranch !== "HEAD" ? git.currentBranch : git?.headRef || "main";
  startInput.value = modal.startPoint;
  startInput.disabled = modal.submitting;
  startInput.addEventListener("input", (event) => {
    modal.startPoint = event.target.value;
  });
  startGroup.append(startLabel, startInput);
  form.append(startGroup);

  const existingWorktrees = Array.isArray(git?.worktrees)
    ? git.worktrees.filter((worktree) => !worktree.primary)
    : [];

  if (existingWorktrees.length > 0) {
    const listWrapper = document.createElement("div");
    listWrapper.className = "wm-worktree-modal__existing";
    const listTitle = document.createElement("h3");
    listTitle.textContent = "Existing worktrees";
    listWrapper.append(listTitle);
    const list = document.createElement("ul");
    existingWorktrees.forEach((worktree) => {
      const item = document.createElement("li");
      const branch = worktree.branch ? ` (${worktree.branch})` : "";
      item.textContent = `${worktree.path}${branch}`;
      list.append(item);
    });
    listWrapper.append(list);
    form.append(listWrapper);
  }

  if (modal.error) {
    const error = document.createElement("p");
    error.className = "wm-worktree-modal__error";
    error.textContent = modal.error;
    form.append(error);
  }

  const actions = document.createElement("div");
  actions.className = "wm-worktree-modal__actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "wm-button secondary";
  cancelButton.textContent = "Cancel";
  cancelButton.disabled = modal.submitting;
  cancelButton.addEventListener("click", () => {
    if (modal.submitting) return;
    closeWorktreeModal();
  });
  actions.append(cancelButton);

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "wm-button";
  submitButton.textContent = modal.submitting ? "Creating..." : "Create Worktree";
  submitButton.disabled = modal.submitting;
  actions.append(submitButton);

  form.append(actions);
  body.append(form);

  appRoot.append(overlay);

  if (!modal.submitting) {
    requestAnimationFrame(() => {
      branchInput.focus();
      branchInput.select();
    });
  }
};

let orchestratorPrefixDirty = false;
let orchestratorDialogSubmitting = false;
const orchestratorDirectoryState = {
  target: null,
  requestId: 0,
  currentPath: null,
  parent: null,
  selection: null,
};

const getSessionById = (sessionId) => state.sessions.find((session) => session.id === sessionId);
const ACTIVE_SESSION_STATUSES = new Set(["starting", "running"]);
const isSessionActive = (session) => ACTIVE_SESSION_STATUSES.has(session?.status);
const getActiveSessions = () => state.sessions.filter((session) => isSessionActive(session));

const LIVE_ROUTE_PREFIX = "/live";
const FILES_ROUTE = "/files";
const SETTINGS_ROUTE = "/settings";
const APPS_ROUTE = "/apps";

const getRouteFromPath = (pathname) => {
  if (
    pathname === FILES_ROUTE ||
    pathname.startsWith(`${FILES_ROUTE}/`) ||
    pathname === "/docs" ||
    pathname.startsWith("/docs/")
  ) {
    return "files";
  }
  if (pathname === SETTINGS_ROUTE) {
    return "settings";
  }
  if (pathname === APPS_ROUTE) {
    return "apps";
  }
  if (pathname === LIVE_ROUTE_PREFIX || pathname.startsWith(`${LIVE_ROUTE_PREFIX}/`)) {
    return "live";
  }
  return "home";
};

const getSessionIdFromPath = (pathname) => {
  if (!pathname.startsWith(LIVE_ROUTE_PREFIX)) {
    return null;
  }
  if (pathname === LIVE_ROUTE_PREFIX) {
    return null;
  }
  const segments = pathname.slice(LIVE_ROUTE_PREFIX.length + 1).split("/").filter(Boolean);
  return segments[0] ?? null;
};

let currentRoute = getRouteFromPath(window.location.pathname);
let currentTheme = "dark";
let tabsVisible = true;
let lastLoggedSessionId = null;
let lastFilesMobileLayout = isMobileFilesLayout();

const ACE_LIGHT_THEME = "ace/theme/tomorrow_night";
const ACE_DARK_THEME = "ace/theme/tomorrow_night";

const applyAceTheme = () => {
  if (!aceEditorInstance) return;
  const targetTheme = currentTheme === "dark" ? ACE_DARK_THEME : ACE_LIGHT_THEME;
  if (aceEditorInstance.getTheme() !== targetTheme) {
    aceEditorInstance.setTheme(targetTheme);
  }
};

if (currentRoute === "files" && window.location.pathname.startsWith("/docs")) {
  const newPath = window.location.pathname.replace("/docs", "/files");
  window.history.replaceState({ route: "files" }, "", newPath);
}

const initialRouteSessionId = getSessionIdFromPath(window.location.pathname);
if (initialRouteSessionId) {
  state.activeSessionId = initialRouteSessionId;
  state.lastActiveSessionId = initialRouteSessionId;
}

const setActiveSession = (sessionId, options = {}) => {
  const { updateHistory = true, logPort = true, allowPending = false, forceLog = false } = options;
  const previousSessionId = state.activeSessionId;

  if (sessionId) {
    const sessionExists = state.sessions.some((session) => session.id === sessionId);
    if (!sessionExists && !allowPending) {
      state.activeSessionId = null;
      lastLoggedSessionId = null;
      syncDesktopSessionIndicator();
      return false;
    }

    state.activeSessionId = sessionId;
    state.lastActiveSessionId = sessionId;

    if (updateHistory && currentRoute === "live") {
      const targetPath = `${LIVE_ROUTE_PREFIX}/${sessionId}`;
      if (window.location.pathname !== targetPath) {
        window.history.pushState({ route: "live", sessionId }, "", targetPath);
      }
    }

    if (logPort && sessionExists) {
      const shouldLog = forceLog ? lastLoggedSessionId !== sessionId : sessionId !== previousSessionId;
      if (shouldLog) {
        const session = getSessionById(sessionId);
        if (session) {
          console.log("This session is sending to port:", session.port);
          lastLoggedSessionId = sessionId;
        }
      }
    }

    syncDesktopSessionIndicator();
    return true;
  }

  state.activeSessionId = null;
  lastLoggedSessionId = null;
  if (updateHistory && currentRoute === "live" && window.location.pathname !== LIVE_ROUTE_PREFIX) {
    window.history.pushState({ route: "live" }, "", LIVE_ROUTE_PREFIX);
  }
  syncDesktopSessionIndicator();
  return true;
};

const ensureActiveSession = () => {
  if (state.activeSessionId && state.sessions.some((session) => session.id === state.activeSessionId)) {
    return state.activeSessionId;
  }
  if (state.lastActiveSessionId && state.sessions.some((session) => session.id === state.lastActiveSessionId)) {
    setActiveSession(state.lastActiveSessionId, { updateHistory: false, logPort: false });
    return state.activeSessionId;
  }
  if (currentRoute === "live") {
    setActiveSession(null, { updateHistory: false, logPort: false });
    return null;
  }
  const activeSessions = getActiveSessions();
  const fallback = activeSessions[0] ?? state.sessions[0] ?? null;
  if (fallback) {
    setActiveSession(fallback.id, { updateHistory: false, logPort: false });
  } else {
    setActiveSession(null, { updateHistory: false, logPort: false });
  }
  return state.activeSessionId;
};

const applyRouteSessionFromPath = (options = {}) => {
  const { allowHistoryUpdate = false, logPort = true } = options;
  const routeSessionId = getSessionIdFromPath(window.location.pathname);

  if (routeSessionId) {
    if (state.sessions.some((session) => session.id === routeSessionId)) {
      if (state.activeSessionId !== routeSessionId) {
        setActiveSession(routeSessionId, { updateHistory: false, logPort });
      }
      return false;
    }
    if (state.activeSessionId) {
      setActiveSession(null, { updateHistory: false, logPort: false });
    }
    return true;
  }

  if (allowHistoryUpdate && state.lastActiveSessionId && state.sessions.some((session) => session.id === state.lastActiveSessionId)) {
    setActiveSession(state.lastActiveSessionId, { updateHistory: true, logPort });
    return false;
  }

  if (state.activeSessionId && !state.sessions.some((session) => session.id === state.activeSessionId)) {
    setActiveSession(null, { updateHistory: allowHistoryUpdate, logPort: false });
  }
  return false;
};
const insertTextAtCursor = (textarea, text, sessionId) => {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const next = `${before}${text}${after}`;
  textarea.value = next;
  const nextCursor = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = nextCursor;
  state.messageDrafts.set(sessionId, next);
  return next;
};

const extractImageFiles = (items) => {
  if (!items) return [];
  const files = [];
  for (const item of Array.from(items)) {
    if (!item) continue;
    if (item.kind === "file") {
      const file = item.getAsFile?.() ?? item;
      if (file instanceof File && file.type?.startsWith?.("image/")) {
        files.push(file);
      }
    } else if (item instanceof File || item instanceof Blob) {
      if (item.type?.startsWith?.("image/")) {
        files.push(item);
      }
    }
  }
  return files;
};

const extractAttachmentFiles = (items) => {
  if (!items) return [];
  const files = [];
  for (const item of Array.from(items)) {
    if (!item) continue;
    if (item.kind === "file") {
      const file = item.getAsFile?.() ?? item;
      if (file instanceof File && !file.type?.startsWith?.("image/")) {
        files.push(file);
      }
    } else if (item instanceof File || item instanceof Blob) {
      if (!item.type || !item.type.startsWith("image/")) {
        files.push(item);
      }
    }
  }
  return files;
};

const handleImageUploads = async (sessionId, files, textarea, resizeTextarea, setUploadingState) => {
  if (!files || files.length === 0) return;
  const session = getSessionById(sessionId);
  if (!session) {
    window.alert("Unable to locate session for image upload.");
    return;
  }

  for (const file of files) {
    if (!file?.type?.startsWith?.("image/")) {
      continue;
    }
    setUploadingState(true);
    try {
      const form = new FormData();
      form.append("agent", session.agent);
      form.append("image", file, file.name);

      const response = await fetch("/api/uploads/images", {
        method: "POST",
        body: form,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const message = data?.error ?? response.statusText ?? "Image upload failed";
        window.alert(message);
        continue;
      }

      const payload = await response.json().catch(() => ({}));
      const placeholder =
        typeof payload?.placeholder === "string"
          ? payload.placeholder
          : typeof payload?.publicPath === "string"
            ? payload.publicPath
            : null;

      if (!placeholder) {
        window.alert("Image upload succeeded without a usable reference.");
        continue;
      }

      const textToInsert = textarea.value.endsWith("\n") ? `${placeholder}\n` : `\n${placeholder}\n`;
      insertTextAtCursor(textarea, textToInsert, sessionId);
      resizeTextarea();
      textarea.focus();
    } catch (error) {
      console.error("Failed to upload image", error);
      window.alert("Image upload failed. Check console for details.");
    } finally {
      setUploadingState(false);
    }
  }
};

const uploadLiveAttachment = async (agentId, file) => {
  const form = new FormData();
  form.append("agent", agentId);
  form.append("file", file, file.name);

  const response = await fetch("/api/uploads/files", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "File upload failed";
    throw new Error(message);
  }

  const data = await response.json().catch(() => ({}));
  const first = Array.isArray(data?.files) ? data.files[0] : null;
  if (!first) {
    throw new Error("Upload succeeded without file details");
  }
  return first;
};

const handleAttachmentUploads = async (sessionId, files, textarea, resizeTextarea, setUploadingState) => {
  if (!files || files.length === 0) return;
  const session = getSessionById(sessionId);
  if (!session) {
    window.alert("Unable to locate session for file upload.");
    return;
  }

  for (const file of files) {
    setUploadingState(true);
    try {
      const payload = await uploadLiveAttachment(session.agent, file);
      const placeholder = typeof payload?.placeholder === "string" ? payload.placeholder : null;
      const fallback =
        typeof payload?.publicPath === "string"
          ? payload.publicPath
          : typeof payload?.absolutePath === "string"
            ? payload.absolutePath
            : "";
      const reference = placeholder || fallback;
      if (!reference) {
        window.alert("File upload succeeded without a usable reference.");
        continue;
      }
      const needsPrefix = textarea.value.length > 0 && !textarea.value.endsWith("\n");
      const textToInsert = needsPrefix ? `\n${reference}\n` : `${reference}\n`;
      insertTextAtCursor(textarea, textToInsert, sessionId);
      resizeTextarea();
      textarea.focus();
    } catch (error) {
      console.error("Failed to upload file", error);
      const message = error instanceof Error ? error.message : "File upload failed. Check console for details.";
      window.alert(message);
    } finally {
      setUploadingState(false);
    }
  }
};

const dialog = document.getElementById("session-dialog");
const agentSelect = document.getElementById("agent-select");
const confirmButton = document.getElementById("confirm-session");
const cancelButton = document.getElementById("cancel-session");
const sessionForm = dialog?.querySelector("form");
const appRoot = document.getElementById("app");
const navLinks = Array.from(document.querySelectorAll("nav a[data-route]"));
const themeToggle = document.getElementById("theme-toggle");
const tabsToggle = document.getElementById("tabs-toggle");
const menuToggle = document.getElementById("menu-toggle");
const menuPanel = document.querySelector(".wm-menu-panel");
const menuTabsContainer = document.getElementById("menu-tabs");
const pullRefreshIndicator = document.getElementById("pull-refresh");
const pullRefreshLabel = pullRefreshIndicator?.querySelector(".label");
const desktopSessionIndicator = document.getElementById("desktop-session-indicator");
const desktopSessionIndicatorButton = document.getElementById("desktop-session-indicator-button");
const identityLoginDialog = document.getElementById("identity-login-dialog");
const identityLoginDialogContent = identityLoginDialog?.querySelector(".wm-identity-dialog__content");
const identityLoginDialogCloseButton = identityLoginDialog?.querySelector('[data-action="identity-dialog-close"]');
const desktopSessionIndicatorName =
  desktopSessionIndicator?.querySelector('[data-part="name"]') ?? null;
const desktopSessionIndicatorDirectory =
  desktopSessionIndicator?.querySelector('[data-part="directory"]') ?? null;
const sessionNameInput = document.getElementById("session-name");
const directoryInput = document.getElementById("working-directory");
const directorySuggestions = document.getElementById("directory-suggestions");
const browseDirectoryButton = document.getElementById("browse-directory");
const directoryDialog = document.getElementById("directory-dialog");
const directoryTitle = document.getElementById("directory-title");
const directoryList = document.getElementById("directory-list");
const directoryCurrent = document.getElementById("directory-current");
const directoryUpButton = document.getElementById("directory-up");
const directoryNewFolderButton = document.getElementById("directory-new-folder");
const directoryUseButton = document.getElementById("directory-use");
const fileTransferDialog = document.getElementById("file-transfer-dialog");
const fileTransferTitle = document.getElementById("file-transfer-title");
const fileTransferSource = document.getElementById("file-transfer-source");
const fileTransferCurrent = document.getElementById("file-transfer-current");
const fileTransferList = document.getElementById("file-transfer-list");
const fileTransferSelected = document.getElementById("file-transfer-selected");
const fileTransferUpButton = document.getElementById("file-transfer-up");
const fileTransferNewFolderButton = document.getElementById("file-transfer-new-folder");
const fileTransferCancelButton = document.getElementById("file-transfer-cancel");
const fileTransferConfirmButton = document.getElementById("file-transfer-confirm");
const orchestratorDialog = document.getElementById("orchestrator-dialog");
const orchestratorForm = orchestratorDialog?.querySelector("form");
const orchestratorLabelInput = document.getElementById("orchestrator-label");
const orchestratorAgentSelect = document.getElementById("orchestrator-agent");
const orchestratorTemplateInput = document.getElementById("orchestrator-template");
const orchestratorActiveRootInput = document.getElementById("orchestrator-active-root");
const orchestratorTemplateBrowseButton = document.getElementById("orchestrator-template-browse");
const orchestratorActiveRootBrowseButton = document.getElementById("orchestrator-active-root-browse");
const orchestratorDirectoryPrefixInput = document.getElementById("orchestrator-directory-prefix");
const orchestratorWorkingDirectoryInput = document.getElementById("orchestrator-working-directory");
const orchestratorIntroTextarea = document.getElementById("orchestrator-intro");
const orchestratorPollTimeoutInput = document.getElementById("orchestrator-timeout");
const orchestratorPollIntervalInput = document.getElementById("orchestrator-interval");
const orchestratorRetryAttemptsInput = document.getElementById("orchestrator-retries");
const orchestratorRetryDelayInput = document.getElementById("orchestrator-retry-delay");
const orchestratorCancelButton = document.getElementById("orchestrator-cancel");
const orchestratorSaveButton = document.getElementById("orchestrator-save");
const orchestratorDirectoryDialog = document.getElementById("orchestrator-directory-dialog");
const orchestratorDirectoryList = document.getElementById("orchestrator-directory-list");
const orchestratorDirectoryCurrent = document.getElementById("orchestrator-directory-current");
const orchestratorDirectoryUpButton = document.getElementById("orchestrator-directory-up");
const orchestratorDirectoryUseButton = document.getElementById("orchestrator-directory-use");

const appDialog = document.getElementById("app-dialog");
const appForm = appDialog?.querySelector("form") ?? null;
const appDialogTitle = document.getElementById("app-dialog-title");
const appLabelInput = document.getElementById("app-label");
const appRootInput = document.getElementById("app-root");
const appRootBrowseButton = document.getElementById("app-root-browse");
const appTmuxInput = document.getElementById("app-tmux-session");
const appTmuxWindowInput = document.getElementById("app-tmux-window");
const appNotesInput = document.getElementById("app-notes");
const appDiscoverToggle = document.getElementById("app-discover-enabled");
const appDiscoverButton = document.getElementById("app-discover");
const appScriptInputs = {
  start: document.getElementById("app-script-start"),
  stop: document.getElementById("app-script-stop"),
  restart: document.getElementById("app-script-restart"),
  build: document.getElementById("app-script-build"),
};
const appCancelButton = document.getElementById("app-cancel");
const appSaveButton = document.getElementById("app-save");
const appLogsDialog = document.getElementById("app-logs-dialog");
const appLogsTitle = document.getElementById("app-logs-title");
const appLogsContent = document.getElementById("app-logs-content");
const appLogsRefreshButton = document.getElementById("app-logs-refresh");
const appLogsCloseButton = document.getElementById("app-logs-close");
const SHARED_TMUX_SESSION = "wingman-apps";

let identityLoginPanelRoot = null;

const ensureIdentityLoginPanel = () => {
  if (!identityLoginDialogContent) return null;
  if (!identityLoginPanelRoot) {
    identityLoginPanelRoot = renderIdentityPanel({ variant: "dialog" });
    identityLoginDialogContent.append(identityLoginPanelRoot);
  }
  return identityLoginPanelRoot;
};

function openIdentityLoginDialog() {
  const panel = ensureIdentityLoginPanel();
  if (!identityLoginDialog || !panel) {
    navigateToSettings();
    return;
  }
  if (typeof identityLoginDialog.showModal === "function") {
    identityLoginDialog.showModal();
  } else {
    navigateToSettings();
  }
}

function closeIdentityLoginDialog() {
  if (identityLoginDialog?.open) {
    identityLoginDialog.close();
  }
}

identityLoginDialogCloseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  closeIdentityLoginDialog();
});

identityLoginDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeIdentityLoginDialog();
});

const applyTheme = (theme, persist = true) => {
  currentTheme = theme;
  document.body.dataset.theme = theme;
  themeToggle?.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  applyAceTheme();
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (error) {
      console.warn("Failed to persist theme preference", error);
    }
  }
};

const getActiveSessionForIndicator = () => {
  if (!state.activeSessionId) return null;
  return state.sessions.find((session) => session.id === state.activeSessionId) ?? null;
};

const shouldShowDesktopIndicator = () => currentRoute === "live" && window.innerWidth >= 900;

const syncDesktopSessionIndicator = () => {
  if (!desktopSessionIndicator) return;
  const session = getActiveSessionForIndicator();
  const canShow = Boolean(session) && shouldShowDesktopIndicator();
  if (!canShow) {
    desktopSessionIndicator.hidden = true;
    return;
  }

  const displayName = getSessionDisplayName(session);
  if (desktopSessionIndicatorName) {
    desktopSessionIndicatorName.textContent = displayName;
    desktopSessionIndicatorName.title = displayName;
  }

  const directoryValue =
    typeof session.workingDirectory === "string" && session.workingDirectory.trim().length > 0
      ? session.workingDirectory
      : state.config?.defaultDirectory ?? "";

  if (desktopSessionIndicatorDirectory) {
    if (directoryValue) {
      desktopSessionIndicatorDirectory.textContent = truncateText(directoryValue, 31);
      desktopSessionIndicatorDirectory.title = directoryValue;
    } else {
      desktopSessionIndicatorDirectory.textContent = "—";
      desktopSessionIndicatorDirectory.title = "";
    }
  }

  desktopSessionIndicator.hidden = false;
};

const detectPreferredTheme = () => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // ignore storage failures
  }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
};

const toggleTheme = () => {
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
};

const applyTabsVisibility = (visible, persist = true) => {
  tabsVisible = visible;
  document.body.dataset.tabsVisible = visible ? "true" : "false";
  tabsToggle?.setAttribute("aria-pressed", visible ? "false" : "true");
  if (persist) {
    try {
      localStorage.setItem(TABS_VISIBILITY_STORAGE_KEY, visible ? "true" : "false");
    } catch (error) {
      console.warn("Failed to persist tabs visibility preference", error);
    }
  }
};

const detectPreferredTabsVisibility = () => {
  try {
    const stored = localStorage.getItem(TABS_VISIBILITY_STORAGE_KEY);
    if (stored === "true" || stored === "false") {
      return stored === "true";
    }
  } catch {
    // ignore storage failures
  }
  return true; // default to visible
};

const toggleTabsVisibility = () => {
  const nextVisible = !tabsVisible;
  applyTabsVisibility(nextVisible);
};

const closeMenu = () => {
  if (document.body.dataset.menuOpen === "true") {
    delete document.body.dataset.menuOpen;
    menuToggle?.setAttribute("aria-expanded", "false");
    menuPanel?.setAttribute("aria-hidden", "true");
    resetPullRefresh();
  }
};

const toggleMenu = () => {
  const isOpen = document.body.dataset.menuOpen === "true";
  if (isOpen) {
    closeMenu();
  } else {
    document.body.dataset.menuOpen = "true";
    menuToggle?.setAttribute("aria-expanded", "true");
    menuPanel?.setAttribute("aria-hidden", "false");
    resetPullRefresh();
  }
};

const initTheme = () => {
  const preferred = detectPreferredTheme();
  applyTheme(preferred, false);
  if (themeToggle) {
    themeToggle.addEventListener("click", toggleTheme);
  }
  if (window.matchMedia) {
    const listener = (event) => {
      const stored = (() => {
        try {
          return localStorage.getItem(THEME_STORAGE_KEY);
        } catch {
          return null;
        }
      })();
      if (stored !== "light" && stored !== "dark") {
        applyTheme(event.matches ? "dark" : "light", false);
      }
    };
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", listener);
  }
};

const initTabsVisibility = () => {
  const preferred = detectPreferredTabsVisibility();
  applyTabsVisibility(preferred, false);
  if (tabsToggle) {
    tabsToggle.addEventListener("click", toggleTabsVisibility);
  }
};

const setActiveNav = () => {
  navLinks.forEach((link) => {
    const route = link.dataset.route;
    if (route === currentRoute) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });
};

const syncMenuTabs = () => {
  if (!menuTabsContainer) return;
  menuTabsContainer.innerHTML = "";
  menuTabsContainer.dataset.state = "ready";

  const heading = document.createElement("p");
  heading.className = "wm-menu-heading";
  heading.textContent = "Agents";
  menuTabsContainer.append(heading);

  const sessionsContainer = document.createElement("div");
  sessionsContainer.className = "wm-menu-sessions-container";

  const activeSessions = getActiveSessions();
  if (activeSessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-menu-empty";
    empty.textContent = "No live sessions yet.";
    sessionsContainer.append(empty);
  } else {
    const sessionsList = document.createElement("div");
    sessionsList.className = "wm-menu-sessions-list";
    const sessionTabs = renderSessionTabs({ onSelect: closeMenu });
    sessionsList.append(sessionTabs);
    sessionsContainer.append(sessionsList);
  }

  const addButton = document.createElement("div");
  addButton.className = "wm-tab new wm-menu-add-session";
  addButton.textContent = "+";
  addButton.title = "Start new session";
  addButton.addEventListener("click", () => {
    openDialog();
    closeMenu();
  });
  sessionsContainer.append(addButton);

  menuTabsContainer.append(sessionsContainer);
};

const PULL_THRESHOLD = 90;
const PULL_MAX = 150;
const PULL_BASE_OFFSET = -120;
let pullStartY = null;
let pullActive = false;
let pullReady = false;
let pullRefreshing = false;

const setPullState = (state, distance = 0) => {
  if (!pullRefreshIndicator) return;
  const clamped = Math.max(0, Math.min(distance, PULL_MAX));
  const translate = state === "hidden"
    ? PULL_BASE_OFFSET
    : Math.min(90, -80 + clamped * 1.1);
  pullRefreshIndicator.dataset.state = state;
  pullRefreshIndicator.style.transform = `translate(-50%, ${translate}px)`;
  if (pullRefreshLabel) {
    if (state === "release") {
      pullRefreshLabel.textContent = "Release to refresh";
    } else if (state === "refresh") {
      pullRefreshLabel.textContent = "Refreshing…";
    } else {
      pullRefreshLabel.textContent = "Pull to refresh";
    }
  }
};

const resetPullRefresh = () => {
  pullStartY = null;
  pullActive = false;
  pullReady = false;
  if (pullRefreshing) return;
  setPullState("hidden", 0);
};

const triggerPullRefresh = () => {
  if (!pullRefreshIndicator || pullRefreshing) return;
  pullRefreshing = true;
  setPullState("refresh", PULL_THRESHOLD);

  const MIN_REFRESH_DURATION = 400;
  pullReady = false;
  pullActive = false;

  setTimeout(() => {
    window.location.reload();
  }, MIN_REFRESH_DURATION);
};

const DIRECTORY_SUGGESTION_DELAY = 160;
const DIRECTORY_BROWSER_ROOT = "__root__";
const DIRECTORY_BROWSER_ROOT_LABEL = "Allowed Directories";
let directorySuggestionTimer = null;
let directorySuggestionRequestId = 0;

const directoryBrowserState = {
  currentPath: "",
  parent: null,
  requestId: 0,
  onSelect: null,
  allowCreate: true,
  confirmLabel: "Use This Directory",
  title: "Select Directory",
  pendingResolve: null,
};

const parseDirectoryLookup = (rawValue) => {
  const defaultPath = state.config?.defaultDirectory ?? "";
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) {
    return { basePath: defaultPath, term: "" };
  }

  const hasTrailingSeparator = /[\\/]$/.test(value);
  if (hasTrailingSeparator) {
    return { basePath: value, term: "" };
  }

  const lastForward = value.lastIndexOf("/");
  const lastBackward = value.lastIndexOf("\\");
  const separatorIndex = Math.max(lastForward, lastBackward);

  if (separatorIndex === -1) {
    return { basePath: defaultPath, term: value };
  }

  return {
    basePath: value.slice(0, separatorIndex + 1),
    term: value.slice(separatorIndex + 1),
  };
};

const requestDirectoryData = async (path, query) => {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (query) params.set("query", query);
  const search = params.toString();
  const url = search ? `/api/directories?${search}` : "/api/directories";
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error("Failed to request directory data", error);
    return null;
  }
};

const fetchDocsDirectoryListing = async (path) => {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (state.files.showHidden) {
    params.set("showHidden", "1");
  }
  const response = await fetch(`/api/docs/tree?${params.toString()}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to load directory";
    throw new Error(message);
  }
  const payload = await response.json();
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  return {
    path: payload?.path ?? path ?? "",
    displayPath: payload?.displayPath ?? payload?.path ?? "",
    parent: payload?.parent ?? null,
    directories: entries.filter((entry) => entry?.type === "directory"),
  };
};

const populateDirectorySuggestions = (data) => {
  if (!directorySuggestions) return;
  directorySuggestions.innerHTML = "";
  if (!data) return;

  const seen = new Set();
  const addOption = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    const option = document.createElement("option");
    option.value = value;
    directorySuggestions.append(option);
  };

  addOption(data.path);
  data.entries.forEach((entry) => addOption(entry.path));
};

const fetchDirectorySuggestions = async (value) => {
  if (!state.config) return;
  const requestId = ++directorySuggestionRequestId;
  const { basePath, term } = parseDirectoryLookup(value);
  let data = await requestDirectoryData(basePath, term);
  if (!data && basePath !== state.config.defaultDirectory) {
    data = await requestDirectoryData(state.config.defaultDirectory, term);
  }
  if (directorySuggestionRequestId !== requestId) return;
  populateDirectorySuggestions(data);
};

const scheduleDirectorySuggestions = (value) => {
  if (!directorySuggestions) return;
  if (directorySuggestionTimer) {
    clearTimeout(directorySuggestionTimer);
  }
  directorySuggestionTimer = setTimeout(() => {
    fetchDirectorySuggestions(value);
  }, DIRECTORY_SUGGESTION_DELAY);
};

const chooseDirectory = (path) => {
  if (typeof path !== "string" || path.length === 0) return;
  const selected = path;
  const onSelect = directoryBrowserState.onSelect;
  if (typeof onSelect === "function") {
    onSelect(selected);
  } else if (directoryInput) {
    directoryInput.value = selected;
    state.lastWorkingDirectory = selected;
    scheduleDirectorySuggestions(selected);
  }
  directoryBrowserState.onSelect = null;
  if (directoryBrowserState.pendingResolve) {
    const resolve = directoryBrowserState.pendingResolve;
    directoryBrowserState.pendingResolve = null;
    resolve(selected);
  }
  if (directoryDialog?.open) {
    directoryDialog.close();
  }
};

const renderDirectoryBrowser = (data) => {
  if (!data) return;
  const isRootView = !data.path || data.path === DIRECTORY_BROWSER_ROOT;
  if (directoryCurrent) {
    const label = isRootView ? DIRECTORY_BROWSER_ROOT_LABEL : data.path;
    directoryCurrent.textContent = label;
  }
  if (directoryUpButton) {
    directoryUpButton.disabled = !data.parent;
  }
  if (directoryUseButton) {
    directoryUseButton.disabled = !(data.path && data.path.length > 0);
  }
  if (directoryNewFolderButton) {
    if (directoryBrowserState.allowCreate) {
      directoryNewFolderButton.hidden = false;
      directoryNewFolderButton.disabled = !data.path;
    } else {
      directoryNewFolderButton.hidden = true;
      directoryNewFolderButton.disabled = true;
    }
  }
  if (!directoryList) return;
  directoryList.innerHTML = "";
  if (!Array.isArray(data.entries) || data.entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "directory-browser__empty";
    empty.textContent = "No subdirectories";
    directoryList.append(empty);
    return;
  }
  data.entries.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "directory-browser__item";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "directory-browser__folder";
    openButton.textContent = entry.name;
    openButton.addEventListener("click", () => {
      updateDirectoryBrowser(entry.path);
    });

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "directory-browser__choose wm-button secondary";
    selectButton.textContent = "Select";
    selectButton.addEventListener("click", () => {
      chooseDirectory(entry.path);
    });

    item.append(openButton, selectButton);
    directoryList.append(item);
  });
};

const updateDirectoryBrowser = async (path) => {
  if (!state.config) return false;
  const requestId = ++directoryBrowserState.requestId;
  let data = await requestDirectoryData(path, undefined);
  if (!data && path && path !== state.config.defaultDirectory) {
    data = await requestDirectoryData(state.config.defaultDirectory, undefined);
  }
  if (directoryBrowserState.requestId !== requestId || !data) {
    return false;
  }
  directoryBrowserState.currentPath = typeof data.path === "string" ? data.path : "";
  directoryBrowserState.parent = data.parent;
  renderDirectoryBrowser(data);
  return true;
};

const openDirectoryBrowser = async (options = {}) => {
  if (!state.config) {
    try {
      await fetchConfig();
    } catch {
      // ignore config fetch failures; fallback prompt handles it
    }
  }

  const {
    initialPath,
    onSelect,
    allowCreate = true,
    confirmLabel = "Use This Directory",
    title = "Select Directory",
  } = options;

  const seedCandidate =
    (typeof initialPath === "string" && initialPath.trim().length > 0 ? initialPath.trim() : null) ??
    directoryInput?.value?.trim() ??
    state.lastWorkingDirectory ??
    state.config?.defaultDirectory ??
    "";

  directoryBrowserState.onSelect = typeof onSelect === "function" ? onSelect : null;
  directoryBrowserState.allowCreate = allowCreate;
  directoryBrowserState.confirmLabel = confirmLabel;
  directoryBrowserState.title = title;

  if (!directoryDialog || typeof directoryDialog.showModal !== "function") {
    const fallback = window.prompt("Enter directory", seedCandidate);
    if (fallback) {
      chooseDirectory(fallback);
    }
    return null;
  }

  if (directoryTitle) {
    directoryTitle.textContent = title;
  }
  if (directoryUseButton) {
    directoryUseButton.textContent = confirmLabel;
  }
  if (directoryNewFolderButton) {
    directoryNewFolderButton.hidden = !allowCreate;
    directoryNewFolderButton.disabled = !allowCreate;
  }

  if (directoryBrowserState.pendingResolve) {
    directoryBrowserState.pendingResolve(null);
    directoryBrowserState.pendingResolve = null;
  }

  const loaded = await updateDirectoryBrowser(seedCandidate);
  if (!loaded) {
    window.alert("Unable to open directory browser for the requested path.");
    directoryBrowserState.onSelect = null;
    return null;
  }

  directoryDialog.showModal();
  return new Promise((resolve) => {
    directoryBrowserState.pendingResolve = resolve;
  });
};

const promptCreateDirectoryAtPath = async (parentPath, { onSuccess } = {}) => {
  const basePath = typeof parentPath === "string" && parentPath.length > 0 ? parentPath : null;
  if (!basePath) {
    window.alert("Select a parent directory first.");
    return false;
  }
  const rawName = window.prompt("Folder name", "New Folder");
  if (!rawName) {
    return false;
  }
  const trimmed = rawName.trim();
  if (trimmed.length === 0) {
    window.alert("Folder name cannot be empty.");
    return false;
  }
  try {
    const result = await createDirectoryEntry(basePath, trimmed);
    if (typeof onSuccess === "function") {
      await Promise.resolve(onSuccess(result));
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create folder";
    window.alert(message);
    return false;
  }
};

const getParentDirectoryPath = (filePath) => {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return null;
  }
  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return null;
  }
  const prefix = normalized.slice(0, index);
  if (filePath.includes("\\")) {
    const backslashIndex = filePath.lastIndexOf("\\");
    if (backslashIndex > index) {
      return filePath.slice(0, backslashIndex);
    }
    return filePath.slice(0, index);
  }
  return filePath.slice(0, index);
};

const resetFileTransferState = () => {
  const transfer = state.files.transfer;
  transfer.mode = null;
  transfer.sourcePath = null;
  transfer.sourceName = null;
  transfer.sourceDisplayPath = null;
  transfer.destinationPath = null;
  transfer.destinationDisplayPath = null;
  transfer.submitting = false;
  transfer.error = null;
  transfer.browser.currentPath = "";
  transfer.browser.parent = null;
  transfer.browser.selection = null;
  transfer.browser.requestId = 0;
  if (fileTransferList) {
    fileTransferList.innerHTML = "";
  }
  if (fileTransferSelected) {
    fileTransferSelected.textContent = "";
  }
  if (fileTransferNewFolderButton) {
    fileTransferNewFolderButton.disabled = true;
  }
};

const syncFileTransferConfirmState = () => {
  if (!fileTransferConfirmButton) return;
  const transfer = state.files.transfer;
  const mode = transfer.mode;
  if (!mode) {
    fileTransferConfirmButton.disabled = true;
    delete fileTransferConfirmButton.dataset.loading;
    fileTransferConfirmButton.textContent = "Confirm";
    return;
  }
  const disabled = transfer.submitting || !transfer.destinationPath;
  fileTransferConfirmButton.disabled = disabled;
  if (transfer.submitting) {
    fileTransferConfirmButton.dataset.loading = "true";
  } else {
    delete fileTransferConfirmButton.dataset.loading;
  }
  if (transfer.submitting) {
    fileTransferConfirmButton.textContent = mode === "move" ? "Moving…" : "Copying…";
  } else {
    fileTransferConfirmButton.textContent = mode === "move" ? "Move Here" : "Copy Here";
  }
};

const setFileTransferSelection = (path, displayPath) => {
  const transfer = state.files.transfer;
  transfer.destinationPath = typeof path === "string" && path.length > 0 ? path : null;
  transfer.browser.selection = transfer.destinationPath;
  transfer.destinationDisplayPath =
    transfer.destinationPath && typeof displayPath === "string" && displayPath.length > 0
      ? displayPath
      : transfer.destinationPath;
  if (fileTransferSelected) {
    if (transfer.destinationDisplayPath) {
      fileTransferSelected.textContent = `Destination: ${transfer.destinationDisplayPath}`;
    } else {
      fileTransferSelected.textContent = "";
    }
  }
  if (fileTransferList) {
    fileTransferList.querySelectorAll(".directory-browser__item").forEach((item) => {
      if (!(item instanceof HTMLElement)) return;
      const itemPath = item.dataset.path;
      if (itemPath && transfer.destinationPath && itemPath === transfer.destinationPath) {
        item.dataset.selected = "true";
      } else {
        delete item.dataset.selected;
      }
    });
  }
  syncFileTransferConfirmState();
};

const renderFileTransferBrowser = (data) => {
  if (!data) return;
  const transfer = state.files.transfer;
  transfer.browser.currentPath = data.path ?? "";
  transfer.browser.parent = typeof data.parent?.path === "string" ? data.parent.path : null;

  if (fileTransferCurrent) {
    fileTransferCurrent.textContent = data.displayPath ?? data.path ?? "";
  }
  if (fileTransferUpButton) {
    fileTransferUpButton.disabled = !transfer.browser.parent;
  }
  if (fileTransferNewFolderButton) {
    fileTransferNewFolderButton.disabled = !(data.path && data.path.length > 0);
  }
  if (!fileTransferList) return;
  fileTransferList.innerHTML = "";

  const directories = Array.isArray(data.directories) ? data.directories : [];
  if (directories.length === 0) {
    const empty = document.createElement("li");
    empty.className = "directory-browser__empty";
    empty.textContent = "No subdirectories";
    fileTransferList.append(empty);
  } else {
    directories.forEach((entry) => {
      const item = document.createElement("li");
      item.className = "directory-browser__item";
      item.dataset.path = entry.path;
      item.dataset.displayPath = entry.displayPath ?? entry.path ?? "";

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "directory-browser__folder";
      openButton.textContent = entry.name;
      openButton.addEventListener("click", () => {
        void updateFileTransferBrowser(entry.path);
      });

      const chooseButton = document.createElement("button");
      chooseButton.type = "button";
      chooseButton.className = "wm-button secondary directory-browser__choose";
      chooseButton.textContent = "Select";
      chooseButton.addEventListener("click", () => {
        setFileTransferSelection(entry.path, entry.displayPath ?? entry.path ?? "");
      });

      item.append(openButton, chooseButton);
      fileTransferList.append(item);
    });
  }

  if (!transfer.destinationPath || transfer.destinationPath === transfer.browser.currentPath) {
    setFileTransferSelection(data.path ?? transfer.browser.currentPath, data.displayPath ?? data.path ?? "");
  } else {
    setFileTransferSelection(transfer.destinationPath, transfer.destinationDisplayPath);
  }
};

const updateFileTransferBrowser = async (path) => {
  const transfer = state.files.transfer;
  const requestId = ++transfer.browser.requestId;
  try {
    const data = await fetchDocsDirectoryListing(path);
    if (transfer.browser.requestId !== requestId) {
      return false;
    }
    renderFileTransferBrowser(data);
    return true;
  } catch (error) {
    if (transfer.browser.requestId === requestId) {
      const message = error instanceof Error ? error.message : "Failed to load directories";
      window.alert(message);
    }
    return false;
  }
};

const closeFileTransferDialog = () => {
  if (fileTransferDialog?.open) {
    fileTransferDialog.close();
  }
  resetFileTransferState();
  syncFileTransferConfirmState();
};

const openFileTransferDialogForMode = async (mode) => {
  if (!fileTransferDialog) return;
  if (mode !== "copy" && mode !== "move") return;
  const files = state.files;
  const sourcePath = typeof files.previewPath === "string" ? files.previewPath : null;
  if (!sourcePath || files.previewLoading) {
    return;
  }

  const transfer = state.files.transfer;
  transfer.mode = mode;
  transfer.sourcePath = sourcePath;
  transfer.sourceName =
    files.previewName ??
    (typeof sourcePath === "string" ? sourcePath.split(/[\\/]/).pop() ?? sourcePath : sourcePath);
  transfer.sourceDisplayPath =
    files.previewDisplayPath ?? files.previewName ?? transfer.sourceName ?? sourcePath;
  transfer.submitting = false;
  transfer.error = null;
  transfer.destinationPath = files.currentPath ?? getParentDirectoryPath(sourcePath);
  transfer.destinationDisplayPath = files.displayPath ?? transfer.destinationPath;

  if (fileTransferTitle) {
    fileTransferTitle.textContent = mode === "move" ? "Move File To…" : "Copy File To…";
  }
  if (fileTransferSource) {
    fileTransferSource.textContent = transfer.sourceDisplayPath ?? transfer.sourcePath ?? "";
  }
  if (fileTransferList) {
    fileTransferList.innerHTML = "";
    const loading = document.createElement("li");
    loading.className = "directory-browser__status";
    loading.textContent = "Loading directories…";
    fileTransferList.append(loading);
  }
  syncFileTransferConfirmState();
  if (!fileTransferDialog.open) {
    fileTransferDialog.showModal();
  }
  const initialPath =
    transfer.destinationPath ??
    files.currentPath ??
    getParentDirectoryPath(sourcePath) ??
    sourcePath;
  await updateFileTransferBrowser(initialPath);
};

const submitFileTransfer = async () => {
  const transfer = state.files.transfer;
  if (!transfer.mode || transfer.submitting) return;
  if (!transfer.sourcePath || !transfer.destinationPath) {
    window.alert("Select a destination directory first.");
    return;
  }
  const sourcePath = transfer.sourcePath;
  const mode = transfer.mode;
  transfer.submitting = true;
  syncFileTransferConfirmState();
  const action = transfer.mode === "move" ? moveFilesEntry : copyFilesEntry;
  try {
    await action(transfer.sourcePath, transfer.destinationPath);
    const refreshPath = state.files.currentPath;
    const moved = mode === "move";
    closeFileTransferDialog();
    if (moved && state.files.previewPath === sourcePath) {
      resetFilesPreview();
    }
    await loadFilesTree(refreshPath);
  } catch (error) {
    transfer.submitting = false;
    syncFileTransferConfirmState();
    const message = error instanceof Error ? error.message : "File operation failed";
    window.alert(message);
  }
};

const fetchConfig = async () => {
  const response = await fetch("/api/config");
  state.config = await response.json();
  agentSelect.innerHTML = "";
  state.config.agents.forEach((agent) => {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = agent.label;
    agentSelect.append(option);
  });
  if (orchestratorAgentSelect) {
    orchestratorAgentSelect.innerHTML = "";
    state.config.agents.forEach((agent) => {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.label;
      orchestratorAgentSelect.append(option);
    });
  }
  if (directoryInput) {
    const initial =
      state.lastWorkingDirectory ??
      state.config.defaultDirectory ??
      "";
    directoryInput.value = initial;
    directoryInput.placeholder = state.config.defaultDirectory ?? "";
    scheduleDirectorySuggestions(initial);
  }
};

const fetchSessions = async () => {
  const activeFilter = state.sessionFilters.npub;
  const query = activeFilter && activeFilter !== "all" ? `?npub=${encodeURIComponent(activeFilter)}` : "";
  const response = await fetch(`/api/sessions${query}`);
  const data = await response.json();
  state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  state.identitySummaries = Array.isArray(data.identities) ? data.identities : [];
  const filterPayload = data.filters && typeof data.filters === "object" ? data.filters : null;
  const npubOptions = filterPayload && Array.isArray(filterPayload.npubs) ? filterPayload.npubs : [];
  state.sessionFilters.options = npubOptions;
  const optionValues = new Set([
    "all",
    ...npubOptions
      .filter((option) => option && typeof option === "object" && typeof option.value === "string")
      .map((option) => option.value),
  ]);
  if (filterPayload && typeof filterPayload.active === "string") {
    state.sessionFilters.npub = filterPayload.active;
  } else if (filterPayload && filterPayload.active === null) {
    state.sessionFilters.npub = "all";
  } else if (!optionValues.has(state.sessionFilters.npub)) {
    state.sessionFilters.npub = "all";
  }

  const sessionIds = new Set(state.sessions.map((session) => session.id));
  if (state.lastActiveSessionId && !sessionIds.has(state.lastActiveSessionId)) {
    state.lastActiveSessionId = null;
  }

  // Clean up data and DOM references for deleted sessions
  for (const key of Array.from(state.logs.keys())) {
    if (!sessionIds.has(key)) state.logs.delete(key);
  }
  for (const key of Array.from(state.conversations.keys())) {
    if (!sessionIds.has(key)) state.conversations.delete(key);
  }
  for (const key of Array.from(state.messageDrafts.keys())) {
    if (!sessionIds.has(key)) state.messageDrafts.delete(key);
  }
  for (const key of Array.from(state.conversationContainers.keys())) {
    if (!sessionIds.has(key)) state.conversationContainers.delete(key);
  }
  for (const key of Array.from(state.logContainers.keys())) {
    if (!sessionIds.has(key)) state.logContainers.delete(key);
  }
  for (const key of Array.from(state.lastMessageCount.keys())) {
    if (!sessionIds.has(key)) state.lastMessageCount.delete(key);
  }
  for (const key of Array.from(state.lastLogLength.keys())) {
    if (!sessionIds.has(key)) state.lastLogLength.delete(key);
  }
  const routeSessionId = getSessionIdFromPath(window.location.pathname);
  const allowHistoryUpdate = currentRoute === "live" && !routeSessionId;
  const redirectHome = applyRouteSessionFromPath({ allowHistoryUpdate });
  if (redirectHome) {
    currentRoute = "home";
    lastLoggedSessionId = null;
    if (window.location.pathname !== "/home") {
      window.history.replaceState({ route: "home" }, "", "/home");
    }
  }
  ensureActiveSession();
  if (
    !redirectHome &&
    currentRoute === "live" &&
    state.activeSessionId &&
    state.sessions.some((session) => session.id === state.activeSessionId)
  ) {
    setActiveSession(state.activeSessionId, { updateHistory: false, forceLog: true });
  }

  syncDesktopSessionIndicator();

  if (!redirectHome && currentRoute === "live" && state.activeSessionId) {
    await Promise.all([
      fetchLogs(state.activeSessionId),
      fetchConversation(state.activeSessionId),
    ]);
  }
};

const buildSessionFilterOptions = () => {
  const seen = new Set();
  const options = [];
  const appendOption = (value, label, meta = {}) => {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label, ...meta });
  };

  appendOption("all", "All identities");

  state.sessionFilters.options.forEach((option) => {
    if (!option || typeof option !== "object") return;
    const value = typeof option.value === "string" ? option.value : "__anonymous__";
    const npub = typeof option.npub === "string" ? option.npub : null;
    const baseLabel = typeof option.label === "string" && option.label.trim().length > 0 ? option.label.trim() : npub ?? "Anonymous";
    const sessionCount = typeof option.sessionCount === "number" ? option.sessionCount : 0;
    const activeCount = typeof option.activeCount === "number" ? option.activeCount : 0;
    const detail = activeCount > 0 ? `${sessionCount} sessions (${activeCount} active)` : `${sessionCount} sessions`;
    appendOption(value, `${baseLabel} • ${detail}`, { npub, sessionCount, activeCount });
  });

  return options;
};

const fetchLogs = async (sessionId) => {
  const response = await fetch(`/api/sessions/${sessionId}/logs`);
  if (!response.ok) return;
  const data = await response.json();
  state.logs.set(sessionId, data.logs);

  // Trigger incremental DOM update if on live route
  if (currentRoute === "live" && sessionId === state.activeSessionId) {
    updateLogsDOM(sessionId);
  }
};

const fetchConversation = async (sessionId) => {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages?refresh=true`);
    if (!response.ok) return;
    const data = await response.json();
    const items = Array.isArray(data?.messages) ? data.messages : [];
    state.conversations.set(sessionId, items);

    // Trigger incremental DOM update if on live route
    if (currentRoute === "live" && sessionId === state.activeSessionId) {
      updateConversationDOM(sessionId);
    }
  } catch (error) {
    console.error("Failed to load conversation", error);
  }
};

const fetchApps = async ({ tail = APP_LOG_PREVIEW_LINES } = {}) => {
  state.apps.loading = true;
  try {
    const response = await fetch(`/api/apps?tail=${encodeURIComponent(String(tail))}`);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const errorMessage =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to load apps";
      throw new Error(errorMessage);
    }
    const items = Array.isArray(payload?.apps) ? payload.apps : [];
    state.apps.items = items.map((item) => {
      const logs = Array.isArray(item?.logs) ? item.logs : [];
      const availableScripts =
        item && typeof item === "object" && item.availableScripts && typeof item.availableScripts === "object"
          ? item.availableScripts
          : {
              start: Boolean(item?.scripts?.start),
              stop: Boolean(item?.scripts?.stop),
              restart: Boolean(item?.scripts?.restart),
              build: Boolean(item?.scripts?.build),
            };
      return {
        ...item,
        logs,
        availableScripts,
      };
    });
    state.apps.error = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load apps";
    state.apps.error = message;
  } finally {
    state.apps.loading = false;
    state.apps.initialized = true;
  }
};

const fetchRestartStatus = async () => {
  state.system.restart.loading = true;
  try {
    const response = await fetch("/api/system/restart/status");
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to load restart status";
      throw new Error(message);
    }
    state.system.restart.inProgress = Boolean(payload?.inProgress);
    state.system.restart.marker = payload?.marker ?? null;
    state.system.restart.outcome = payload?.outcome ?? null;
    state.system.restart.error = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load restart status";
    state.system.restart.error = message;
  } finally {
    state.system.restart.loading = false;
  }
};

const refreshApps = async ({ tail = APP_LOG_PREVIEW_LINES, skipRender = false } = {}) => {
  await Promise.all([fetchApps({ tail }), fetchRestartStatus()]);
  if (!skipRender && currentRoute === "apps") {
    render();
  }
};

const ensureAppsLoaded = async () => {
  if (state.apps.loading) return;
  if (!state.apps.initialized) {
    await refreshApps({ skipRender: false });
  }
};

const pollApps = async () => {
  if (appsPollInFlight || state.apps.loading) {
    return;
  }
  appsPollInFlight = true;
  try {
    await fetchApps({ tail: APP_LOG_PREVIEW_LINES });
    await fetchRestartStatus();
    if (currentRoute === "apps") {
      render();
    }
  } catch (error) {
    console.error("Failed to poll apps", error);
  } finally {
    appsPollInFlight = false;
  }
};

const syncAppsPolling = () => {
  if (currentRoute === "apps") {
    if (!appsPollIntervalId) {
      appsPollIntervalId = setInterval(() => {
        void pollApps();
      }, APPS_POLL_INTERVAL_MS);
    }
  } else if (appsPollIntervalId) {
    clearInterval(appsPollIntervalId);
    appsPollIntervalId = null;
  }
};

const pollSessions = async () => {
  try {
    const previousSessionCount = state.sessions.length;
    const previousSessionIds = state.sessions.map(s => s.id).join(',');

    await fetchSessions();
    syncMenuTabs();
    syncDesktopSessionIndicator();

    if (currentRoute === "home") {
      render();
      return;
    }

    if (currentRoute !== "live") {
      return;
    }

    const currentSessionCount = state.sessions.length;
    const currentSessionIds = state.sessions.map(s => s.id).join(',');
    const sessionsChanged = previousSessionCount !== currentSessionCount || previousSessionIds !== currentSessionIds;

    if (!state.activeSessionId) {
      // On live route with no active session, render to show empty state
      render();
    } else {
      // On live route with active session:
      // - Update menu tabs to reflect current sessions
      syncMenuTabs();
      // - Only replace tabs bar if sessions changed (to preserve event listeners)
      if (sessionsChanged && tabsVisible) {
        const tabsBar = document.querySelector('.wm-tabs-bar');
        if (tabsBar) {
          const existingTabs = tabsBar.querySelector('.wm-tabs');
          if (existingTabs) {
            const newTabs = renderTabs();
            existingTabs.replaceWith(newTabs);
          }
        }
      }
      // - Incremental updates for conversation/logs are handled by fetchConversation and fetchLogs
    }
  } catch (error) {
    console.error("Failed to refresh sessions", error);
  }
};

const pollSessionsLoop = async () => {
  if (sessionPollInFlight) {
    return;
  }
  sessionPollInFlight = true;
  try {
    await pollSessions();
  } catch (error) {
    console.error("Session polling loop failed", error);
  } finally {
    sessionPollInFlight = false;
  }
};

const startSessionPolling = () => {
  if (sessionPollIntervalId !== null) {
    return;
  }
  sessionPollIntervalId = window.setInterval(() => {
    if (currentRoute === "live") {
      void pollSessionsLoop();
    }
  }, SESSION_POLL_INTERVAL_MS);
  if (currentRoute === "live") {
    void pollSessionsLoop();
  }
};

const stopSessionPolling = () => {
  if (sessionPollIntervalId === null) {
    return;
  }
  window.clearInterval(sessionPollIntervalId);
  sessionPollIntervalId = null;
};

const syncSessionPolling = () => {
  if (currentRoute === "live") {
    startSessionPolling();
  } else {
    stopSessionPolling();
  }
};

const updateConversationDOM = (sessionId) => {
  let container = state.conversationContainers.get(sessionId);

  // If container reference is lost, try to find it in the DOM
  if (!container || !document.contains(container)) {
    const conversationWrapper = document.querySelector('.wm-live-conversation .wm-conversation');
    if (conversationWrapper) {
      container = conversationWrapper;
      state.conversationContainers.set(sessionId, container);
      // Re-sync the message count based on actual DOM
      const existingMessages = container.querySelectorAll('.wm-message');
      existingMessages.forEach((node) => attachCopyButton(node));
      state.lastMessageCount.set(sessionId, existingMessages.length);
    } else {
      return;
    }
  }

  const conversation = state.conversations.get(sessionId) ?? [];
  const lastCount = state.lastMessageCount.get(sessionId) ?? 0;

  // Handle new messages
  if (conversation.length > lastCount) {
    const newMessages = conversation.slice(lastCount);

    newMessages.forEach((message) => {
      const bubble = document.createElement("article");
      bubble.className = `wm-message ${message.type ?? message.role ?? "assistant"}`;
      const body = document.createElement("pre");
      body.textContent = message.content ?? message.message ?? "";
      bubble.append(body);
      attachCopyButton(bubble);
      container.append(bubble);
    });

    state.lastMessageCount.set(sessionId, conversation.length);
  }

  // Handle updated messages (streaming SSE - message content changes)
  if (conversation.length === lastCount && conversation.length > 0) {
    const domMessages = container.querySelectorAll('.wm-message');

    conversation.forEach((message, idx) => {
      const domMessage = domMessages[idx];
      if (domMessage) {
        attachCopyButton(domMessage);
        const body = domMessage.querySelector('pre');
        const currentContent = body?.textContent || '';
        const newContent = message.content ?? message.message ?? '';

        if (currentContent !== newContent) {
          if (body) {
            body.textContent = newContent;
          }
        }
      }
    });
  }
};

const updateLogsDOM = (sessionId) => {
  let container = state.logContainers.get(sessionId);

  // If container reference is lost, try to find it in the DOM
  if (!container || !document.contains(container)) {
    const logViewer = document.querySelector('.wm-log-panel .log-viewer');
    if (logViewer) {
      container = logViewer;
      state.logContainers.set(sessionId, container);
      // Re-sync the log length
      const currentLines = container.textContent.split('\n').filter(l => l.length > 0);
      state.lastLogLength.set(sessionId, currentLines.length);
    } else {
      return;
    }
  }

  const logs = state.logs.get(sessionId) ?? [];
  const lastLength = state.lastLogLength.get(sessionId) ?? 0;

  // Only update if logs changed
  if (logs.length !== lastLength || logs.join("\n") !== container.textContent) {
    container.textContent = logs.join("\n");
    state.lastLogLength.set(sessionId, logs.length);
  }
};

const openDialog = () => {
  if (!state.config) return;
  const fallbackDirectory =
    directoryInput?.value?.trim() ||
    state.lastWorkingDirectory ||
    state.config.defaultDirectory ||
    "";
  if (sessionNameInput) {
    sessionNameInput.value = "";
  }
  if (directoryInput) {
    directoryInput.value = fallbackDirectory;
    scheduleDirectorySuggestions(fallbackDirectory);
  }
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    if (sessionNameInput) {
      sessionNameInput.focus();
      sessionNameInput.select();
    } else {
      directoryInput?.focus();
      directoryInput?.select();
    }
  } else {
    // Fallback: use prompt if dialog unsupported.
    const agent = window.prompt(
      `Select agent (${state.config.agents.map((a) => a.id).join(", ")}):`,
      state.config.agents[0]?.id ?? "",
    );
    if (agent) {
      const directory = window.prompt("Working directory:", fallbackDirectory) ?? fallbackDirectory;
      const sessionName = window.prompt("Session name (optional):", "") ?? "";
      launchSession(agent, directory, sessionName);
    }
  }
};

const closeDialog = () => {
  if (dialog.open) {
    dialog.close();
  }
  if (sessionNameInput) {
    sessionNameInput.value = "";
  }
};

const handleSessionStart = async (session) => {
  if (!session || !session.id) {
    return;
  }

  const switchingToLive = currentRoute !== "live";
  if (switchingToLive) {
    currentRoute = "live";
  }
  setActiveSession(session.id, { allowPending: true, logPort: false, updateHistory: true });
  if (typeof session.workingDirectory === "string" && session.workingDirectory.length > 0) {
    state.lastWorkingDirectory = session.workingDirectory;
    if (directoryInput) {
      directoryInput.value = session.workingDirectory;
      scheduleDirectorySuggestions(session.workingDirectory);
    }
  }
  await fetchSessions();
  await Promise.all([fetchConversation(session.id), fetchLogs(session.id)]);
  render();
};

const launchSession = async (agentId, workingDirectory, name) => {
  if (!agentId) {
    window.alert("Select an agent before launching a session.");
    return;
  }

  const payload = { agent: agentId };
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (trimmedName.length > 0) {
    payload.name = trimmedName.slice(0, 120);
  }
  if (typeof workingDirectory === "string" && workingDirectory.trim().length > 0) {
    payload.directory = workingDirectory.trim();
  }

  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    window.alert(`Failed to start session: ${data.error ?? response.statusText}`);
    return;
  }

  const session = await response.json();
  await handleSessionStart(session);
};

const stopSession = async (sessionId) => {
  const response = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    window.alert(`Failed to stop session: ${data.error ?? response.statusText}`);
    return;
  }
  await fetchSessions();
  render();
};

const deleteSession = async (sessionId) => {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/storage`, { method: "DELETE" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      window.alert(`Failed to delete session: ${data.error ?? response.statusText}`);
      return;
    }
    await fetchSessions();
    render();
  } catch (error) {
    console.error("Failed to delete session", error);
    window.alert("Failed to delete session. Check console for details.");
  }
};

const resumeSession = async (sessionId) => {
  const session = getSessionById(sessionId);
  if (!session) {
    window.alert("Session not available. It may have been deleted.");
    return;
  }
  currentRoute = "live";
  setActiveSession(sessionId, { updateHistory: true, forceLog: true });
  await Promise.all([fetchConversation(sessionId), fetchLogs(sessionId)]);
  render();
};

const sendMessage = async (sessionId, content) => {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  if (!content?.trim()) {
    window.alert("Enter a message before sending.");
    return;
  }

  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      window.alert(`Agent request failed: ${data.error ?? response.statusText}`);
      return;
    }
    const payload = await response.json();
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    state.conversations.set(sessionId, messages);
    state.messageDrafts.set(sessionId, "");

    // Trigger incremental updates instead of full render
    updateConversationDOM(sessionId);
    requestAnimationFrame(() => {
      scrollConversationAreaToBottom(sessionId, { includeWindow: true });
    });
    await fetchLogs(sessionId);

    // Clear textarea and restore focus
    const textarea = document.querySelector('.wm-composer textarea');
    if (textarea) {
      textarea.value = "";
      textarea.style.height = "auto";
      requestAnimationFrame(() => {
        textarea.focus();
      });
    }
  } catch (error) {
    console.error("Failed to send agent message", error);
    window.alert("Failed to send message to agent. Check console for details.");
  }
};

const normaliseOrchestratorPresetSummary = (item) => {
  if (!item || typeof item !== "object") return null;
  const id = typeof item.id === "string" ? item.id : "";
  if (!id) return null;
  const label = typeof item.label === "string" ? item.label : "";
  const agent = typeof item.agent === "string" ? item.agent : "";
  return { id, label, agent };
};

const refreshOrchestratorPresets = async () => {
  if (state.orchestratorPresetsLoading) return;
  state.orchestratorPresetsLoading = true;
  state.orchestratorPresetsError = null;
  if (currentRoute === "home") render();

  try {
    const response = await fetch("/api/orchestrators");
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error ?? response.statusText ?? "Failed to load orchestrators");
    }

    const payload = await response.json().catch(() => ({}));
    const candidates = Array.isArray(payload?.presets) ? payload.presets : [];
    state.orchestratorPresets = candidates
      .map((item) => normaliseOrchestratorPresetSummary(item))
      .filter((item) => item !== null);
    state.orchestratorPresetsError = null;
  } catch (error) {
    console.error("Failed to load orchestrator presets", error);
    state.orchestratorPresets = [];
    state.orchestratorPresetsError = error instanceof Error ? error.message : String(error);
  } finally {
    state.orchestratorPresetsLoading = false;
    state.orchestratorPresetsLoaded = true;
    if (currentRoute === "home") {
      render();
    }
  }
};

const ensureOrchestratorPresetsLoaded = () => {
  if (!state.orchestratorPresetsLoaded && !state.orchestratorPresetsLoading) {
    refreshOrchestratorPresets().catch((error) => {
      console.error("Failed to load orchestrators", error);
    });
  }
};

const launchOrchestratorPreset = async (presetId) => {
  const response = await fetch(`/api/orchestrators/${encodeURIComponent(presetId)}/launch`, {
    method: "POST",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? response.statusText ?? "Failed to launch orchestrator");
  }
  return response.json();
};

const createOrchestratorPreset = async (payload) => {
  const response = await fetch("/api/orchestrators", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? response.statusText ?? "Failed to create orchestrator");
  }
  return response.json();
};

const renderOrchestratorPresetButtons = (container) => {
  if (!container) return;
  container.textContent = "";

  if (state.orchestratorPresetsLoading && !state.orchestratorPresetsLoaded) {
    container.textContent = "Loading orchestrators...";
    return;
  }

  if (state.orchestratorPresetsError) {
    container.textContent = `Failed to load orchestrator presets: ${state.orchestratorPresetsError}`;
    return;
  }

  if (state.orchestratorPresets.length === 0) {
    container.textContent = "No orchestrator presets configured.";
    return;
  }

  for (const preset of state.orchestratorPresets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wm-button secondary";
    const label = preset.label && preset.label.length > 0 ? preset.label : preset.id;
    button.textContent = label;

    const setPending = (pending) => {
      if (pending) {
        button.disabled = true;
        button.dataset.pending = "true";
        button.textContent = "Launching...";
      } else {
        button.disabled = false;
        delete button.dataset.pending;
        button.textContent = label;
      }
    };

    button.addEventListener("click", async () => {
      if (button.dataset.pending === "true") return;
      setPending(true);
      try {
        const result = await launchOrchestratorPreset(preset.id);
        if (!result?.session) {
          window.alert("Orchestrator launched, but no session information was returned.");
          return;
        }
        await handleSessionStart(result.session);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.alert(`Failed to launch ${label}: ${message}`);
      } finally {
        if (button.isConnected) {
          setPending(false);
        }
      }
    });

    container.append(button);
  }
};

const formatDirectoryPrefix = (value) => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed
    .replace(/[^a-zA-Z0-9/_-]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
};

const getDefaultOrchestratorPath = (target) => {
  return target === "templates" ? "orchestrator/templates" : "orchestrator/active";
};

const fetchOrchestratorDirectoryData = async (target, path) => {
  const params = new URLSearchParams({ target });
  if (path) {
    params.set("path", path);
  }
  const response = await fetch(`/api/orchestrators/directories?${params.toString()}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? response.statusText ?? "Failed to load directories");
  }
  return response.json();
};

const renderOrchestratorDirectoryBrowser = (data) => {
  if (!orchestratorDirectoryCurrent || !orchestratorDirectoryList) return;
  orchestratorDirectoryCurrent.textContent = data.path;
  orchestratorDirectoryList.textContent = "";
  if (orchestratorDirectoryUpButton) {
    orchestratorDirectoryUpButton.disabled = !data.parent;
  }

  if (Array.isArray(data.entries) && data.entries.length > 0) {
    data.entries.forEach((entry) => {
      const item = document.createElement("li");
      item.className = "directory-browser__item";
      item.dataset.path = entry.path;

      const folderButton = document.createElement("button");
      folderButton.type = "button";
      folderButton.className = "directory-browser__folder";
      folderButton.textContent = entry.name;
      folderButton.dataset.path = entry.path;

      const chooseButton = document.createElement("button");
      chooseButton.type = "button";
      chooseButton.className = "wm-button secondary directory-browser__choose";
      chooseButton.textContent = "Choose";
      chooseButton.dataset.path = entry.path;

      item.append(folderButton, chooseButton);
      orchestratorDirectoryList.append(item);
    });
  } else {
    const empty = document.createElement("li");
    empty.className = "directory-browser__empty";
    empty.textContent = "No subdirectories";
    orchestratorDirectoryList.append(empty);
  }

  refreshOrchestratorDirectoryHighlights();
};

const setOrchestratorDirectorySelection = (path) => {
  orchestratorDirectoryState.selection = path;
  refreshOrchestratorDirectoryHighlights();
};

const refreshOrchestratorDirectoryHighlights = () => {
  if (!orchestratorDirectoryList) return;
  const selected = orchestratorDirectoryState.selection;
  orchestratorDirectoryList.querySelectorAll(".directory-browser__item").forEach((item) => {
    if (!(item instanceof HTMLElement)) return;
    const path = item.dataset.path;
    if (selected && path === selected) {
      item.dataset.selected = "true";
    } else {
      delete item.dataset.selected;
    }
  });
};

const updateOrchestratorDirectoryBrowser = async (target, path) => {
  orchestratorDirectoryState.target = target;
  orchestratorDirectoryState.requestId += 1;
  const requestId = orchestratorDirectoryState.requestId;
  orchestratorDirectoryState.selection = null;

  let data;
  try {
    data = await fetchOrchestratorDirectoryData(target, path ?? undefined);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
    return false;
  }

  if (orchestratorDirectoryState.requestId !== requestId) {
    return false;
  }

  orchestratorDirectoryState.currentPath = data.path ?? null;
  orchestratorDirectoryState.parent = data.parent ?? null;
  orchestratorDirectoryState.selection = data.path ?? null;
  renderOrchestratorDirectoryBrowser(data);
  return true;
};

const openOrchestratorDirectoryDialog = async (target, initialPath) => {
  if (!orchestratorDirectoryDialog || typeof orchestratorDirectoryDialog.showModal !== "function") {
    window.alert("Your browser does not support the directory picker.");
    return;
  }

  const seed = initialPath && initialPath.trim().length > 0 ? initialPath : getDefaultOrchestratorPath(target);
  const loaded = await updateOrchestratorDirectoryBrowser(target, seed ?? null);
  if (!loaded) {
    return;
  }
  orchestratorDirectoryDialog.showModal();
};

const setOrchestratorDialogPending = (pending) => {
  orchestratorDialogSubmitting = pending;
  if (orchestratorSaveButton) {
    orchestratorSaveButton.disabled = pending;
    orchestratorSaveButton.textContent = pending ? "Saving..." : "Save";
  }
};

const resetOrchestratorForm = () => {
  orchestratorPrefixDirty = false;
  const defaultDir = state.lastWorkingDirectory ?? state.config?.defaultDirectory ?? "";
  if (orchestratorLabelInput) {
    orchestratorLabelInput.value = "";
  }
  if (orchestratorTemplateInput) {
    orchestratorTemplateInput.value = "";
  }
  if (orchestratorActiveRootInput) {
    orchestratorActiveRootInput.value = "orchestrator/active";
    orchestratorActiveRootInput.disabled = true;
  }
  if (orchestratorTemplateBrowseButton) {
    orchestratorTemplateBrowseButton.disabled = false;
  }
  if (orchestratorActiveRootBrowseButton) {
    orchestratorActiveRootBrowseButton.disabled = true;
  }
  if (orchestratorDirectoryPrefixInput) {
    orchestratorDirectoryPrefixInput.value = "";
    orchestratorDirectoryPrefixInput.placeholder = "Security_Review";
  }
  if (orchestratorWorkingDirectoryInput) {
    orchestratorWorkingDirectoryInput.value = defaultDir;
  }
  if (orchestratorIntroTextarea) {
    orchestratorIntroTextarea.value = "";
  }
  if (orchestratorPollTimeoutInput) {
    orchestratorPollTimeoutInput.value = "30000";
  }
  if (orchestratorPollIntervalInput) {
    orchestratorPollIntervalInput.value = "250";
  }
  if (orchestratorRetryAttemptsInput) {
    orchestratorRetryAttemptsInput.value = "10";
  }
  if (orchestratorRetryDelayInput) {
    orchestratorRetryDelayInput.value = "1000";
  }

  if (state.config?.agents && orchestratorAgentSelect) {
    orchestratorAgentSelect.value = state.config.agents[0]?.id ?? "";
  }
  applyOrchestratorTemplateState();
};

const applyOrchestratorTemplateState = () => {
  const hasTemplate = Boolean(orchestratorTemplateInput?.value.trim().length);
  if (orchestratorActiveRootInput) {
    orchestratorActiveRootInput.disabled = !hasTemplate;
    if (!hasTemplate) {
      orchestratorActiveRootInput.value = getDefaultOrchestratorPath("active");
    }
  }
  if (orchestratorActiveRootBrowseButton) {
    orchestratorActiveRootBrowseButton.disabled = !hasTemplate;
  }
};

const closeOrchestratorDialog = () => {
  setOrchestratorDialogPending(false);
  if (orchestratorDialog && typeof orchestratorDialog.close === "function" && orchestratorDialog.open) {
    orchestratorDialog.close();
  }
};

const openOrchestratorDialog = () => {
  if (!state.config) {
    window.alert("Configuration is still loading. Try again shortly.");
    return;
  }
  if (!orchestratorDialog || typeof orchestratorDialog.showModal !== "function") {
    window.alert("Your browser does not support the orchestrator dialog.");
    return;
  }
  resetOrchestratorForm();
  orchestratorDialog.showModal();
  orchestratorLabelInput?.focus();
};

const readIntegerInput = (input, fallback, minimum) => {
  if (!input) return fallback;
  const value = Number.parseInt(input.value, 10);
  if (Number.isFinite(value) && (!Number.isFinite(minimum) || value >= minimum)) {
    return value;
  }
  return fallback;
};

const handleOrchestratorFormSubmit = async (event) => {
  event.preventDefault();
  if (orchestratorDialogSubmitting) return;

  const label = orchestratorLabelInput?.value.trim() ?? "";
  if (!label) {
    window.alert("Enter a button label for the orchestrator.");
    orchestratorLabelInput?.focus();
    return;
  }

  const agent = orchestratorAgentSelect?.value ?? "";
  if (!agent) {
    window.alert("Select an agent for the orchestrator.");
    orchestratorAgentSelect?.focus();
    return;
  }

  const templateDirRaw = orchestratorTemplateInput?.value.trim() ?? "";
  const workingDirectoryRaw = orchestratorWorkingDirectoryInput?.value.trim() ?? "";
  const useTemplate = templateDirRaw.length > 0;
  if (!useTemplate && !workingDirectoryRaw) {
    window.alert("Provide either a template directory or a working directory.");
    orchestratorTemplateInput?.focus();
    return;
  }

  const directoryPrefixRaw = orchestratorDirectoryPrefixInput?.value.trim() ?? "";
  const introMessageRaw = orchestratorIntroTextarea?.value ?? "";
  const introMessageTrimmed = introMessageRaw.trim();
  const pollTimeout = readIntegerInput(orchestratorPollTimeoutInput, 30000, 1000);
  const pollInterval = readIntegerInput(orchestratorPollIntervalInput, 250, 50);
  const retryAttempts = readIntegerInput(orchestratorRetryAttemptsInput, 10, 1);
  const retryDelay = readIntegerInput(orchestratorRetryDelayInput, 1000, 0);

  const payload = {
    label,
    agent,
    templateDir: useTemplate ? templateDirRaw : undefined,
    activeRoot: useTemplate ? (orchestratorActiveRootInput?.value.trim() || "orchestrator/active") : undefined,
    directoryPrefix: useTemplate
      ? directoryPrefixRaw || formatDirectoryPrefix(label)
      : directoryPrefixRaw || undefined,
    workingDirectory: useTemplate ? undefined : workingDirectoryRaw || undefined,
    introMessage: introMessageTrimmed ? introMessageTrimmed : undefined,
    pollTimeoutMs: pollTimeout,
    pollIntervalMs: pollInterval,
    retryAttempts,
    retryDelayMs: retryDelay,
  };

  setOrchestratorDialogPending(true);
  try {
    await createOrchestratorPreset(payload);
    closeOrchestratorDialog();
    await refreshOrchestratorPresets();
    if (currentRoute !== "home") {
      currentRoute = "home";
      render();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    window.alert(`Failed to create orchestrator: ${message}`);
  } finally {
    if (orchestratorDialog?.open) {
      setOrchestratorDialogPending(false);
    }
  }
};

const APP_STATUS_LABELS = {
  idle: "Idle",
  running: "Running",
  stopping: "Stopping",
  restarting: "Restarting",
  building: "Building",
  failed: "Failed",
};

const APP_ACTION_LABELS = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  build: "Build",
};

const APP_BUSY_STATUSES = new Set(["stopping", "restarting", "building"]);

const formatAppActionLabel = (action) => APP_ACTION_LABELS[action] ?? action ?? "Unknown";

const formatAppTimestamp = (value) => {
  if (!value) return "—";
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  } catch {
    return value;
  }
};

const getAppById = (appId) => state.apps.items.find((item) => item?.id === appId) ?? null;

const isAppBusy = (app) => {
  const status = app?.status;
  if (!status) return false;
  if (status.inProgressAction) return true;
  if (APP_BUSY_STATUSES.has(status.status)) return true;
  return false;
};

const isAppActionDisabled = (app, action) => {
  const status = app?.status;
  if (!status) return true;
  const available = Boolean(app?.availableScripts?.[action]);
  if (!available) return true;
  if (status.inProgressAction && status.inProgressAction !== action) {
    return true;
  }
  if (status.inProgressAction === action) {
    return true;
  }
  const statusValue = status.status;
  if (APP_BUSY_STATUSES.has(statusValue)) {
    return true;
  }
  if (action === "start") {
    return statusValue === "running";
  }
  if (action === "stop") {
    return statusValue !== "running";
  }
  if (action === "restart") {
    return false;
  }
  if (action === "build") {
    return statusValue === "running";
  }
  return true;
};

const appDialogState = {
  mode: "create",
  appId: null,
};

const deriveAppWindowName = (labelValue, rootValue) => {
  const label = (labelValue ?? "").trim();
  const root = (rootValue ?? "").trim();
  const basename = (input) => {
    if (!input) return "";
    const segments = input.split(/[\\/]/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : "";
  };
  const source = label || basename(root);
  const cleaned = source
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 48);
  return cleaned.length > 0 ? cleaned : "app";
};

const updateAppWindowPreview = () => {
  if (!appTmuxWindowInput) return;
  if (appTmuxWindowInput.dataset.locked === "true") return;
  const label = appLabelInput?.value ?? "";
  const root = appRootInput?.value ?? "";
  appTmuxWindowInput.value = deriveAppWindowName(label, root);
};

const setAppDialogSubmitting = (submitting) => {
  if (!appForm) return;
  const elements = Array.from(appForm.elements);
  for (const element of elements) {
    if (
      element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      if (element.dataset.role === "cancel") continue;
      element.disabled = submitting;
    }
  }
  if (appDialog) {
    if (submitting) {
      appDialog.dataset.submitting = "true";
    } else {
      delete appDialog.dataset.submitting;
    }
  }
};

if (appLabelInput) {
  appLabelInput.addEventListener("input", () => {
    if (appDialogState.mode === "edit" && appTmuxWindowInput?.dataset.locked === "true") {
      return;
    }
    updateAppWindowPreview();
  });
}

if (appRootInput) {
  appRootInput.addEventListener("input", () => {
    if (appDialogState.mode === "edit" && appTmuxWindowInput?.dataset.locked === "true") {
      return;
    }
    updateAppWindowPreview();
  });
}

appRootBrowseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  const seed =
    appRootInput?.value?.trim() ||
    state.lastWorkingDirectory ||
    state.config?.defaultDirectory ||
    "";
  void openDirectoryBrowser({
    initialPath: seed,
    title: "Select App Root",
    confirmLabel: "Use This Directory",
    allowCreate: true,
    onSelect: (path) => {
      if (appRootInput) {
        appRootInput.value = path;
        updateAppWindowPreview();
      }
      state.lastWorkingDirectory = path;
    },
  });
});

const resetAppDialog = () => {
  if (appForm) {
    appForm.reset();
  }
  if (appDialogTitle) {
    appDialogTitle.textContent = "Add App";
  }
  if (appDiscoverToggle) {
    appDiscoverToggle.checked = true;
  }
  Object.values(appScriptInputs).forEach((input) => {
    if (input) {
      input.value = "";
    }
  });
  if (appTmuxInput) {
    appTmuxInput.value = SHARED_TMUX_SESSION;
  }
  if (appTmuxWindowInput) {
    delete appTmuxWindowInput.dataset.locked;
    appTmuxWindowInput.value = deriveAppWindowName(appLabelInput?.value ?? "", appRootInput?.value ?? "");
  }
  if (appNotesInput) {
    appNotesInput.value = "";
  }
  appDialogState.mode = "create";
  appDialogState.appId = null;
};

const populateAppDialog = (app) => {
  if (!app) return;
  if (appDialogTitle) {
    appDialogTitle.textContent = "Edit App";
  }
  if (appLabelInput) {
    appLabelInput.value = app.label ?? "";
  }
  if (appRootInput) {
    appRootInput.value = app.root ?? "";
  }
  if (appTmuxInput) {
    appTmuxInput.value = SHARED_TMUX_SESSION;
  }
  if (appTmuxWindowInput) {
    appTmuxWindowInput.dataset.locked = "true";
    appTmuxWindowInput.value =
      app.tmuxWindow ?? app.tmuxSession ?? deriveAppWindowName(app.label ?? "", app.root ?? "");
  }
  if (appNotesInput) {
    appNotesInput.value = app.notes ?? "";
  }
  Object.entries(appScriptInputs).forEach(([action, input]) => {
    if (!input) return;
    input.value = app.scripts?.[action] ?? "";
  });
};

const collectAppFormValues = () => {
  const label = appLabelInput?.value?.trim() ?? "";
  const root = appRootInput?.value?.trim() ?? "";
  const notesRaw = appNotesInput?.value ?? "";
  const notesTrimmed = notesRaw.trim();
  const scripts = {};
  for (const [action, input] of Object.entries(appScriptInputs)) {
    if (!input) continue;
    const value = input.value.trim();
    if (value.length > 0) {
      scripts[action] = value;
    }
  }
  const discoverScripts = appDiscoverToggle ? appDiscoverToggle.checked : true;
  return { label, root, notesRaw, notesTrimmed, scripts, discoverScripts };
};

const handleAppFormSubmit = async (event) => {
  event.preventDefault();
  const values = collectAppFormValues();
  if (!values.root) {
    window.alert("Provide a root directory for the app.");
    appRootInput?.focus();
    return;
  }

  const scriptsPayload = Object.keys(values.scripts).length > 0 ? values.scripts : undefined;
  const mode = appDialogState.mode;
  const appId = appDialogState.appId;

  let url;
  let method;
  let body;

  if (mode === "edit" && appId) {
    url = `/api/apps/${encodeURIComponent(appId)}`;
    method = "PUT";
    body = {
      label: values.label ? values.label : undefined,
      root: values.root,
      scripts: scriptsPayload,
      notes:
        values.notesRaw.length === 0
          ? null
          : values.notesTrimmed.length > 0
            ? values.notesTrimmed
            : undefined,
      discoverScripts: values.discoverScripts,
    };
  } else {
    url = "/api/apps";
    method = "POST";
    body = {
      label: values.label,
      root: values.root,
      scripts: scriptsPayload,
      notes: values.notesTrimmed.length > 0 ? values.notesTrimmed : undefined,
      discoverScripts: values.discoverScripts,
    };
  }

  setAppDialogSubmitting(true);
  try {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to save app";
      throw new Error(message);
    }
    closeAppDialog();
    await refreshApps({ skipRender: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save app";
    window.alert(message);
  } finally {
    setAppDialogSubmitting(false);
  }
};

const openAppDialog = (appId = null) => {
  if (!appDialog) return;
  resetAppDialog();
  if (appId) {
    const app = getAppById(appId);
    if (!app) return;
    appDialogState.mode = "edit";
    appDialogState.appId = appId;
    populateAppDialog(app);
  }
  if (appDialog.open) {
    appDialog.close();
  }
  appDialog.showModal();
  (appLabelInput ?? appRootInput)?.focus();
};

const closeAppDialog = () => {
  if (!appDialog) return;
  if (appDialog.open) {
    appDialog.close();
  } else {
    resetAppDialog();
  }
};

const handleAppDiscover = async (event) => {
  event.preventDefault();
  if (!appRootInput) return;
  const root = appRootInput.value.trim();
  if (!root) {
    window.alert("Enter the app root directory before discovering scripts.");
    appRootInput.focus();
    return;
  }
  if (appDiscoverButton) {
    appDiscoverButton.disabled = true;
  }
  try {
    const response = await fetch(`/api/apps/discover?root=${encodeURIComponent(root)}`);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to discover scripts";
      throw new Error(message);
    }
    const scripts = payload && typeof payload === "object" ? (payload.scripts ?? {}) : {};
    let applied = 0;
    for (const [action, input] of Object.entries(appScriptInputs)) {
      if (!input) continue;
      const candidate = scripts?.[action];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        input.value = candidate;
        applied += 1;
      }
    }
    if (applied === 0) {
      window.alert("No scripts discovered. Enter commands manually.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to discover scripts";
    window.alert(message);
  } finally {
    if (appDiscoverButton) {
      appDiscoverButton.disabled = false;
    }
  }
};

const triggerAppAction = async (appId, action) => {
  try {
    const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to perform action";
      throw new Error(message);
    }
    await refreshApps({ skipRender: currentRoute !== "apps" });
    if (currentRoute !== "apps") {
      render();
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to perform action";
    window.alert(message);
    return false;
  }
};

const triggerWarmRestart = async () => {
  if (state.system.restart.submitting || state.system.restart.inProgress) {
    return false;
  }
  state.system.restart.submitting = true;
  try {
    const response = await fetch("/api/system/restart", { method: "POST" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to initiate restart";
      throw new Error(message);
    }
    state.system.restart.inProgress = true;
    state.system.restart.error = null;
    await fetchRestartStatus();
    if (currentRoute === "apps") {
      render();
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to initiate restart";
    state.system.restart.error = message;
    window.alert(message);
    return false;
  } finally {
    state.system.restart.submitting = false;
  }
};

const removeApp = async (appId) => {
  const app = getAppById(appId);
  if (!app) return;
  const confirmed = window.confirm(`Remove "${app.label ?? app.id}" from Wingman?`);
  if (!confirmed) return;
  let url = `/api/apps/${encodeURIComponent(appId)}`;
  if (app?.status?.running) {
    const kill = window.confirm("The app appears to be running. Kill the tmux session as well?");
    if (kill) {
      url += url.includes("?") ? "&killSession=true" : "?killSession=true";
    }
  }
  try {
    const response = await fetch(url, { method: "DELETE" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to remove app";
      throw new Error(message);
    }
    await refreshApps({ skipRender: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to remove app";
    window.alert(message);
  }
};

const renderAppLogPreview = (logs) => {
  const preview = document.createElement("pre");
  preview.className = "wm-app-log";
  if (Array.isArray(logs) && logs.length > 0) {
    preview.textContent = logs.join("\n");
  } else {
    preview.textContent = "No recent logs.";
  }
  return preview;
};

const renderWingmanCard = (app) => {
  const card = document.createElement("section");
  card.className = "wm-card wm-app-card wm-app-card-core";

  const header = document.createElement("div");
  header.className = "wm-app-card__header";
  const title = document.createElement("h3");
  title.textContent = app.label ?? "Wingman Server";
  header.append(title);

  const statusBadge = document.createElement("span");
  statusBadge.className = "wm-app-status";
  const restartInProgress = state.system.restart.inProgress;
  const statusValue = restartInProgress ? "restarting" : app?.status?.status ?? "running";
  statusBadge.dataset.state = statusValue;
  statusBadge.textContent = APP_STATUS_LABELS[statusValue] ?? statusValue;
  header.append(statusBadge);
  card.append(header);

  const statusInfo = document.createElement("div");
  statusInfo.className = "wm-app-status-info";

  if (state.system.restart.error) {
    const errorLine = document.createElement("p");
    errorLine.className = "wm-app-status-error";
    errorLine.textContent = state.system.restart.error;
    statusInfo.append(errorLine);
  } else if (restartInProgress) {
    const progressLine = document.createElement("p");
    const sessionCount = Array.isArray(state.system.restart.marker?.sessionIds)
      ? state.system.restart.marker.sessionIds.length
      : null;
    progressLine.textContent =
      sessionCount && sessionCount > 0
        ? `Warm restart in progress… preserving ${sessionCount} active session${sessionCount === 1 ? "" : "s"}.`
        : "Warm restart in progress… Wingman will reload without interrupting active sessions.";
    statusInfo.append(progressLine);
  } else if (state.system.restart.outcome) {
    const outcome = state.system.restart.outcome;
    const summaryLine = document.createElement("p");
    summaryLine.textContent = `Last warm restart restored ${outcome.restored} session${
      outcome.restored === 1 ? "" : "s"
    } (${formatAppTimestamp(outcome.timestamp)}).`;
    statusInfo.append(summaryLine);
    if (outcome.failed?.length > 0) {
      const failedLine = document.createElement("p");
      failedLine.textContent = `Unable to rehydrate ${outcome.failed.length} session${
        outcome.failed.length === 1 ? "" : "s"
      }.`;
      statusInfo.append(failedLine);
    }
  } else {
    const idleLine = document.createElement("p");
    idleLine.textContent = "Warm restart keeps agent sessions alive while Wingman reloads.";
    statusInfo.append(idleLine);
  }

  const marker = state.system.restart.marker;
  if (marker?.createdAt && !restartInProgress) {
    const scheduledLine = document.createElement("p");
    scheduledLine.textContent = `Last restart request: ${formatAppTimestamp(marker.createdAt)}`;
    statusInfo.append(scheduledLine);
  }

  card.append(statusInfo);

  card.append(renderAppLogPreview(app.logs));

  const actions = document.createElement("div");
  actions.className = "wm-app-actions";

  const viewLogsButton = document.createElement("button");
  viewLogsButton.type = "button";
  viewLogsButton.className = "wm-button secondary";
  viewLogsButton.textContent = "View Logs";
  viewLogsButton.addEventListener("click", () => void openAppLogsDialog(app.id));
  actions.append(viewLogsButton);

  const restartButton = document.createElement("button");
  restartButton.type = "button";
  restartButton.className = "wm-button";
  restartButton.textContent = restartInProgress ? "Restarting…" : "Restart Wingman";
  restartButton.disabled = state.system.restart.submitting || restartInProgress;
  restartButton.addEventListener("click", async () => {
    if (restartButton.disabled) return;
    restartButton.disabled = true;
    restartButton.textContent = "Restarting…";
    const success = await triggerWarmRestart();
    if (!success) {
      restartButton.disabled = false;
      restartButton.textContent = "Restart Wingman";
    }
  });
  actions.append(restartButton);

  card.append(actions);
  return card;
};

const renderAppCard = (app) => {
  const card = document.createElement("section");
  card.className = "wm-card wm-app-card";
  if (app.id === "wingman-core") {
    card.classList.add("wm-app-card-core");
  }

  const header = document.createElement("div");
  header.className = "wm-app-card__header";
  const title = document.createElement("h3");
  title.textContent = app.label ?? app.id;
  header.append(title);

  const statusBadge = document.createElement("span");
  statusBadge.className = "wm-app-status";
  const statusValue = app?.status?.status ?? "idle";
  statusBadge.dataset.state = statusValue;
  statusBadge.textContent = APP_STATUS_LABELS[statusValue] ?? statusValue;
  header.append(statusBadge);
  card.append(header);

  const meta = document.createElement("div");
  meta.className = "wm-app-meta";

  const rootRow = document.createElement("div");
  rootRow.className = "wm-app-meta-row";
  const rootLabel = document.createElement("span");
  rootLabel.className = "wm-app-meta-label";
  rootLabel.textContent = "Root";
  const rootValue = document.createElement("code");
  rootValue.textContent = app.root;
  rootValue.title = app.root;
  rootRow.append(rootLabel, rootValue);
  meta.append(rootRow);

  const tmuxRow = document.createElement("div");
  tmuxRow.className = "wm-app-meta-row";
  const tmuxLabel = document.createElement("span");
  tmuxLabel.className = "wm-app-meta-label";
  tmuxLabel.textContent = "tmux session";
  const tmuxValue = document.createElement("code");
  tmuxValue.textContent = SHARED_TMUX_SESSION;
  tmuxValue.title = SHARED_TMUX_SESSION;
  tmuxRow.append(tmuxLabel, tmuxValue);
  meta.append(tmuxRow);

  const windowRow = document.createElement("div");
  windowRow.className = "wm-app-meta-row";
  const windowLabel = document.createElement("span");
  windowLabel.className = "wm-app-meta-label";
  windowLabel.textContent = "tmux window";
  const windowValue = document.createElement("code");
  const windowName = app.tmuxWindow ?? app.tmuxSession ?? deriveAppWindowName(app.label ?? "", app.root ?? "");
  windowValue.textContent = windowName;
  windowValue.title = windowName;
  windowRow.append(windowLabel, windowValue);
  meta.append(windowRow);

  card.append(meta);

  if (app.notes) {
    const notes = document.createElement("p");
    notes.className = "wm-app-notes";
    notes.textContent = app.notes;
    card.append(notes);
  }

  const statusInfo = document.createElement("div");
  statusInfo.className = "wm-app-status-info";

  const lastAction = document.createElement("p");
  lastAction.textContent = `Last Action: ${
    app.status?.lastAction ? formatAppActionLabel(app.status.lastAction) : "—"
  }`;
  statusInfo.append(lastAction);

  const updatedLine = document.createElement("p");
  updatedLine.textContent = `Updated: ${formatAppTimestamp(app.status?.updatedAt ?? null)}`;
  statusInfo.append(updatedLine);

  const messageLine = document.createElement("p");
  messageLine.textContent = `Message: ${app.status?.message ?? "—"}`;
  statusInfo.append(messageLine);

  if (typeof app.status?.lastExitCode === "number") {
    const exitLine = document.createElement("p");
    exitLine.textContent = `Last Exit Code: ${app.status.lastExitCode}`;
    statusInfo.append(exitLine);
  }

  card.append(statusInfo);

  card.append(renderAppLogPreview(app.logs));

  const actions = document.createElement("div");
  actions.className = "wm-app-actions";

  const logsButton = document.createElement("button");
  logsButton.type = "button";
  logsButton.className = "wm-button secondary";
  logsButton.textContent = "View Logs";
  logsButton.addEventListener("click", () => {
    void openAppLogsDialog(app.id);
  });
  actions.append(logsButton);

  const isCoreApp = app.id === "wingman-core";
  const actionOrder = ["start", "stop", "restart", "build"];
  actionOrder.forEach((action) => {
    if (!app.availableScripts?.[action]) return;
    if (isCoreApp && (action === "start" || action === "stop")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = action === "stop" ? "wm-button secondary" : "wm-button";
    button.textContent = APP_ACTION_LABELS[action];
    button.disabled = isAppActionDisabled(app, action);
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      const success = await triggerAppAction(app.id, action);
      if (!success) {
        button.disabled = false;
      }
    });
    actions.append(button);
  });

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "wm-button secondary";
  editButton.textContent = "Edit";
  editButton.addEventListener("click", () => openAppDialog(app.id));
  actions.append(editButton);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "wm-button danger";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", () => removeApp(app.id));
  actions.append(removeButton);

  card.append(actions);

  return card;
};

const renderApps = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-apps";

  const header = document.createElement("div");
  header.className = "wm-apps-header";

  const title = document.createElement("h2");
  title.textContent = "Apps";
  header.append(title);

  const headerActions = document.createElement("div");
  headerActions.className = "wm-apps-header-actions";

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "wm-button secondary";
  refreshButton.textContent = state.apps.loading ? "Refreshing…" : "Refresh";
  refreshButton.disabled = state.apps.loading;
  refreshButton.addEventListener("click", () => {
    refreshButton.disabled = true;
    void refreshApps({ skipRender: false });
  });

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "wm-button";
  addButton.textContent = "Add App";
  addButton.addEventListener("click", () => openAppDialog());

  headerActions.append(refreshButton, addButton);
  header.append(headerActions);
  wrapper.append(header);

  if (!state.apps.initialized && !state.apps.loading) {
    void refreshApps({ skipRender: false });
  }

  if (state.apps.error) {
    const errorBox = document.createElement("div");
    errorBox.className = "wm-apps-error";
    const errorText = document.createElement("p");
    errorText.textContent = state.apps.error;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "wm-button secondary";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      void refreshApps({ skipRender: false });
    });
    errorBox.append(errorText, retry);
    wrapper.append(errorBox);
  }

  const apps = Array.isArray(state.apps.items) ? state.apps.items : [];
  if (state.apps.loading && apps.length === 0) {
    const loading = document.createElement("p");
    loading.className = "wm-apps-empty";
    loading.textContent = "Loading apps…";
    wrapper.append(loading);
    return wrapper;
  }

  if (apps.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-apps-empty";
    empty.textContent = "No apps registered yet. Use “Add App” to get started.";
    wrapper.append(empty);
    return wrapper;
  }

  const grid = document.createElement("div");
  grid.className = "wm-apps-grid";

  const coreApp = apps.find((item) => item?.id === "wingman-core");
  if (coreApp) {
    grid.append(renderWingmanCard(coreApp));
  }
  apps
    .filter((item) => item?.id !== "wingman-core")
    .forEach((app) => {
      grid.append(renderAppCard(app));
    });

  wrapper.append(grid);

  return wrapper;
};

const openAppLogsDialog = async (appId) => {
  if (!appLogsDialog) return;
  const app = getAppById(appId);
  if (appLogsTitle) {
    appLogsTitle.textContent = app?.label ?? appId;
  }
  state.appLogViewer.appId = appId;
  state.appLogViewer.title = app?.label ?? appId;
  state.appLogViewer.lines = [];
  state.appLogViewer.loading = true;
  if (appLogsContent) {
    appLogsContent.textContent = "Loading logs…";
  }
  if (appLogsDialog.open) {
    appLogsDialog.close();
  }
  appLogsDialog.showModal();
  await refreshAppLogs(appId);
};

const refreshAppLogs = async (appId, { tail } = {}) => {
  const targetId = appId ?? state.appLogViewer.appId;
  if (!targetId) return;
  const tailSize = typeof tail === "number" && tail > 0 ? tail : state.appLogViewer.tail;
  state.appLogViewer.loading = true;
  try {
    const response = await fetch(
      `/api/apps/${encodeURIComponent(targetId)}/logs?tail=${encodeURIComponent(String(tailSize))}`,
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to load logs";
      throw new Error(message);
    }
    const lines = Array.isArray(payload?.logs) ? payload.logs : [];
    state.appLogViewer.lines = lines;
    if (appLogsContent) {
      appLogsContent.textContent = lines.length > 0 ? lines.join("\n") : "No log output yet.";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load logs";
    if (appLogsContent) {
      appLogsContent.textContent = `Error: ${message}`;
    }
  } finally {
    state.appLogViewer.loading = false;
  }
};

const closeAppLogsDialog = () => {
  if (!appLogsDialog) return;
  if (appLogsDialog.open) {
    appLogsDialog.close();
    return;
  }
  state.appLogViewer.appId = null;
  state.appLogViewer.title = "";
  state.appLogViewer.lines = [];
  state.appLogViewer.loading = false;
  if (appLogsContent) {
    appLogsContent.textContent = "";
  }
};

const renderIdentitySummary = () => {
  const summary = document.createElement("div");
  summary.className = "wm-identity-summary";

  const list = document.createElement("dl");
  list.className = "wm-identity-summary-list";

  const npubLabel = document.createElement("dt");
  npubLabel.textContent = "Active npub";
  const npubValue = document.createElement("dd");
  npubValue.dataset.role = "identity-npub";
  npubValue.textContent = "Not signed in";

  const methodLabel = document.createElement("dt");
  methodLabel.textContent = "Method";
  const methodValue = document.createElement("dd");
  methodValue.dataset.role = "identity-method";
  methodValue.textContent = "—";

  const expiryLabel = document.createElement("dt");
  expiryLabel.textContent = "Session";
  const expiryValue = document.createElement("dd");
  expiryValue.dataset.role = "identity-expiry";
  expiryValue.textContent = "—";

  list.append(npubLabel, npubValue, methodLabel, methodValue, expiryLabel, expiryValue);
  summary.append(list);

  const actions = document.createElement("div");
  actions.className = "wm-identity-summary-actions";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "wm-button secondary";
  copyButton.dataset.action = "copy-active-npub";
  copyButton.textContent = "Copy npub";
  copyButton.disabled = true;
  actions.append(copyButton);

  const logoutButton = document.createElement("button");
  logoutButton.type = "button";
  logoutButton.className = "wm-button secondary";
  logoutButton.dataset.action = "identity-logout";
  logoutButton.textContent = "Logout";
  actions.append(logoutButton);

  const feedback = document.createElement("span");
  feedback.className = "wm-identity-copy-feedback";
  feedback.dataset.role = "identity-copy-feedback";
  feedback.hidden = true;
  actions.append(feedback);

  summary.append(actions);
  return summary;
};

const renderLocalIdentityPanel = () => {
  const panel = document.createElement("section");
  panel.className = "wm-identity-panel";
  panel.dataset.identityPanel = "local";

  const heading = document.createElement("h3");
  heading.textContent = "Local Keys";
  panel.append(heading);

  const description = document.createElement("p");
  description.className = "wm-identity-panel-description";
  description.textContent = "Generate or import a keypair stored on this device.";
  panel.append(description);

  const actions = document.createElement("div");
  actions.className = "wm-identity-button-row";

  const generateBtn = document.createElement("button");
  generateBtn.type = "button";
  generateBtn.className = "wm-button";
  generateBtn.dataset.action = "generate-keys";
  generateBtn.textContent = "Generate Keys";
  actions.append(generateBtn);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "wm-button secondary";
  copyBtn.dataset.action = "copy-nsec";
  copyBtn.textContent = "Copy nsec";
  actions.append(copyBtn);

  panel.append(actions);

  const outputs = document.createElement("div");
  outputs.className = "wm-identity-output";

  const npubLine = document.createElement("div");
  npubLine.className = "wm-identity-output-line";
  const npubKeyLabel = document.createElement("span");
  npubKeyLabel.className = "wm-identity-output-label";
  npubKeyLabel.textContent = "npub";
  const npubValue = document.createElement("span");
  npubValue.className = "wm-identity-output-value";
  npubValue.dataset.role = "npub";
  npubLine.append(npubKeyLabel, npubValue);
  outputs.append(npubLine);

  const nsecOutput = document.createElement("pre");
  nsecOutput.className = "wm-identity-secret";
  nsecOutput.dataset.role = "nsec";
  nsecOutput.setAttribute("hidden", "");
  outputs.append(nsecOutput);

  panel.append(outputs);

  const importForm = document.createElement("form");
  importForm.className = "wm-identity-import";
  importForm.dataset.form = "import-nsec";

  const importLabel = document.createElement("label");
  importLabel.className = "wm-field-label";
  importLabel.setAttribute("for", "identity-import-nsec");
  importLabel.textContent = "Import nsec";

  const importControls = document.createElement("div");
  importControls.className = "wm-identity-import-controls";

  const importInput = document.createElement("input");
  importInput.id = "identity-import-nsec";
  importInput.name = "nsec";
  importInput.type = "text";
  importInput.autocomplete = "off";
  importInput.placeholder = "nsec1...";

  const importSubmit = document.createElement("button");
  importSubmit.type = "submit";
  importSubmit.className = "wm-button secondary";
  importSubmit.textContent = "Sign In";

  importControls.append(importInput, importSubmit);
  importForm.append(importLabel, importControls);
  panel.append(importForm);

  return panel;
};

const renderNip07Panel = () => {
  const panel = document.createElement("section");
  panel.className = "wm-identity-panel";
  panel.dataset.identityPanel = "nip07";

  const heading = document.createElement("h3");
  heading.textContent = "Browser Extension (NIP-07)";
  panel.append(heading);

  const description = document.createElement("p");
  description.className = "wm-identity-panel-description";
  description.textContent = "Connect using a Nostr extension such as Alby, nos2x, or Flamingo.";
  panel.append(description);

  const loginButton = document.createElement("button");
  loginButton.type = "button";
  loginButton.className = "wm-button";
  loginButton.dataset.action = "nip07-login";
  loginButton.textContent = "Connect Extension";
  panel.append(loginButton);

  const status = document.createElement("p");
  status.className = "wm-identity-status-line";
  status.dataset.role = "nip07-status";
  status.setAttribute("aria-live", "polite");
  panel.append(status);

  return panel;
};

const renderBunkerPanel = () => {
  const panel = document.createElement("section");
  panel.className = "wm-identity-panel";
  panel.dataset.identityPanel = "bunker";

  const heading = document.createElement("h3");
  heading.textContent = "Bunker Remote Signer";
  panel.append(heading);

  const description = document.createElement("p");
  description.className = "wm-identity-panel-description";
  description.textContent = "Connect a remote signer with a bunker:// URI.";
  panel.append(description);

  const form = document.createElement("form");
  form.className = "wm-identity-bunker-form";
  form.dataset.form = "bunker-auth";

  const textarea = document.createElement("textarea");
  textarea.name = "bunkerUri";
  textarea.rows = 3;
  textarea.placeholder = "bunker://...";
  form.append(textarea);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "wm-button";
  submit.textContent = "Connect Bunker";
  form.append(submit);

  panel.append(form);

  const bunkerActions = document.createElement("div");
  bunkerActions.className = "wm-identity-button-row";
  const scanButton = document.createElement("button");
  scanButton.type = "button";
  scanButton.className = "wm-button secondary";
  scanButton.dataset.action = "scan-qr";
  scanButton.textContent = "Scan QR";
  bunkerActions.append(scanButton);
  panel.append(bunkerActions);

  const status = document.createElement("p");
  status.className = "wm-identity-status-line";
  status.dataset.role = "bunker-status";
  status.setAttribute("aria-live", "polite");
  panel.append(status);

  return panel;
};

const renderIdentityPanel = (options = {}) => {
  const variant = options.variant ?? "settings";
  const card = document.createElement("section");
  card.className = "wm-card";
  if (variant === "settings") {
    card.classList.add("wm-settings-identity");
    card.id = "identity-panel";
  } else if (variant === "dialog") {
    card.classList.add("wm-identity-dialog-card");
  } else {
    card.classList.add("wm-identity-panel-card");
  }

  const header = document.createElement("div");
  header.className = "wm-home-section-header";
  const title = document.createElement("h2");
  title.textContent = "Identity";
  header.append(title);
  card.append(header);

  const summary = renderIdentitySummary();
  card.append(summary);

  const panels = document.createElement("div");
  panels.className = "wm-identity-panels";
  panels.append(renderLocalIdentityPanel(), renderNip07Panel(), renderBunkerPanel());
  card.append(panels);

  registerIdentityDom(card);
  bindIdentityFlows(card);

  return card;
};

let detachHomeIdentityBannerListener = null;

const renderHomeIdentityBanner = () => {
  detachHomeIdentityBannerListener?.();
  const card = document.createElement("section");
  card.className = "wm-card wm-home-identity-banner";

  const info = document.createElement("div");
  info.className = "wm-home-identity-info";

  const label = document.createElement("span");
  label.className = "wm-home-identity-label";
  label.textContent = "Identity:";

  const status = document.createElement("span");
  status.className = "wm-home-identity-status";
  status.hidden = true;

  info.append(label, status);

  const actions = document.createElement("div");
  actions.className = "wm-home-identity-actions";

  const loginButton = document.createElement("button");
  loginButton.type = "button";
  loginButton.className = "wm-button";
  loginButton.textContent = "Log In";
  loginButton.addEventListener("click", () => {
    openIdentityLoginDialog();
  });

  const manageButton = document.createElement("button");
  manageButton.type = "button";
  manageButton.className = "wm-link-button wm-home-identity-manage";
  manageButton.textContent = "Manage";
  manageButton.hidden = true;
  manageButton.addEventListener("click", () => {
    closeIdentityLoginDialog();
    navigateToSettings();
  });

  actions.append(loginButton, manageButton);
  card.append(info, actions);

  const updateBanner = () => {
    const { npub } = state.identity;
    if (npub) {
      const truncated = npub.length > 12 ? `${npub.slice(0, 12)}...` : npub;
      status.textContent = truncated;
      status.title = npub;
      status.hidden = false;
      manageButton.hidden = false;
      loginButton.hidden = true;
    } else {
      status.textContent = "";
      status.removeAttribute("title");
      status.hidden = true;
      manageButton.hidden = true;
      loginButton.hidden = false;
    }
  };

  const identityEventHandler = () => {
    updateBanner();
  };
  const trackedEvents = ["wingman:identity-ui-state", ...IDENTITY_EVENT_NAMES];
  trackedEvents.forEach((eventName) => {
    window.addEventListener(eventName, identityEventHandler);
  });

  detachHomeIdentityBannerListener = () => {
    trackedEvents.forEach((eventName) => {
      window.removeEventListener(eventName, identityEventHandler);
    });
    detachHomeIdentityBannerListener = null;
  };

  updateBanner();

  return card;
};

const renderHome = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-home";

  wrapper.append(renderHomeIdentityBanner());

  if (!state.apps.initialized && !state.apps.loading) {
    void ensureAppsLoaded();
  }

  const orchestratorCard = document.createElement("section");
  orchestratorCard.className = "wm-card wm-home-orchestrator";

  const orchestratorHeader = document.createElement("div");
  orchestratorHeader.className = "wm-home-section-header";

  const orchestratorTitle = document.createElement("h2");
  orchestratorTitle.textContent = "Orchestrator";

  const orchestratorContent = document.createElement("div");
  orchestratorContent.className = "wm-home-orchestrator-content";
  orchestratorContent.id = "orchestrator-content";

  const setOrchestratorCollapsed = (collapsed) => {
    if (collapsed) {
      orchestratorCard.dataset.collapsed = "true";
      orchestratorContent.hidden = true;
      orchestratorHeader.setAttribute("aria-expanded", "false");
    } else {
      delete orchestratorCard.dataset.collapsed;
      orchestratorContent.hidden = false;
      orchestratorHeader.setAttribute("aria-expanded", "true");
    }
  };

  const orchestratorCreateButton = document.createElement("button");
  orchestratorCreateButton.type = "button";
  orchestratorCreateButton.className = "wm-button secondary wm-button-icon";
  orchestratorCreateButton.setAttribute("aria-label", "Add orchestrator preset");
  orchestratorCreateButton.innerHTML = '<span aria-hidden="true">+</span>';
  orchestratorCreateButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openOrchestratorDialog();
  });

  const orchestratorHeaderActions = document.createElement("div");
  orchestratorHeaderActions.className = "wm-home-section-actions";
  orchestratorHeaderActions.append(orchestratorCreateButton);

  const orchestratorActions = document.createElement("div");
  orchestratorActions.className = "wm-home-orchestrator-actions";
  renderOrchestratorPresetButtons(orchestratorActions);

  if (!state.orchestratorPresetsLoaded && !state.orchestratorPresetsLoading) {
    ensureOrchestratorPresetsLoaded();
  }

  // Make header clickable to toggle collapse
  orchestratorHeader.addEventListener("click", (event) => {
    if (orchestratorCreateButton.contains(event.target)) return;
    const currentlyCollapsed = orchestratorCard.dataset.collapsed === "true";
    setOrchestratorCollapsed(!currentlyCollapsed);
  });

  orchestratorHeader.append(orchestratorTitle, orchestratorHeaderActions);
  orchestratorContent.append(orchestratorActions);
  orchestratorCard.append(orchestratorHeader, orchestratorContent);
  setOrchestratorCollapsed(false);

  wrapper.append(orchestratorCard);

  const appsCard = document.createElement("section");
  appsCard.className = "wm-card wm-home-apps";

  const appsHeader = document.createElement("div");
  appsHeader.className = "wm-home-section-header";

  const appsTitle = document.createElement("h2");
  appsTitle.textContent = "Running Apps";
  appsHeader.append(appsTitle);
  appsCard.append(appsHeader);

  const appsContent = document.createElement("div");
  appsContent.className = "wm-home-apps-content";

  if (state.apps.error) {
    const error = document.createElement("p");
    error.className = "wm-home-apps-status";
    error.textContent = state.apps.error;
    appsContent.append(error);
  } else {
    const runningApps = Array.isArray(state.apps.items)
      ? state.apps.items.filter((app) => app?.status?.status === "running")
      : [];

    if (state.apps.loading && !state.apps.initialized) {
      const loading = document.createElement("p");
      loading.className = "wm-home-apps-status";
      loading.textContent = "Loading apps…";
      appsContent.append(loading);
    } else if (runningApps.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-home-apps-status";
      empty.textContent = "No apps are currently running.";
      appsContent.append(empty);
    } else {
      const table = document.createElement("table");
      table.className = "wm-home-apps-table";

      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      ["App", "Status", "Root", "Actions"].forEach((label) => {
        const th = document.createElement("th");
        th.textContent = label;
        headerRow.append(th);
      });
      thead.append(headerRow);
      table.append(thead);

      const tbody = document.createElement("tbody");
      runningApps.forEach((app) => {
        const row = document.createElement("tr");

        const nameCell = document.createElement("td");
        nameCell.textContent = app.label ?? app.id;
        row.append(nameCell);

        const statusCell = document.createElement("td");
        const statusValue = app?.status?.status ?? "unknown";
        statusCell.textContent = APP_STATUS_LABELS[statusValue] ?? statusValue;
        row.append(statusCell);

        const rootCell = document.createElement("td");
        rootCell.textContent = app.root ?? "—";
        rootCell.title = app.root ?? "";
        row.append(rootCell);

        const actionsCell = document.createElement("td");
        actionsCell.className = "wm-home-apps-actions";

        const addActionButton = (action) => {
          if (!app.availableScripts?.[action]) return;
          if (app.id === "wingman-core" && action === "stop") return;
          const button = document.createElement("button");
          button.type = "button";
          button.className = action === "stop" ? "wm-button secondary" : "wm-button";
          button.textContent = APP_ACTION_LABELS[action] ?? action;
          button.disabled = isAppActionDisabled(app, action);
          button.addEventListener("click", async () => {
            if (button.disabled) return;
            button.disabled = true;
            const success = await triggerAppAction(app.id, action);
            if (!success && button.isConnected) {
              button.disabled = false;
            }
          });
          actionsCell.append(button);
        };

        addActionButton("stop");
        addActionButton("restart");

        if (!actionsCell.hasChildNodes()) {
          actionsCell.textContent = "—";
        }

        row.append(actionsCell);
        tbody.append(row);
      });

      table.append(tbody);
      appsContent.append(table);
    }
  }

  appsCard.append(appsContent);

  const liveCard = document.createElement("section");
  liveCard.className = "wm-card wm-home-live";

  const liveHeader = document.createElement("div");
  liveHeader.className = "wm-home-section-header";

  const liveTitle = document.createElement("h2");
  liveTitle.textContent = "Live Agents";

  const liveContent = document.createElement("div");
  liveContent.className = "wm-home-live-content";
  liveContent.id = "live-agents-content";

  const setCollapsed = (collapsed) => {
    if (collapsed) {
      liveCard.dataset.collapsed = "true";
      liveContent.hidden = true;
    } else {
      delete liveCard.dataset.collapsed;
      liveContent.hidden = false;
    }
  };

  // Make header clickable to toggle collapse
  liveHeader.addEventListener("click", () => {
    const currentlyCollapsed = liveCard.dataset.collapsed === "true";
    setCollapsed(!currentlyCollapsed);
  });

  liveHeader.append(liveTitle);
  liveCard.append(liveHeader);

  const renderSessionActions = (target, session) => {
    const resumeBtn = document.createElement("button");
    resumeBtn.className = "wm-button";
    resumeBtn.textContent = "Resume";
    resumeBtn.addEventListener("click", () => resumeSession(session.id));
    target.append(resumeBtn);

    if (isSessionActive(session)) {
      const stopBtn = document.createElement("button");
      stopBtn.className = "wm-button secondary";
      stopBtn.textContent = "Stop";
      stopBtn.addEventListener("click", () => stopSession(session.id));
      target.append(stopBtn);
    } else {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "wm-button secondary";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => deleteSession(session.id));
      target.append(deleteBtn);
    }
  };

  const actions = document.createElement("div");
  actions.className = "wm-actions";

  const filterContainer = document.createElement("div");
  filterContainer.className = "wm-session-filter";
  const filterLabel = document.createElement("label");
  filterLabel.textContent = "Identity";
  const filterSelect = document.createElement("select");
  filterSelect.className = "wm-select";
  buildSessionFilterOptions().forEach((option) => {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    if (option.value === state.sessionFilters.npub) {
      opt.selected = true;
    }
    filterSelect.append(opt);
  });
  filterSelect.addEventListener("change", (event) => {
    const target = event.target;
    const value = target instanceof HTMLSelectElement && target.value ? target.value : "all";
    state.sessionFilters.npub = value;
    void fetchSessions().then(() => {
      syncMenuTabs();
      if (currentRoute === "home" || currentRoute === "live") {
        render();
      }
    });
  });
  filterLabel.append(filterSelect);
  filterContainer.append(filterLabel);
  actions.append(filterContainer);

  const launchBtn = document.createElement("button");
  launchBtn.className = "wm-button";
  launchBtn.textContent = "Launch Agent Session";
  launchBtn.addEventListener("click", openDialog);
  actions.append(launchBtn);

  const table = document.createElement("table");
  table.className = "session-table";

  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th>Name</th><th>Agent</th><th>Identity</th><th>Status</th><th>Port</th><th>PID</th><th>Started</th><th>Directory</th><th></th></tr>";
  table.append(thead);

  const tbody = document.createElement("tbody");
  if (state.sessions.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.textContent = "No active sessions";
    row.append(cell);
    tbody.append(row);
  } else {
    state.sessions.forEach((session) => {
      const row = document.createElement("tr");
      const displayName = getSessionDisplayName(session);
      const identityLabel = session.npub && session.npub.length > 0 ? session.npub : "Anonymous";
      row.innerHTML = `
        <td>${escapeHtml(displayName)}</td>
        <td>${escapeHtml(session.agent)}</td>
        <td class="identity-cell" title="${escapeHtml(identityLabel)}">${escapeHtml(identityLabel)}</td>
        <td>${escapeHtml(session.status)}</td>
        <td>${escapeHtml(session.port)}</td>
        <td>${session.pid ?? "-"}</td>
        <td>${new Date(session.startedAt).toLocaleTimeString()}</td>
        <td class="directory-cell"></td>
        <td></td>
      `;
      const directoryCell = row.querySelector(".directory-cell");
      if (directoryCell) {
        const directoryValue =
          session.workingDirectory ??
          state.config?.defaultDirectory ??
          "-";
        directoryCell.textContent = directoryValue;
        if (typeof session.workingDirectory === "string") {
          directoryCell.title = session.workingDirectory;
        } else {
          directoryCell.removeAttribute("title");
        }
      }
      const actionsCell = row.lastElementChild;

      renderSessionActions(actionsCell, session);
      tbody.append(row);
    });
  }

  table.append(tbody);

  const tableContainer = document.createElement("div");
  tableContainer.className = "wm-table-container session-table-wrapper";
  tableContainer.append(table);

  const cardsContainer = document.createElement("div");
  cardsContainer.className = "session-card-list";
  if (state.sessions.length === 0) {
    const emptyCard = document.createElement("article");
    emptyCard.className = "session-card empty";
    emptyCard.textContent = "No active sessions";
    cardsContainer.append(emptyCard);
  } else {
    state.sessions.forEach((session) => {
      const card = document.createElement("article");
      card.className = "session-card";

      const header = document.createElement("header");
      header.className = "session-card-header";
      const title = document.createElement("h3");
      const displayName = getSessionDisplayName(session);
      title.textContent = displayName;
      const status = document.createElement("span");
      status.className = `session-status ${session.status}`;
      status.textContent = session.status;
      header.append(title, status);
      card.append(header);

      const details = document.createElement("div");
      details.className = "session-card-details";
      const addDetail = (label, value) => {
        const item = document.createElement("div");
        item.className = "session-card-detail";
        const term = document.createElement("span");
        term.className = "session-card-detail-label";
        term.textContent = label;
        const desc = document.createElement("span");
        desc.className = "session-card-detail-value";
        desc.textContent = value ?? "-";
        item.append(term, desc);
        details.append(item);
      };

      addDetail("Agent", session.agent);
      addDetail("Identity", session.npub ?? "Anonymous");
      addDetail("Port", session.port ?? "-");
      addDetail("PID", session.pid ?? "-");
      addDetail("Started", new Date(session.startedAt).toLocaleTimeString());
      const directoryValue =
        session.workingDirectory ?? state.config?.defaultDirectory ?? "-";
      addDetail("Directory", directoryValue);
      card.append(details);

      const actionRow = document.createElement("div");
      actionRow.className = "session-card-actions";
      renderSessionActions(actionRow, session);
      card.append(actionRow);

      cardsContainer.append(card);
    });
  }

  liveContent.append(actions, cardsContainer, tableContainer);
  liveCard.append(liveContent);

  setCollapsed(false);
  wrapper.append(liveCard);
  wrapper.append(appsCard);
  return wrapper;
};

const promptCreateDirectory = async () => {
  const files = state.files;
  if (files.loading) return;
  const parentPath = files.currentPath;
  const rawName = window.prompt("Folder name", "New Folder");
  const name = rawName?.trim();
  if (!name) return;
  files.loading = true;
  if (currentRoute === "files") render();
  try {
    const result = await createFilesDirectory(parentPath, name);
    await loadFilesTree(result?.path ?? parentPath);
  } catch (error) {
    files.loading = false;
    if (currentRoute === "files") render();
    const message = error instanceof Error ? error.message : "Failed to create directory";
    window.alert(message);
  }
};

const promptCreateFile = async () => {
  const files = state.files;
  if (files.loading) return;
  const parentPath = files.currentPath;
  const rawName = window.prompt("File name (include extension)", "notes.txt");
  const name = rawName?.trim();
  if (!name) return;
  files.loading = true;
  if (currentRoute === "files") render();
  try {
    const result = await createFilesTextFile(parentPath, name, "");
    await loadFilesTree(parentPath);
    if (result?.path) {
      if (result.previewable) {
        void loadFilesPreview(result.path);
      } else {
        resetFilesPreview();
        if (currentRoute === "files") render();
      }
      void openFileEditor(result.path, result.displayPath ?? null, result.name ?? null);
    }
  } catch (error) {
    files.loading = false;
    if (currentRoute === "files") render();
    const message = error instanceof Error ? error.message : "Failed to create file";
    window.alert(message);
  }
};

const uploadSelectedFile = async (file) => {
  if (!(file instanceof File)) return;
  const files = state.files;
  if (files.loading || files.uploading) return;
  const parentPath = files.currentPath;
  files.uploading = true;
  if (currentRoute === "files") render();
  try {
    const result = await uploadFilesBinary(parentPath, file);
    await loadFilesTree(parentPath);
    if (result?.path && result.previewable) {
      void loadFilesPreview(result.path);
    }
  } catch (error) {
    files.uploading = false;
    if (currentRoute === "files") render();
    const message = error instanceof Error ? error.message : "Failed to upload file";
    window.alert(message);
    return;
  }
  files.uploading = false;
  if (currentRoute === "files") render();
};

const promptUploadFile = () => {
  const files = state.files;
  if (files.loading || files.uploading) return;
  const input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  input.addEventListener("change", () => {
    const [selected] = input.files ?? [];
    if (selected) {
      void uploadSelectedFile(selected);
    }
    input.remove();
  });
  input.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.body.append(input);
  input.click();
};

const runGitCommand = async (action) => {
  if (!action) return "cancelled";
  const files = state.files;
  if (files.gitCommandPending) return "cancelled";

  const requiresRepository = action !== "init";
  const gitInfo = files.git;
  const inRepository = Boolean(gitInfo?.isRepository);

  if (requiresRepository && !inRepository) {
    window.alert("Initialize a git repository before running this command.");
    return "cancelled";
  }

  const directory =
    action === "init" && !inRepository ? files.currentPath ?? gitInfo?.repoRoot ?? null : gitInfo?.repoRoot ?? files.currentPath ?? null;

  if (!directory) {
    window.alert("Select a directory before running git commands.");
    return "cancelled";
  }

  const payload = { action, directory };

  if (action === "commit") {
    const rawMessage = window.prompt("Commit message", "");
    if (rawMessage === null) {
      return "cancelled";
    }
    const message = rawMessage.trim();
    if (!message) {
      window.alert("Commit message cannot be empty.");
      return "cancelled";
    }
    payload.message = message;
  } else if (action === "push") {
    const remotePrompt = window.prompt("Remote name (leave blank for tracked remote)", "");
    if (remotePrompt === null) {
      return "cancelled";
    }
    const remote = remotePrompt.trim();
    const defaultBranch =
      gitInfo?.currentBranch && gitInfo.currentBranch !== "HEAD" ? gitInfo.currentBranch : "";
    const branchPrompt = window.prompt("Branch name (leave blank for current tracking branch)", defaultBranch);
    if (branchPrompt === null) {
      return "cancelled";
    }
    const branch = branchPrompt.trim();
    if (remote) {
      payload.remote = remote;
      if (branch) {
        payload.branch = branch;
      }
    }
  } else if (action === "pushUpstream") {
    const remotePrompt = window.prompt("Remote name", "origin");
    if (remotePrompt === null) {
      return "cancelled";
    }
    const remote = remotePrompt.trim() || "origin";
    const defaultBranch =
      gitInfo?.currentBranch && gitInfo.currentBranch !== "HEAD" ? gitInfo.currentBranch : "main";
    const branchPrompt = window.prompt("Branch name", defaultBranch);
    if (branchPrompt === null) {
      return "cancelled";
    }
    const branch = branchPrompt.trim();
    if (!branch) {
      window.alert("Branch name is required to set upstream.");
      return "cancelled";
    }
    payload.remote = remote;
    payload.branch = branch;
  }

  files.gitCommandPending = true;
  if (currentRoute === "files") {
    render();
  }

  try {
    const response = await fetch("/api/docs/git", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      const exitCode = typeof data?.exitCode === "number" ? ` (exit ${data.exitCode})` : "";
      const message = typeof data?.error === "string" && data.error.length > 0 ? data.error : "Git command failed";
      throw new Error(`${message}${exitCode}`);
    }

    const stdout = typeof data?.stdout === "string" ? data.stdout.trim() : "";
    const stderr = typeof data?.stderr === "string" ? data.stderr.trim() : "";
    const output = [stdout, stderr].filter((part) => part.length > 0).join("\n");
    window.alert(output || "Git command completed successfully.");

    if (files.currentPath) {
      await loadFilesTree(files.currentPath);
    } else {
      await loadFilesTree();
    }
    return "success";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    window.alert(message);
    return "error";
  } finally {
    files.gitCommandPending = false;
    if (currentRoute === "files") {
      render();
    }
  }
};

const renderFiles = () => {
  const files = state.files;
  if (!files.initialized) {
    files.initialized = true;
    void loadFilesTree();
  }

  const wrapper = document.createElement("div");
  wrapper.className = "wm-files";

  const layout = document.createElement("div");
  layout.className = "wm-files-layout";

  const browserCard = document.createElement("section");
  browserCard.className = "wm-card wm-files-browser";

  const browserHeader = document.createElement("div");
  browserHeader.className = "wm-files-browser__header";

  const headerButton = document.createElement("button");
  headerButton.type = "button";
  headerButton.className = "wm-files-browser__info";
  headerButton.setAttribute("aria-expanded", "true");
  const headerTitle = document.createElement("h2");
  headerTitle.textContent = "Files";
  const pathLabel = document.createElement("span");
  pathLabel.className = "wm-files-browser__path";
  pathLabel.textContent = files.displayPath ?? "~";
  headerButton.append(headerTitle, pathLabel);

  const controls = document.createElement("div");
  controls.className = "wm-files-browser__controls";

  const upButton = document.createElement("button");
  upButton.type = "button";
  upButton.className = "wm-button secondary wm-button-icon";
  setIconButton(upButton, "arrowUp", "Go up one directory");
  upButton.disabled = files.loading || !files.parent?.path;
  upButton.addEventListener("click", () => {
    if (files.loading) return;
    if (files.parent?.path) {
      void loadFilesTree(files.parent.path);
    }
  });

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "wm-button secondary wm-button-icon";
  setIconButton(refreshButton, "refresh", "Refresh directory contents");
  refreshButton.disabled = files.loading;
  refreshButton.addEventListener("click", () => {
    if (files.loading) return;
    void loadFilesTree(files.currentPath);
  });

  const toggleHiddenButton = document.createElement("button");
  toggleHiddenButton.type = "button";
  toggleHiddenButton.className = "wm-button secondary wm-button-icon";
  toggleHiddenButton.disabled = files.loading;
  const syncHiddenButtonIcon = () => {
    const iconKey = files.showHidden ? "eyeOff" : "eye";
    const label = files.showHidden ? "Hide hidden files" : "Show hidden files";
    setIconButton(toggleHiddenButton, iconKey, label);
    toggleHiddenButton.setAttribute("aria-pressed", files.showHidden ? "true" : "false");
  };
  syncHiddenButtonIcon();
  toggleHiddenButton.addEventListener("click", () => {
    if (files.loading) return;
    files.showHidden = !files.showHidden;
    syncHiddenButtonIcon();
    try {
      localStorage.setItem(FILES_SHOW_HIDDEN_STORAGE_KEY, files.showHidden ? "true" : "false");
    } catch {
      // Ignore storage failures
    }
    void loadFilesTree(files.currentPath);
    if (currentRoute === "files") {
      render();
    }
  });

  const newFolderButton = document.createElement("button");
  newFolderButton.type = "button";
  newFolderButton.className = "wm-button secondary wm-button-icon";
  setIconButton(newFolderButton, "folderPlus", "Create new folder");
  newFolderButton.disabled = files.loading;
  newFolderButton.addEventListener("click", () => {
    if (files.loading) return;
    void promptCreateDirectory();
  });

  const newFileButton = document.createElement("button");
  newFileButton.type = "button";
  newFileButton.className = "wm-button secondary wm-button-icon";
  setIconButton(newFileButton, "filePlus", "Create new file");
  newFileButton.disabled = files.loading;
  newFileButton.addEventListener("click", () => {
    if (files.loading) return;
    void promptCreateFile();
  });

  const uploadButton = document.createElement("button");
  uploadButton.type = "button";
  uploadButton.className = "wm-button secondary wm-button-icon";
  const syncUploadButtonState = () => {
    uploadButton.disabled = files.loading || files.uploading;
    setIconButton(uploadButton, "upload", files.uploading ? "Uploading…" : "Upload file");
    if (files.uploading) {
      uploadButton.dataset.loading = "true";
    } else {
      delete uploadButton.dataset.loading;
    }
  };
  syncUploadButtonState();
  uploadButton.addEventListener("click", () => {
    if (files.loading || files.uploading) return;
    promptUploadFile();
  });

  const gitWrapper = document.createElement("div");
  gitWrapper.className = "wm-files-browser__git";
  const gitSelect = document.createElement("select");
  gitSelect.className = "wm-select";
  gitSelect.setAttribute("aria-label", "Git commands");
  const gitPlaceholder = document.createElement("option");
  gitPlaceholder.value = "";
  gitPlaceholder.textContent = "Git…";
  gitSelect.append(gitPlaceholder);
  const gitOptions = [
    { value: "addAll", label: "git add .", requiresRepo: true },
    { value: "commit", label: "git commit -m", requiresRepo: true },
    { value: "push", label: "git push", requiresRepo: true },
    { value: "pushUpstream", label: "git push -u origin <branch>", requiresRepo: true },
    { value: "init", label: "git init", requiresRepo: false },
  ];
  const repoReady = Boolean(files.git?.isRepository);
  gitOptions.forEach((optionDef) => {
    const option = document.createElement("option");
    option.value = optionDef.value;
    option.textContent = optionDef.label;
    if (optionDef.requiresRepo && !repoReady) {
      option.disabled = true;
    }
    gitSelect.append(option);
  });
  const gitRunButton = document.createElement("button");
  gitRunButton.type = "button";
  gitRunButton.className = "wm-button secondary";
  const updateGitControlsState = () => {
    const disabled = files.loading || files.gitCommandPending;
    gitSelect.disabled = disabled;
    gitRunButton.disabled = disabled || gitSelect.value === "";
    if (files.gitCommandPending) {
      gitRunButton.dataset.loading = "true";
      gitRunButton.textContent = "Running…";
    } else {
      delete gitRunButton.dataset.loading;
      gitRunButton.textContent = "Run";
    }
  };
  updateGitControlsState();
  gitSelect.addEventListener("change", () => {
    updateGitControlsState();
  });
  gitRunButton.addEventListener("click", async () => {
    const action = gitSelect.value;
    if (!action) return;
    const outcome = await runGitCommand(action);
    if (outcome !== "cancelled") {
      gitSelect.value = "";
    }
    updateGitControlsState();
  });
  gitWrapper.append(gitSelect, gitRunButton);

  controls.append(
    upButton,
    refreshButton,
    toggleHiddenButton,
    newFolderButton,
    newFileButton,
    uploadButton,
    gitWrapper,
  );

  if (canCreateWorktree()) {
    const worktreeButton = document.createElement("button");
    worktreeButton.type = "button";
    worktreeButton.className = "wm-button wm-button-icon";
    setIconButton(worktreeButton, "branchPlus", "Create new worktree");
    worktreeButton.disabled = files.loading || state.files.worktreeModal.submitting;
    worktreeButton.addEventListener("click", () => {
      if (files.loading) return;
      openWorktreeModal();
    });
    if (state.files.worktreeModal.submitting) {
      worktreeButton.dataset.loading = "true";
    }
    controls.append(worktreeButton);
  }

  browserHeader.append(headerButton, controls);

  const list = document.createElement("ul");
  list.className = "wm-files-browser__list";
  list.id = "files-browser-list";
  headerButton.setAttribute("aria-controls", list.id);

  const collapsed = Boolean(files.browserCollapsed);
  const setBrowserCollapsed = (next) => {
    files.browserCollapsed = next;
    if (next) {
      browserCard.dataset.collapsed = "true";
      list.hidden = true;
      list.setAttribute("aria-hidden", "true");
      headerButton.setAttribute("aria-expanded", "false");
    } else {
      delete browserCard.dataset.collapsed;
      list.hidden = false;
      list.removeAttribute("aria-hidden");
      headerButton.setAttribute("aria-expanded", "true");
    }
  };
  setBrowserCollapsed(collapsed);
  headerButton.addEventListener("click", () => {
    setBrowserCollapsed(!files.browserCollapsed);
  });
  headerButton.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " " || event.key === "Space") {
      event.preventDefault();
      setBrowserCollapsed(!files.browserCollapsed);
    }
  });

  if (files.error) {
    const item = document.createElement("li");
    item.className = "wm-files-browser__status";
    item.textContent = files.error;
    list.append(item);
  } else {
    const entries = Array.isArray(files.entries) ? files.entries : [];
    if (entries.length === 0 && !files.loading) {
      const empty = document.createElement("li");
      empty.className = "wm-files-browser__status";
      empty.textContent = "Directory is empty.";
      list.append(empty);
    }

    entries.forEach((entry) => {
      const item = document.createElement("li");
      item.className = "wm-files-browser__item";
      item.dataset.type = entry.type;
      if (entry.type === "file" && entry.path === files.previewPath) {
        item.dataset.selected = "true";
      }

      const button = document.createElement("button");
      button.type = "button";

      const name = document.createElement("span");
      name.className = "wm-files-browser__name";
      const iconKey =
        entry.type === "directory"
          ? "folder"
          : entry.previewable
            ? entry.previewFormat === "markdown"
              ? "fileText"
              : "fileCode"
            : "ban";
      const iconDefinition = FILE_BROWSER_ICON_DEFS[iconKey] ?? FILE_BROWSER_ICON_DEFS.file;
      const icon = createIconSvg(iconDefinition);
      const iconWrapper = document.createElement("span");
      iconWrapper.className = "wm-files-browser__icon";
      iconWrapper.setAttribute("aria-hidden", "true");
      iconWrapper.append(icon);
      const label = document.createElement("span");
      label.textContent = entry.name;
      name.append(iconWrapper, label);
      button.append(name);

      const meta = document.createElement("span");
      meta.className = "wm-files-browser__meta";
      if (entry.type === "directory") {
        meta.textContent = "Folder";
      } else if (entry.previewable) {
        meta.textContent = entry.previewLabel ?? (entry.previewFormat === "markdown" ? "Markdown" : "Code");
      } else {
        meta.textContent = "Preview unavailable";
      }
      button.append(meta);

      if (entry.type === "directory") {
        button.addEventListener("click", () => {
          if (files.loading) return;
          void loadFilesTree(entry.path);
        });
      } else if (entry.previewable) {
        button.addEventListener("click", () => {
          if (files.previewPath !== entry.path || files.previewError) {
            void loadFilesPreview(entry.path);
          } else if (!files.previewLoading) {
            void loadFilesPreview(entry.path);
          }
        });
      } else {
        button.addEventListener("click", () => {
          showFilesPreviewUnavailable(entry);
        });
      }

      item.append(button);
      list.append(item);
    });

    if (files.uploading && !files.loading) {
      const uploadingItem = document.createElement("li");
      uploadingItem.className = "wm-files-browser__status";
      uploadingItem.textContent = "Uploading file…";
      list.append(uploadingItem);
    }

    if (files.loading) {
      const loadingItem = document.createElement("li");
      loadingItem.className = "wm-files-browser__status";
      loadingItem.textContent = "Loading…";
      list.append(loadingItem);
    }
  }

  browserCard.append(browserHeader, list);

  const previewCard = document.createElement("section");
  previewCard.className = "wm-card wm-files-preview";

  const previewHeader = document.createElement("div");
  previewHeader.className = "wm-files-preview__header";
  const previewTitle = document.createElement("h2");
  previewTitle.className = "wm-files-preview__title";
  previewTitle.textContent = files.previewName ?? "Preview";
  const previewPathRow = document.createElement("div");
  previewPathRow.className = "wm-files-preview__path-row";
  const previewPath = document.createElement("p");
  previewPath.className = "wm-files-preview__path";
  if (files.previewDisplayPath) {
    previewPath.textContent = files.previewDisplayPath;
  } else if (files.previewName) {
    previewPath.textContent = files.previewName;
  } else {
    previewPath.textContent = "~";
  }
  if (files.previewLabel) {
    const formatBadge = document.createElement("span");
    formatBadge.className = "wm-files-preview__badge";
    formatBadge.textContent = files.previewLabel;
    previewPath.append(document.createTextNode(" "), formatBadge);
  }
  previewPathRow.append(previewPath);

  const copyablePath = files.previewDisplayPath || files.previewPath || null;
  if (copyablePath) {
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "wm-files-copy-link";
    copyButton.setAttribute("aria-label", "Copy file path");
    copyButton.title = "Copy file path";
    const defaultIcon =
      '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M16 1H8a2 2 0 0 0-2 2v2H5a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8l1-2H5V7h1v2h10V3h2v9l2-1V3a2 2 0 0 0-2-2Zm-2 6H8V3h6v4Zm7.71 9.29-5-5a1 1 0 0 0-1.42 1.42l1.3 1.29-4.59 4.59V22h3.41l4.59-4.59 1.29 1.3a1 1 0 0 0 1.42-1.42Z"/></svg>';
    const successIcon =
      '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="m9 16.17-3.5-3.5L4.08 14.1 9 19l12-12-1.41-1.41Z"/></svg>';
    copyButton.innerHTML = defaultIcon;
    copyButton.addEventListener("click", async () => {
      const text = copyablePath;
      if (!text) return;
      const success = await copyTextToClipboard(text);
      if (success) {
        copyButton.dataset.copied = "true";
        copyButton.innerHTML = successIcon;
        setTimeout(() => {
          if (copyButton.isConnected) {
            delete copyButton.dataset.copied;
            copyButton.innerHTML = defaultIcon;
          }
        }, 1600);
      }
    });
    previewPathRow.append(copyButton);
  }

  const previewInfo = document.createElement("div");
  previewInfo.className = "wm-files-preview__info";
  previewInfo.append(previewTitle, previewPathRow);
  previewHeader.append(previewInfo);

  const previewActions = document.createElement("div");
  previewActions.className = "wm-files-preview__actions";
  const hasFileSelection = typeof files.previewPath === "string" && !files.previewLoading;
  const canEdit = hasFileSelection && !files.previewError && files.previewContent !== null;

  if (canEdit) {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "wm-button secondary";
    editButton.textContent = "Edit File";
    editButton.addEventListener("click", () => {
      void openFileEditor(files.previewPath, files.previewDisplayPath ?? null, files.previewName ?? null);
    });
    previewActions.append(editButton);
  }

  if (hasFileSelection) {
    const copyUrlButton = document.createElement("button");
    copyUrlButton.type = "button";
    copyUrlButton.className = "wm-button secondary";
    copyUrlButton.textContent = "Copy URL";
    copyUrlButton.addEventListener("click", async () => {
      const targetPath = typeof files.previewPath === "string" ? files.previewPath : null;
      if (!targetPath) return;
      const rawUrl = `${window.location.origin}/api/docs/file/raw?path=${encodeURIComponent(targetPath)}`;
      const success = await copyTextToClipboard(rawUrl);
      if (success) {
        const originalText = "Copy URL";
        copyUrlButton.dataset.copied = "true";
        copyUrlButton.textContent = "Copied!";
        setTimeout(() => {
          if (copyUrlButton.isConnected) {
            delete copyUrlButton.dataset.copied;
            copyUrlButton.textContent = originalText;
          }
        }, 1600);
      } else {
        window.alert("Unable to copy the file URL. Copy it manually from the address bar instead.");
      }
    });
    previewActions.append(copyUrlButton);

    const copyToButton = document.createElement("button");
    copyToButton.type = "button";
    copyToButton.className = "wm-button";
    copyToButton.textContent = "Copy File To…";
    copyToButton.addEventListener("click", () => {
      void openFileTransferDialogForMode("copy");
    });
    previewActions.append(copyToButton);

    const moveToButton = document.createElement("button");
    moveToButton.type = "button";
    moveToButton.className = "wm-button";
    moveToButton.textContent = "Move File To…";
    moveToButton.addEventListener("click", () => {
      void openFileTransferDialogForMode("move");
    });
    previewActions.append(moveToButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "wm-button secondary";
    deleteButton.textContent = "Delete File";
    deleteButton.addEventListener("click", async () => {
      const targetPath = typeof files.previewPath === "string" ? files.previewPath : null;
      if (!targetPath) return;
      const displayName = files.previewName ?? files.previewDisplayPath ?? targetPath;
      const confirmed = window.confirm(`Delete "${displayName}"? This cannot be undone.`);
      if (!confirmed) {
        return;
      }
      const originalText = deleteButton.textContent;
      deleteButton.disabled = true;
      deleteButton.dataset.loading = "true";
      deleteButton.textContent = "Deleting…";
      try {
        await deleteFilesEntry(targetPath);
        resetFilesPreview();
        render();
        await loadFilesTree(state.files.currentPath);
      } catch (error) {
        deleteButton.disabled = false;
        deleteButton.textContent = originalText;
        deleteButton.removeAttribute("data-loading");
        const message = error instanceof Error ? error.message : "Failed to delete file";
        window.alert(message);
      }
    });
    previewActions.append(deleteButton);
  }

  if (previewActions.childElementCount > 0) {
    previewHeader.append(previewActions);
  }

  const previewBody = document.createElement("div");
  previewBody.className = "wm-files-preview__body";

  if (files.previewLoading) {
    previewBody.dataset.loading = "true";
    previewBody.textContent = "Loading preview…";
  } else if (files.previewError) {
    const error = document.createElement("div");
    error.className = "wm-files-browser__status";
    error.textContent = files.previewError;
    previewBody.append(error);
  } else if (files.previewContent !== null) {
    if (files.previewFormat === "markdown") {
      if (files.previewContent.trim().length > 0) {
        const content = document.createElement("div");
        content.className = "wm-files-preview-content";
        content.innerHTML = renderMarkdownToHtml(files.previewContent);
        previewBody.append(content);
      } else {
        previewBody.dataset.empty = "true";
        previewBody.textContent = "This document is empty.";
      }
    } else {
      const content = document.createElement("div");
      content.className = "wm-files-preview-code";
      content.innerHTML = renderCodeToHtml(files.previewContent, files.previewLanguage ?? "plaintext");
      previewBody.append(content);
    }
  } else {
    previewBody.dataset.empty = "true";
    previewBody.textContent = "Select a previewable file to view.";
  }

  previewCard.append(previewHeader, previewBody);

  layout.append(browserCard, previewCard);
  wrapper.append(layout);
  return wrapper;
};

const renderSettings = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-settings";

  const pageTitle = document.createElement("h1");
  pageTitle.textContent = "Settings";
  wrapper.append(pageTitle);

  wrapper.append(renderIdentityPanel());

  const sections = [
    {
      title: "Wingman Settings",
      description: "Adjust global preferences for the Wingman workspace.",
    },
    {
      title: "Agent Settings",
      description: "Manage default behaviors for the connected agents.",
    },
    {
      title: "Orchestrator Settings",
      description: "Tune orchestrator automation and preset options.",
    },
    {
      title: "User Settings",
      description: "Update your personal profile and interface choices.",
    },
    {
      title: "Team Settings",
      description: "Coordinate shared settings and access for your team.",
    },
  ];

  sections.forEach((section) => {
    const card = document.createElement("section");
    card.className = "wm-card";

    const heading = document.createElement("h2");
    heading.textContent = section.title;

    const description = document.createElement("p");
    description.textContent = section.description;

    card.append(heading, description);
    wrapper.append(card);
  });

  return wrapper;
};

const renderSessionTabs = (options = {}) => {
  const onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
  const tabs = document.createElement("div");
  tabs.className = "wm-tabs menu";

  const activeSessions = getActiveSessions();
  activeSessions.forEach((session) => {
    const tab = document.createElement("div");
    tab.className = "wm-tab";
    if (session.id === state.activeSessionId) {
      tab.classList.add("active");
    }

    const displayName = getSessionDisplayName(session);
    const safeLabel = escapeHtml(displayName);
    tab.innerHTML = `
      <span>${safeLabel}</span>
      <span class="close" title="Stop session">×</span>
    `;
    tab.title = `${displayName} - ${session.agent}:${session.port}`;

    tab.addEventListener("click", () => {
      const wasLiveRoute = currentRoute === "live";
      if (state.activeSessionId === session.id && wasLiveRoute) {
        // Already active, no need to switch
        onSelect?.();
        return;
      }
      currentRoute = "live";
      setActiveSession(session.id, { updateHistory: true, forceLog: true });
      fetchLogs(session.id);
      fetchConversation(session.id);
      if (wasLiveRoute) {
        // Don't call render() when already on Live - it will destroy DOM references
        // Instead, just update the tabs to show active state
        if (tabsVisible) {
          const tabsBar = document.querySelector('.wm-tabs-bar');
          if (tabsBar) {
            const existingTabs = tabsBar.querySelector('.wm-tabs');
            if (existingTabs) {
              const newTabs = renderTabs();
              existingTabs.replaceWith(newTabs);
            }
          }
        }
        updateLivePanelsForSession(session.id);
      } else {
        render();
      }
      onSelect?.();
    });

    const closeButton = tab.querySelector(".close");
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      stopSession(session.id);
      onSelect?.();
    });

    tabs.append(tab);
  });

  return tabs;
};

const renderTabs = (options = {}) => {
  const variant = options.variant === "menu" ? "menu" : "default";
  const onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
  const tabs = document.createElement("div");
  tabs.className = `wm-tabs${variant === "menu" ? " menu" : ""}`;

  const activeSessions = getActiveSessions();
  activeSessions.forEach((session) => {
    const tab = document.createElement("div");
    tab.className = "wm-tab";
    if (session.id === state.activeSessionId) {
      tab.classList.add("active");
    }

    const displayName = getSessionDisplayName(session);
    const safeLabel = escapeHtml(displayName);
    tab.innerHTML = `
      <span>${safeLabel}</span>
      <span class="close" title="Stop session">×</span>
    `;
    tab.title = `${displayName} - ${session.agent}:${session.port}`;

    tab.addEventListener("click", () => {
      if (state.activeSessionId === session.id && currentRoute === "live") {
        // Already active, no need to switch
        onSelect?.();
        return;
      }
      currentRoute = "live";
      setActiveSession(session.id, { updateHistory: true, forceLog: true });
      fetchLogs(session.id);
      fetchConversation(session.id);
      // Don't call render() - it will destroy DOM references
      // Instead, just update the tabs to show active state
      if (tabsVisible) {
        const tabsBar = document.querySelector('.wm-tabs-bar');
        if (tabsBar) {
          const existingTabs = tabsBar.querySelector('.wm-tabs');
          if (existingTabs) {
            const newTabs = renderTabs();
            existingTabs.replaceWith(newTabs);
          }
        }
      }
      updateLivePanelsForSession(session.id);
      onSelect?.();
    });

    const closeButton = tab.querySelector(".close");
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      stopSession(session.id);
      onSelect?.();
    });

    tabs.append(tab);
  });

  const newTab = document.createElement("div");
  newTab.className = "wm-tab new";
  newTab.textContent = "+";
  newTab.title = "Start new session";
  newTab.addEventListener("click", () => {
    openDialog();
    onSelect?.();
  });
  tabs.append(newTab);

  return tabs;
};

const renderLogs = (sessionId) => {
  const logs = state.logs.get(sessionId) ?? ["No logs yet"];
  const panel = document.createElement("details");
  panel.className = "wm-log-panel";
  const summary = document.createElement("summary");
  summary.textContent = "Raw Terminal Output";
  const container = document.createElement("div");
  container.className = "log-viewer";
  container.textContent = logs.join("\n");
  const isOpen = state.logPanelOpen.get(sessionId) ?? false;
  panel.open = Boolean(isOpen);
  panel.addEventListener("toggle", () => {
    state.logPanelOpen.set(sessionId, panel.open);
  });
  panel.append(summary, container);

  // Store reference for incremental updates
  state.logContainers.set(sessionId, container);
  state.lastLogLength.set(sessionId, logs.length);

  return panel;
};

const renderConversation = (sessionId) => {
  const conversation = state.conversations.get(sessionId) ?? [];
  const wrapper = document.createElement("div");
  wrapper.className = "wm-conversation";

  if (conversation.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Conversation has no messages yet.";
    wrapper.append(empty);
  } else {
    conversation.forEach((message) => {
      const bubble = document.createElement("article");
      bubble.className = `wm-message ${message.type ?? message.role ?? "assistant"}`;
      const body = document.createElement("pre");
      body.textContent = message.content ?? message.message ?? "";
      bubble.append(body);
      attachCopyButton(bubble);
      wrapper.append(bubble);
    });
  }

  // Store reference for incremental updates
  state.conversationContainers.set(sessionId, wrapper);
  state.lastMessageCount.set(sessionId, conversation.length);

  return wrapper;
};

const renderComposer = (sessionId) => {
  const composerShell = document.createElement("div");
  composerShell.className = "wm-composer-shell";
  composerShell.dataset.sessionId = sessionId;

  const composer = document.createElement("form");
  composer.className = "wm-composer";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Ask the agent something...";
  textarea.value = state.messageDrafts.get(sessionId) ?? "";
  textarea.setAttribute("rows", "1");

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.style.display = "none";

  const attachmentInput = document.createElement("input");
  attachmentInput.type = "file";
  attachmentInput.multiple = true;
  attachmentInput.style.display = "none";

  const resizeTextarea = () => {
    textarea.style.height = "auto";
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
    const minHeight = lineHeight;
    const maxHeight = lineHeight * 8;
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  };

  let submit;
  let commandButton;
  const setUploadingState = (isUploading) => {
    if (isUploading) {
      composer.dataset.uploading = "true";
    } else {
      delete composer.dataset.uploading;
    }
    if (submit) {
      submit.disabled = Boolean(isUploading);
    }
    if (commandButton) {
      commandButton.disabled = Boolean(isUploading);
    }
  };

  textarea.addEventListener("input", (event) => {
    state.messageDrafts.set(sessionId, event.target.value);
    resizeTextarea();
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  textarea.addEventListener("paste", async (event) => {
    const items = event.clipboardData?.items ?? event.clipboardData?.files;
    const imageFiles = extractImageFiles(items);
    const otherFiles = extractAttachmentFiles(items);
    if (imageFiles.length > 0 || otherFiles.length > 0) {
      event.preventDefault();
    }
    if (imageFiles.length > 0) {
      await handleImageUploads(sessionId, imageFiles, textarea, resizeTextarea, setUploadingState);
    }
    if (otherFiles.length > 0) {
      await handleAttachmentUploads(sessionId, otherFiles, textarea, resizeTextarea, setUploadingState);
    }
  });

  const handleDropEvent = async (event) => {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const imageFiles = extractImageFiles(transfer.items ?? transfer.files);
    const otherFiles = extractAttachmentFiles(transfer.items ?? transfer.files);
    if (imageFiles.length === 0 && otherFiles.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (imageFiles.length > 0) {
      await handleImageUploads(sessionId, imageFiles, textarea, resizeTextarea, setUploadingState);
    }
    if (otherFiles.length > 0) {
      await handleAttachmentUploads(sessionId, otherFiles, textarea, resizeTextarea, setUploadingState);
    }
  };

  composer.addEventListener("dragover", (event) => {
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    event.preventDefault();
  });
  composer.addEventListener("drop", handleDropEvent);

  fileInput.addEventListener("change", async () => {
    const files = extractImageFiles(fileInput.files);
    if (files.length > 0) {
      await handleImageUploads(sessionId, files, textarea, resizeTextarea, setUploadingState);
    }
    fileInput.value = "";
  });

  attachmentInput.addEventListener("change", async () => {
    const files = extractAttachmentFiles(attachmentInput.files);
    if (files.length > 0) {
      await handleAttachmentUploads(sessionId, files, textarea, resizeTextarea, setUploadingState);
    }
    attachmentInput.value = "";
  });

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const draft = textarea.value;
    state.messageDrafts.set(sessionId, draft);
    const result = sendMessage(sessionId, draft);
    if (result?.finally) {
      result.finally(() => {
        requestAnimationFrame(() => {
          const newTextarea = document.querySelector('.wm-composer textarea');
          if (newTextarea) {
            newTextarea.focus();
          }
        });
      });
    }
  });

  commandButton = document.createElement("button");
  commandButton.type = "button";
  commandButton.className = "wm-button secondary wm-command-button";
  commandButton.innerHTML = '<span class="button-icon" aria-hidden="true">$></span><span class="button-text">Cmd</span>';
  commandButton.setAttribute("aria-haspopup", "true");
  commandButton.setAttribute("aria-expanded", "false");

  const commandMenu = document.createElement("div");
  commandMenu.className = "wm-command-menu";
  commandMenu.setAttribute("role", "menu");

  const addCommand = (label, handler) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "wm-command-item";
    item.textContent = label;
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => {
      handler();
      commandMenu.classList.remove("is-open");
      commandButton.setAttribute("aria-expanded", "false");
    });
    commandMenu.append(item);
  };

  addCommand("Scroll to end", () => {
    scrollConversationAreaToBottom(sessionId, { includeWindow: true });
  });

  addCommand("Copy chat", () => {
    copyConversationToClipboard(sessionId);
  });

  addCommand("Attach image", () => {
    fileInput.click();
  });

  addCommand("Upload file", () => {
    attachmentInput.click();
  });

  const toggleCommandMenu = () => {
    const isOpen = commandMenu.classList.toggle("is-open");
    commandButton.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) {
      const closeMenu = (event) => {
        if (!commandMenu.contains(event.target) && event.target !== commandButton) {
          commandMenu.classList.remove("is-open");
          commandButton.setAttribute("aria-expanded", "false");
          document.removeEventListener("mousedown", closeMenu);
          document.removeEventListener("touchstart", closeMenu);
        }
      };
      document.addEventListener("mousedown", closeMenu);
      document.addEventListener("touchstart", closeMenu, { passive: true });
    }
  };

  commandButton.addEventListener("click", () => {
    if (commandButton.disabled) return;
    toggleCommandMenu();
  });

  submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "wm-button";
  submit.innerHTML = '<span class="button-icon" aria-hidden="true">-&gt;</span><span class="button-text">Send</span>';
  submit.setAttribute("aria-label", "Send");

  const buttonGroup = document.createElement("div");
  buttonGroup.className = "wm-button-group";
  const commandWrapper = document.createElement("div");
  commandWrapper.className = "wm-command-wrapper";
  commandWrapper.append(commandButton, commandMenu);

  buttonGroup.append(commandWrapper, submit);

  composer.append(fileInput, attachmentInput, textarea, buttonGroup);
  composerShell.append(composer);

  resizeTextarea();

  requestAnimationFrame(() => {
    if (!document.contains(textarea)) return;
    textarea.focus();
    resizeTextarea();
  });

  return composerShell;
};

const updateLivePanelsForSession = (sessionId) => {
  const scrollRegion = document.querySelector('.wm-live-scroll');
  if (scrollRegion) {
    scrollRegion.innerHTML = "";
    const logSection = renderLogs(sessionId);
    scrollRegion.append(logSection);
    const conversationContainer = document.createElement("div");
    conversationContainer.className = "wm-live-conversation";
    conversationContainer.append(renderConversation(sessionId));
    scrollRegion.append(conversationContainer);
    requestAnimationFrame(() => {
      scrollConversationAreaToBottom(sessionId);
    });
  }

  const currentComposer = document.querySelector('.wm-composer-shell');
  if (currentComposer) {
    currentComposer.replaceWith(renderComposer(sessionId));
  } else {
    const liveWrapper = document.querySelector('.wm-live');
    if (liveWrapper) {
      liveWrapper.append(renderComposer(sessionId));
    }
  }
};

const renderLive = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-live";

  if (tabsVisible) {
    const tabsBar = document.createElement("div");
    tabsBar.className = "wm-tabs-bar";
    tabsBar.append(renderTabs());
    wrapper.append(tabsBar);
  }

  if (state.sessions.length === 0) {
    const container = document.createElement("section");
    container.className = "wm-card wm-live-main";
    const empty = document.createElement("p");
    empty.textContent = "No live sessions. Launch a new agent to begin.";
    container.append(empty);
    wrapper.append(container);
    return wrapper;
  }

  if (!state.activeSessionId || !state.sessions.some((session) => session.id === state.activeSessionId)) {
    ensureActiveSession();
  }

  if (!state.activeSessionId) {
    const container = document.createElement("section");
    container.className = "wm-card wm-live-main";
    const empty = document.createElement("p");
    empty.textContent = "No live session selected. Launch a new agent or use the menu to resume one.";
    container.append(empty);
    wrapper.append(container);
    return wrapper;
  }

  const sessionId = state.activeSessionId;

  const main = document.createElement("section");
  main.className = "wm-card wm-live-main";

  const scrollRegion = document.createElement("div");
  scrollRegion.className = "wm-live-scroll";
  const logSection = renderLogs(sessionId);
  scrollRegion.append(logSection);

  const conversationContainer = document.createElement("div");
  conversationContainer.className = "wm-live-conversation";
  conversationContainer.append(renderConversation(sessionId));
  scrollRegion.append(conversationContainer);
  requestAnimationFrame(() => {
    scrollConversationAreaToBottom(sessionId);
  });

  main.append(scrollRegion);
  wrapper.append(main);

  wrapper.append(renderComposer(sessionId));

  return wrapper;
};

const render = () => {
  appRoot.innerHTML = "";
  let view;
  if (currentRoute === "live") {
    view = renderLive();
  } else if (currentRoute === "apps") {
    view = renderApps();
  } else if (currentRoute === "files") {
    view = renderFiles();
  } else if (currentRoute === "settings") {
    view = renderSettings();
  } else {
    view = renderHome();
  }
  if (currentRoute !== "home") {
    detachHomeIdentityBannerListener?.();
  }
  appRoot.append(view);
  renderFileEditorOverlay();
  renderWorktreeModal();
  appRoot.dataset.route = currentRoute;
  setActiveNav();
  closeMenu();
  syncMenuTabs();
  syncDesktopSessionIndicator();
  syncSessionPolling();
  syncAppsPolling();
  lastFilesMobileLayout = isMobileFilesLayout();
  if (!pullRefreshing && !pullActive) {
    resetPullRefresh();
  }
};

const handleTouchStart = (event) => {
  if (!pullRefreshIndicator || pullRefreshing) return;
  if (document.body.dataset.menuOpen === "true") return;

  const touch = event.touches?.[0];
  if (!touch) return;

  // Only allow pull-to-refresh if touch starts in header area
  const header = document.querySelector('.wm-header');
  if (!header) return;

  const headerRect = header.getBoundingClientRect();
  if (touch.clientY < headerRect.top || touch.clientY > headerRect.bottom) {
    return;
  }

  pullStartY = touch.clientY;
  pullActive = true;
  pullReady = false;
};

const handleTouchMove = (event) => {
  if (!pullActive || pullRefreshing || !pullRefreshIndicator) return;
  const touch = event.touches?.[0];
  if (!touch) return;

  const delta = touch.clientY - (pullStartY ?? touch.clientY);
  if (delta <= 0) {
    pullReady = false;
    setPullState("pull", 0);
    return;
  }
  const distance = Math.min(delta, PULL_MAX);
  if (distance > 0) {
    try {
      event.preventDefault();
    } catch {
      // ignore
    }
  }
  if (distance >= PULL_THRESHOLD) {
    pullReady = true;
    setPullState("release", distance);
  } else {
    pullReady = false;
    setPullState("pull", distance);
  }
};

const finishPull = () => {
  if (!pullActive) return;
  pullActive = false;
  if (pullReady && !pullRefreshing) {
    triggerPullRefresh();
  } else {
    resetPullRefresh();
  }
};

function navigateToSettings({ skipMenuClose = false } = {}) {
  if (!skipMenuClose) {
    closeMenu();
  }
  closeIdentityLoginDialog();
  currentRoute = "settings";
  lastLoggedSessionId = null;
  if (window.location.pathname !== SETTINGS_ROUTE) {
    window.history.pushState({ route: "settings" }, "", SETTINGS_ROUTE);
  }
  render();
}

navLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const targetRoute = link.dataset.route;
    if (!targetRoute || targetRoute === currentRoute) return;
    closeMenu();
    if (targetRoute === "live") {
      currentRoute = "live";
      const hasActive = state.activeSessionId && state.sessions.some((session) => session.id === state.activeSessionId);
      const hasLast = state.lastActiveSessionId && state.sessions.some((session) => session.id === state.lastActiveSessionId);
      const targetSessionId = hasActive ? state.activeSessionId : hasLast ? state.lastActiveSessionId : null;
      if (targetSessionId) {
        setActiveSession(targetSessionId, { updateHistory: true, forceLog: true });
      } else {
        setActiveSession(null, { updateHistory: true });
      }
    } else if (targetRoute === "apps") {
      currentRoute = "apps";
      lastLoggedSessionId = null;
      if (window.location.pathname !== APPS_ROUTE) {
        window.history.pushState({ route: "apps" }, "", APPS_ROUTE);
      }
      void ensureAppsLoaded();
    } else if (targetRoute === "files") {
      currentRoute = "files";
      lastLoggedSessionId = null;
      if (window.location.pathname !== FILES_ROUTE) {
        window.history.pushState({ route: "files" }, "", FILES_ROUTE);
      }
      if (!state.files.initialized) {
        state.files.initialized = true;
        void loadFilesTree();
      }
    } else if (targetRoute === "settings") {
      navigateToSettings({ skipMenuClose: true });
      return;
    } else {
      currentRoute = "home";
      lastLoggedSessionId = null;
      if (window.location.pathname !== "/home") {
        window.history.pushState({ route: "home" }, "", "/home");
      }
    }
    render();
  });
});

menuToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMenu();
});

desktopSessionIndicatorButton?.addEventListener("click", (event) => {
  event.preventDefault();
  const session = getActiveSessionForIndicator();
  if (!session) return;
  closeMenu();
  if (currentRoute !== "live") {
    currentRoute = "live";
  }
  setActiveSession(session.id, { updateHistory: true, forceLog: true });
  render();
  requestAnimationFrame(() => {
    scrollConversationAreaToBottom(session.id, { includeWindow: true });
  });
});

document.addEventListener("click", (event) => {
  if (document.body.dataset.menuOpen === "true") {
    const target = event.target;
    if (target instanceof Node && !menuToggle?.contains(target) && !menuPanel?.contains(target)) {
      closeMenu();
    }
  }

  const clickTarget = event.target;
  if (clickTarget instanceof HTMLElement) {
    if (clickTarget.matches('[data-action="identity-logout"]')) {
      if (!clickTarget.disabled) {
        void handleIdentityLogout(event, identityDomEntryByNode.get(clickTarget) ?? null);
      } else {
        event.preventDefault();
      }
      return;
    }
    if (clickTarget.matches('[data-action="copy-active-npub"]')) {
      void handleIdentityCopy(event, identityDomEntryByNode.get(clickTarget) ?? null);
      return;
    }
  }
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 720) {
    closeMenu();
  }
  syncDesktopSessionIndicator();
  const mobileLayout = isMobileFilesLayout();
  if (currentRoute === "files" && mobileLayout !== lastFilesMobileLayout) {
    lastFilesMobileLayout = mobileLayout;
    render();
  } else {
    lastFilesMobileLayout = mobileLayout;
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu();
  }
});

if (directoryInput) {
  directoryInput.addEventListener("input", (event) => {
    scheduleDirectorySuggestions(event.target.value);
  });
  directoryInput.addEventListener("focus", () => {
    scheduleDirectorySuggestions(directoryInput.value);
  });
}

browseDirectoryButton?.addEventListener("click", (event) => {
  event.preventDefault();
  const seed =
    directoryInput?.value?.trim() ||
    state.lastWorkingDirectory ||
    state.config?.defaultDirectory ||
    "";
  void openDirectoryBrowser({
    initialPath: seed,
    title: "Select Working Directory",
    confirmLabel: "Use This Directory",
    allowCreate: true,
    onSelect: (path) => {
      if (!directoryInput) return;
      directoryInput.value = path;
      state.lastWorkingDirectory = path;
      scheduleDirectorySuggestions(path);
    },
  });
});

directoryUpButton?.addEventListener("click", (event) => {
  event.preventDefault();
  if (directoryBrowserState.parent) {
    updateDirectoryBrowser(directoryBrowserState.parent);
  }
});

directoryNewFolderButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  if (!directoryBrowserState.allowCreate) return;
  const parentPath = directoryBrowserState.currentPath || directoryBrowserState.parent || state.config?.defaultDirectory || "";
  if (!parentPath) {
    window.alert("Select a directory first.");
    return;
  }
  await promptCreateDirectoryAtPath(parentPath, {
    onSuccess: async () => {
      await updateDirectoryBrowser(parentPath);
    },
  });
});

directoryUseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  if (directoryBrowserState.currentPath) {
    chooseDirectory(directoryBrowserState.currentPath);
  }
});

if (directoryDialog) {
  directoryDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    directoryDialog.close();
  });
  directoryDialog.addEventListener("close", () => {
    directoryBrowserState.requestId += 1;
    if (directoryBrowserState.pendingResolve) {
      const resolve = directoryBrowserState.pendingResolve;
      directoryBrowserState.pendingResolve = null;
      resolve(null);
    }
    directoryBrowserState.onSelect = null;
    directoryBrowserState.allowCreate = true;
    directoryBrowserState.confirmLabel = "Use This Directory";
    directoryBrowserState.title = "Select Directory";
  });
}

fileTransferCancelButton?.addEventListener("click", (event) => {
  event.preventDefault();
  closeFileTransferDialog();
});

fileTransferDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeFileTransferDialog();
});

fileTransferDialog?.addEventListener("close", () => {
  resetFileTransferState();
  syncFileTransferConfirmState();
});

fileTransferUpButton?.addEventListener("click", (event) => {
  event.preventDefault();
  const parent = state.files.transfer.browser.parent;
  if (parent) {
    void updateFileTransferBrowser(parent);
  }
});

fileTransferNewFolderButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  const parent =
    state.files.transfer.browser.currentPath ||
    state.files.transfer.browser.parent ||
    state.files.currentPath ||
    "";
  if (!parent) {
    window.alert("Select a directory first.");
    return;
  }
  await promptCreateDirectoryAtPath(parent, {
    onSuccess: async (result) => {
      await updateFileTransferBrowser(parent);
      if (result?.path) {
        setFileTransferSelection(result.path, result?.displayPath ?? result.path);
      }
    },
  });
});

fileTransferConfirmButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  await submitFileTransfer();
});

window.addEventListener("touchstart", handleTouchStart, { passive: true });
window.addEventListener("touchmove", handleTouchMove, { passive: false });
window.addEventListener("touchend", finishPull, { passive: true });
window.addEventListener("touchcancel", finishPull, { passive: true });

window.addEventListener("popstate", () => {
  currentRoute = getRouteFromPath(window.location.pathname);
  if (currentRoute !== "live") {
    lastLoggedSessionId = null;
  }
  const redirectHome = applyRouteSessionFromPath({ allowHistoryUpdate: false });
  if (redirectHome) {
    currentRoute = "home";
    if (window.location.pathname !== "/home") {
      window.history.replaceState({ route: "home" }, "", "/home");
    }
  }
  if (currentRoute === "files") {
    if (window.location.pathname.startsWith("/docs")) {
      const newPath = window.location.pathname.replace("/docs", "/files");
      window.history.replaceState({ route: "files" }, "", newPath);
    }
    if (!state.files.initialized) {
      state.files.initialized = true;
      void loadFilesTree();
    } else if (!state.files.loading && !state.files.currentPath) {
      void loadFilesTree();
    }
  } else if (currentRoute === "apps") {
    void ensureAppsLoaded();
  }
  render();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.fileEditor.open) {
    event.preventDefault();
    requestFileEditorClose();
  }
});

const handleSessionLaunchRequest = () => {
  const agentId = agentSelect?.value ?? "";
  const workingDirectory = directoryInput?.value ?? "";
  const sessionName = sessionNameInput?.value ?? "";
  closeDialog();
  launchSession(agentId, workingDirectory, sessionName);
};

orchestratorForm?.addEventListener("submit", handleOrchestratorFormSubmit);

if (orchestratorCancelButton) {
  orchestratorCancelButton.addEventListener("click", (event) => {
    event.preventDefault();
    closeOrchestratorDialog();
  });
}

if (orchestratorDialog) {
  orchestratorDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeOrchestratorDialog();
  });
  orchestratorDialog.addEventListener("close", () => {
    setOrchestratorDialogPending(false);
  });
}

if (orchestratorDirectoryDialog) {
  orchestratorDirectoryDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    orchestratorDirectoryDialog.close();
  });
  orchestratorDirectoryDialog.addEventListener("close", () => {
    orchestratorDirectoryState.target = null;
    orchestratorDirectoryState.selection = null;
    orchestratorDirectoryState.currentPath = null;
    orchestratorDirectoryState.parent = null;
  });
}

orchestratorDirectoryUpButton?.addEventListener("click", (event) => {
  event.preventDefault();
  if (orchestratorDirectoryState.parent && orchestratorDirectoryState.target) {
    updateOrchestratorDirectoryBrowser(orchestratorDirectoryState.target, orchestratorDirectoryState.parent);
  }
});

orchestratorDirectoryList?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const path = target.dataset.path;
  if (!path || !orchestratorDirectoryState.target) return;

  if (target.classList.contains("directory-browser__folder")) {
    updateOrchestratorDirectoryBrowser(orchestratorDirectoryState.target, path);
  }

  if (target.classList.contains("directory-browser__choose")) {
    setOrchestratorDirectorySelection(path);
  }
});

orchestratorDirectoryUseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  const target = orchestratorDirectoryState.target;
  if (!target) return;
  const selected = orchestratorDirectoryState.selection ?? orchestratorDirectoryState.currentPath;
  if (!selected) {
    window.alert("Select a directory first.");
    return;
  }

  if (target === "templates") {
    if (orchestratorTemplateInput) {
      orchestratorTemplateInput.value = selected;
      orchestratorTemplateInput.dispatchEvent(new Event("input"));
    }
    if (!orchestratorPrefixDirty && orchestratorDirectoryPrefixInput) {
      const lastSegment = selected.split("/").filter(Boolean).pop() ?? "";
      const suggestion = formatDirectoryPrefix(lastSegment);
      if (suggestion) {
        orchestratorDirectoryPrefixInput.value = suggestion;
      }
      orchestratorDirectoryPrefixInput.placeholder = suggestion || "Security_Review";
    }
  } else if (target === "active") {
    if (orchestratorActiveRootInput) {
      orchestratorActiveRootInput.value = selected;
    }
  }

  setOrchestratorDirectorySelection(selected);
  applyOrchestratorTemplateState();
  if (orchestratorDirectoryDialog.open) {
    orchestratorDirectoryDialog.close();
  }
});

appForm?.addEventListener("submit", handleAppFormSubmit);

appCancelButton?.addEventListener("click", (event) => {
  event.preventDefault();
  closeAppDialog();
});

appDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeAppDialog();
});

appDialog?.addEventListener("close", () => {
  resetAppDialog();
});

appDiscoverButton?.addEventListener("click", handleAppDiscover);

appLogsRefreshButton?.addEventListener("click", (event) => {
  event.preventDefault();
  void refreshAppLogs();
});

appLogsCloseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  closeAppLogsDialog();
});

appLogsDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeAppLogsDialog();
});

appLogsDialog?.addEventListener("close", () => {
  closeAppLogsDialog();
});

orchestratorLabelInput?.addEventListener("input", () => {
  const suggestion = formatDirectoryPrefix(orchestratorLabelInput.value);
  if (!orchestratorPrefixDirty && orchestratorDirectoryPrefixInput) {
    orchestratorDirectoryPrefixInput.value = suggestion;
  }
  if (orchestratorDirectoryPrefixInput) {
    orchestratorDirectoryPrefixInput.placeholder = suggestion || "Security_Review";
  }
});

orchestratorDirectoryPrefixInput?.addEventListener("input", () => {
  orchestratorPrefixDirty = true;
});

orchestratorTemplateInput?.addEventListener("input", () => {
  applyOrchestratorTemplateState();
});

orchestratorTemplateBrowseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  const seed = orchestratorTemplateInput?.value ?? getDefaultOrchestratorPath("templates");
  openOrchestratorDirectoryDialog("templates", seed);
});

orchestratorActiveRootBrowseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  if (orchestratorActiveRootBrowseButton.disabled) return;
  const seed = orchestratorActiveRootInput?.value ?? getDefaultOrchestratorPath("active");
  openOrchestratorDirectoryDialog("active", seed);
});

sessionForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  handleSessionLaunchRequest();
});

confirmButton.addEventListener("click", (event) => {
  event.preventDefault();
  handleSessionLaunchRequest();
});

cancelButton.addEventListener("click", (event) => {
  event.preventDefault();
  closeDialog();
});

dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});

(async () => {
  initTheme();
  initTabsVisibility();
  await fetchConfig();
  await refreshOrchestratorPresets();
  await fetchSessions();
  if (currentRoute === "apps") {
    await fetchApps({ tail: APP_LOG_PREVIEW_LINES });
  }
  render();
})();
