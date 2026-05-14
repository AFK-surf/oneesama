import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function createJsonFileCollection(filePath, collection = "default") {
  mkdirSync(dirname(filePath), { recursive: true });
  const items = new Map();

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf8");
    if (raw.trim()) {
      const parsed = JSON.parse(raw);
      for (const item of parsed.items || []) {
        if (item?.id) items.set(item.id, item);
      }
    }
  }

  function save() {
    const payload = {
      schema: "meeting-avatar-bot.collection.v1",
      updatedAt: new Date().toISOString(),
      items: [...items.values()],
    };
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(tmp, filePath);
  }

  return {
    provider: "json-file",
    collection,
    get(id) {
      return items.get(id) || null;
    },
    set(id, value) {
      items.set(id, value);
      save();
      return value;
    },
    list() {
      return [...items.values()];
    },
    path: filePath,
  };
}
