// Shared Discord embed + unicode-bar helpers for the Legion visual layer.
// Zero-dependency. Colors follow a traffic-light convention:
//   green = healthy, amber = needs attention (pending approvals), red = error,
//   blurple = neutral/info, purple = thinking/in-progress.
export const COLORS = {
  ok: 0x2ecc71,
  warn: 0xf39c12,
  err: 0xe74c3c,
  info: 0x5865f2,
  think: 0x9b59b6
};

// ▰▰▰▱▱ progress bar. frac clamped to [0,1].
export function bar(frac, width = 10) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  const full = Math.round(f * width);
  return "▰".repeat(full) + "▱".repeat(width - full);
}

export function embed({ title, description, color = COLORS.info, fields, footer, timestamp = true } = {}) {
  const e = { color };
  if (title) e.title = String(title).slice(0, 256);
  if (description) e.description = String(description).slice(0, 4000);
  if (fields?.length) {
    e.fields = fields.slice(0, 25).map((f) => ({
      name: String(f.name ?? "\u200b").slice(0, 256),
      value: String(f.value ?? "\u200b").slice(0, 1024),
      inline: Boolean(f.inline)
    }));
  }
  if (footer) e.footer = { text: String(footer).slice(0, 2048) };
  if (timestamp) e.timestamp = new Date().toISOString();
  return e;
}

// Wrap text in an ansi code block (Discord renders real terminal colors).
export function ansiBlock(text) {
  return "```ansi\n" + String(text).slice(0, 3800) + "\n```";
}

export const ANSI = {
  reset: "\u001b[0m",
  gray: "\u001b[30m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  white: "\u001b[37m",
  bold: "\u001b[1m"
};
