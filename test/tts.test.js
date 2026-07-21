import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHost } from "../src/agent-host.js";
import { FileBackedAgentStore } from "../src/agent-store.js";
import {
  MAX_TTS_CHARACTERS,
  registerTtsTool,
  synthesize
} from "../src/integrations/tts.js";
import { saveEnv } from "../src/setup-wizard.js";
import { ToolRegistry } from "../src/tool-registry.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const fakeAudio = Buffer.from("ID3 fake mp3 bytes");

test("synthesize writes stubbed provider audio to the private cache", async () => {
  const dir = tempDir("tts-cache-");
  const seen = [];
  const result = await synthesize("hello there", {
    dataDir: dir,
    provider: "stub",
    voice: "test-voice",
    providers: {
      stub: async (request) => {
        seen.push(request);
        return fakeAudio;
      }
    }
  });

  assert.equal(result.mimeType, "audio/mpeg");
  assert.equal(path.dirname(result.path), path.join(dir, "audio-cache"));
  assert.deepEqual(fs.readFileSync(result.path), fakeAudio);
  assert.equal(seen[0].text, "hello there");
  assert.equal(seen[0].voice, "test-voice");
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
});

test("synthesize truncates over-length input before invoking a provider", async () => {
  let spoken = null;
  const logs = [];
  const result = await synthesize("x".repeat(MAX_TTS_CHARACTERS + 25), {
    dataDir: tempDir("tts-truncate-"),
    provider: "stub",
    providers: { stub: async ({ text }) => { spoken = text; return fakeAudio; } },
    log: (line) => logs.push(line)
  });

  assert.equal(result.error, undefined);
  assert.equal(Array.from(spoken).length, MAX_TTS_CHARACTERS);
  assert.match(logs[0], /truncated to 4000/);
});

test("missing edge-tts returns installation guidance without hanging", async () => {
  const result = await synthesize("hello", {
    dataDir: tempDir("tts-edge-missing-"),
    provider: "edge",
    execFileImpl(command, args, options, callback) {
      const error = new Error("spawn failed");
      error.code = "ENOENT";
      callback(error, "", "");
    }
  });

  assert.deepEqual(result, {
    error: "TTS provider edge-tts not installed; run: pipx install edge-tts"
  });
});

test("OpenAI and ElevenLabs providers use their documented binary endpoints", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => fakeAudio
    };
  };

  await synthesize("openai speech", {
    dataDir: tempDir("tts-openai-"),
    provider: "openai",
    voice: "alloy",
    env: { OPENAI_API_KEY: "test-openai-key" },
    fetchImpl
  });
  await synthesize("eleven speech", {
    dataDir: tempDir("tts-eleven-"),
    provider: "elevenlabs",
    voice: "voice-id",
    env: { ELEVENLABS_API_KEY: "test-eleven-key" },
    fetchImpl
  });

  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/speech");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "tts-1",
    voice: "alloy",
    input: "openai speech",
    response_format: "mp3"
  });
  assert.match(calls[1].url, /\/v1\/text-to-speech\/voice-id\?output_format=mp3_44100_128$/);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    text: "eleven speech",
    model_id: "eleven_multilingual_v2"
  });
});

test("speak degrades to a cached path outside Discord", async () => {
  let uploads = 0;
  const tools = new ToolRegistry();
  const runtime = {
    tools,
    channels: { discord: { sendFile: async () => { uploads += 1; } } }
  };
  registerTtsTool(runtime, {
    dataDir: tempDir("tts-local-"),
    provider: "stub",
    providers: { stub: async () => fakeAudio }
  });

  const outcome = await tools.invoke("speak", { text: "local voice" }, {
    channel: "local",
    __confirmed: true
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.delivered, false);
  assert.equal(fs.existsSync(outcome.result.path), true);
  assert.equal(uploads, 0);
});

test("speak uploads the cached audio on Discord", async () => {
  const uploads = [];
  const tools = new ToolRegistry();
  const runtime = {
    tools,
    channels: {
      discord: {
        async sendFile(channelId, buffer, filename) {
          uploads.push({ channelId, buffer, filename });
          return { id: "audio-message" };
        }
      }
    }
  };
  registerTtsTool(runtime, {
    dataDir: tempDir("tts-discord-"),
    provider: "stub",
    providers: { stub: async () => fakeAudio }
  });

  const outcome = await tools.invoke("speak", { text: "discord voice" }, {
    channel: "discord",
    channelId: "channel-7",
    runtime,
    __confirmed: true
  });
  assert.equal(outcome.result.delivered, true);
  assert.equal(outcome.result.messageId, "audio-message");
  assert.equal(uploads[0].channelId, "channel-7");
  assert.deepEqual(uploads[0].buffer, fakeAudio);
  assert.match(uploads[0].filename, /^[0-9a-f-]+\.mp3$/);
});

test("AgentHost carries the Discord destination and streaming callback into the provider", async () => {
  let capturedContext = null;
  let capturedDelta = null;
  const runtime = {
    context: {},
    memory: { retrieve: () => [], remember: () => null },
    scrutiny: { evaluate: () => ({ action: "act", score: 0.9, reasons: [], customContext: [] }) },
    tools: new ToolRegistry(),
    outcomes: { record: () => null },
    processSignal: (signal) => ({
      id: "output-1",
      scrutiny: {
        action: "act",
        score: 0.9,
        reasons: [],
        dimensions: { novelty: 0.3, risk: 0.1, repetition: 0.1 }
      },
      customContext: [],
      propagation: { created: false },
      signal
    })
  };
  const provider = {
    isConfigured: () => true,
    async generate(options) {
      capturedContext = options.context;
      capturedDelta = options.onDelta;
      return { text: "done", toolCalls: [], iterations: 1 };
    }
  };
  const host = new AgentHost({
    runtime,
    modelProvider: provider,
    store: new FileBackedAgentStore({ dir: tempDir("tts-agent-host-") })
  });

  const onDelta = () => {};
  await host.handleMessage({
    channel: "discord",
    from: "user-1",
    sessionId: "discord:guild-1:channel-9",
    text: "say hello",
    onDelta,
    metadata: { channelId: "channel-9" }
  });
  assert.equal(capturedContext.channelId, "channel-9");
  assert.equal(capturedDelta, onDelta);
});

test("setup wizard allowlists TTS configuration without exposing live keys", () => {
  const dir = tempDir("tts-env-");
  const previous = {
    provider: process.env.OPENAGI_TTS_PROVIDER,
    voice: process.env.OPENAGI_TTS_VOICE,
    key: process.env.ELEVENLABS_API_KEY
  };
  try {
    const saved = saveEnv({
      dataDir: dir,
      values: {
        OPENAGI_TTS_PROVIDER: "elevenlabs",
        OPENAGI_TTS_VOICE: "voice-test",
        ELEVENLABS_API_KEY: "test-key"
      }
    });
    assert.deepEqual(saved.keys.sort(), [
      "ELEVENLABS_API_KEY",
      "OPENAGI_TTS_PROVIDER",
      "OPENAGI_TTS_VOICE"
    ]);
  } finally {
    if (previous.provider === undefined) delete process.env.OPENAGI_TTS_PROVIDER;
    else process.env.OPENAGI_TTS_PROVIDER = previous.provider;
    if (previous.voice === undefined) delete process.env.OPENAGI_TTS_VOICE;
    else process.env.OPENAGI_TTS_VOICE = previous.voice;
    if (previous.key === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = previous.key;
  }
});
