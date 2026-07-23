import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONTEXT_REFERENCE_MAX_GIT_COMMITS,
  expandContextReferences,
  parseContextReferences
} from "../src/context-references.js";

function makeTempDir(t, prefix) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function referenceContent(output, number = 1) {
  const header = `[Reference ${number}:`;
  const headerStart = output.indexOf(header);
  assert.notEqual(headerStart, -1, `missing ${header}`);
  const bodyStart = output.indexOf("\n", headerStart) + 1;
  const end = output.indexOf(`\n[End reference ${number}]`, bodyStart);
  assert.notEqual(end, -1, `missing end marker for reference ${number}`);
  return output.slice(bodyStart, end);
}

function textResponse(body, contentType = "text/plain; charset=utf-8") {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? contentType : null;
      }
    },
    async text() {
      return body;
    }
  };
}

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      LC_ALL: "C"
    }
  });
}

test("parseContextReferences preserves reference order and strips trailing punctuation", () => {
  const source = [
    "Use @file:notes.txt:2-4, then @folder:docs); compare @diff;",
    "@staged! @git:99? and @url:https://example.test/a?q=1).",
    "Ignore me@example.test."
  ].join(" ");
  const references = parseContextReferences(source);

  assert.deepEqual(
    references.map((reference) => reference.type),
    ["file", "folder", "diff", "staged", "git", "url"]
  );
  assert.deepEqual(references[0], {
    type: "file",
    value: "notes.txt:2-4",
    path: "notes.txt",
    range: { start: 2, end: 4 },
    raw: "@file:notes.txt:2-4",
    index: source.indexOf("@file:")
  });
  assert.equal(references[1].path, "docs");
  assert.equal(references[1].raw, "@folder:docs");
  assert.equal(references[4].count, CONTEXT_REFERENCE_MAX_GIT_COMMITS);
  assert.equal(references[4].raw, "@git:99");
  assert.equal(references[5].url, "https://example.test/a?q=1");
  assert.equal(references[5].raw, "@url:https://example.test/a?q=1");
  assert.ok(
    references.every((reference, index) => (
      index === 0 || reference.index > references[index - 1].index
    ))
  );
});

test("messages without references remain byte-identical", async () => {
  const source = "No references here.\r\nKeep spacing, inline code, and punctuation: []{}!";
  let fetchCalls = 0;
  let gitCalls = 0;
  const expanded = await expandContextReferences(source, {
    fetchUrl: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    },
    runGit: async () => {
      gitCalls += 1;
      throw new Error("must not run git");
    }
  });

  assert.equal(expanded, source);
  assert.equal(Buffer.from(expanded).equals(Buffer.from(source)), true);
  assert.equal(fetchCalls, 0);
  assert.equal(gitCalls, 0);
});

test("file references expand full content and 1-indexed inclusive ranges", async (t) => {
  const workspaceDir = makeTempDir(t, "openagi-context-files");
  const homeDir = makeTempDir(t, "openagi-context-home");
  writeFile(workspaceDir, "notes.txt", "one\ntwo\nthree\nfour");
  writeFile(homeDir, "home-note.txt", "from home");

  const full = await expandContextReferences("Read @file:notes.txt", {
    workspaceDir,
    homeDir
  });
  assert.equal(referenceContent(full), "one\ntwo\nthree\nfour");

  const ranged = await expandContextReferences("Read @file:notes.txt:2-3", {
    workspaceDir,
    homeDir
  });
  assert.equal(referenceContent(ranged), "two\nthree");

  const reversed = await expandContextReferences("Read @file:notes.txt:4-2", {
    workspaceDir,
    homeDir
  });
  assert.equal(referenceContent(reversed), "one\ntwo\nthree\nfour");

  const outsideRange = await expandContextReferences("Read @file:notes.txt:2-99", {
    workspaceDir,
    homeDir
  });
  assert.equal(referenceContent(outsideRange), "one\ntwo\nthree\nfour");

  const homeRelative = await expandContextReferences("Read @file:~/home-note.txt", {
    workspaceDir,
    homeDir
  });
  assert.equal(referenceContent(homeRelative), "from home");
});

test("missing, outside, and binary file references fail closed with graceful notes", async (t) => {
  const workspaceDir = makeTempDir(t, "openagi-context-safe");
  const homeDir = makeTempDir(t, "openagi-context-safe-home");
  const outsideDir = makeTempDir(t, "openagi-context-outside");
  const outsideFile = writeFile(outsideDir, "outside.txt", "do not read");
  writeFile(workspaceDir, "binary.dat", Buffer.from([0x41, 0x00, 0x42]));

  const missing = await expandContextReferences("Read @file:missing.txt", {
    workspaceDir,
    homeDir
  });
  assert.match(
    referenceContent(missing),
    /^\[Unavailable: .*(?:does not exist|ENOENT).*\]$/
  );

  const outside = await expandContextReferences(`Read @file:${outsideFile}`, {
    workspaceDir,
    homeDir
  });
  assert.match(referenceContent(outside), /^\[Unavailable: referenced path is outside the allowed workspace\]$/);
  assert.doesNotMatch(outside, /do not read/);

  const binary = await expandContextReferences("Read @file:binary.dat", {
    workspaceDir,
    homeDir
  });
  assert.match(referenceContent(binary), /^\[Unavailable: binary files cannot be attached as context\]$/);
});

