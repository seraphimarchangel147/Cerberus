// Vision is only useful if the pixels actually reach the model, and only safe
// if a path argument cannot become an exfiltration primitive. These cover both:
// the provider image-block contract, and the read guards shared with delivery.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadVisionImage, VISION_MAX_BYTES } from "../src/vision-load.js";
import { registerCoreTools, ToolRegistry } from "../src/tool-registry.js";

function fixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-load-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Real encoder output would need ffmpeg; these are minimal but genuinely
  // valid headers, which is what the sniffer and dimension reader parse.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR"),
    (() => { const b = Buffer.alloc(8); b.writeUInt32BE(64, 0); b.writeUInt32BE(48, 4); return b; })(),
    Buffer.from([8, 2, 0, 0, 0])
  ]);
  const gif = Buffer.concat([
    Buffer.from("GIF89a"),
    (() => { const b = Buffer.alloc(4); b.writeUInt16LE(80, 0); b.writeUInt16LE(60, 2); return b; })(),
    Buffer.alloc(8)
  ]);
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0]),
    (() => {
      const b = Buffer.alloc(9);
      b.writeUInt16BE(11, 0); // segment length
      b[2] = 8; // precision
      b.writeUInt16BE(24, 3); // height
      b.writeUInt16BE(32, 5); // width
      return b;
    })()
  ]);

  const write = (name, buffer) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, buffer);
    return target;
  };
  return {
    dir,
    png: write("shot.png", png),
    gif: write("anim.gif", gif),
    jpeg: write("photo.jpg", jpeg),
    mislabeled: write("actually-png.jpg", png),
    notImage: write("fake.png", Buffer.from("this is not an image at all")),
    text: write("notes.txt", Buffer.from("plain text")),
    empty: write("empty.png", Buffer.alloc(0))
  };
}

test("images load with the media type sniffed from their bytes", () => {
  const f = fixtures();
  const png = loadVisionImage(f.png);
  assert.equal(png.mediaType, "image/png");
  assert.equal(png.width, 64);
  assert.equal(png.height, 48);
  assert.equal(png.image.mediaType, "image/png");
  assert.ok(png.image.data.length > 0);

  const gif = loadVisionImage(f.gif);
  assert.equal(gif.mediaType, "image/gif");
  assert.equal(gif.width, 80);
  assert.equal(gif.height, 60);

  const jpeg = loadVisionImage(f.jpeg);
  assert.equal(jpeg.mediaType, "image/jpeg");
  assert.equal(jpeg.width, 32);
  assert.equal(jpeg.height, 24);
});

test("the result satisfies the provider image-block contract", () => {
  const f = fixtures();
  const loaded = loadVisionImage(f.png);
  // Mirrors providerToolImage() in model-provider.js. If this drifts, the
  // image silently stops rendering and the model goes blind without an error.
  assert.equal(typeof loaded.image.data, "string");
  assert.ok(loaded.image.data.length >= 1);
  assert.ok(loaded.image.data.length <= Math.ceil((20 * 1024 * 1024 * 4) / 3) + 4);
  assert.match(loaded.image.data, /^[A-Za-z0-9+/]+={0,2}$/u);
  assert.ok(["image/png", "image/jpeg", "image/webp", "image/gif"].includes(loaded.image.mediaType));
});

test("content wins over a lying extension", () => {
  const f = fixtures();
  const loaded = loadVisionImage(f.mislabeled);
  assert.equal(loaded.mediaType, "image/png");
  assert.equal(loaded.declaredMediaType, "image/jpeg");
  assert.equal(loaded.extensionMatchedContent, false);
});

test("non-images are refused even with an image extension", () => {
  const f = fixtures();
  assert.throws(() => loadVisionImage(f.notImage), /not a supported image/u);
  assert.throws(() => loadVisionImage(f.text), /not a PNG, JPEG, GIF, or WEBP/u);
  assert.throws(() => loadVisionImage(f.empty), /empty/u);
});

test("a path argument cannot become an exfiltration primitive", () => {
  const f = fixtures();
  assert.throws(() => loadVisionImage("relative/path.png"), /must be absolute/u);
  assert.throws(() => loadVisionImage("~/.ssh/id_rsa.png"), /protected location/u);
  assert.throws(() => loadVisionImage("~/.openagi/identity.png"), /protected location/u);
  assert.throws(() => loadVisionImage("~/.aws/credentials.png"), /protected location/u);
  assert.throws(() => loadVisionImage(f.dir), /not a regular file/u);
  assert.throws(() => loadVisionImage(path.join(f.dir, "missing.png")), /could not be read/u);

  const link = path.join(f.dir, "link.png");
  fs.symlinkSync(f.png, link);
  assert.throws(() => loadVisionImage(link), /Symlinks are not readable/u);
});

test("oversized images are refused before reaching the provider", () => {
  const f = fixtures();
  assert.throws(() => loadVisionImage(f.gif, { maxBytes: 4 }), /limit is 4/u);
  assert.ok(VISION_MAX_BYTES <= 20 * 1024 * 1024);
});

test("an isolated project cannot read outside its workspace", () => {
  const f = fixtures();
  assert.throws(
    () => loadVisionImage(f.png, { projectId: "isolated", workspaceRoot: path.join(f.dir, "nested") }),
    /outside this project's workspace/u
  );
  // The same file is readable once the workspace actually contains it.
  const nested = path.join(f.dir, "nested");
  fs.mkdirSync(nested, { recursive: true });
  const inside = path.join(nested, "shot.png");
  fs.copyFileSync(f.png, inside);
  assert.equal(
    loadVisionImage(inside, { projectId: "isolated", workspaceRoot: nested }).mediaType,
    "image/png"
  );
});

test("vision_load is registered and returns an image through the registry", async () => {
  const f = fixtures();
  const registry = new ToolRegistry();
  registerCoreTools(registry, {});

  const tool = registry.list().find((entry) => entry.name === "vision_load");
  assert.ok(tool, "vision_load must be registered");
  assert.equal(tool.sideEffects, false);

  const invoked = await registry.invoke("vision_load", { path: f.png }, {});
  const result = invoked.result ?? invoked;
  assert.equal(result.mediaType, "image/png");
  assert.equal(typeof result.image.data, "string");

  // The registry reports refusals as a failed invocation envelope rather than
  // a thrown rejection, so the guard message reaches the model as tool output.
  const refused = await registry.invoke("vision_load", { path: "~/.ssh/id_rsa.png" }, {});
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), /protected location/u);
});
