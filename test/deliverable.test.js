import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DELIVERABLE_EXTENSION_MAP,
  classifyDeliverablePath,
  scanDeliverables,
  stripDeliveredPaths
} from "../src/deliverable.js";

function temporaryDirectory(t, prefix = "openagi-deliverable") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(root, relativePath, contents = relativePath) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

test("the Hermes extension table maps every supported type to its delivery route", () => {
  const expected = {
    image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "svg"],
    video: ["mp4", "mov", "avi", "mkv", "webm"],
    audio: ["mp3", "wav", "ogg", "m4a", "flac"],
    document: ["pdf", "docx", "doc", "odt", "rtf", "txt", "md"],
    data: ["xlsx", "xls", "csv", "tsv", "json", "xml", "yaml", "yml"],
    presentation: ["pptx", "ppt", "odp"],
    archive: ["zip", "tar", "gz", "tgz", "bz2", "7z"],
    web: ["html", "htm"]
  };
  const seen = new Set();
  for (const [category, extensions] of Object.entries(expected)) {
    for (const extension of extensions) {
      const result = classifyDeliverablePath(`/tmp/file.${extension.toUpperCase()}`);
      assert.equal(result.category, category);
      assert.equal(
        result.delivery,
        category === "image" || category === "video"
          ? "inline"
          : category === "audio"
            ? "voice"
            : "file"
      );
      assert.equal(result.extension, extension);
      seen.add(extension);
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    Object.keys(DELIVERABLE_EXTENSION_MAP).sort()
  );
  for (const extension of ["py", "js", "ts", "log", "sh", "exe"]) {
    assert.equal(classifyDeliverablePath(`/tmp/source.${extension}`), null);
  }
});

test("absolute and home-relative files scan once and every successful occurrence strips", (t) => {
  const root = temporaryDirectory(t);
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir);
  const chart = fixture(root, "chart.png", Buffer.from("chart"));
  fixture(homeDir, "report.pdf", Buffer.from("report"));
  const text = `Chart ${chart}, duplicate ${chart}. Home ~/report.pdf!`;

  const candidates = scanDeliverables(text, { homeDir });

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].filename, "chart.png");
  assert.equal(candidates[0].occurrences.length, 2);
  assert.deepEqual(candidates[0].buffer, Buffer.from("chart"));
  assert.equal(candidates[1].filename, "report.pdf");
  assert.equal(candidates[1].occurrences.length, 1);
  const stripped = stripDeliveredPaths(text, candidates);
  assert.doesNotMatch(stripped, /chart\.png|report\.pdf/u);
  assert.match(stripped, /^Chart,/u);
  assert.match(stripped, /Home!/u);
});

test("fenced and inline code, relative paths, URLs, and source files remain untouched", (t) => {
  const root = temporaryDirectory(t);
  const chart = fixture(root, "chart.png");
  const second = fixture(root, "second.png");
  const source = fixture(root, "worker.py", "print('example')\n");
  const text = [
    "```text",
    chart,
    "```",
    "~~~",
    second,
    "~~~",
    `Inline \`${chart}\``,
    "Relative relative.png",
    "Remote https://example.test/assets/remote.png",
    `Source ${source}`
  ].join("\n");

  assert.deepEqual(scanDeliverables(text), []);
  assert.equal(stripDeliveredPaths(text, []), text);
});

test("trailing prose punctuation is excluded from the delivered path span", (t) => {
  const root = temporaryDirectory(t);
  const chart = fixture(root, "chart.png");
  const text = `Result (${chart}).`;

  const candidates = scanDeliverables(text);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].raw, chart);
  assert.equal(text.slice(candidates[0].start, candidates[0].end), chart);
  assert.equal(stripDeliveredPaths(text, candidates), "Result ().");
});

test("missing, non-regular, symlinked, sensitive, and oversized paths fail closed", (t) => {
  const root = temporaryDirectory(t);
  const directoryNamedFile = path.join(root, "folder.pdf");
  fs.mkdirSync(directoryNamedFile);
  const ordinary = fixture(root, "ordinary.pdf", "ordinary");
  const oversized = fixture(root, "large.pdf", "x".repeat(20));
  const sensitive = fixture(root, "secrets/report.json", "{\"token\":\"hidden\"}");
  const missing = path.join(root, "missing.pdf");
  const link = path.join(root, "link.pdf");
  let linkCreated = true;
  try {
    fs.symlinkSync(ordinary, link, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") linkCreated = false;
    else throw error;
  }
  const paths = [
    missing,
    directoryNamedFile,
    sensitive,
    oversized,
    ...(linkCreated ? [link] : [])
  ];

  const candidates = scanDeliverables(paths.join("\n"), {
    maxFileBytes: 10
  });

  assert.deepEqual(candidates, []);
});

test("file-count and aggregate-byte caps are deterministic", (t) => {
  const root = temporaryDirectory(t);
  const first = fixture(root, "a.txt", "aaaa");
  const second = fixture(root, "b.txt", "bbbb");
  const third = fixture(root, "c.txt", "cccc");
  const text = `${first} ${second} ${third}`;

  const fileCapped = scanDeliverables(text, { maxFiles: 2 });
  assert.deepEqual(fileCapped.map((item) => item.filename), ["a.txt", "b.txt"]);

  const byteCapped = scanDeliverables(text, { maxTotalBytes: 7 });
  assert.deepEqual(byteCapped.map((item) => item.filename), ["a.txt"]);
});
