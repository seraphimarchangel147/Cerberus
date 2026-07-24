import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode !== "0" && mode !== "1") {
  console.error("Usage: node scripts/run-tests.mjs <0|1> [node --test arguments]");
  process.exit(2);
}

const child = spawn(
  process.execPath,
  ["--test", ...process.argv.slice(3)],
  {
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      OPENAGI_AUTO_APPROVE: mode
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
  if (signal) {
    console.error(`Test process ended from ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = Number.isInteger(code) ? code : 1;
});
