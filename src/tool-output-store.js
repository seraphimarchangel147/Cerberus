import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir.js";
import { ensureDir, writeTextAtomic } from "./file-utils.js";
import { createId } from "./utils.js";

const REF_PATTERN = /^out_[a-f0-9]{16}$/;

// Oversized model-facing tool results live here so context truncation never
// destroys evidence. The strict ref parser also makes the reader path-safe.
export class ToolOutputStore {
  constructor({ dir } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "tool-outputs");
    ensureDir(this.dir);
  }

  put(value) {
    const ref = createId("out");
    writeTextAtomic(path.join(this.dir, `${ref}.txt`), String(value ?? ""));
    return ref;
  }

  read(ref, { offset = 0, maxChars = 12000 } = {}) {
    const id = String(ref ?? "");
    if (!REF_PATTERN.test(id)) throw new Error("Invalid tool-output ref.");
    const text = fs.readFileSync(path.join(this.dir, `${id}.txt`), "utf8");
    const start = Math.max(0, Math.trunc(Number(offset) || 0));
    const limit = Math.max(1, Math.min(50000, Math.trunc(Number(maxChars) || 12000)));
    return {
      ref: id,
      offset: start,
      totalChars: text.length,
      content: text.slice(start, start + limit),
      hasMore: start + limit < text.length
    };
  }
}

let defaultStore;

export function defaultToolOutputStore() {
  defaultStore ??= new ToolOutputStore();
  return defaultStore;
}
