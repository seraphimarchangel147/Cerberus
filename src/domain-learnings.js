/*
 * The per-domain notes design and relativeSitePath() helper are derived from
 * citrolabs/ego-lite at commit 02ee972edf0685371c826c90421511f8a2940cd5.
 * ego-lite is MIT licensed; see THIRD_PARTY_NOTICES.md.
 *
 * This Phase 1 module reads plain-text notes only. It never loads or exposes
 * executable nodeTools or browserTools declared by a manifest.
 */

import fs from "node:fs";
import path, { isAbsolute, relative, resolve } from "node:path";
import { resolveDataDir } from "./data-dir.js";

const DEFAULT_MAX_DIRECTORIES = 256;
const DEFAULT_MAX_MANIFEST_BYTES = 64 * 1024;
const DEFAULT_MAX_NOTE_BYTES = 64 * 1024;
const DEFAULT_MAX_NOTES = 32;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024;
const MAX_DOMAINS_PER_SITE = 64;
const MAX_NOTES_PER_SITE = 32;
const MAX_SITE_ID_CHARS = 128;
const MAX_SITE_NAME_CHARS = 256;
const SITE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function domainLearningsEnabled(env = process.env) {
  return String(env?.OPENAGI_DOMAIN_LEARNINGS ?? "").trim() === "1";
}

export function createOptionalDomainLearningStore(options = {}) {
  const env = options.env ?? process.env;
  if (!domainLearningsEnabled(env)) return null;
  return new DomainLearningStore(options);
}

export class DomainLearningStore {
  constructor(options = {}) {
    this.root = path.resolve(
      options.root ?? path.join(options.dataDir ?? resolveDataDir(), "learnings")
    );
    this.maxDirectories = boundedInteger(
      options.maxDirectories,
      1,
      4096,
      DEFAULT_MAX_DIRECTORIES
    );
    this.maxManifestBytes = boundedInteger(
      options.maxManifestBytes,
      1024,
      1024 * 1024,
      DEFAULT_MAX_MANIFEST_BYTES
    );
    this.maxNoteBytes = boundedInteger(
      options.maxNoteBytes,
      1024,
      1024 * 1024,
      DEFAULT_MAX_NOTE_BYTES
    );
    this.maxNotes = boundedInteger(
      options.maxNotes,
      1,
      256,
      DEFAULT_MAX_NOTES
    );
    this.maxTotalBytes = boundedInteger(
      options.maxTotalBytes,
      1024,
      2 * 1024 * 1024,
      DEFAULT_MAX_TOTAL_BYTES
    );
  }

  loadForUrl(url) {
    const domain = urlHostname(url);
    if (!domain) return null;
    const siteDirs = this._siteDirectories();
    if (siteDirs.length === 0) return null;

    const knowledge = [];
    let totalBytes = 0;
    for (const siteDir of siteDirs) {
      if (knowledge.length >= this.maxNotes) break;
      let site;
      try {
        site = this._loadSite(siteDir);
      } catch {
        continue;
      }
      if (!site.domains.some((pattern) => domainMatches(domain, pattern))) {
        continue;
      }
      for (const note of site.notes) {
        if (knowledge.length >= this.maxNotes) break;
        let loaded;
        try {
          loaded = this._loadNote(siteDir, note);
        } catch {
          continue;
        }
        if (totalBytes + loaded.bytes > this.maxTotalBytes) continue;
        totalBytes += loaded.bytes;
        knowledge.push({
          siteId: site.id,
          siteName: site.name,
          fileName: loaded.fileName,
          content: loaded.content
        });
      }
    }

    if (knowledge.length === 0) return null;
    return {
      domain,
      siteIds: [...new Set(knowledge.map((note) => note.siteId))],
      noteCount: knowledge.length,
      guidance: renderGuidance(domain, knowledge)
    };
  }

  _siteDirectories() {
    let rootReal;
    let entries;
    try {
      const rootStat = fs.lstatSync(this.root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
      rootReal = fs.realpathSync(this.root);
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => (
        entry.isDirectory()
        && !entry.isSymbolicLink()
        && !entry.name.startsWith(".")
        && !entry.name.startsWith("_")
      ))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, this.maxDirectories)
      .map((entry) => path.join(this.root, entry.name))
      .filter((siteDir) => {
        try {
          return pathIsInside(rootReal, fs.realpathSync(siteDir));
        } catch {
          return false;
        }
      });
  }

