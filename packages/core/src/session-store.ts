import crypto from "node:crypto";
import {
  createStateCollection,
  type StateCollection,
  type StateProviderOptions,
} from "./persistence/state-provider.js";

export interface SessionRecord {
  id: string;
  status: string;
  source: string;
  meetUrl: string;
  avatar: string;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface SessionStoreOptions extends StateProviderOptions {}

export interface SessionCreateInput extends Partial<SessionRecord> {}

export function createSessionStore(options: SessionStoreOptions = {}) {
  const sessions = createStateCollection({
    provider: options.provider || (options.filePath ? "json-file" : "memory"),
    filePath: options.filePath,
    sqlitePath: options.sqlitePath,
    collection: options.collection || "sessions",
  }) as StateCollection<SessionRecord>;

  return {
    provider: sessions.provider,
    path: sessions.path,
    collection: sessions.collection,
    create(input: SessionCreateInput) {
      const now = new Date().toISOString();
      const session: SessionRecord = {
        id: `meet_${crypto.randomUUID().slice(0, 8)}`,
        status: "created",
        source: input.source || "unknown",
        meetUrl: input.meetUrl || "",
        avatar: input.avatar || "hiyori",
        requestedBy: input.requestedBy || "",
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.id, session);
      return session;
    },
    get(id: string) {
      return sessions.get(id);
    },
    list() {
      return sessions.list().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    latest() {
      const items = sessions.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return items[0] || null;
    },
    update(id: string, patch: Partial<SessionRecord>) {
      const current = sessions.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      sessions.set(id, next);
      return next;
    },
    close() {
      sessions.close?.();
    },
  };
}

export function createInMemorySessionStore() {
  return createSessionStore({ provider: "memory" });
}

export function createPersistentSessionStore(filePath: string, options: SessionStoreOptions = {}) {
  return createSessionStore({ ...options, filePath, provider: options.provider || "json-file" });
}
