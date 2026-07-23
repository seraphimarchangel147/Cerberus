import path from "node:path";

const PROTECTED_ENGINES = /(?:^|[_.@-])(?:zerohermes|hermes|openagi|cua)(?:[_.@-]|$)/i;
const PROTECTED_PROCESSES = /(?:zerohermes|hermes-gateway|openagi|node.*hosted-server)/i;

/** @returns {{catastrophic: boolean, reason: string|null}} */
export function classifyCommand(command) {
  const normalized = normalizeCommand(command);
  if (!normalized) return safe();

  if (containsCatastrophicRm(normalized)) {
    return catastrophic("recursive forced delete targets a protected or dangerously short path");
  }
  if (segments(normalized).some(isShutdownSegment)) {
    return catastrophic("command shuts down or reboots the host/WSL environment");
  }
  if (segments(normalized).some(isProtectedSystemctlSegment)) {
    return catastrophic("command stops, disables, kills, or masks a protected agent service");
  }
  if (segments(normalized).some(isProtectedProcessKillSegment)) {
    return catastrophic("command kills a protected agent process");
  }
  if (segments(normalized).some(isDiskSurgerySegment)) {
    return catastrophic("command can overwrite or repartition a block device");
  }
  if (segments(normalized).some(isForcePushToPrimaryBranch)) {
    return catastrophic("command force-pushes the main or master branch");
  }
  if (containsCredentialWrite(normalized)) {
    return catastrophic("command writes to a private key or agent credential file");
  }
  if (containsForkBomb(normalized)) {
    return catastrophic("command contains a fork-bomb pattern");
  }
  return safe();
}

/** @returns {{catastrophic: boolean, reason: string|null}} */
export function isCatastrophicToolCall({ toolName, args } = {}) {
  if (toolName === "code_shell" && args?.command != null) {
    return classifyCommand(String(args.command));
  }
  return safe();
}

export function createCatastrophicPreToolHook() {
  return Object.freeze({
    name: "catastrophic-policy",
    event: "pre_tool_call",
    tier: "gateway",
    immutable: true,
    handler(payload = {}) {
      if (payload.confirmed === true || payload.sessionAllowed === true) {
        return { action: "allow" };
      }
      const classified = isCatastrophicToolCall(payload);
      if (!classified.catastrophic) return { action: "allow" };
      return {
        action: "block",
        code: "catastrophic",
        approvalRequired: true,
        reason: classified.reason,
        message: `Catastrophic tool call requires human approval: ${classified.reason}`
      };
    }
  });
}

function normalizeCommand(command) {
  let value = typeof command === "string" ? command.trim() : "";
  // Models commonly send the literal bash wrapper even though code_shell adds
  // one itself. Peel it before matching so quoting cannot hide the payload.
  for (let i = 0; i < 2; i += 1) {
    const match = /^(?:\/[^\s]+\/)?bash\s+-lc\s+(?:'([\s\S]*)'|"([\s\S]*)"|([\s\S]+))$/i.exec(value);
    if (!match) break;
    value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  }
  return value.replace(/\r?\n/g, "; ").replace(/[\t ]+/g, " ").trim();
}

function segments(command) {
  return command
    .split(/(?:&&|\|\||[;|])/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^\(+\s*/, "").replace(/^sudo\s+(?:-[^\s]+\s+)*/i, ""));
}

