import fs from "node:fs";
import path from "node:path";

const DIRECT_UNREF_CALL = /\.unref\s*\(/u;

export function findDirectUnrefCalls(file, source) {
  const findings = [];
  for (const [index, line] of String(source ?? "").split(/\r?\n/u).entries()) {
    if (!DIRECT_UNREF_CALL.test(line)) continue;
    findings.push({
      file,
      line: index + 1,
      source: line.trim()
    });
  }
  return findings;
}

export function scanSourceForDirectUnrefCalls(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const files = collectJavaScriptFiles(root);
  return files.flatMap((filePath) => {
    const relative = path.relative(root, filePath).split(path.sep).join("/");
    return findDirectUnrefCalls(
      relative,
      fs.readFileSync(filePath, "utf8")
    );
  });
}

function collectJavaScriptFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(resolved);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(resolved);
      }
    }
  }
  return files.sort();
}
