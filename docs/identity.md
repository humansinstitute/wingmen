# Nostr Authentication Implementation Guide
## Using Applesauce SDK for Bun TypeScript

This guide provides complete implementation details for three authentication methods in your Bun TypeScript application using the Applesauce SDK.

---

## Table of Contents

1. [Project Setup](#project-setup)
2. [Core Dependencies](#core-dependencies)
3. [Authentication System Architecture](#authentication-system-architecture)
4. [Method 1: NIP-07 Browser Sign-In](#method-1-nip-07-browser-sign-in)
5. [Method 2: Generate New Keys](#method-2-generate-new-keys)
6. [Method 3: Bunker URI Remote Signer](#method-3-bunker-uri-remote-signer)
7. [Complete Implementation Example](#complete-implementation-example)
8. [Security Considerations](#security-considerations)
9. [Testing Strategy](#testing-strategy)

---

## Project Setup

### Installation

```bash
# Install Applesauce signers package
bun add applesauce-signers

# Install Applesauce relay for connection management
bun add applesauce-relay

# Install Applesauce core utilities
bun add applesauce-core

# Install nostr-tools for additional utilities
bun add nostr-tools

# Install RxJS for observable support
bun add rxjs
```

> We intentionally scope remote signer permissions to `kind 22242` so the bunker only
> signs authentication challenges. If future features require content publishing,
> expand the list accordingly.

### TypeScript Configuration

Ensure your `tsconfig.json` includes:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

---

## Core Dependencies

### Key Applesauce Classes

1. **SimpleSigner**: For locally generated keys
2. **NostrConnectSigner**: For NIP-46 remote signing (Bunker)
3. **PasswordSigner**: For encrypted key storage (NIP-49)
4. **RelayPool**: For managing relay connections

### NIP Standards Used

- **NIP-01**: Basic protocol and event structure
- **NIP-07**: `window.nostr` browser extension capability
- **NIP-19**: Bech32 encoded entities (nsec, npub)
- **NIP-46**: Nostr Remote Signing (Bunker protocol)
- **NIP-49**: Private key encryption

---

## Authentication System Architecture

### Core Interfaces

```typescript
import type { NostrEvent, EventTemplate } from 'nostr-tools';

// Base signer interface (NIP-07 compatible)
export interface Nip07Interface {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<NostrEvent>;
  nip04?: {
    encrypt: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
  };
  nip44?: {
    encrypt: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
  };
}

// Authentication state
export enum AuthMethod {
  NONE = 'none',
  NIP07 = 'nip07',
  LOCAL_KEYS = 'local_keys',
  BUNKER = 'bunker',
}

export interface AuthState {
  method: AuthMethod;
  pubkey: string | null;
  signer: Nip07Interface | null;
  isAuthenticated: boolean;
}

// Session storage for local keys
export interface LocalKeySession {
  npub: string;
  encryptedNsec: string;
  sessionExpiresAt: number;
  createdAt: number;
}
```

### Authentication Manager Class

```typescript
import { SimpleSigner, NostrConnectSigner, PasswordSigner } from 'applesauce-signers';
import { RelayPool } from 'applesauce-relay';
import { nip19 } from 'nostr-tools';

export class AuthManager {
  private state: AuthState = {
    method: AuthMethod.NONE,
    pubkey: null,
    signer: null,
    isAuthenticated: false,
  };

  private relayPool: RelayPool;
  private defaultRelays: string[];

  constructor(relays?: string[]) {
    this.relayPool = new RelayPool();

    const envRelays = (Bun.env.NOSTR_RELAYS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    this.defaultRelays = relays?.length ? relays : envRelays.length ? envRelays : [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.nostr.band',
    ];
    
    // Set up global relay communication for NostrConnectSigner
    NostrConnectSigner.pool = this.relayPool;
  }

  getState(): AuthState {
    return { ...this.state };
  }

  getSigner(): Nip07Interface | null {
    return this.state.signer;
  }

  async getPublicKey(): Promise<string | null> {
    if (!this.state.signer) return null;
    return await this.state.signer.getPublicKey();
  }

  isAuthenticated(): boolean {
    return this.state.isAuthenticated;
  }

  // Method implementations follow...
}

### Session Persistence Strategy

- The `npub` acts as the canonical user identifier across all sign-in flows.
- After any successful login, the client calls `POST /api/auth/session` with the `npub`
  and optional Applesauce-encrypted `nsec`. The Bun server issues a 3-day HttpOnly cookie
  (rolling on activity) that authenticates subsequent requests without re-signing.
- The browser caches only non-sensitive metadata (`npub`, encrypted payloads, expiry hints)
  so that UI can show the active account and prompt for re-authentication when the cookie
  is near expiry. Raw `nsec` values never touch storage without PasswordSigner encryption.
```

---

## Method 1: NIP-07 Browser Sign-In

### Overview

NIP-07 enables web browsers or browser extensions (like Alby, nos2x, Flamingo) to expose a `window.nostr` object that provides signing capabilities without exposing private keys to the web application.

### Required Browser Extensions

Users need one of these extensions installed:
- **nos2x** (Chromium): https://github.com/fiatjaf/nos2x
- **Alby** (Multi-browser): https://getalby.com/
- **Flamingo** (Chromium): https://www.getalby.com/flamingo

### Implementation

> **Bundling note:** The dashboard does not import applesauce modules directly from `node_modules`. Instead, run `bun run build:bunker-client` to emit `public/vendor/bunker-client.js`, which re-exports `NostrConnectSigner` and `RelayPool`. The UI imports that bundle so the browser keeps the `bunker://` secret local while avoiding dozens of per-module requests.

```typescript
// In AuthManager class

/**
 * Check if NIP-07 extension is available
 */
private isNip07Available(): boolean {
  return typeof window !== 'undefined' && 
         typeof (window as any).nostr !== 'undefined' &&
         typeof (window as any).nostr.getPublicKey === 'function' &&
         typeof (window as any).nostr.signEvent === 'function';
}

/**
 * Login with NIP-07 browser extension
 */
async loginWithNip07(): Promise<AuthState> {
  if (!this.isNip07Available()) {
    throw new Error(
      'NIP-07 extension not detected. Please install a Nostr signer extension like Alby, nos2x, or Flamingo.'
    );
  }

  try {
    const nostr = (window as any).nostr as Nip07Interface;
    
    // Request public key from extension
    const pubkey = await nostr.getPublicKey();
    
    if (!pubkey || pubkey.length !== 64) {
      throw new Error('Invalid public key returned from NIP-07 extension');
    }

    // Update state
    this.state = {
      method: AuthMethod.NIP07,
      pubkey,
      signer: nostr,
      isAuthenticated: true,
    };

    console.log('NIP-07 authentication successful:', pubkey);
    return this.getState();
  } catch (error) {
    console.error('NIP-07 authentication failed:', error);
    throw new Error(`Failed to authenticate with NIP-07: ${error.message}`);
  }
}

/**
 * Sign an event using NIP-07
 */
async signEventWithNip07(eventTemplate: EventTemplate): Promise<NostrEvent> {
  if (this.state.method !== AuthMethod.NIP07 || !this.state.signer) {
    throw new Error('Not authenticated with NIP-07');
  }

  try {
    const signedEvent = await this.state.signer.signEvent(eventTemplate);
    return signedEvent;
  } catch (error) {
    console.error('Failed to sign event with NIP-07:', error);
    throw error;
  }
}
```

### Frontend UI Example

```typescript
// React/Preact example
function Nip07LoginButton() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const authState = await authManager.loginWithNip07();
      console.log('Logged in with pubkey:', authState.pubkey);
      // Navigate to authenticated area
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button onClick={handleLogin} disabled={loading}>
        {loading ? 'Connecting...' : 'Login with Browser Extension'}
      </button>
      {error && <div className="error">{error}</div>}
      <p className="help-text">
        Requires a Nostr extension like Alby, nos2x, or Flamingo
      </p>
    </div>
  );
}
```

### NIP-07 Encryption Methods (Optional)

```typescript
/**
 * Encrypt message using NIP-04 (deprecated but widely supported)
 */
async nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
  if (this.state.method !== AuthMethod.NIP07 || !this.state.signer?.nip04) {
    throw new Error('NIP-04 encryption not available');
  }
  return await this.state.signer.nip04.encrypt(recipientPubkey, plaintext);
}

/**
 * Decrypt message using NIP-04
 */
async nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
  if (this.state.method !== AuthMethod.NIP07 || !this.state.signer?.nip04) {
    throw new Error('NIP-04 decryption not available');
  }
  return await this.state.signer.nip04.decrypt(senderPubkey, ciphertext);
}

/**
 * Encrypt message using NIP-44 (recommended)
 */
async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
  if (this.state.method !== AuthMethod.NIP07 || !this.state.signer?.nip44) {
    throw new Error('NIP-44 encryption not available');
  }
  return await this.state.signer.nip44.encrypt(recipientPubkey, plaintext);
}

/**
 * Decrypt message using NIP-44
 */
async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
  if (this.state.method !== AuthMethod.NIP07 || !this.state.signer?.nip44) {
    throw new Error('NIP-44 decryption not available');
  }
  return await this.state.signer.nip44.decrypt(senderPubkey, ciphertext);
}
```

---

## Method 2: Generate New Keys

### Overview

Generate a new keypair locally in the application. The user can copy their nsec (private key) to use in other clients or to restore their session later.

### Implementation

```typescript
import { SimpleSigner } from 'applesauce-signers';
import { nip19 } from 'nostr-tools';

// In AuthManager class

/**
 * Generate new keys and login automatically
 * Returns the nsec that user should save
 */
async generateNewKeys(): Promise<{ authState: AuthState; nsec: string; npub: string }> {
  try {
    // Create a new SimpleSigner (automatically generates keys)
    const signer = new SimpleSigner();
    
    // Get the public key
    const pubkey = await signer.getPublicKey();
    
    // Get the private key (32 bytes)
    if (!signer.key) {
      throw new Error('Failed to generate private key');
    }
    
    // Encode keys in bech32 format
    const nsec = nip19.nsecEncode(signer.key);
    const npub = nip19.npubEncode(pubkey);

    // Update state
    this.state = {
      method: AuthMethod.LOCAL_KEYS,
      pubkey,
      signer,
      isAuthenticated: true,
    };

    console.log('Generated new keys:', { pubkey, npub });

    // Encrypt the nsec before persisting anywhere outside memory
    const encryptedNsec = await this.encryptPrivateKey(signer.key);

    // Persist a short-lived auth session (sets HttpOnly cookie + returns expiry)
    const sessionExpiresAt = await this.persistSession(npub, encryptedNsec);

    // Cache lightweight session metadata for UX (npub + expiry only)
    this.cacheSessionIdentity({
      npub,
      encryptedNsec,
      createdAt: Date.now(),
      sessionExpiresAt,
    });

    return {
      authState: this.getState(),
      nsec,
      npub,
    };
  } catch (error) {
    console.error('Failed to generate new keys:', error);
    throw new Error(`Key generation failed: ${error.message}`);
  }
}

/**
 * Login with an existing nsec private key
 */
async loginWithNsec(nsec: string): Promise<AuthState> {
  try {
    // Decode the nsec
    const decoded = nip19.decode(nsec);
    
    if (decoded.type !== 'nsec') {
      throw new Error('Invalid nsec format. Expected a private key starting with "nsec1"');
    }

    const privateKey = decoded.data as Uint8Array;

    // Create signer with the private key
    const signer = new SimpleSigner(privateKey);
    
    // Get public key
    const pubkey = await signer.getPublicKey();
    const npub = nip19.npubEncode(pubkey);

    // Update state
    this.state = {
      method: AuthMethod.LOCAL_KEYS,
      pubkey,
      signer,
      isAuthenticated: true,
    };

    console.log('Logged in with nsec:', { pubkey, npub });
    
    const encryptedNsec = await this.encryptPrivateKey(privateKey);
    const sessionExpiresAt = await this.persistSession(pubkey, encryptedNsec);

    this.cacheSessionIdentity({
      npub,
      encryptedNsec,
      createdAt: Date.now(),
      sessionExpiresAt,
    });

    return this.getState();
  } catch (error) {
    console.error('Failed to login with nsec:', error);
    throw new Error(`Invalid nsec: ${error.message}`);
  }
}

/**
 * Get the nsec for the current session (if using local keys)
 */
getNsec(): string | null {
  if (this.state.method !== AuthMethod.LOCAL_KEYS || !this.state.signer) {
    return null;
  }

  const simpleSigner = this.state.signer as SimpleSigner;
  if (!simpleSigner.key) {
    return null;
  }

  return nip19.nsecEncode(simpleSigner.key);
}

/**
 * Export current keys (for backup)
 */
exportKeys(): { nsec: string; npub: string } | null {
  if (this.state.method !== AuthMethod.LOCAL_KEYS || !this.state.pubkey) {
    return null;
  }

  const nsec = this.getNsec();
  if (!nsec) {
    return null;
  }

  return {
    nsec,
    npub: nip19.npubEncode(this.state.pubkey),
  };
}

/**
 * Cache session metadata in browser storage (npub + encrypted nsec)
 * The actual session token lives in an HttpOnly cookie managed by the server.
 */
private cacheSessionIdentity(session: LocalKeySession): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    localStorage.setItem('nostr_session', JSON.stringify(session));
  }
}

/**
 * Restore session from storage
 */
async restoreSessionFromStorage(): Promise<AuthState | null> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }

  const stored = localStorage.getItem('nostr_session');
  if (!stored) {
    return null;
  }

  try {
    const session: LocalKeySession = JSON.parse(stored);

    if (Date.now() > session.sessionExpiresAt) {
      localStorage.removeItem('nostr_session');
      return null;
    }

    const decrypted = await this.decryptPrivateKey(session.encryptedNsec);
    const nsec = nip19.nsecEncode(decrypted);
    return await this.loginWithNsec(nsec);
  } catch (error) {
    console.error('Failed to restore session:', error);
    localStorage.removeItem('nostr_session');
    return null;
  }
}

private async encryptPrivateKey(rawKey: Uint8Array): Promise<string> {
  const password = await this.promptForEncryptionPassword();
  const signer = await PasswordSigner.fromPrivateKey(rawKey, password);
  return signer.ncryptsec;
}

private async decryptPrivateKey(encrypted: string): Promise<Uint8Array> {
  const password = await this.promptForEncryptionPassword();
  const signer = await PasswordSigner.fromNcryptsec(encrypted, password);
  return signer.key!;
}

private async promptForEncryptionPassword(): Promise<string> {
  // Integrate with the UI layer to capture a secret passphrase.
  // For example, open a modal asking the user to set (or unlock with)
  // an Applesauce-compatible password. Implementation lives in the UI module.
  return await uiPrompts.ensurePassword();
}

private async persistSession(npub: string, encryptedNsec: string | null): Promise<number> {
  // Request a 3-day session from the Bun backend. The server will mint
  // an HttpOnly cookie and respond with the expiry timestamp for UI usage.
  const response = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ npub, encryptedNsec }),
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error('Failed to persist session');
  }

  const payload = await response.json() as { expiresAt: number };
  return payload.expiresAt;
}

The password prompt references the existing UI modal helpers; adapt `uiPrompts.ensurePassword`
to whichever UX Wingman exposes for unlocking encrypted secrets.
```

### Frontend UI Example

```typescript
export const wireLocalIdentityPanel = (root: HTMLElement) => {
  const generateBtn = root.querySelector<HTMLButtonElement>('[data-action="generate-keys"]');
  const importForm = root.querySelector<HTMLFormElement>('[data-form="import-nsec"]');
  const npubOutput = root.querySelector<HTMLElement>('[data-role="npub"]');
  const nsecOutput = root.querySelector<HTMLPreElement>('[data-role="nsec"]');

  let latestKeys: { nsec: string; npub: string } | null = null;

  generateBtn?.addEventListener('click', async () => {
    if (!generateBtn) return;
    generateBtn.disabled = true;
    try {
      const { nsec, npub } = await authManager.generateNewKeys();
      latestKeys = { nsec, npub };

      if (npubOutput) npubOutput.textContent = npub;
      if (nsecOutput) {
        nsecOutput.textContent = nsec;
        nsecOutput.removeAttribute('hidden');
      }

      root.classList.add('is-authenticated');
    } catch (error) {
      console.error(error);
      showToast(error.message ?? 'Key generation failed');
    } finally {
      generateBtn.disabled = false;
    }
  });

  root.querySelector('[data-action="copy-nsec"]')?.addEventListener('click', async () => {
    if (!latestKeys) return;
    await navigator.clipboard.writeText(latestKeys.nsec);
    showToast('Private key copied to clipboard');
  });

  importForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    const input = importForm.querySelector<HTMLInputElement>('input[name="nsec"]');
    if (!input) return;

    const value = input.value.trim();
    if (!value) return;

    importForm.classList.add('is-loading');
    try {
      await authManager.loginWithNsec(value);
      root.classList.add('is-authenticated');
      showToast('Signed in with existing keys');
    } catch (error) {
      showToast(error.message ?? 'Import failed');
    } finally {
      importForm.classList.remove('is-loading');
    }
  });
};
```

The selectors (`data-action="…"`, `data-role="…"`) align with the dashboard’s vanilla
DOM update loop in `src/ui/app.js`. Helpers such as `showToast` live in the existing
UI utility bundle; no reactive framework is required.

---

## Method 3: Bunker URI Remote Signer

### Overview

NIP-46 defines "Nostr Connect" - a protocol for remote signing where private keys remain on a separate device/service (the "bunker"), and the app sends signing requests over Nostr relays. This provides enhanced security by keeping keys off the client device.

### Bunker URI Format

```
bunker://<remote-signer-pubkey>?relay=<relay-url>&relay=<another-relay>&secret=<optional-secret>
```

Example:
```
bunker://266815e0c9210dfa324c6cba3573b14bee49da4209a9456f9484e5106cd408a5?relay=wss%3A%2F%2Frelay.nsec.app&secret=d9aa70
```

### Implementation

```typescript
import { NostrConnectSigner } from '/vendor/bunker-client.js';

// In AuthManager class

/**
 * Connect using bunker:// URI
 */
async loginWithBunker(bunkerUri: string): Promise<AuthState> {
  try {
    // Parse and validate the bunker URI
    if (!bunkerUri.startsWith('bunker://')) {
      throw new Error('Invalid bunker URI. Must start with "bunker://"');
    }

    // Parse the bunker URI to extract components
    const parsed = NostrConnectSigner.parseBunkerURI(bunkerUri);
    console.log('Parsed bunker URI:', {
      remote: parsed.remote,
      relays: parsed.relays,
      hasSecret: !!parsed.secret,
    });

    // Create signer from bunker URI
    const signer = await NostrConnectSigner.fromBunkerURI(bunkerUri, {
      permissions: NostrConnectSigner.buildSigningPermissions([
        22242, // NIP-46 auth challenge responses only
      ]),
      pool: this.relayPool, // Use shared relay pool
    });

    // Wait for connection to be established
    console.log('Connecting to remote signer...');
    await signer.waitForSigner();
    
    // Get the user's public key from the remote signer
    const pubkey = await signer.getPublicKey();
    console.log('Connected to bunker with pubkey:', pubkey);

    // Update state
    this.state = {
      method: AuthMethod.BUNKER,
      pubkey,
      signer,
      isAuthenticated: true,
    };

    // Store non-sensitive bunker metadata for session restoration (secret excluded)
    const sessionExpiresAt = await this.persistSession(pubkey, null);
    this.saveBunkerSession({
      remote: parsed.remote,
      relays: parsed.relays,
      pubkey,
      sessionExpiresAt,
    });

    return this.getState();
  } catch (error) {
    console.error('Failed to connect with bunker:', error);
    throw new Error(`Bunker connection failed: ${error.message}`);
  }
}

// Secrets embedded in bunker:// URIs are never written to storage. Users re-enter
// them on reconnect if the remote signer requires it.

/**
 * Connect using bunker with manual configuration
 */
async loginWithBunkerManual(
  remotePubkey: string,
  relays: string[],
  secret?: string
): Promise<AuthState> {
  try {
    // Create signer with manual configuration
    const signer = new NostrConnectSigner({
      remote: remotePubkey,
      relays,
      pool: this.relayPool,
    });

    // Connect with optional secret
    await signer.connect(
      secret,
      NostrConnectSigner.buildSigningPermissions([22242])
    );

    console.log('Connected to remote signer');

    // Get user's public key
    const pubkey = await signer.getPublicKey();
    console.log('User pubkey:', pubkey);

    // Update state
    this.state = {
      method: AuthMethod.BUNKER,
      pubkey,
      signer,
      isAuthenticated: true,
    };

    const sessionExpiresAt = await this.persistSession(pubkey, null);
    this.saveBunkerSession({
      remote: remotePubkey,
      relays,
      pubkey,
      sessionExpiresAt,
    });

    return this.getState();
  } catch (error) {
    console.error('Failed to connect with manual bunker config:', error);
    throw new Error(`Bunker connection failed: ${error.message}`);
  }
}

/**
 * Generate a nostrconnect:// URI to initiate connection from client side
 */
async generateNostrConnectURI(appMetadata: {
  name?: string;
  url?: string;
  image?: string;
}): Promise<string> {
  // Create a temporary signer for the connection request
  const tempSigner = new NostrConnectSigner({
    relays: this.defaultRelays,
    pool: this.relayPool,
  });

  // Generate the nostrconnect:// URI
  const uri = tempSigner.getNostrConnectURI({
    name: appMetadata.name || 'My Nostr App',
    url: appMetadata.url || window.location.origin,
    image: appMetadata.image,
    permissions: NostrConnectSigner.buildSigningPermissions([0, 1, 3, 4, 7, 10002]),
  });

  // Store the temporary signer for when connection is established
  (this as any)._pendingConnectSigner = tempSigner;

  return uri;
}

/**
 * Wait for remote signer to connect (after showing nostrconnect:// URI)
 */
async waitForRemoteConnection(timeoutMs: number = 60000): Promise<AuthState> {
  const tempSigner = (this as any)._pendingConnectSigner as NostrConnectSigner;
  
  if (!tempSigner) {
    throw new Error('No pending connection. Call generateNostrConnectURI first.');
  }

  try {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Wait for remote signer to connect
    await tempSigner.waitForSigner(controller.signal);
    clearTimeout(timeoutId);

    // Get user's public key
    const pubkey = await tempSigner.getPublicKey();
    console.log('Remote signer connected with pubkey:', pubkey);

    // Update state
    this.state = {
      method: AuthMethod.BUNKER,
      pubkey,
      signer: tempSigner,
      isAuthenticated: true,
    };

    // Clean up
    delete (this as any)._pendingConnectSigner;

    return this.getState();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Connection timeout: Remote signer did not respond');
    }
    throw new Error(`Failed to connect: ${error.message}`);
  }
}

/**
 * Encryption methods for bunker signer
 */
async bunkerNip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
  if (this.state.method !== AuthMethod.BUNKER || !this.state.signer) {
    throw new Error('Not authenticated with bunker');
  }

  const bunkerSigner = this.state.signer as NostrConnectSigner;
  return await bunkerSigner.nip44.encrypt(recipientPubkey, plaintext);
}

async bunkerNip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
  if (this.state.method !== AuthMethod.BUNKER || !this.state.signer) {
    throw new Error('Not authenticated with bunker');
  }

  const bunkerSigner = this.state.signer as NostrConnectSigner;
  return await bunkerSigner.nip44.decrypt(senderPubkey, ciphertext);
}

/**
 * Save bunker session
 */
private saveBunkerSession(meta: {
  remote: string;
  relays: string[];
  pubkey: string;
  sessionExpiresAt: number;
}): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    localStorage.setItem('nostr_bunker', JSON.stringify({
      ...meta,
      createdAt: Date.now(),
    }));
  }
}

/**
 * Restore bunker session
 */
async restoreBunkerSession(): Promise<AuthState | null> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }

  const stored = localStorage.getItem('nostr_bunker');
  if (!stored) {
    return null;
  }

  try {
    const session = JSON.parse(stored);

    if (Date.now() > session.sessionExpiresAt) {
      localStorage.removeItem('nostr_bunker');
      return null;
    }

    return await this.loginWithBunkerManual(session.remote, session.relays);
  } catch (error) {
    console.error('Failed to restore bunker session:', error);
    localStorage.removeItem('nostr_bunker');
    return null;
  }
}
```

### Frontend UI Example

```typescript
export const wireBunkerLogin = (root: HTMLElement) => {
  const connectForm = root.querySelector<HTMLFormElement>('[data-form="bunker-auth"]');
  const uriInput = connectForm?.querySelector<HTMLTextAreaElement>('textarea[name="bunkerUri"]');
  const statusEl = root.querySelector<HTMLElement>('[data-role="bunker-status"]');

  connectForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!connectForm || !uriInput) return;

    const value = uriInput.value.trim();
    if (!value) {
      showToast('Enter a bunker:// URI');
      return;
    }

    connectForm.classList.add('is-loading');
    if (statusEl) statusEl.textContent = 'Connecting…';

    try {
      await authManager.loginWithBunker(value);
      if (statusEl) statusEl.textContent = 'Connected to remote signer';
      root.classList.add('is-authenticated');
    } catch (error) {
      if (statusEl) statusEl.textContent = (error as Error).message ?? 'Connection failed';
    } finally {
      connectForm.classList.remove('is-loading');
    }
  });
};

export const wireBunkerQRScanner = (root: HTMLElement, onScan: (uri: string) => void) => {
  const scanButton = root.querySelector<HTMLButtonElement>('[data-action="scan-qr"]');

  scanButton?.addEventListener('click', async () => {
    const uri = await startQrScanner();
    if (!uri) return;
    onScan(uri);
  });
};
```

`startQrScanner` references an optional utility that can stream camera frames to the
browser; if unavailable it can gracefully fallback to manual URI entry.

---

## Complete Implementation Example

### Full AuthManager Implementation

```typescript
import { SimpleSigner, NostrConnectSigner, PasswordSigner } from 'applesauce-signers';
import { RelayPool } from 'applesauce-relay';
import { nip19 } from 'nostr-tools';
import type { NostrEvent, EventTemplate } from 'nostr-tools';

export class NostrAuthManager {
  private state: AuthState;
  private relayPool: RelayPool;
  private defaultRelays: string[];

  constructor(relays?: string[]) {
    this.state = {
      method: AuthMethod.NONE,
      pubkey: null,
      signer: null,
      isAuthenticated: false,
    };

    const envRelays = (Bun.env.NOSTR_RELAYS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    this.defaultRelays = relays?.length ? relays : envRelays.length ? envRelays : [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.nostr.band',
    ];

    this.relayPool = new RelayPool();
    NostrConnectSigner.pool = this.relayPool;
  }

  // === STATE MANAGEMENT ===

  getState(): AuthState {
    return { ...this.state };
  }

  isAuthenticated(): boolean {
    return this.state.isAuthenticated;
  }

  async getPublicKey(): Promise<string | null> {
    if (!this.state.signer) return null;
    return await this.state.signer.getPublicKey();
  }

  getSigner(): Nip07Interface | null {
    return this.state.signer;
  }

  getAuthMethod(): AuthMethod {
    return this.state.method;
  }

  // === LOGOUT ===

  async logout(): Promise<void> {
    // Clean up based on method
    if (this.state.method === AuthMethod.BUNKER && this.state.signer) {
      // Note: NostrConnectSigner doesn't have a disconnect method in current API
      // Connection will be cleaned up when signer is garbage collected
    }

    // Clear session storage
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.removeItem('nostr_session');
      localStorage.removeItem('nostr_bunker');
    }

    // Reset state
    this.state = {
      method: AuthMethod.NONE,
      pubkey: null,
      signer: null,
      isAuthenticated: false,
    };

    console.log('Logged out successfully');
  }

  // === NIP-07 METHODS ===
  // [Include all NIP-07 methods from Method 1]

  // === LOCAL KEYS METHODS ===
  // [Include all local keys methods from Method 2]

  // === BUNKER METHODS ===
  // [Include all bunker methods from Method 3]

  // === SIGNING ===

  /**
   * Sign an event with the current signer (works for all methods)
   */
  async signEvent(eventTemplate: EventTemplate): Promise<NostrEvent> {
    if (!this.state.signer || !this.state.isAuthenticated) {
      throw new Error('Not authenticated');
    }

    try {
      return await this.state.signer.signEvent(eventTemplate);
    } catch (error) {
      console.error('Failed to sign event:', error);
      throw new Error(`Signing failed: ${error.message}`);
    }
  }

  /**
   * Create and sign a simple text note
   */
  async publishNote(content: string): Promise<NostrEvent> {
    const pubkey = await this.getPublicKey();
    if (!pubkey) throw new Error('Not authenticated');

    const eventTemplate: EventTemplate = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content,
    };

    return await this.signEvent(eventTemplate);
  }

  // === RELAY MANAGEMENT ===

  getRelayPool(): RelayPool {
    return this.relayPool;
  }

  getDefaultRelays(): string[] {
    return [...this.defaultRelays];
  }

  setDefaultRelays(relays: string[]): void {
    this.defaultRelays = relays;
  }

  /**
   * Publish an event to relays
   */
  async publishEvent(event: NostrEvent, relays?: string[]): Promise<void> {
    const targetRelays = relays || this.defaultRelays;
    
    try {
      const responses = await this.relayPool.publish(targetRelays, event);
      
      const successes = responses.filter(r => r.ok).length;
      console.log(`Published to ${successes}/${responses.length} relays`);
      
      responses.forEach(response => {
        if (!response.ok) {
          console.warn(`Failed to publish to ${response.from}:`, response.message);
        }
      });
    } catch (error) {
      console.error('Failed to publish event:', error);
      throw error;
    }
  }
}
```

### Usage Example

```typescript
// Initialize the auth manager
const authManager = new NostrAuthManager();

// Example 1: NIP-07 Login
async function loginWithExtension() {
  try {
    const state = await authManager.loginWithNip07();
    console.log('Logged in!', state);
  } catch (error) {
    console.error('Login failed:', error);
  }
}

// Example 2: Generate New Keys
async function createNewIdentity() {
  try {
    const { nsec, npub } = await authManager.generateNewKeys();
    console.log('New identity created!');
    console.log('Save your nsec:', nsec);
    console.log('Your npub:', npub);
  } catch (error) {
    console.error('Failed to generate keys:', error);
  }
}

// Example 3: Login with Existing Keys
async function loginWithExistingKeys(nsec: string) {
  try {
    await authManager.loginWithNsec(nsec);
    console.log('Logged in with existing keys!');
  } catch (error) {
    console.error('Login failed:', error);
  }
}

// Example 4: Bunker Login
async function loginWithRemoteSigner(bunkerUri: string) {
  try {
    await authManager.loginWithBunker(bunkerUri);
    console.log('Connected to remote signer!');
  } catch (error) {
    console.error('Connection failed:', error);
  }
}

// Example 5: Publish a Note
async function publishMessage(content: string) {
  try {
    const event = await authManager.publishNote(content);
    await authManager.publishEvent(event);
    console.log('Note published!', event.id);
  } catch (error) {
    console.error('Failed to publish:', error);
  }
}

// Example 6: Check Auth State on App Load
async function restoreSession() {
  // Try to restore local keys session
  let restored = await authManager.restoreSessionFromStorage();
  
  if (!restored) {
    // Try to restore bunker session
    restored = await authManager.restoreBunkerSession();
  }
  
  if (restored) {
    console.log('Session restored!', restored);
  } else {
    console.log('No existing session');
  }
}
```

---

## Security Considerations

### General Security

1. **Never log private keys**: Ensure nsec values are never logged to console or sent to analytics
2. **Use HTTPS**: Always serve your app over HTTPS in production
3. **Validate inputs**: Validate all user inputs, especially nsec and bunker URIs
4. **Clear sensitive data**: Clear private keys from memory when logging out

### Method-Specific Security

#### NIP-07 (Browser Extension)
- **Pros**: Private keys never leave the extension
- **Cons**: User must trust the extension
- **Recommendation**: Only recommend well-audited extensions like Alby or nos2x

#### Local Keys
- **Pros**: Full control, no external dependencies
- **Cons**: Keys stored in browser memory/storage
- **Recommendations**:
  - Warn users to never enter their main nsec on untrusted devices
  - Encrypt cached nsecs with PasswordSigner before persisting anywhere
  - Store only `npub`, encrypted material, and expiry metadata in localStorage
  - Implement automatic logout after inactivity

#### Bunker (Remote Signer)
- **Pros**: Most secure - keys never on client device
- **Cons**: Requires external service/device
- **Recommendations**:
  - Always use TLS-enabled relays (wss://)
  - Implement proper permission scoping
  - Show users what permissions they're granting

### Storage Security

```typescript
// Enhanced session storage with encryption (optional)
import { PasswordSigner } from 'applesauce-signers';

async function saveEncryptedSession(nsec: string, password: string) {
  const signer = new PasswordSigner();
  
  // Decode nsec to bytes
  const decoded = nip19.decode(nsec);
  const privateKey = decoded.data as Uint8Array;
  
  // Encrypt with password
  signer.key = privateKey;
  await signer.setPassword(password);
  
  // Store encrypted version (safe to keep in localStorage)
  localStorage.setItem('nostr_encrypted', signer.ncryptsec);
}

async function restoreEncryptedSession(password: string) {
  const ncryptsec = localStorage.getItem('nostr_encrypted');
  if (!ncryptsec) return null;
  
  const signer = new PasswordSigner();
  signer.ncryptsec = ncryptsec;
  
  try {
    await signer.unlock(password);
    // Use the unlocked signer
    return signer;
  } catch (error) {
    throw new Error('Invalid password');
  }
}
```

---

## Testing Strategy

### Unit Tests

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { NostrAuthManager } from './auth-manager';

describe('NostrAuthManager', () => {
  let authManager: NostrAuthManager;

  beforeEach(() => {
    authManager = new NostrAuthManager();
  });

  test('should initialize with no authentication', () => {
    expect(authManager.isAuthenticated()).toBe(false);
    expect(authManager.getAuthMethod()).toBe(AuthMethod.NONE);
  });

  test('should generate new keys successfully', async () => {
    const result = await authManager.generateNewKeys();
    
    expect(result.nsec).toMatch(/^nsec1/);
    expect(result.npub).toMatch(/^npub1/);
    expect(authManager.isAuthenticated()).toBe(true);
    expect(authManager.getAuthMethod()).toBe(AuthMethod.LOCAL_KEYS);
  });

  test('should login with valid nsec', async () => {
    // Generate keys first
    const { nsec } = await authManager.generateNewKeys();
    
    // Logout
    await authManager.logout();
    expect(authManager.isAuthenticated()).toBe(false);
    
    // Login with the nsec
    await authManager.loginWithNsec(nsec);
    expect(authManager.isAuthenticated()).toBe(true);
  });

  test('should reject invalid nsec', async () => {
    await expect(
      authManager.loginWithNsec('invalid_nsec')
    ).rejects.toThrow();
  });

  test('should sign events correctly', async () => {
    await authManager.generateNewKeys();
    
    const event = await authManager.publishNote('Test message');
    
    expect(event.kind).toBe(1);
    expect(event.content).toBe('Test message');
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
  });

  test('should export keys correctly', async () => {
    await authManager.generateNewKeys();
    
    const exported = authManager.exportKeys();
    expect(exported).not.toBeNull();
    expect(exported!.nsec).toMatch(/^nsec1/);
    expect(exported!.npub).toMatch(/^npub1/);
  });

  test('should logout and clear state', async () => {
    await authManager.generateNewKeys();
    expect(authManager.isAuthenticated()).toBe(true);
    
    await authManager.logout();
    expect(authManager.isAuthenticated()).toBe(false);
    expect(authManager.getSigner()).toBeNull();
  });
});
```

### Integration Tests

```typescript
describe('NostrAuthManager Integration', () => {
  test('should handle full authentication flow', async () => {
    const authManager = new NostrAuthManager();
    
    // Generate keys
    const { nsec, npub } = await authManager.generateNewKeys();
    expect(authManager.isAuthenticated()).toBe(true);
    
    // Publish a note
    const event = await authManager.publishNote('Hello Nostr!');
    expect(event.pubkey).toBe((await authManager.getPublicKey())!);
    
    // Logout
    await authManager.logout();
    expect(authManager.isAuthenticated()).toBe(false);
    
    // Login again with same keys
    await authManager.loginWithNsec(nsec);
    expect(authManager.isAuthenticated()).toBe(true);
    expect(await authManager.getPublicKey()).toBe(event.pubkey);
  });
});
```

### Manual Testing Checklist

- [ ] NIP-07 detection works correctly when extension is/isn't installed
- [ ] Generate new keys produces valid nsec/npub
- [ ] Copy to clipboard works for keys
- [ ] Import existing nsec works correctly
- [ ] Bunker URI parsing handles various formats
- [ ] Bunker connection timeout works
- [ ] Session restoration works after page refresh
- [ ] Redundant logins receive a fresh 3-day session cookie
- [ ] Encrypted nsec cache purges when cookie expires or logout runs
- [ ] Logout clears all sensitive data
- [ ] Events can be signed and published with all methods
- [ ] Error messages are user-friendly

---

## Additional Resources

### Applesauce SDK Documentation
- GitHub: https://github.com/hzrd149/applesauce
- Signers Package: https://github.com/hzrd149/applesauce/tree/master/packages/signers
- Relay Package: https://github.com/hzrd149/applesauce/tree/master/packages/relay

### Nostr Protocol
- NIP-01 (Basic Protocol): https://github.com/nostr-protocol/nips/blob/master/01.md
- NIP-07 (Browser Extension): https://github.com/nostr-protocol/nips/blob/master/07.md
- NIP-19 (Bech32 Keys): https://github.com/nostr-protocol/nips/blob/master/19.md
- NIP-46 (Remote Signing): https://github.com/nostr-protocol/nips/blob/master/46.md

### Remote Signers
- nsec.app: https://nsec.app
- Nostrum: https://nostrum.app
- Amber (Android): https://github.com/greenart7c3/Amber

### Browser Extensions
- Alby: https://getalby.com
- nos2x: https://github.com/fiatjaf/nos2x
- Flamingo: https://www.getalby.com/flamingo

---

## Conclusion

This guide provides a complete implementation of three authentication methods for your Bun TypeScript Nostr application:

1. **NIP-07**: Secure browser extension signing
2. **Local Keys**: Quick identity generation with nsec export
3. **Bunker**: Advanced remote signing for maximum security

The Applesauce SDK provides excellent abstractions that make implementing all three methods straightforward while maintaining security and following Nostr standards.

Key advantages of this approach:
- ✅ All three methods use the same `Nip07Interface`
- ✅ Easy to switch between methods
- ✅ Consistent API for signing and encryption
- ✅ Built-in relay pool management
- ✅ Type-safe with TypeScript
- ✅ Works seamlessly with Bun runtime

Next steps:
1. Implement the authentication UI for your specific framework
2. Add proper error handling and loading states
3. Implement session persistence strategy
4. Add user onboarding flows
5. Test thoroughly with real extensions and bunkers
