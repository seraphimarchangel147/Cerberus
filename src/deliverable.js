import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DELIVERABLE_MAX_FILES = 8;
export const DELIVERABLE_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const DELIVERABLE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const TYPE_ROWS = [
  ["image", "inline", "png", "image/png"],
  ["image", "inline", "jpg", "image/jpeg"],
  ["image", "inline", "jpeg", "image/jpeg"],
  ["image", "inline", "gif", "image/gif"],
  ["image", "inline", "webp", "image/webp"],
  ["image", "inline", "bmp", "image/bmp"],
  ["image", "inline", "tiff", "image/tiff"],
  ["image", "inline", "svg", "image/svg+xml"],
  ["video", "inline", "mp4", "video/mp4"],
  ["video", "inline", "mov", "video/quicktime"],
  ["video", "inline", "avi", "video/x-msvideo"],
  ["video", "inline", "mkv", "video/x-matroska"],
  ["video", "inline", "webm", "video/webm"],
  ["audio", "voice", "mp3", "audio/mpeg"],
  ["audio", "voice", "wav", "audio/wav"],
  ["audio", "voice", "ogg", "audio/ogg"],
  ["audio", "voice", "m4a", "audio/mp4"],
  ["audio", "voice", "flac", "audio/flac"],
  ["document", "file", "pdf", "application/pdf"],
  ["document", "file", "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["document", "file", "doc", "application/msword"],
  ["document", "file", "odt", "application/vnd.oasis.opendocument.text"],
  ["document", "file", "rtf", "application/rtf"],
  ["document", "file", "txt", "text/plain"],
  ["document", "file", "md", "text/markdown"],
  ["data", "file", "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["data", "file", "xls", "application/vnd.ms-excel"],
  ["data", "file", "csv", "text/csv"],
  ["data", "file", "tsv", "text/tab-separated-values"],
  ["data", "file", "json", "application/json"],
  ["data", "file", "xml", "application/xml"],
  ["data", "file", "yaml", "application/yaml"],
  ["data", "file", "yml", "application/yaml"],
  ["presentation", "file", "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["presentation", "file", "ppt", "application/vnd.ms-powerpoint"],
  ["presentation", "file", "odp", "application/vnd.oasis.opendocument.presentation"],
  ["archive", "file", "zip", "application/zip"],
  ["archive", "file", "tar", "application/x-tar"],
  ["archive", "file", "gz", "application/gzip"],
  ["archive", "file", "tgz", "application/gzip"],
  ["archive", "file", "bz2", "application/x-bzip2"],
  ["archive", "file", "7z", "application/x-7z-compressed"],
  ["web", "file", "html", "text/html"],
  ["web", "file", "htm", "text/html"]
];

export const DELIVERABLE_EXTENSION_MAP = Object.freeze(Object.fromEntries(
  TYPE_ROWS.map(([category, delivery, extension, mimeType]) => [
    extension,
    Object.freeze({ category, delivery, extension, mimeType })
  ])
));

const EXTENSION_PATTERN = Object.keys(DELIVERABLE_EXTENSION_MAP)
  .sort((left, right) => right.length - left.length)
  .join("|");
const LOCAL_PATH_RE = new RegExp(
  `(?<![A-Za-z0-9_:/\\\\])((?:~[\\\\/]|[A-Za-z]:[\\\\/]|\\/)[^\\s<>"'\`]*?\\.(${EXTENSION_PATTERN}))(?=$|[\\s.,;:!?)}\\]>'"\`])`,
  "giu"
);
const PINNED_ARTIFACT_RE = /(?<![A-Za-z0-9_:/\\])(artifact:artifact_[a-f0-9]{16}@[1-9][0-9]{0,15})(?=$|[\s.,;:!?)}\]>'"`])/giu;
const SENSITIVE_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".openagi",
  "auth",
  "credentials",
  "secrets",
  "tokens"
]);
const SENSITIVE_BASENAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc"
]);

