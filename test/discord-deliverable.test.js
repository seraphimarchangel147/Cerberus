import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiscordChannel } from "../src/discord-channel.js";

function makeWorkspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-discord-deliverable-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFixture(directory, filename, contents = filename) {
  const filePath = path.join(directory, filename);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function makeChannel(homeDir) {
  const uploads = [];
  const messages = [];
  const logs = [];
  const channel = Object.create(DiscordChannel.prototype);
  channel.token = "discord-test-token";
  channel.deliverableOptions = { homeDir };
  channel.log = (entry) => logs.push(entry);
  channel.sendFile = async (channelId, buffer, filename, options) => {
    uploads.push({ channelId, buffer, filename, options });
    return { id: `upload-${uploads.length}` };
  };
  channel.sendMessage = async (channelId, text, replyToId) => {
    messages.push({ channelId, text, replyToId });
    return { id: `message-${messages.length}` };
  };
  return { channel, logs, messages, uploads };
}

test("Discord uploads and strips a referenced chart", async (t) => {
  const directory = makeWorkspace(t);
  writeFixture(directory, "chart.png", Buffer.from("image-bytes"));
  const chartPath = "~/chart.png";
  const harness = makeChannel(directory);

  const result = await harness.channel.deliverAgentReply(
    "channel-1",
    `Here is the chart: ${chartPath}\nThe same chart again: ${chartPath}`,
    { replyToId: "source-1" }
  );

  assert.equal(harness.uploads.length, 1);
  assert.equal(harness.uploads[0].filename, "chart.png");
  assert.deepEqual(harness.uploads[0].buffer, Buffer.from("image-bytes"));
  assert.equal(harness.messages.length, 1);
  assert.doesNotMatch(harness.messages[0].text, new RegExp(escapeRegExp(chartPath), "u"));
  assert.match(harness.messages[0].text, /Here is the chart:/u);
  assert.equal(harness.messages[0].replyToId, "source-1");
  assert.equal(result.successfulCandidates.length, 1);
});

test("Discord ignores fenced, inline-code, and source paths", async (t) => {
  const directory = makeWorkspace(t);
  writeFixture(directory, "fenced.png");
  writeFixture(directory, "inline.png");
  writeFixture(directory, "helper.py", "print('safe sample')\n");
  const fencedPath = "~/fenced.png";
  const inlinePath = "~/inline.png";
  const sourcePath = "~/helper.py";
  const harness = makeChannel(directory);
  const text = [
    "Keep these examples unchanged:",
    "```text",
    fencedPath,
    "```",
    `Inline: \`${inlinePath}\``,
    `Source: ${sourcePath}`
  ].join("\n");

  await harness.channel.deliverAgentReply("channel-2", text);

  assert.equal(harness.uploads.length, 0);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].text, text);
});

test("Discord preserves deliverable type routing", async (t) => {
  const directory = makeWorkspace(t);
  for (const filename of ["image.png", "movie.mp4", "sound.mp3", "report.pdf"]) {
    writeFixture(directory, filename);
  }
  const paths = ["~/image.png", "~/movie.mp4", "~/sound.mp3", "~/report.pdf"];
  const harness = makeChannel(directory);

  await harness.channel.deliverAgentReply("channel-3", paths.join("\n"));

  assert.deepEqual(
    harness.uploads.map((upload) => [
      path.extname(upload.filename),
      upload.options.category,
      upload.options.delivery
    ]),
    [
      [".png", "image", "inline"],
      [".mp4", "video", "inline"],
      [".mp3", "audio", "voice"],
      [".pdf", "document", "file"]
    ]
  );
});

test("Discord strips successful uploads but retains failed paths", async (t) => {
  const directory = makeWorkspace(t);
  writeFixture(directory, "chart.png");
  writeFixture(directory, "report.pdf");
  const chartPath = "~/chart.png";
  const reportPath = "~/report.pdf";
  const harness = makeChannel(directory);
  harness.channel.sendFile = async (channelId, buffer, filename, options) => {
    harness.uploads.push({ channelId, buffer, filename, options });
    if (filename === "report.pdf") {
      throw new Error("upload failed with discord-test-token");
    }
    return { id: "chart-upload" };
  };

  const result = await harness.channel.deliverAgentReply(
    "channel-4",
    `Chart ${chartPath}\nReport ${reportPath}`
  );

  assert.equal(harness.uploads.length, 2);
  assert.doesNotMatch(result.text, new RegExp(escapeRegExp(chartPath), "u"));
  assert.match(result.text, new RegExp(escapeRegExp(reportPath), "u"));
  assert.equal(result.successfulCandidates.length, 1);
  assert.equal(harness.logs.length, 1);
  assert.equal(harness.logs[0].op, "deliverable-error");
  assert.doesNotMatch(harness.logs[0].error, /discord-test-token/u);
});

test("Discord streaming replaces transient paths and handles attachment-only replies", async (t) => {
  const directory = makeWorkspace(t);
  writeFixture(directory, "chart.png");
  const chartPath = "~/chart.png";
  const harness = makeChannel(directory);
  const finalized = [];
  const replyStream = {
    async finish(text) {
      finalized.push(text);
      return true;
    }
  };

  const result = await harness.channel.deliverAgentReply(
    "channel-5",
    chartPath,
    { replyToId: "source-5", replyStream }
  );

  assert.equal(harness.uploads.length, 1);
  assert.deepEqual(finalized, ["Attached file."]);
  assert.equal(harness.messages.length, 0);
  assert.equal(result.text, "Attached file.");
  assert.equal(result.streamed, true);
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
