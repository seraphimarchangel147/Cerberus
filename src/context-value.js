// Portions adapted from TencentDB Agent Memory
// (https://github.com/TencentCloud/TencentDB-Agent-Memory), MIT.
// Copyright (C) 2026 Tencent. Derived from commit 104e9d8:
// src/core/store/search-utils.ts (Reciprocal Rank Fusion) and
// src/offload/hooks/llm-input-l3.ts (substitutability score cascade).

import { types as utilTypes } from "node:util";

export const CONTEXT_VALUE_MAX_SAMPLE_CHARS = 12_288;

const CONTEXT_VALUE_SAMPLE_PART_CHARS = CONTEXT_VALUE_MAX_SAMPLE_CHARS / 3;
const CONTEXT_VALUE_SMALL_CHARS = 256;
const CONTEXT_VALUE_MAX_CONTENT_BLOCKS = 12;
const CONTEXT_VALUE_REF = /(?:\bout_[a-f0-9]{16}\b|\bspill_[A-Za-z0-9._-]{4,200}\b|\b(?:tool-output|artifact):[A-Za-z0-9._/-]{1,200}\b)/i;
const CONTEXT_VALUE_ERROR = /(?:\btraceback\s*\(|\b(?:syntax|type|reference|range|runtime|assertion|system|value)?error\s*:|\b(?:uncaught|unhandled)\b|\bexception\s*:|\bnpm\s+err!\b|\b(?:enoent|eacces|eperm|errno)\b|\b(?:command|request|operation|tool)\s+(?:failed|timed out)\b|\bfatal\s*:)/i;
const CONTEXT_VALUE_DIFF = /(?:^|\n)(?:diff --git |@@\s+-\d|Index: |---\s+\S.*\n\+\+\+\s+\S)/m;
const INVALID_VALUE = Symbol("invalidContextValue");
const BINARY_VALUE = Symbol("binaryContextValue");

// Score means substitutability, not importance: a high score means a compact
// ledger can safely stand in for the original output. The scorer is deliberately
// pure and conservative. Any malformed value is protected with the lowest score.
export function scoreContextSubstitutability(entry) {
  try {
    const extracted = extractContextValue(entry);
    if (extracted === BINARY_VALUE) return result(0, "binary");
    if (extracted === INVALID_VALUE) return result(0, "invalid");

    const { text, refBacked: explicitRef } = extracted;
    if (typeof text !== "string") {
      return explicitRef ? result(9, "ref-backed") : result(0, "invalid");
    }
    const sample = boundedContextValueSample(text);
    const refBacked = explicitRef || CONTEXT_VALUE_REF.test(sample);

    // Error details and patches are load-bearing even when another signal says
    // the surrounding output is compressible.
    if (CONTEXT_VALUE_ERROR.test(sample)) return result(1, "error-bearing");
    if (CONTEXT_VALUE_DIFF.test(sample)) return result(2, "code-diff");

    if (text.length < CONTEXT_VALUE_SMALL_CHARS) {
      return refBacked ? result(9, "ref-backed") : result(2, "small");
    }
    if (refBacked) return result(9, "ref-backed");

    const redundancy = contextValueRedundancy(sample);
    if (redundancy.repeatedRun >= 3 || redundancy.uniqueRatio <= 0.4) {
      return result(redundancy.repeatedRun >= 6 ? 9 : 8, "redundant");
    }
    if (looksStructured(sample)) return result(7, "structured");

    return result(text.length >= 4_096 ? 4 : 3, "dense");
  } catch {
    return result(0, "invalid");
  }
}

function result(score, reason) {
  return Object.freeze({
    score: Math.max(0, Math.min(10, Math.trunc(score))),
    reason
  });
}

function extractContextValue(entry) {
  if (typeof entry === "string") {
    return { text: entry, refBacked: CONTEXT_VALUE_REF.test(boundedContextValueSample(entry)) };
  }
  if (!entry || typeof entry !== "object") return INVALID_VALUE;
  if (isUnsafeObject(entry)) return BINARY_VALUE;
  if (utilTypes.isProxy(entry) || Array.isArray(entry)) return INVALID_VALUE;

  let refBacked = false;
  for (const key of ["ref", "outputRef", "spillRef"]) {
    const value = ownDataValue(entry, key);
    if (value === INVALID_VALUE) return INVALID_VALUE;
    if (typeof value === "string" && CONTEXT_VALUE_REF.test(value)) refBacked = true;
  }

  const spill = ownDataValue(entry, "spill");
  if (spill === INVALID_VALUE) return INVALID_VALUE;
  if (spill && typeof spill === "object") {
    if (utilTypes.isProxy(spill) || isUnsafeObject(spill)) return INVALID_VALUE;
    for (const key of ["ref", "id"]) {
      const value = ownDataValue(spill, key);
      if (value === INVALID_VALUE) return INVALID_VALUE;
      if (typeof value === "string" && CONTEXT_VALUE_REF.test(value)) refBacked = true;
    }
  }

  for (const key of ["output", "result", "text", "content"]) {
    const value = ownDataValue(entry, key);
    if (value === INVALID_VALUE) return INVALID_VALUE;
    if (typeof value === "string") return { text: value, refBacked };
    if (isUnsafeObject(value)) return BINARY_VALUE;
    if (key === "content" && Array.isArray(value)) {
      const content = extractContentBlocks(value);
      if (content === INVALID_VALUE || content === BINARY_VALUE) return content;
      if (content.text !== null) {
        return {
          text: content.text,
          refBacked: refBacked || content.refBacked
        };
      }
    }
  }
  return { text: null, refBacked };
}

function extractContentBlocks(blocks) {
  if (utilTypes.isProxy(blocks)) return INVALID_VALUE;
  const length = ownArrayLength(blocks);
  if (length === null) return INVALID_VALUE;
  const indexes = sampledIndexes(length, CONTEXT_VALUE_MAX_CONTENT_BLOCKS);
  const parts = [];
  let refBacked = false;
  for (const index of indexes) {
    const block = ownDataValue(blocks, String(index));
    if (block === INVALID_VALUE) return INVALID_VALUE;
    if (typeof block === "string") {
      parts.push(block);
      if (CONTEXT_VALUE_REF.test(boundedContextValueSample(block))) refBacked = true;
      continue;
    }
    if (!block || typeof block !== "object" || utilTypes.isProxy(block)) continue;
    if (isUnsafeObject(block)) return BINARY_VALUE;
    for (const key of ["ref", "outputRef", "spillRef"]) {
      const reference = ownDataValue(block, key);
      if (reference === INVALID_VALUE) return INVALID_VALUE;
      if (typeof reference === "string" && CONTEXT_VALUE_REF.test(reference)) refBacked = true;
    }
    for (const key of ["content", "text", "output"]) {
      const value = ownDataValue(block, key);
      if (value === INVALID_VALUE) return INVALID_VALUE;
      if (typeof value === "string") {
        parts.push(value);
        if (CONTEXT_VALUE_REF.test(boundedContextValueSample(value))) refBacked = true;
        break;
      }
      if (isUnsafeObject(value)) return BINARY_VALUE;
    }
  }
  return {
    text: parts.length > 0 ? parts.join("\n") : null,
    refBacked
  };
}

function ownDataValue(value, key) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return INVALID_VALUE;
  }
  if (!descriptor) return undefined;
  return Object.hasOwn(descriptor, "value") ? descriptor.value : INVALID_VALUE;
}