export function classifyDeliverablePath(value) {
  const extension = path.extname(String(value ?? "")).slice(1).toLowerCase();
  const classification = DELIVERABLE_EXTENSION_MAP[extension];
  return classification ? { ...classification } : null;
}

export function scanDeliverables(text, options = {}) {
  const source = String(text ?? "");
  if (!source) return [];
  const settings = scanSettings(options);
  const protectedRanges = findCodeRanges(source);
  const candidates = [];
  const byPath = new Map();
  let totalBytes = 0;

  LOCAL_PATH_RE.lastIndex = 0;
  let match;
  while ((match = LOCAL_PATH_RE.exec(source)) !== null) {
    const start = match.index;
    const end = start + match[1].length;
    if (rangeIsProtected(start, end, protectedRanges)) continue;

    const mentionedPath = match[1];
    const classification = classifyDeliverablePath(mentionedPath);
    if (!classification) continue;

    const resolvedPath = resolveMentionedPath(mentionedPath, settings.homeDir);
    if (!resolvedPath || isSensitivePath(resolvedPath, settings.homeDir)) continue;

    let realPath;
    let stat;
    try {
      const linkStat = settings.fsImpl.lstatSync(resolvedPath);
      if (linkStat.isSymbolicLink?.()) continue;
      realPath = settings.fsImpl.realpathSync(resolvedPath);
      if (isSensitivePath(realPath, settings.homeDir)) continue;
      if (!withinProjectWorkspace(realPath, settings)) continue;
      stat = settings.fsImpl.statSync(realPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > settings.maxFileBytes) continue;

    const key = path.normalize(realPath);
    const occurrence = Object.freeze({
      start,
      end,
      raw: mentionedPath
    });
    const duplicate = byPath.get(key);
    if (duplicate) {
      duplicate.occurrences.push(occurrence);
      continue;
    }
    if (candidates.length >= settings.maxFiles) continue;
    if (totalBytes + stat.size > settings.maxTotalBytes) continue;

    let buffer;
    try {
      buffer = settings.fsImpl.readFileSync(realPath);
    } catch {
      continue;
    }
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (buffer.byteLength > settings.maxFileBytes) continue;
    if (totalBytes + buffer.byteLength > settings.maxTotalBytes) continue;

    const candidate = {
      ...classification,
      raw: mentionedPath,
      path: mentionedPath,
      resolvedPath: realPath,
      filename: safeAttachmentFilename(path.basename(realPath)),
      buffer,
      size: buffer.byteLength,
      start,
      end,
      occurrences: [occurrence]
    };
    candidates.push(candidate);
    byPath.set(key, candidate);
    totalBytes += buffer.byteLength;
  }

  if (settings.resolveArtifact) {
    const byArtifact = new Map();
    PINNED_ARTIFACT_RE.lastIndex = 0;
    while ((match = PINNED_ARTIFACT_RE.exec(source)) !== null) {
      const start = match.index;
      const end = start + match[1].length;
      if (rangeIsProtected(start, end, protectedRanges)) continue;
      const raw = match[1];
      const occurrence = Object.freeze({ start, end, raw });
      const duplicate = byArtifact.get(raw);
      if (duplicate) {
        duplicate.occurrences.push(occurrence);
        continue;
      }
      if (candidates.length >= settings.maxFiles) continue;

      let resolved;
      try {
        resolved = settings.resolveArtifact(raw, {
          projectId: settings.projectId
        });
      } catch {
        continue;
      }
      const candidate = artifactCandidate(resolved, raw, occurrence);
      if (!candidate) continue;
      if (candidate.size > settings.maxFileBytes) continue;
      if (totalBytes + candidate.size > settings.maxTotalBytes) continue;
      candidates.push(candidate);
      byArtifact.set(raw, candidate);
      totalBytes += candidate.size;
    }
  }

  candidates.sort((left, right) => left.start - right.start);
  return candidates;
}

export function stripDeliveredPaths(text, successfulCandidates = []) {
  const source = String(text ?? "");
  const spans = [];
  for (const candidate of successfulCandidates ?? []) {
    const occurrences = Array.isArray(candidate?.occurrences)
      ? candidate.occurrences
      : [candidate];
    for (const occurrence of occurrences) {
      const start = Number(occurrence?.start);
      const end = Number(occurrence?.end);
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
      if (start < 0 || end <= start || end > source.length) continue;
      const raw = String(occurrence?.raw ?? "");
      if (raw && source.slice(start, end) !== raw) continue;
      spans.push({ start, end });
    }
  }
  if (spans.length === 0) return source;

  const merged = mergeSpans(spans);
  let output = source;
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const span = merged[index];
    output = `${output.slice(0, span.start)}${output.slice(span.end)}`;
  }
  return output
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/[ \t]+([.,;:!?])/gu, "$1")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function scanSettings(options) {
  const projectId = typeof options.projectId === "string" && options.projectId.trim()
    ? options.projectId.trim().toLowerCase()
    : "default";
  const workspaceRoot = typeof options.workspaceRoot === "string"
    && options.workspaceRoot.trim()
    ? path.resolve(options.workspaceRoot)
    : null;
  const resolveArtifact = typeof options.resolveArtifact === "function"
    ? options.resolveArtifact
    : typeof options.artifactStore?.resolvePinnedRef === "function"
      ? options.artifactStore.resolvePinnedRef.bind(options.artifactStore)
      : null;
  return {
    fsImpl: options.fsImpl ?? fs,
    homeDir: path.resolve(options.homeDir ?? os.homedir()),
    projectId,
    workspaceRoot,
    resolveArtifact,
    maxFiles: boundedInteger(options.maxFiles, DELIVERABLE_MAX_FILES, 1, 32),
    maxFileBytes: boundedInteger(
      options.maxFileBytes,
      DELIVERABLE_MAX_FILE_BYTES,
      1,
      100 * 1024 * 1024
    ),
    maxTotalBytes: boundedInteger(
      options.maxTotalBytes,
      DELIVERABLE_MAX_TOTAL_BYTES,
      1,
      200 * 1024 * 1024
    )
  };
}