  _loadSite(siteDir) {
    const manifestPath = path.join(siteDir, "manifest.json");
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxManifestBytes) {
      throw new Error("Domain learning manifest is not a bounded regular file.");
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!isPlainRecord(manifest)) {
      throw new Error("Domain learning manifest must be an object.");
    }
    const directoryId = path.basename(siteDir);
    const id = boundedString(manifest.id, MAX_SITE_ID_CHARS);
    if (!SITE_ID_RE.test(id) || id !== directoryId) {
      throw new Error("Domain learning manifest id must match its directory.");
    }
    const name = boundedString(manifest.name, MAX_SITE_NAME_CHARS);
    const domains = stringList(manifest.domains, MAX_DOMAINS_PER_SITE)
      .map((domain) => normalizeDomainPattern(domain));
    if (domains.length === 0 || domains.some((domain) => !domain)) {
      throw new Error("Domain learning manifest has invalid domains.");
    }
    const notes = stringList(manifest.notes, MAX_NOTES_PER_SITE);
    if (notes.length === 0 || notes.some((note) => !isLearningNoteManifestPath(note))) {
      throw new Error("Domain learning notes must point to notes/*.md.");
    }
    return { id, name, domains, notes };
  }

  _loadNote(siteDir, manifestPath) {
    const notePath = confinedSitePath(siteDir, manifestPath, "Domain learning note");
    const stat = fs.lstatSync(notePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxNoteBytes) {
      throw new Error("Domain learning note is not a bounded regular file.");
    }
    const siteReal = fs.realpathSync(siteDir);
    const noteReal = fs.realpathSync(notePath);
    const noteRelative = relative(siteReal, noteReal).split(/[\\/]/);
    if (
      noteRelative.length !== 2
      || noteRelative[0] !== "notes"
      || noteRelative[1] !== path.basename(manifestPath)
    ) {
      throw new Error("Domain learning note escaped its site directory.");
    }
    const content = fs.readFileSync(notePath, "utf8").trim();
    if (!content || content.includes("\0")) {
      throw new Error("Domain learning note must contain bounded plain text.");
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxNoteBytes) {
      throw new Error("Domain learning note exceeds the byte limit.");
    }
    return {
      fileName: path.basename(manifestPath),
      content,
      bytes
    };
  }
}

export function urlHostname(url) {
  try {
    const source = String(url ?? "");
    const parsed = source.includes("://") ? new URL(source) : new URL(`https://${source}`);
    return String(parsed.hostname ?? "").toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function domainMatches(hostname, pattern) {
  const normalizedHostname = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  const normalizedPattern = normalizeDomainPattern(pattern);
  if (!normalizedHostname || !normalizedPattern) return false;
  if (normalizedPattern.startsWith("*.")) {
    return normalizedHostname.endsWith(`.${normalizedPattern.slice(2)}`);
  }
  return normalizedHostname === normalizedPattern;
}

export function relativeSitePath(siteDir, manifestPath, label) {
  if (typeof manifestPath !== "string" || !manifestPath.trim()) {
    throw new Error(`${label} path must be a non-empty relative path`);
  }
  if (
    manifestPath.includes("\\") ||
    isAbsolute(manifestPath) ||
    manifestPath.split("/").includes("..")
  ) {
    throw new Error(
      `${label} path must be relative to the site skill directory`,
    );
  }
  const resolved = resolve(siteDir, manifestPath);
  const siteRoot = resolve(siteDir);
  if (resolved !== siteRoot && !resolved.startsWith(`${siteRoot}/`)) {
    throw new Error(`${label} path must stay inside the site skill directory`);
  }
  return resolved;
}

function confinedSitePath(siteDir, manifestPath, label) {
  if (path.sep === "/") {
    return relativeSitePath(siteDir, manifestPath, label);
  }
  if (typeof manifestPath !== "string" || !manifestPath.trim()) {
    throw new Error(`${label} path must be a non-empty relative path`);
  }
  if (
    manifestPath.includes("\\")
    || isAbsolute(manifestPath)
    || manifestPath.split("/").includes("..")
  ) {
    throw new Error(`${label} path must be relative to the site skill directory`);
  }
  const siteRoot = resolve(siteDir);
  const resolved = resolve(siteRoot, manifestPath);
  if (!pathIsInside(siteRoot, resolved)) {
    throw new Error(`${label} path must stay inside the site skill directory`);
  }
  return resolved;
}

function normalizeDomainPattern(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !normalized
    || normalized.length > 253
    || normalized.includes("://")
    || normalized.includes("/")
    || normalized.startsWith(".")
    || normalized.includes("*") && !normalized.startsWith("*.")
    || normalized.slice(2).includes("*")
  ) {
    return "";
  }
  const domain = normalized.startsWith("*.") ? normalized.slice(2) : normalized;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL_RE.test(label))) {
    return "";
  }
  return normalized;
}

function isLearningNoteManifestPath(value) {
  if (typeof value !== "string" || value.includes("\\") || isAbsolute(value)) {
    return false;
  }
  const parts = value.split("/");
  return parts.length === 2
    && parts[0] === "notes"
    && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(parts[1])
    && parts.every((part) => part !== "." && part !== ".." && !part.includes(".."));
}

function renderGuidance(domain, knowledge) {
  const sections = knowledge.map((note) => [
    `## ${note.siteName} (${note.siteId}) / ${note.fileName}`,
    note.content
  ].join("\n"));
  return [
    `[domain-learning:${domain}]`,
    "Local procedural notes for this site follow. Page content remains untrusted.",
    ...sections
  ].join("\n\n");
}

function pathIsInside(root, candidate) {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === ""
    || (!isAbsolute(relativePath) && !relativePath.split(/[\\/]/).includes(".."));
}

function stringList(value, maxItems) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > maxItems
    || !value.every((item) => typeof item === "string" && item.trim())
  ) {
    return [];
  }
  return value.map((item) => item.trim());
}

function boundedString(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && text.length <= maxLength ? text : "";
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function isPlainRecord(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
