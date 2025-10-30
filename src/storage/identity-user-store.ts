import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { normaliseNpub } from "../identity/npub-utils";

export interface IdentityUserRecord {
  npub: string;
  normalizedNpub: string;
  alias: string;
  roles: string[];
  onboardedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type IdentityUserRow = {
  normalizedNpub: string;
  npub: string;
  alias: string;
  roles: string;
  onboardedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type TouchOptions = {
  alias?: string | null;
  lastSeenAt?: string | Date | null;
};

const DEFAULT_DB_PATH = new URL("../../data/identity-users.db", import.meta.url).pathname;

const parseRoles = (input: string | null | undefined): string[] => {
  if (!input || input.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
};

const toIsoString = (value: string | Date | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return value.toISOString();
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return trimmed;
  }
  return date.toISOString();
};

class IdentityUserStore {
  private readonly db: Database;

  constructor(filePath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.initialise();
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_users (
        normalized_npub TEXT PRIMARY KEY,
        npub TEXT NOT NULL,
        alias TEXT NOT NULL,
        roles TEXT NOT NULL DEFAULT '[]',
        onboarded_at TEXT,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  listUsers(): IdentityUserRecord[] {
    const statement = this.db.prepare<IdentityUserRow, IdentityUserRow>(
      `SELECT
         normalized_npub as normalizedNpub,
         npub,
         alias,
         roles,
         onboarded_at as onboardedAt,
         last_seen_at as lastSeenAt,
         created_at as createdAt,
         updated_at as updatedAt
       FROM identity_users
       ORDER BY alias`,
    );
    const rows = statement.all();
    return rows.map((row) => this.hydrate(row));
  }

  touch(npub: string, options: TouchOptions = {}): IdentityUserRecord {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const aliasInput = typeof options.alias === "string" ? options.alias.trim() : null;
    const lastSeenIso = toIsoString(options.lastSeenAt);
    const existing = this.get(normalized);
    const now = new Date().toISOString();

    if (existing) {
      const update = this.db.prepare(
        `UPDATE identity_users
         SET npub = ?2,
             alias = CASE WHEN ?3 IS NOT NULL AND length(?3) > 0 THEN ?3 ELSE alias END,
             last_seen_at = CASE WHEN ?4 IS NOT NULL THEN ?4 ELSE last_seen_at END,
             updated_at = ?5
         WHERE normalized_npub = ?1`,
      );
      update.run(normalized, npub, aliasInput, lastSeenIso, now);
      return this.getOrThrow(normalized);
    }

    const alias = aliasInput && aliasInput.length > 0 ? aliasInput : npub;
    const insert = this.db.prepare(
      `INSERT INTO identity_users (
         normalized_npub,
         npub,
         alias,
         roles,
         onboarded_at,
         last_seen_at,
         created_at,
         updated_at
       ) VALUES (?1, ?2, ?3, '[]', NULL, ?4, ?5, ?5)`,
    );
    insert.run(normalized, npub, alias, lastSeenIso, now);
    return this.getOrThrow(normalized);
  }

  setRole(npub: string, role: string, enabled: boolean): IdentityUserRecord {
    const record = this.touch(npub);
    const normalized = record.normalizedNpub;
    const roles = new Set(record.roles);
    if (enabled) {
      roles.add(role);
    } else {
      roles.delete(role);
    }
    const updatedRoles = JSON.stringify(Array.from(roles).sort());
    const now = new Date().toISOString();
    const onboardedAt =
      role === "onboard" ? (enabled ? now : null) : record.onboardedAt;

    const update = this.db.prepare(
      `UPDATE identity_users
         SET roles = ?2,
             onboarded_at = ?3,
             updated_at = ?4
       WHERE normalized_npub = ?1`,
    );
    update.run(normalized, updatedRoles, onboardedAt, now);
    return this.getOrThrow(normalized);
  }

  getByNormalized(normalizedNpub: string): IdentityUserRecord | null {
    if (!normalizedNpub) return null;
    return this.get(normalizedNpub);
  }

  getByNpub(npub: string): IdentityUserRecord | null {
    const normalized = normaliseNpub(npub);
    if (!normalized) return null;
    return this.get(normalized);
  }

  private get(normalizedNpub: string): IdentityUserRecord | null {
    const statement = this.db.prepare<IdentityUserRow, IdentityUserRow>(
      `SELECT
         normalized_npub as normalizedNpub,
         npub,
         alias,
         roles,
         onboarded_at as onboardedAt,
         last_seen_at as lastSeenAt,
         created_at as createdAt,
         updated_at as updatedAt
       FROM identity_users
       WHERE normalized_npub = ?1`,
    );
    const row = statement.get(normalizedNpub);
    if (!row) return null;
    return this.hydrate(row);
  }

  private getOrThrow(normalizedNpub: string): IdentityUserRecord {
    const record = this.get(normalizedNpub);
    if (!record) {
      throw new Error(`Failed to load identity user ${normalizedNpub}`);
    }
    return record;
  }

  private hydrate(row: IdentityUserRow): IdentityUserRecord {
    return {
      npub: row.npub,
      normalizedNpub: row.normalizedNpub,
      alias: row.alias,
      roles: Array.from(new Set(parseRoles(row.roles))).sort(),
      onboardedAt: row.onboardedAt ?? null,
      lastSeenAt: row.lastSeenAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export const identityUserStore = new IdentityUserStore();