function artifactCandidate(value, raw, occurrence) {
  const resolved = value?.artifact ?? value;
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    return null;
  }
  const kind = resolved.kind;
  if (kind !== "markdown" && kind !== "data") return null;
  let buffer;
  if (Buffer.isBuffer(resolved.buffer)) {
    buffer = Buffer.from(resolved.buffer);
  } else if (kind === "markdown") {
    const content = resolved.content ?? resolved.body;
    if (typeof content !== "string") return null;
    buffer = Buffer.from(content, "utf8");
  } else {
    const content = Object.hasOwn(resolved, "content")
      ? resolved.content
      : resolved.data;
    try {
      buffer = Buffer.from(`${stableJson(content)}\n`, "utf8");
    } catch {
      return null;
    }
  }
  const id = typeof resolved.id === "string" && resolved.id
    ? resolved.id
    : raw.slice("artifact:".length).split("@")[0];
  const extension = kind === "markdown" ? "md" : "json";
  const title = typeof resolved.title === "string" && resolved.title.trim()
    ? resolved.title.trim()
    : id;
  const stem = safeAttachmentFilename(title)
    .replace(/\.(?:md|json)$/iu, "")
    .replace(/[. ]+$/gu, "")
    || id;
  return {
    category: kind === "markdown" ? "document" : "data",
    delivery: "file",
    extension,
    mimeType: kind === "markdown" ? "text/markdown" : "application/json",
    artifactId: id,
    revision: Number(resolved.revision ?? raw.split("@").at(-1)),
    raw,
    path: raw,
    resolvedPath: null,
    filename: safeAttachmentFilename(`${stem}.${extension}`),
    buffer,
    size: buffer.byteLength,
    start: occurrence.start,
    end: occurrence.end,
    occurrences: [occurrence]
  };
}

