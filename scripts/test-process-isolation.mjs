import fs from "node:fs";
import path from "node:path";

// Node's test runner executes files in parallel child processes. Give each
// child an independent default runtime tree so snapshots and SQLite handles
// cannot contend across test files. Explicit caller-provided data roots remain
// untouched because OPENAGI_TEST_DATA_ROOT is set only by run-tests.mjs.
const root = process.env.OPENAGI_TEST_DATA_ROOT;
if (root) {
  const dataDir = path.join(path.resolve(root), `process-${process.pid}`);
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.OPENAGI_DATA_DIR = dataDir;
}
