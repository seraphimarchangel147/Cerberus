import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mode = process.argv[2];
if (mode !== "0" && mode !== "1") {
  console.error("Usage: node scripts/run-tests.mjs <0|1> [node --test arguments]");
  process.exit(2);
}

// Tests that construct a default runtime must never read or mutate the
// operator's live ~/.openagi tree. Keep the whole lane in a disposable data
// root unless the caller deliberately supplied an isolated one.
const ownedDataDir = process.env.OPENAGI_DATA_DIR
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), "openagi-test-data-"));
const child = spawn(
  process.execPath,
  [
    "--import",
    new URL("./test-process-isolation.mjs", import.meta.url).href,
    "--test",
    ...process.argv.slice(3)
  ],
  {
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      OPENAGI_AUTO_APPROVE: mode,
      ...(ownedDataDir ? { OPENAGI_TEST_DATA_ROOT: ownedDataDir } : {})
    }
  }
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited.
    }
  });
}

child.once("error", (error) => {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (ownedDataDir) {
    try {
      fs.rmSync(ownedDataDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50
      });
    } catch {
      // Child exit releases all handles; a later temp cleanup can reclaim an
      // antivirus-delayed directory without risking the user's live data.
    }
  }
  if (signal) {
    console.error(`Test process ended from ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = Number.isInteger(code) ? code : 1;
});
