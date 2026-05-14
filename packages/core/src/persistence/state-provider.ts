import { createJsonFileCollection } from "./json-file-collection.js";
import { createSqliteCollection, type CreateSqliteCollectionOptions } from "./sqlite-collection.js";

export interface StateCollection<T = unknown> {
  provider: string;
  path: string;
  collection: string;
  get(id: string): T | null;
  set(id: string, value: T): T;
  list(): T[];
  close?(): void;
}

export interface StateProviderOptions {
  provider?: string;
  collection?: string;
  filePath?: string;
  sqlitePath?: string;
  dbPath?: string;
}

function createMapCollection(collection = "default") {
  const items = new Map();
  return {
    provider: "memory",
    path: "",
    collection,
    get: (id) => items.get(id) || null,
    set: (id, value) => {
      items.set(id, value);
      return value;
    },
    list: () => [...items.values()],
  };
}

export function normalizeStateProvider(provider: unknown): string {
  return String(provider || "json-file")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
}

export function createStateCollection(options: StateProviderOptions = {}): StateCollection {
  const provider = normalizeStateProvider(options.provider);
  const collection = options.collection || "default";
  if (provider === "memory" || provider === "in-memory") {
    return createMapCollection(collection) as StateCollection;
  }
  if (provider === "json-file" || provider === "file" || provider === "persistent") {
    if (!options.filePath) throw new Error("filePath is required for json-file state provider");
    return createJsonFileCollection(options.filePath, collection) as StateCollection;
  }
  if (provider === "sqlite" || provider === "sqlite3" || provider === "better-sqlite3") {
    const dbPath = options.sqlitePath || options.dbPath || options.filePath;
    if (!dbPath) throw new Error("sqlitePath is required for sqlite state provider");
    return createSqliteCollection({
      dbPath,
      collection,
    } satisfies CreateSqliteCollectionOptions) as StateCollection;
  }
  throw new Error(`Unsupported MAB_STATE_PROVIDER provider: ${provider}`);
}
