import fs from "node:fs";
import path from "node:path";
import { resolveReadablePath } from "./deliverable.js";

// The provider image-block contract (providerToolImage in model-provider.js)
// accepts exactly these four media types on both the Anthropic and OpenAI
// paths. Anything else must be refused here with an actionable message rather
// than silently dropped downstream, where it would look like the model simply
// ignored the image.
export const VISION_MEDIA_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif"
});

// Providers reject oversized payloads outright. Cap below the transport limit
// so an honest refusal replaces a provider-side failure mid-turn.
export const VISION_MAX_BYTES = 5 * 1024 * 1024;

// Magic-number prefixes. An extension is a claim; the bytes are the evidence.
// A .png that is actually something else must not reach the provider as an
// image block, and a mislabeled extension should still work when the bytes are
// a valid image.
const SIGNATURES = [
  { mediaType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mediaType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] }
];

function sniffMediaType(buffer) {
  for (const { mediaType, bytes } of SIGNATURES) {
    if (buffer.length < bytes.length) continue;
    if (bytes.every((byte, index) => buffer[index] === byte)) return mediaType;
  }
  // WEBP is RIFF....WEBP — a container check, not a flat prefix.
  if (
    buffer.length >= 12
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Read PNG/JPEG/GIF/WEBP pixel dimensions from header bytes. Dimensions are
 * advisory (they label the image for the model), so any parse failure yields
 * nulls rather than failing the read.
 */
function readDimensions(buffer, mediaType) {
  try {
    if (mediaType === "image/png" && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mediaType === "image/gif" && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (mediaType === "image/webp" && buffer.length >= 21) {
      const format = buffer.toString("ascii", 12, 16);
      if (format === "VP8X" && buffer.length >= 30) {
        return {
          width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
          height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16))
        };
      }
      if (format === "VP8 " && buffer.length >= 30) {
        return {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff
        };
      }
      if (format === "VP8L" && buffer.length >= 25) {
        // VP8L: 1-byte signature (0x2f) then 14 bits width-1, 14 bits height-1.
        const bits = buffer.readUInt32LE(21);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1
        };
      }
    }
    if (mediaType === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        // SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7)
          };
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
    }
  } catch {
    // Advisory only.
  }
  return { width: null, height: null };
}

/**
 * Load a local image so the model can actually SEE it.
 *
 * The provider layer already renders any tool result carrying
 * `{ image: { data, mediaType } }` as a real image block on both the Anthropic
 * and OpenAI paths — this returns exactly that shape, so no provider change is
 * needed. Path safety is delegated to the deliverable module so read and write
 * lanes enforce one identical policy.
 */
export function loadVisionImage(input, options = {}) {
  const requested = String(input ?? "").trim();
  if (!requested) throw new Error("A file path is required.");

  const { realPath, size } = resolveReadablePath(requested, options);

  const extension = path.extname(realPath).slice(1).toLowerCase();
  const declared = VISION_MEDIA_TYPES[extension] ?? null;
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? Math.min(options.maxBytes, VISION_MAX_BYTES)
    : VISION_MAX_BYTES;

  if (size > maxBytes) {
    throw new Error(
      `Image is ${size} bytes; the limit is ${maxBytes}. Resize or crop it first.`
    );
  }

  const readFile = options.fsImpl?.readFileSync ?? fs.readFileSync;
  let buffer;
  try {
    buffer = readFile(realPath);
  } catch {
    throw new Error("Path could not be read.");
  }
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.byteLength === 0) throw new Error("File is empty.");
  if (buffer.byteLength > maxBytes) {
    throw new Error(
      `Image is ${buffer.byteLength} bytes; the limit is ${maxBytes}. Resize or crop it first.`
    );
  }

  // Trust the bytes over the extension.
  const sniffed = sniffMediaType(buffer);
  if (!sniffed) {
    throw new Error(
      declared
        ? `File claims to be ${declared} but its bytes are not a supported image.`
        : "File is not a PNG, JPEG, GIF, or WEBP image."
    );
  }

  const { width, height } = readDimensions(buffer, sniffed);
  return {
    path: realPath,
    mediaType: sniffed,
    // Surfaced so a mismatch is visible to the agent rather than silent.
    declaredMediaType: declared,
    extensionMatchedContent: declared === null ? null : declared === sniffed,
    bytes: buffer.byteLength,
    width,
    height,
    // Consumed by providerToolImage() and rendered as an image block.
    image: { data: buffer.toString("base64"), mediaType: sniffed }
  };
}
