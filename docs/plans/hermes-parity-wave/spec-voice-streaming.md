# Spec 5 — Voice (TTS) + Streaming Replies (UX polish)

Branch: `codex/voice-streaming`. Reviewer: Seraphim. Read `README.md` first. **Do this LAST** —
it's polish, not capability. Two independent sub-features; ship them as separate commits on
the branch so either can be reviewed/reverted alone.

---

## 5A — Text-to-Speech (voice replies)

### Goal
Let Azazel optionally speak — send a voice/audio attachment on Discord for stories, summaries,
or when the user asks him to "say it." Hermes renders these as native voice bubbles.

### Approach
TTS provider is operator-configured, not model-picked. Support a simple provider abstraction:
- **edge-tts** (free, no key, `edge-tts` npm or the `edge-tts` python CLI) as the default.
- Optional **OpenAI TTS** / **ElevenLabs** if a key is present (env-gated).

### Implementation
1. New file `src/integrations/tts.js`:
   - `synthesize(text, { voice, provider }) -> { path, mimeType }` writing an mp3/ogg to
     `<dataDir>/audio-cache/<uuid>.mp3`.
   - Default provider = edge-tts via child_process (no key). Cap input length (e.g. 4000 chars;
     truncate with a logged note).
2. Discord delivery: `discord-channel.js` already has `sendFile(channelId, buffer, filename,
   {content, embeds})` (used for charts). Reuse it — upload the audio as an attachment. On
   Discord a `.ogg`/`.mp3` shows as a playable file; that's the target.
3. Expose as tool `speak`:
   ```
   name:"speak", sideEffects:true (posts to channel)
   parameters: { text: string, voice?: string }
   ```
   Handler synthesizes, then posts the file to `context.channelId` via the discord channel.
   For non-Discord channels, degrade gracefully (return the file path, no post).
4. Optional `/voice <text>` slash command mirroring the tool.

### Config (env/wizard allowlist)
`OPENAGI_TTS_PROVIDER` (edge|openai|elevenlabs, default edge), `OPENAGI_TTS_VOICE`,
`OPENAI_API_KEY`/`ELEVENLABS_API_KEY` reused if present.

### Tests
- `synthesize` with a stubbed provider (don't invoke real edge-tts in CI) writes a file and
  returns a path+mime.
- Over-length input truncates, doesn't throw.
- `speak` on a non-Discord channel degrades to path-return.
- Don't hit the network / spawn real TTS binaries in tests — stub the transport.

### Pitfall
edge-tts may not be installed on the box. Detect at first use; if missing, return a clear
`{error:"TTS provider edge-tts not installed; run: pipx install edge-tts"}` rather than
hanging. Do NOT auto-install in the handler.

---

## 5B — Streaming replies

### Goal
Stream the model's tokens to Discord as they arrive (live-edited message) instead of posting
one final block. Hermes streams; Azazel's live-status card partly covers the gap but true
streaming feels more responsive.

### Reality check first
- The live model path is the **Anthropic `/messages`** shape against `api.kimi.com/coding/v1`.
  Streaming requires `"stream": true` + SSE parsing. **Zed must first verify the coding
  endpoint supports SSE streaming** (POST with `stream:true`, read `text/event-stream`). If it
  does NOT, STOP — document it and skip 5B; the live-status card stays the UX. Report the
  finding either way.
- If streaming IS supported: add a streaming code path to `AnthropicProvider` guarded by a
  `stream` option, accumulating `content_block_delta` text events.

### Implementation (only if SSE works)
1. `AnthropicProvider.generate({..., onDelta})` — when `onDelta` is provided and no tools are
   pending, request `stream:true` and call `onDelta(textChunk)` per delta. Tool-use turns are
   NOT streamed to the user (they're internal) — only the final assistant prose streams.
2. `discord-channel.js runTurn`: throttle a live message edit (reuse the LiveStatus 1.5s
   PATCH-throttle pattern) — create one message, edit it with accumulated text every ~1.2s,
   finalize on completion. Respect the 2000-char Discord limit (roll to a new message on
   overflow).
3. Keep it behind `DISCORD_STREAMING` env (default OFF) so it can be toggled without a deploy,
   same pattern as `DISCORD_REPLY` / `DISCORD_LIVE_STATUS`.

### Tests
- Provider: a stubbed SSE stream of deltas → `onDelta` called in order, final text assembled.
- Non-streaming path unchanged when `onDelta` absent (regression guard).
- Char-overflow rolls to a second message.

---

## Definition of done (both sub-features)
Both lanes green, homoglyph-clean, CHANGES.md entries (one per sub-feature), commit SHAs,
branch only. For 5B, the FIRST deliverable is the SSE-support finding — report it before
building the streaming path. Seraphim will file the endpoint capability in the wiki.
