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
  return {
    fsImpl: options.fsImpl ?? fs,
    homeDir: path.resolve(options.homeDir ?? os.homedir()),
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