function shellWords(value) {
  return value.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)?.map((token) => {
    const quoted = (token.startsWith("\"") && token.endsWith("\""))
      || (token.startsWith("'") && token.endsWith("'"));
    const unquoted = quoted ? token.slice(1, -1) : token;
    return unquoted.replace(/\\([\\"' ])/g, "$1");
  }) ?? [];
}

function containsCatastrophicRm(command) {
  return segments(command).some((segment) => {
    if (!/^rm\s+/i.test(segment)) return false;
    const words = shellWords(segment).slice(1);
    const flags = words.filter((word) => /^-/.test(word) && word !== "--");
    const recursive = flags.some((flag) => flag === "--recursive" || /^-[^-]*r/i.test(flag));
    const forced = flags.some((flag) => flag === "--force" || /^-[^-]*f/i.test(flag));
    if (!recursive || !forced) return false;

    let optionsEnded = false;
    const targets = [];
    for (const word of words) {
      if (word === "--") { optionsEnded = true; continue; }
      if (!optionsEnded && word.startsWith("-")) continue;
      if (/^(?:\d*)?>/.test(word)) break;
      targets.push(word);
    }
    return targets.some(isProtectedDeleteTarget);
  });
}

function isProtectedDeleteTarget(target) {
  const clean = String(target).replace(/["']/g, "").replace(/\/$/, "") || "/";
  if (/^(?:~|\$HOME|\$\{HOME\})(?:\/|$)/i.test(clean)) return true;
  if (/^\/home(?:\/|$)/i.test(clean)) return true;
  if (/^\/mnt\/c(?:\/|$)/i.test(clean)) return true;
  if (!clean.startsWith("/")) return false;
  return path.posix.resolve(clean).length < 6;
}

function isShutdownSegment(segment) {
  return /^(?:wsl(?:\.exe)?\s+--shutdown(?:\s|$)|shutdown(?:\s|$)|reboot(?:\s|$)|poweroff(?:\s|$))/i.test(segment);
}

function isProtectedSystemctlSegment(segment) {
  if (!/^systemctl\s+/i.test(segment)) return false;
  const words = shellWords(segment).slice(1);
  const actionIndex = words.findIndex((word) => /^(?:stop|disable|kill|mask)$/i.test(word));
  if (actionIndex < 0) return false;
  return words.slice(actionIndex + 1).some((word) => !word.startsWith("-") && PROTECTED_ENGINES.test(word));
}

function isProtectedProcessKillSegment(segment) {
  if (!/^(?:pkill|killall)\s+/i.test(segment)) return false;
  return PROTECTED_PROCESSES.test(segment.replace(/^(?:pkill|killall)\s+/i, ""));
}

function isDiskSurgerySegment(segment) {
  if (/^(?:mkfs(?:\.[a-z0-9_-]+)?|fdisk|parted)(?:\s|$)/i.test(segment)) return true;
  return /^dd\s+/i.test(segment) && /(?:^|\s)of\s*=\s*\/dev\//i.test(segment);
}

function isForcePushToPrimaryBranch(segment) {
  const words = shellWords(segment);
  if (words[0]?.toLowerCase() !== "git") return false;
  const pushIndex = words.findIndex((word, index) => index > 0 && word.toLowerCase() === "push");
  if (pushIndex < 0) return false;
  const tail = words.slice(pushIndex + 1);
  const forced = tail.some((word) => /^(?:-f|--force(?:-with-lease)?)(?:=|$)/i.test(word));
  if (!forced) return false;
  const positional = tail.filter((word) => !word.startsWith("-"));
  if (positional.length < 2) return false;
  return positional.slice(1).some((word) => /(?:^|:|\/)(?:main|master)$/i.test(word));
}

function containsCredentialWrite(command) {
  const redirects = [...command.matchAll(/(?:^|\s)(?:\d*)?>{1,2}\s*([^\s;&|]+)/g)]
    .map((match) => match[1]);
  if (redirects.some(isCredentialPath)) return true;

  return segments(command).some((segment) => {
    if (!/^(?:cp|mv)\s+/i.test(segment)) return false;
    const words = shellWords(segment).slice(1).filter((word) => !word.startsWith("-"));
    return words.length >= 2 && isCredentialPath(words.at(-1));
  });
}

function isCredentialPath(value) {
  const target = String(value ?? "").replace(/["']/g, "").replace(/[),]+$/, "");
  if (/(?:^|\/)id_rsa$/i.test(target) || /\.pem$/i.test(target)) return true;
  return /^(?:~|\$HOME|\$\{HOME\}|\/home\/[^/]+)\/(?:\.openagi|\.zeroclaw|\.hermes)(?:\/[^/]+)*\/\.env$/i.test(target);
}

function containsForkBomb(command) {
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*;?\s*\}\s*;?\s*:/i.test(command)) return true;
  return /(?:function\s+)?([a-z_][a-z0-9_]*)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*;?\s*\}\s*;?\s*\1\b/i.test(command);
}

function catastrophic(reason) {
  return { catastrophic: true, reason };
}

function safe() {
  return { catastrophic: false, reason: null };
}
