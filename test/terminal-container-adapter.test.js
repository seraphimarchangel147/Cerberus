import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DockerTerminalAdapter,
  buildDockerTerminalRunArgs
} from "../src/terminal-container-adapter.js";

const INSTALL_ID = "b".repeat(64);
const TERMINAL_ID = "terminal_0000000000000001";
const CONTAINER_NAME = "openagi-term-bbbbbbbb-0000000000000001";
const IMAGE = `openagi/terminal@sha256:${"a".repeat(64)}`;

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-terminal-adapter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function startOptions(t) {
  return {
    terminalId: TERMINAL_ID,
    projectId: "alpha",
    containerName: CONTAINER_NAME,
    installId: INSTALL_ID,
    image: IMAGE,
    workspaceRoot: workspace(t),
    cwd: ".",
    user: "65534:65534",
    limits: {
      processes: 16,
      cpus: 0.25,
      memoryBytes: 128 * 1024 * 1024,
      tmpfsBytes: 8 * 1024 * 1024,
      openFiles: 128
    }
  };
}

test("Docker PTY argv is fixed, local-only, bounded, and overrides image CMD", (t) => {
  const options = startOptions(t);
  const args = buildDockerTerminalRunArgs(options);
  const imageIndex = args.indexOf(IMAGE);

  assert.equal(args[0], "run");
  assert.deepEqual(args.slice(imageIndex), [IMAGE, "-i"]);
  assert.deepEqual(args.slice(args.indexOf("--entrypoint"), imageIndex), [
    "--entrypoint",
    "/bin/sh"
  ]);
  assert.ok(args.includes("--pull"));
  assert.equal(args[args.indexOf("--pull") + 1], "never");
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--log-driver") + 1], "none");
  assert.equal(args[args.indexOf("--memory-swap") + 1], String(128 * 1024 * 1024));
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(args[args.indexOf("--security-opt") + 1], "no-new-privileges:true");
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("HOME=/tmp"));
  assert.equal(args.some((value) => /TOKEN|SECRET|PASSWORD|docker\.sock/iu.test(value)), false);
});

test("Docker adapter rejects remote daemons and malformed enumeration", async () => {
  const remote = new DockerTerminalAdapter({
    env: { DOCKER_HOST: "tcp://127.0.0.1:2375" }
  });
  await assert.rejects(
    () => remote.verifyImage(IMAGE),
    (error) => error?.code === "TERMINAL_REMOTE_DOCKER_BLOCKED"
  );

  const malformed = new DockerTerminalAdapter({ env: {} });
  malformed._verifyLocalDaemon = async () => "npipe:////./pipe/docker_engine";
  malformed._run = async () => ({
    ok: true,
    stdout: "not-a-container-id\n",
    stderr: ""
  });
  await assert.rejects(
    () => malformed.listManaged({ installId: INSTALL_ID }),
    (error) => error?.code === "TERMINAL_CONTAINER_LIST_INVALID"
  );

  const overflow = new DockerTerminalAdapter({ env: {} });
  overflow._verifyLocalDaemon = async () => "unix:///var/run/docker.sock";
  overflow._run = async () => ({
    ok: true,
    stdout: `${Array.from({ length: 65 }, (_, index) => (
      index.toString(16).padStart(12, "0")
    )).join("\n")}\n`,
    stderr: ""
  });
  await assert.rejects(
    () => overflow.listManaged({ installId: INSTALL_ID }),
    (error) => error?.code === "TERMINAL_CONTAINER_LIST_INVALID"
  );
});

test("managed enumeration validates exact labels and container identities", async () => {
  const adapter = new DockerTerminalAdapter({ env: {} });
  adapter._verifyLocalDaemon = async () => "unix:///var/run/docker.sock";
  const fullId = "c".repeat(64);
  adapter._run = async (args) => {
    if (args[0] === "ps") {
      return { ok: true, stdout: `${fullId.slice(0, 12)}\n`, stderr: "" };
    }
    return {
      ok: true,
      stdout: JSON.stringify([{
        Id: fullId,
        Name: `/${CONTAINER_NAME}`,
        Config: {
          Labels: {
            "openagi.terminal.managed": "true",
            "openagi.terminal.install": INSTALL_ID,
            "openagi.terminal.id": TERMINAL_ID,
            "openagi.terminal.project": "alpha"
          }
        },
        State: { Running: true, ExitCode: 0 }
      }]),
      stderr: ""
    };
  };

  const listed = await adapter.listManaged({ installId: INSTALL_ID });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, fullId);
  assert.equal(listed[0].name, CONTAINER_NAME);
  assert.equal(listed[0].running, true);
});