function stableJson(value, seen = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Artifact data must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Artifact data cannot be cyclic.");
    seen.add(value);
    const rendered = `[${value.map((item) => stableJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return rendered;
  }
  if (!value || typeof value !== "object") {
    throw new TypeError("Artifact data must be JSON-compatible.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Artifact data must use plain objects.");
  }
  if (seen.has(value)) throw new TypeError("Artifact data cannot be cyclic.");
  seen.add(value);
  const rendered = `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return rendered;
}

function resolveMentionedPath(value, homeDir) {
  const raw = String(value ?? "");
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.resolve(homeDir, raw.slice(2));
  }
  if (!path.isAbsolute(raw)) return null;
  return path.resolve(raw);
}

function isSensitivePath(value, homeDir) {
  const absolute = path.resolve(value);
  const segments = absolute.split(/[\\/]+/u).map((segment) => segment.toLowerCase());
  const basename = path.basename(absolute).toLowerCase();
  if (SENSITIVE_SEGMENTS.has(basename)) return true;
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) return true;
  if (SENSITIVE_BASENAMES.has(basename)) return true;
  if (basename.startsWith(".env")) return true;
  if (/(?:^|[._-])(?:credential|password|secret|token)s?(?:[._-]|$)/u.test(basename)) {
    return true;
  }
  const relativeHome = path.relative(homeDir, absolute);
  if (isRelativeInside(relativeHome)) {
    const first = relativeHome.split(path.sep)[0]?.toLowerCase();
    if ([".config", ".docker"].includes(first)) return true;
  }
  return false;
}

function withinProjectWorkspace(realPath, settings) {
  if (settings.projectId === "default") return true;
  if (!settings.workspaceRoot) return false;
  let realRoot;
  try {
    realRoot = settings.fsImpl.realpathSync(settings.workspaceRoot);
  } catch {
    return false;
  }
  const relative = path.relative(realRoot, realPath);
  return relative === "" || isRelativeInside(relative);
}

function safeAttachmentFilename(value) {
  const cleaned = String(value ?? "attachment")
    .replace(/[\r\n\0]/gu, "")
    .replace(/[\\/]/gu, "_")
    .slice(0, 180);
  return cleaned || "attachment";
}

function findCodeRanges(source) {
  const fenced = findFencedCodeRanges(source);
  const inline = [];
  let index = 0;
  while (index < source.length) {
    if (indexInRanges(index, fenced) || source[index] !== "`") {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (source[runEnd] === "`") runEnd += 1;
    const marker = source.slice(index, runEnd);
    const close = source.indexOf(marker, runEnd);
    if (close === -1 || indexInRanges(close, fenced)) {
      index = runEnd;
      continue;
    }
    inline.push({ start: index, end: close + marker.length });
    index = close + marker.length;
  }
  return [...fenced, ...inline].sort((left, right) => left.start - right.start);
}

function findFencedCodeRanges(source) {
  const ranges = [];
  const lines = [];
  const lineRe = /.*(?:\r?\n|$)/gu;
  let match;
  while ((match = lineRe.exec(source)) !== null && match[0]) {
    lines.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0].replace(/\r?\n$/u, "")
    });
  }

  let open = null;
  for (const line of lines) {
    if (!open) {
      const opening = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line.text);
      if (opening) {
        open = {
          start: line.start,
          character: opening[1][0],
          length: opening[1].length
        };
      }
      continue;
    }
    const closing = new RegExp(
      `^[ \\t]{0,3}${escapeRegExp(open.character)}{${open.length},}[ \\t]*$`,
      "u"
    );
    if (closing.test(line.text)) {
      ranges.push({ start: open.start, end: line.end });
      open = null;
    }
  }
  if (open) ranges.push({ start: open.start, end: source.length });
  return ranges;
}

function rangeIsProtected(start, end, ranges) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function indexInRanges(index, ranges) {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function mergeSpans(spans) {
  const sorted = [...spans].sort((left, right) => (
    left.start - right.start || left.end - right.end
  ));
  const merged = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function isRelativeInside(relative) {
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