test("file symlinks cannot escape the allowed roots", async (t) => {
  const workspaceDir = makeTempDir(t, "openagi-context-link");
  const homeDir = makeTempDir(t, "openagi-context-link-home");
  const outsideDir = makeTempDir(t, "openagi-context-link-outside");
  const outsideFile = writeFile(outsideDir, "outside.txt", "symlink secret");
  const link = path.join(workspaceDir, "outside-link.txt");
  try {
    fs.symlinkSync(outsideFile, link, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const expanded = await expandContextReferences("Read @file:outside-link.txt", {
    workspaceDir,
    homeDir
  });
  assert.match(
    referenceContent(expanded),
    /^\[Unavailable: (?:symbolic-link references cannot be attached|referenced path resolves outside the allowed workspace)\]$/
  );
  assert.doesNotMatch(expanded, /symlink secret/);
});

test("folder listings are sorted, skip unsafe entries, and honor entry and depth caps", async (t) => {
  const workspaceDir = makeTempDir(t, "openagi-context-folder");
  writeFile(workspaceDir, "tree/b.txt", "b");
  writeFile(workspaceDir, "tree/a.txt", "a");
  writeFile(workspaceDir, "tree/nested/c.txt", "c");
  writeFile(workspaceDir, "tree/.hidden.txt", "hidden");
  writeFile(workspaceDir, "tree/node_modules/package/index.js", "ignored");
  writeFile(workspaceDir, "tree/dist/bundle.js", "ignored");
  writeFile(workspaceDir, "tree/secrets/key.txt", "ignored");
  const link = path.join(workspaceDir, "tree", "z-link.txt");
  try {
    fs.symlinkSync(path.join(workspaceDir, "tree", "a.txt"), link, "file");
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
  }

  const options = { workspaceDir, homeDir: workspaceDir };
  const first = referenceContent(
    await expandContextReferences("List @folder:tree", options)
  );
  const second = referenceContent(
    await expandContextReferences("List @folder:tree", options)
  );
  assert.equal(first, second);
  assert.equal(first, [
    "tree/",
    "  a.txt",
    "  b.txt",
    "  nested/",
    "    c.txt"
  ].join("\n"));

  const entryCapped = referenceContent(
    await expandContextReferences("List @folder:tree", {
      ...options,
      folderMaxEntries: 2
    })
  );
  assert.equal(entryCapped, [
    "tree/",
    "  a.txt",
    "  b.txt",
    "  ...[folder listing truncated]"
  ].join("\n"));

  const depthCapped = referenceContent(
    await expandContextReferences("List @folder:tree", {
      ...options,
      folderMaxDepth: 1
    })
  );
  assert.equal(depthCapped, [
    "tree/",
    "  a.txt",
    "  b.txt",
    "  nested/"
  ].join("\n"));
});

test("real git references expand unstaged, staged, and commit patch context", async (t) => {
  const workspaceDir = makeTempDir(t, "openagi-context-git");
  git(workspaceDir, "init", "--quiet");
  git(workspaceDir, "config", "user.name", "Context Fixture");
  git(workspaceDir, "config", "user.email", "context@example.test");
  writeFile(workspaceDir, "tracked.txt", "base line\n");
  git(workspaceDir, "add", "tracked.txt");
  git(workspaceDir, "commit", "--quiet", "-m", "initial context commit");

  writeFile(workspaceDir, "tracked.txt", "base line\nunstaged line\n");
  writeFile(workspaceDir, "staged.txt", "staged line\n");
  git(workspaceDir, "add", "staged.txt");

  const expanded = await expandContextReferences(
    "Inspect @diff then @staged then @git:3",
    { workspaceDir, homeDir: workspaceDir }
  );
  const unstaged = referenceContent(expanded, 1);
  const staged = referenceContent(expanded, 2);
  const history = referenceContent(expanded, 3);

  assert.match(unstaged, /diff --git a\/tracked\.txt b\/tracked\.txt/);
  assert.match(unstaged, /^\+unstaged line$/m);
  assert.doesNotMatch(unstaged, /staged\.txt/);
  assert.match(staged, /diff --git a\/staged\.txt b\/staged\.txt/);
  assert.match(staged, /^\+staged line$/m);
  assert.match(history, /Subject: initial context commit/);
  assert.match(history, /diff --git a\/tracked\.txt b\/tracked\.txt/);
  assert.match(history, /^\+base line$/m);
});

test("@git commit counts clamp to one through ten before invoking git", async (t) => {
  const workspaceDir = makeTempDir(t, "openagi-context-git-clamp");
  const parsed = parseContextReferences("Old @git:0 and many @git:999");
  assert.deepEqual(parsed.map((reference) => reference.count), [1, 10]);

  const calls = [];
  const expanded = await expandContextReferences("Inspect @git:999", {
    workspaceDir,
    homeDir: workspaceDir,
    async runGit(args, options) {
      calls.push({ args, options });
      return { stdout: "clamped history" };
    }
  });

  assert.equal(referenceContent(expanded), "clamped history");
  assert.equal(calls.length, 1);
  const countFlag = calls[0].args.indexOf("-n");
  assert.notEqual(countFlag, -1);
  assert.equal(calls[0].args[countFlag + 1], "10");
  assert.equal(calls[0].options.cwd, workspaceDir);
  assert.ok(calls[0].options.maxBuffer >= 65536);
});

test("URL references strip punctuation, clean HTML, and honor per-reference caps", async (t) => {
  const workspaceDir = makeTempDir(t, "openagi-context-url");
  const calls = [];
  const expanded = await expandContextReferences(
    "Fetch @url:https://example.test/page?q=1).",
    {
      workspaceDir,
      homeDir: workspaceDir,
      async fetchUrl(url, init, guard) {
        calls.push({ url, init, guard });
        return textResponse(
          "<html><head><style>.bad{display:none}</style><script>bad()</script></head>"
          + "<body><h1>A &amp; B</h1><p>Hello <b>world</b>.</p></body></html>",
          "text/html; charset=utf-8"
        );
      }
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/page?q=1");
  assert.equal(calls[0].guard.label, "context reference URL");
  assert.equal(calls[0].guard.maxRedirects, 5);
  assert.match(calls[0].init.headers.accept, /text\/html/);
  const cleaned = referenceContent(expanded);
  assert.match(cleaned, /^A & B\nHello world ?\.$/);
  assert.doesNotMatch(cleaned, /<[^>]+>|bad\(\)|display:none/);

  const capped = await expandContextReferences(
    "Fetch @url:https://example.test/long.",
    {
      workspaceDir,
      homeDir: workspaceDir,
      maxCharsPerRef: 32,
      async fetchUrl(url) {
        assert.equal(url, "https://example.test/long");
        return textResponse("x".repeat(200));
      }
    }
  );
  const cappedContent = referenceContent(capped);
  assert.equal(cappedContent.length, 32);
  assert.match(cappedContent, /\.\.\.\[truncated\]$/);
});

test("the aggregate context cap bounds content and reports omitted references", async (t) => {
  const workspaceDir = makeTempDir(t, "openagi-context-total-cap");
  writeFile(workspaceDir, "one.txt", "a".repeat(100));
  writeFile(workspaceDir, "two.txt", "b".repeat(100));
  writeFile(workspaceDir, "three.txt", "c".repeat(100));

  const expanded = await expandContextReferences(
    "Use @file:one.txt @file:two.txt @file:three.txt",
    {
      workspaceDir,
      homeDir: workspaceDir,
      maxCharsPerRef: 50,
      maxTotalChars: 65
    }
  );
  const first = referenceContent(expanded, 1);
  const second = referenceContent(expanded, 2);
  assert.equal(first.length, 50);
  assert.equal(second.length, 15);
  assert.equal(first.length + second.length, 65);
  assert.doesNotMatch(expanded, /\[Reference 3:/);
  assert.match(expanded, /attached context size limit reached/);
});

test("reference count caps are deterministic and explicitly reported", async (t) => {
  const workspaceDir = makeTempDir(t, "openagi-context-ref-cap");
  writeFile(workspaceDir, "one.txt", "one");
  writeFile(workspaceDir, "two.txt", "two");
  writeFile(workspaceDir, "three.txt", "three");

  const expanded = await expandContextReferences(
    "Use @file:one.txt @file:two.txt @file:three.txt",
    {
      workspaceDir,
      homeDir: workspaceDir,
      maxRefs: 2
    }
  );
  assert.equal(referenceContent(expanded, 1), "one");
  assert.equal(referenceContent(expanded, 2), "two");
  assert.doesNotMatch(expanded, /\[Reference 3:/);
  assert.match(expanded, /maximum 2 references per message/);
});

test("pre-aborted and mid-fetch abort signals stop expansion", async (t) => {
  const workspaceDir = makeTempDir(t, "openagi-context-abort");
  writeFile(workspaceDir, "note.txt", "never attached");
  const preAborted = new AbortController();
  preAborted.abort(new Error("caller stopped"));

  await assert.rejects(
    expandContextReferences("Read @file:note.txt", {
      workspaceDir,
      homeDir: workspaceDir,
      signal: preAborted.signal
    }),
    /caller stopped/
  );

  const midFetch = new AbortController();
  let fetchCalls = 0;
  await assert.rejects(
    expandContextReferences("Fetch @url:https://example.test/slow", {
      workspaceDir,
      homeDir: workspaceDir,
      signal: midFetch.signal,
      async fetchUrl() {
        fetchCalls += 1;
        midFetch.abort();
        return textResponse("too late");
      }
    }),
    (error) => error?.name === "AbortError" || /abort/i.test(error?.message ?? "")
  );
  assert.equal(fetchCalls, 1);
});