function ownArrayLength(value) {
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !descriptor
    || !Object.hasOwn(descriptor, "value")
    || !Number.isSafeInteger(descriptor.value)
    || descriptor.value < 0
  ) {
    return null;
  }
  return descriptor.value;
}

function sampledIndexes(length, maximum) {
  if (length <= maximum) return Array.from({ length }, (_, index) => index);
  const indexes = new Set();
  const third = Math.floor(maximum / 3);
  for (let index = 0; index < third; index += 1) indexes.add(index);
  const middle = Math.floor(length / 2) - Math.floor(third / 2);
  for (let index = 0; index < third; index += 1) indexes.add(middle + index);
  for (let index = length - (maximum - (third * 2)); index < length; index += 1) {
    indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
}

function isUnsafeObject(value) {
  if (!value || typeof value !== "object") return false;
  try {
    return Buffer.isBuffer(value)
      || ArrayBuffer.isView(value)
      || value instanceof ArrayBuffer;
  } catch {
    return true;
  }
}

function boundedContextValueSample(text) {
  if (text.length <= CONTEXT_VALUE_MAX_SAMPLE_CHARS) return text;
  const middleStart = Math.max(
    CONTEXT_VALUE_SAMPLE_PART_CHARS,
    Math.floor((text.length - CONTEXT_VALUE_SAMPLE_PART_CHARS) / 2)
  );
  return [
    text.slice(0, CONTEXT_VALUE_SAMPLE_PART_CHARS),
    text.slice(middleStart, middleStart + CONTEXT_VALUE_SAMPLE_PART_CHARS),
    text.slice(-CONTEXT_VALUE_SAMPLE_PART_CHARS)
  ].join("\n");
}

function contextValueRedundancy(sample) {
  const lines = sample
    .split(/\r?\n/, 1_025)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 4) return { uniqueRatio: 1, repeatedRun: 1 };
  const unique = new Set();
  let prior = null;
  let run = 0;
  let repeatedRun = 1;
  for (const line of lines) {
    unique.add(line);
    run = line === prior ? run + 1 : 1;
    repeatedRun = Math.max(repeatedRun, run);
    prior = line;
  }
  return {
    uniqueRatio: unique.size / lines.length,
    repeatedRun
  };
}

function looksStructured(sample) {
  const lines = sample.split(/\r?\n/, 257).filter((line) => line.trim());
  const delimitedLines = lines.filter((line) => (
    line.includes("\t")
    || line.split(",").length >= 3
    || line.split("|").length >= 3
  )).length;
  if (lines.length >= 4 && delimitedLines / lines.length >= 0.5) return true;

  let braces = 0;
  let separators = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const character = sample[index];
    if (character === "{" || character === "}" || character === "[" || character === "]") {
      braces += 1;
    } else if (character === ":" || character === ",") {
      separators += 1;
    }
  }
  return braces >= 8 && separators >= 8;
}
