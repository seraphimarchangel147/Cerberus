import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveDataDir } from "../data-dir.js";
import { ensureDir } from "../file-utils.js";

export const MAX_TTS_CHARACTERS = 4000;

const DEFAULT_VOICES = {
  edge: "en-US-AriaNeural",
  openai: "alloy",
  // ElevenLabs uses voice ids rather than display names. This is the stable
  // premade voice from its official quickstart and can be overridden live.
  elevenlabs: "JBFqnCBsd6RMkjVDRZzb"
};

function runExecFile(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function fetchAudio(fetchImpl, url, init, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`request returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("provider returned empty audio");
    return bytes;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function defaultProviders({ env, fetchImpl, execFileImpl }) {
  return {
    edge: async ({ text, voice, outputPath }) => {
      await runExecFile(execFileImpl, "edge-tts", [
        "--voice", voice,
        "--text", text,
        "--write-media", outputPath
      ], { timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 });
      return { path: outputPath };
    },
    openai: async ({ text, voice }) => {
      if (!env.OPENAI_API_KEY) {
        const error = new Error("TTS provider openai is not configured; set OPENAI_API_KEY.");
        error.code = "TTS_NOT_CONFIGURED";
        throw error;
      }
      return fetchAudio(fetchImpl, "https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ model: "tts-1", voice, input: text, response_format: "mp3" })
      });
    },
    elevenlabs: async ({ text, voice }) => {
      if (!env.ELEVENLABS_API_KEY) {
        const error = new Error("TTS provider elevenlabs is not configured; set ELEVENLABS_API_KEY.");
        error.code = "TTS_NOT_CONFIGURED";
        throw error;
      }
      const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
      return fetchAudio(fetchImpl, endpoint, {
        method: "POST",
        headers: {
          "xi-api-key": env.ELEVENLABS_API_KEY,
          "content-type": "application/json"
        },
        body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" })
      });
    }
  };
}

function providerError(provider, error) {
  if (provider === "edge" && error?.code === "ENOENT") {
    return "TTS provider edge-tts not installed; run: pipx install edge-tts";
  }
  if (error?.code === "TTS_NOT_CONFIGURED") return error.message;
  // Child-process error messages include argv (and therefore the spoken
  // text), while HTTP errors may contain transport details. Keep both out of
  // model-visible results and audit logs.
  if (provider === "edge") return "TTS provider edge failed while running edge-tts.";
  const safeDetail = /^(?:request returned \d{3}|request timed out|provider returned empty audio)$/.test(error?.message ?? "")
    ? `: ${error.message}`
    : ".";
  return `TTS provider ${provider} failed${safeDetail}`;
}

export async function synthesize(text, options = {}) {
  const input = String(text ?? "").trim();
  if (!input) return { error: "TTS text is required." };

  const characters = Array.from(input);
  const truncated = characters.length > MAX_TTS_CHARACTERS;
  const spokenText = truncated
    ? characters.slice(0, MAX_TTS_CHARACTERS).join("")
    : input;
  if (truncated) {
    const log = options.log ?? console.warn;
    try { log(`[openagi] TTS input truncated to ${MAX_TTS_CHARACTERS} characters.`); } catch { /* advisory */ }
  }

  const env = options.env ?? process.env;
  const provider = String(options.provider ?? env.OPENAGI_TTS_PROVIDER ?? "edge").trim().toLowerCase();
  const providers = options.providers ?? defaultProviders({
    env,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    execFileImpl: options.execFileImpl ?? execFile
  });
  const implementation = providers[provider];
  if (typeof implementation !== "function") {
    return { error: `Unknown TTS provider: ${provider || "(empty)"}. Expected edge, openai, or elevenlabs.` };
  }

  const configuredVoice = String(options.voice ?? env.OPENAGI_TTS_VOICE ?? "").trim();
  const voice = configuredVoice || DEFAULT_VOICES[provider] || "default";
  const cacheDir = path.join(options.dataDir ?? resolveDataDir(), "audio-cache");
  ensureDir(cacheDir);
  const outputPath = path.join(cacheDir, `${randomUUID()}.mp3`);

  try {
    const audio = await implementation({ text: spokenText, voice, outputPath });
    if (Buffer.isBuffer(audio) || audio instanceof Uint8Array || audio instanceof ArrayBuffer) {
      await fs.promises.writeFile(outputPath, Buffer.from(audio), { mode: 0o600, flag: "wx" });
    } else if (path.resolve(audio?.path ?? "") !== path.resolve(outputPath)) {
      throw new Error("provider returned an invalid audio result");
    }
    const stat = await fs.promises.stat(outputPath);
    if (!stat.isFile() || stat.size === 0) throw new Error("provider returned empty audio");
    await fs.promises.chmod(outputPath, 0o600);
    return { path: outputPath, mimeType: "audio/mpeg" };
  } catch (error) {
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    return { error: providerError(provider, error) };
  }
}

function discordChannelId(context) {
  if (context?.channelId) return String(context.channelId);
  const match = /^discord:[^:]+:([^:]+)$/.exec(String(context?.sessionId ?? ""));
  return match?.[1] ?? null;
}

export function registerTtsTool(runtime, options = {}) {
  runtime.tools.register({
    name: "speak",
    sideEffects: true,
    description: "Speak text aloud. On Discord, posts an MP3 voice attachment; on other channels, returns a private cached audio path.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to speak (up to 4000 characters)." },
        voice: { type: "string", description: "Optional provider-specific voice name or id." }
      },
      required: ["text"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      const audio = await synthesize(args?.text, {
        ...options,
        voice: args?.voice ?? options.voice
      });
      if (audio.error) return audio;

      const channelId = context?.channel === "discord" ? discordChannelId(context) : null;
      const discord = context?.runtime?.channels?.discord ?? runtime.channels?.discord;
      if (!channelId || !discord?.sendFile) {
        return { ...audio, delivered: false };
      }

      const buffer = await fs.promises.readFile(audio.path);
      const message = await discord.sendFile(channelId, buffer, path.basename(audio.path));
      return {
        ...audio,
        delivered: true,
        channelId,
        messageId: message?.id ?? null
      };
    }
  });
}
