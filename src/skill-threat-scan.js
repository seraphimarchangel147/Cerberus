// Static threat scanner for imported skill packages.
//
// Imported skill bytes are untrusted review data. Quarantine already bounds
// SIZE and LOCATION; this module inspects CONTENT so a human reviewer sees a
// ranked, evidence-backed verdict instead of a directory listing.
//
// The scanner is pure and offline: it takes in-memory buffers, never touches
// the filesystem, never executes anything, and returns a deterministic result
// bound to a rule digest so a verdict can be reproduced and audited later.
//
// Deliberate differences from a plain regex table:
//   1. Confusable/invisible-character defanging. Every line is scanned twice —
//      raw, and NFKC-normalized with invisible characters stripped and
//      homoglyphs folded to ASCII. A payload written as `сurl` (Cyrillic es)
//      still trips the curl rules, and matching only in the defanged view is
//      itself escalated as deliberate evasion.
//   2. Correlation rules. Individually-dull findings that compose into an
//      attack (a credential read plus a network sink in the same file) are
//      escalated to a critical chain finding.
//   3. Capability reconciliation. Imported skills must declare allowed_tools;
//      content that clearly needs a capability the manifest never declared is
//      reported as an undeclared capability.
//   4. Bounded matching. Every rule uses bounded quantifiers and is applied
//      per line with explicit line/length caps, so a hostile package cannot
//      turn the scanner into a denial of service.
//   5. Redacted evidence. Matched credential material is masked before it is
//      stored in the candidate record or shown to a reviewer.

import { createHash } from "node:crypto";

export const THREAT_SCANNER_VERSION = "openagi-skill-threat-v1";

export const THREAT_VERDICTS = Object.freeze({
  SAFE: "safe",
  CAUTION: "caution",
  DANGEROUS: "dangerous"
});

const VERDICT_RANK = Object.freeze({ safe: 0, caution: 1, dangerous: 2 });
const SEVERITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const SEVERITY_ORDER = Object.freeze(["critical", "high", "medium", "low"]);

// Scan bounds. A skill file is review data, not a corpus.
const MAX_SCAN_BYTES_PER_FILE = 1024 * 1024;
const MAX_SCAN_LINES_PER_FILE = 20_000;
const MAX_LINE_SCAN_LENGTH = 4096;
const MAX_FINDINGS = 500;
const MAX_EVIDENCE_LENGTH = 160;

// Capabilities a rule can imply. Reconciled against declared allowed_tools.
export const CAPABILITIES = Object.freeze({
  SHELL: "shell",
  NETWORK: "network",
  FILESYSTEM_WRITE: "filesystem_write"
});

// Extensions that have no business inside a review-only skill package.
const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".com", ".msi",
  ".dmg", ".app", ".deb", ".rpm", ".jar", ".class", ".pyc",
  ".wasm", ".o", ".a", ".node"
]);

// Zero-width, joiner and bidirectional-control characters. Their only use in a
// skill document is hiding text from a human reviewer.
const INVISIBLE_CHARS = new Map([
  ["\u200b", "zero-width space"],
  ["\u200c", "zero-width non-joiner"],
  ["\u200d", "zero-width joiner"],
  ["\u2060", "word joiner"],
  ["\u2061", "function application"],
  ["\u2062", "invisible times"],
  ["\u2063", "invisible separator"],
  ["\u2064", "invisible plus"],
  ["\ufeff", "zero-width no-break space"],
  ["\u00ad", "soft hyphen"],
  ["\u180e", "Mongolian vowel separator"],
  ["\u202a", "left-to-right embedding"],
  ["\u202b", "right-to-left embedding"],
  ["\u202c", "pop directional formatting"],
  ["\u202d", "left-to-right override"],
  ["\u202e", "right-to-left override"],
  ["\u2066", "left-to-right isolate"],
  ["\u2067", "right-to-left isolate"],
  ["\u2068", "first strong isolate"],
  ["\u2069", "pop directional isolate"],
  ["\ufff9", "interlinear annotation anchor"],
  ["\ufffa", "interlinear annotation separator"],
  ["\ufffb", "interlinear annotation terminator"],
  ["\u{e0001}", "language tag"]
]);

const BIDI_CONTROL_CHARS = new Set([
  "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
  "\u2066", "\u2067", "\u2068", "\u2069"
]);

// Confusable folding. Latin-looking codepoints from other scripts are folded to
// their ASCII lookalike so an obfuscated payload cannot slip past a rule.
const CONFUSABLES = new Map(Object.entries({
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c",
  "\u0443": "y", "\u0445": "x", "\u0455": "s", "\u0456": "i", "\u0458": "j",
  "\u04bb": "h", "\u0501": "d", "\u051b": "q", "\u051d": "w",
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H",
  "\u0399": "I", "\u039a": "K", "\u039c": "M", "\u039d": "N", "\u039f": "O",
  "\u03a1": "P", "\u03a4": "T", "\u03a5": "Y", "\u03a7": "X",
  "\u03bf": "o", "\u03b1": "a", "\u03b9": "i", "\u03bd": "v", "\u03c1": "p",
  "\u2024": ".", "\u2044": "/", "\u2215": "/", "\u29f8": "/", "\u29f9": "\\",
  "\ufe52": ".", "\uff0e": ".", "\uff0f": "/", "\uff3c": "\\",
  "\uff10": "0", "\uff11": "1", "\uff12": "2", "\uff13": "3", "\uff14": "4",
  "\uff15": "5", "\uff16": "6", "\uff17": "7", "\uff18": "8", "\uff19": "9",
  "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-",
  "\u2212": "-", "\uff0d": "-",
  "\u2018": "'", "\u2019": "'", "\u201c": "\"", "\u201d": "\"",
  "\u0130": "I", "\u0131": "i", "\u017f": "s"
}));

function rule(id, severity, category, description, pattern, extra = {}) {
  return Object.freeze({
    id,
    severity,
    category,
    description,
    pattern,
    capability: extra.capability ?? null,
    signal: extra.signal ?? null
  });
}

// Correlation signals. A rule can emit a signal; signals that co-occur inside a
// single file compose into a chain finding even when no single rule is critical.
const SIGNALS = Object.freeze({
  CREDENTIAL_READ: "credential_read",
  NETWORK_SINK: "network_sink",
  ENCODE: "encode",
  DYNAMIC_EXEC: "dynamic_exec",
  REMOTE_FETCH: "remote_fetch"
});

export const THREAT_RULES = Object.freeze([
  // ── Exfiltration: secrets piped into a network call ──────────────────────
  // A credential inside an Authorization / api-key HEADER is the credential's
  // declared, intended use — that is how every authenticated API call is
  // written. Exfiltration does the opposite: it smuggles the secret into a
  // query string, request body, or URL path where the receiving host was never
  // meant to be trusted with it. Only the smuggled shape is critical; the
  // header shape stays visible as a low informational finding.
  rule("env_exfil_curl", "critical", "exfiltration",
    "curl sending a secret environment variable outside an authorization header",
    /curl\s+(?![^\n]{0,400}-H\s*["']?\s*(Authorization|X-Api-Key|Api-Key|Private-Token|X-Auth-Token)\s*:)[^\n]{0,400}\$\{?\w{0,32}(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.NETWORK_SINK }),
  rule("credential_in_auth_header", "low", "exfiltration",
    "passes a secret in an authorization header (the credential's declared use)",
    /-H\s*["']?\s*(Authorization|X-Api-Key|Api-Key|Private-Token|X-Auth-Token)\s*:[^\n]{0,200}\$\{?\w{0,32}(KEY|TOKEN|SECRET|PASSWORD)/i,
    { capability: CAPABILITIES.NETWORK }),
  rule("env_exfil_wget", "critical", "exfiltration",
    "wget sending a secret environment variable outside an authorization header",
    /wget\s+(?![^\n]{0,400}--header\s*=?\s*["']?\s*(Authorization|X-Api-Key)\s*:)[^\n]{0,400}\$\{?\w{0,32}(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.NETWORK_SINK }),
  rule("env_exfil_fetch", "critical", "exfiltration",
    "fetch() call interpolating a secret environment variable",
    /fetch\s*\([^\n]{0,400}\$\{?\w{0,32}(KEY|TOKEN|SECRET|PASSWORD|API)/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.NETWORK_SINK }),
  rule("env_exfil_httpx", "critical", "exfiltration",
    "HTTP client call carrying a secret variable",
    /http(?:x)?\.(get|post|put|patch)\s*\([^\n]{0,400}(KEY|TOKEN|SECRET|PASSWORD)/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.NETWORK_SINK }),
  rule("env_exfil_requests", "critical", "exfiltration",
    "requests call carrying a secret variable",
    /requests\.(get|post|put|patch)\s*\([^\n]{0,400}(KEY|TOKEN|SECRET|PASSWORD)/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.NETWORK_SINK }),
  rule("encoded_exfil", "high", "exfiltration",
    "base64 encoding combined with environment access",
    /base64[^\n]{0,80}\benv\b/i, { signal: SIGNALS.ENCODE }),

  // ── Exfiltration: credential stores ──────────────────────────────────────
  rule("ssmcp_dir_access", "high", "exfiltration",
    "references the user SSH directory",
    /(\$HOME|~)\/\.ssh\b/i, { signal: SIGNALS.CREDENTIAL_READ }),
  rule("aws_dir_access", "high", "exfiltration",
    "references the user AWS credentials directory",
    /(\$HOME|~)\/\.aws\b/i, { signal: SIGNALS.CREDENTIAL_READ }),
  rule("gpg_dir_access", "high", "exfiltration",
    "references the user GPG keyring",
    /(\$HOME|~)\/\.gnupg\b/i, { signal: SIGNALS.CREDENTIAL_READ }),
  rule("kube_dir_access", "high", "exfiltration",
    "references the Kubernetes config directory",
    /(\$HOME|~)\/\.kube\b/i, { signal: SIGNALS.CREDENTIAL_READ }),
  rule("docker_dir_access", "high", "exfiltration",
    "references Docker config, which may hold registry credentials",
    /(\$HOME|~)\/\.docker\b/i, { signal: SIGNALS.CREDENTIAL_READ }),
  rule("agent_secrets_access", "critical", "exfiltration",
    "reads an agent secrets file",
    /\b(cat|less|head|tail|cp|source|\.|grep|rsync|scp|read_file|open|load_dotenv)\b[^\n]{0,120}(\$HOME|~)\/\.(openagi|hermes|zeroclaw|claude|codex)\/(\.env|secrets|credentials)/i,
    { signal: SIGNALS.CREDENTIAL_READ }),
  rule("agent_secrets_reference", "medium", "exfiltration",
    "mentions an agent secrets file",
    /(\$HOME|~)\/\.(openagi|hermes|zeroclaw|claude|codex)\/(\.env|secrets|credentials)/i),
  // Reading another agent's private state is the threat; documenting where it
  // lives is not. Require a read/copy command on the same line.
  rule("agent_state_access", "high", "exfiltration",
    "reads another agent's private data directory",
    /\b(cat|less|head|tail|cp|rsync|scp|tar|zip|find|read_file|open)\b[^\n]{0,120}(\$HOME|~)\/\.(openagi|hermes|zeroclaw)\//i,
    { signal: SIGNALS.CREDENTIAL_READ }),
  rule("agent_state_reference", "low", "exfiltration",
    "mentions another agent's private data directory",
    /(\$HOME|~)\/\.(openagi|hermes|zeroclaw)\//i),
  rule("read_secrets_file", "critical", "exfiltration",
    "reads a known secrets file",
    /\bcat\s+(?!>)[^\n]{0,200}(\.env\b|credentials\b|\.netrc\b|\.pgpass\b|\.npmrc\b|\.pypirc\b)/i,
    { signal: SIGNALS.CREDENTIAL_READ }),
  rule("browser_cookie_store", "critical", "exfiltration",
    "reads a browser cookie or login database",
    /(Cookies|Login Data|key4\.db|logins\.json|cookies\.sqlite)\b/i,
    { signal: SIGNALS.CREDENTIAL_READ }),
  rule("keychain_dump", "critical", "exfiltration",
    "dumps an OS keychain or credential manager",
    /\b(security\s+find-(generic|internet)-password|secret-tool\s+lookup|cmdkey\s+\/list)\b/i,
    { signal: SIGNALS.CREDENTIAL_READ }),

  // ── Exfiltration: programmatic environment access ────────────────────────
  rule("dump_all_env", "high", "exfiltration",
    "dumps the entire environment",
    /\bprintenv\b|\benv\s*\|/i, { signal: SIGNALS.CREDENTIAL_READ }),
  rule("python_environ_get_secret", "critical", "exfiltration",
    "reads a secret via os.environ.get()",
    /os\.environ\s*\.get\s*\(\s*["'][^"']{0,64}(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
    { signal: SIGNALS.CREDENTIAL_READ }),
  rule("python_getenv_secret", "critical", "exfiltration",
    "reads a secret via os.getenv()",
    /os\.getenv\s*\(\s*["'][^"']{0,64}(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
    { signal: SIGNALS.CREDENTIAL_READ }),
  rule("python_os_environ", "medium", "exfiltration",
    "iterates or dumps os.environ",
    /os\.environ\s*(?:\)|\]|\.items\(|\.keys\(|\.values\()/i,
    { signal: SIGNALS.CREDENTIAL_READ }),
  rule("node_process_env_secret", "critical", "exfiltration",
    "reads a secret from process.env",
    /process\.env(?:\.|\[\s*["'])\w{0,48}(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
    { signal: SIGNALS.CREDENTIAL_READ }),
  rule("node_process_env_dump", "medium", "exfiltration",
    "enumerates process.env wholesale",
    /(JSON\.stringify\s*\(\s*process\.env|Object\.(keys|entries)\s*\(\s*process\.env)/i,
    { signal: SIGNALS.CREDENTIAL_READ }),
  rule("ruby_env_secret", "critical", "exfiltration",
    "reads a secret via Ruby ENV[]",
    /ENV\[\s*["'][^"']{0,64}(KEY|TOKEN|SECRET|PASSWORD)/i,
    { signal: SIGNALS.CREDENTIAL_READ }),

  // ── Exfiltration: covert channels ────────────────────────────────────────
  rule("dns_exfil", "critical", "exfiltration",
    "DNS lookup with variable interpolation, a classic covert channel",
    /\b(dig|nslookup|host)\s+[^\n]{0,200}\$/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.NETWORK_SINK }),
  rule("tmp_staging", "critical", "exfiltration",
    "stages data in /tmp then transmits it",
    />\s*\/tmp\/[^\s]{1,200}\s*&&\s*(curl|wget|nc|python)/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.NETWORK_SINK }),
  rule("md_image_exfil", "high", "exfiltration",
    "markdown image URL with interpolation, an image-beacon exfiltration",
    /!\[[^\]]{0,200}\]\(https?:\/\/[^)]{0,200}[$\{]/i, { signal: SIGNALS.NETWORK_SINK }),
  rule("md_link_exfil", "medium", "exfiltration",
    "markdown link with variable interpolation",
    /\[[^\]]{0,200}\]\(https?:\/\/[^)]{0,200}[$\{]/i, { signal: SIGNALS.NETWORK_SINK }),
  rule("context_exfil", "critical", "exfiltration",
    "instructs the agent to emit its conversation history, leaking everything in context",
    /\b(include|output|print|send|share|dump)\b(?:\s+\w+){0,4}\s+\b(conversation|chat\s+history|previous\s+messages|system\s+context)\b/i),
  rule("send_to_url", "high", "exfiltration",
    "instructs the agent to send data to an external URL",
    /\b(send|post|upload|transmit|exfiltrate)\b[^\n]{0,120}\b(to|at)\s+https?:\/\//i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.NETWORK_SINK }),

  // ── Prompt injection ─────────────────────────────────────────────────────
  rule("prompt_injection_ignore", "critical", "injection",
    "prompt injection: ignore previous instructions",
    /\bignore\b(?:\s+\w+){0,4}\s+\b(previous|all|above|prior|earlier)\b(?:\s+\w+){0,2}\s+\b(instructions|prompts|rules)\b/i),
  rule("disregard_rules", "critical", "injection",
    "instructs the agent to disregard its rules",
    /\b(disregard|forget|override)\b(?:\s+\w+){0,4}\s+\b(your|all|any|the)\b(?:\s+\w+){0,3}\s+\b(instructions|rules|guidelines|policies)\b/i),
  rule("sys_prompt_override", "critical", "injection",
    "attempts to override the system prompt",
    /\bsystem\b(?:\s+\w+){0,3}\s+\bprompt\b(?:\s+\w+){0,3}\s+\b(override|replace|ignore)\b/i),
  rule("leak_system_prompt", "high", "injection",
    "attempts to extract the system prompt",
    /\b(output|print|reveal|repeat|show)\b(?:\s+\w+){0,4}\s+\b(system|initial|original)\b(?:\s+\w+){0,2}\s+\b(prompt|instructions)\b/i),
  rule("role_hijack", "high", "injection",
    "attempts to override the agent's role",
    /\byou\s+are\b(?:\s+\w+){0,4}\s+\bnow\b\s+\w/i),
  rule("role_pretend", "high", "injection",
    "attempts to make the agent assume a different identity",
    /\bpretend\b(?:\s+\w+){0,3}\s+\b(you\s+are|to\s+be)\b/i),
  rule("deception_hide", "critical", "injection",
    "instructs the agent to hide information from the user",
    /\bdo\s+not\b(?:\s+\w+){0,4}\s+\b(tell|inform|show|mention\s+to)\b(?:\s+\w+){0,3}\s+\b(the\s+)?(user|operator|human)\b/i),
  rule("silent_action", "critical", "injection",
    "instructs the agent to act without reporting it",
    /\b(silently|without\s+(telling|informing|notifying|asking))\b[^\n]{0,80}\b(run|execute|send|delete|install|write)\b/i),
  rule("conditional_deception", "high", "injection",
    "conditional instruction to behave differently when unobserved",
    /\b(when|if)\s+no\s*one\s+is\s+(watching|looking)\b/i),
  rule("bypass_restrictions", "critical", "injection",
    "instructs the agent to act without restrictions",
    /\bact\s+as\s+(if|though)\b(?:\s+\w+){0,4}\s+\byou\b(?:\s+\w+){0,3}\s+\b(have\s+no|lack|don't\s+have)\b(?:\s+\w+){0,2}\s+\b(restrictions|limits|rules|guardrails)\b/i),
  rule("remove_filters", "critical", "injection",
    "instructs the agent to respond without safety filters",
    /\b(respond|answer|reply|comply)\b\s+\bwithout\b(?:\s+\w+){0,3}\s+\b(restrictions|limitations|filters|safety|refusals)\b/i),
  rule("translate_execute", "critical", "injection",
    "translate-then-execute evasion",
    /\btranslate\b[^\n]{0,120}\binto\b[^\n]{0,120}\band\s+(execute|run|eval)\b/i),
  rule("jailbreak_dan", "critical", "injection",
    "DAN-style jailbreak attempt",
    /\bDAN\s+mode\b|\bDo\s+Anything\s+Now\b/i),
  rule("jailbreak_dev_mode", "critical", "injection",
    "developer-mode jailbreak attempt",
    /\bdeveloper\s+mode\b[^\n]{0,60}\benabled?\b/i),
  rule("hypothetical_bypass", "high", "injection",
    "hypothetical framing used to bypass restrictions",
    /\bhypothetical(?:ly)?\b[^\n]{0,120}\b(ignore|bypass|override|disable)\b/i),
  rule("fake_update", "high", "injection",
    "fake update or patch announcement, a social-engineering opener",
    /\byou\s+have\s+been\b(?:\s+\w+){0,3}\s+\b(updated|upgraded|patched|reconfigured)\b\s+to\b/i),
  rule("authority_impersonation", "high", "injection",
    "content impersonates the operator or system authority",
    /^\s*(\[)?(system|developer|operator|admin)(\])?\s*:\s*\S/i),
  rule("html_comment_injection", "high", "injection",
    "hidden instructions inside an HTML comment",
    /<!--[^>]{0,400}\b(ignore|override|system\s+prompt|secret|do\s+not\s+tell)\b[^>]{0,400}-->/i),
  rule("hidden_div", "high", "injection",
    "hidden HTML element carrying invisible instructions",
    /<\s*(div|span|p)\b[^>]{0,200}(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0)/i),
  rule("educational_pretext", "low", "injection",
    "educational pretext commonly used to justify harmful content",
    /\bfor\s+educational\s+purposes?\s+only\b/i),

  // ── Destructive operations ───────────────────────────────────────────────
  rule("destructive_root_rm", "critical", "destructive",
    "recursive delete from the filesystem root",
    /\brm\s+-[a-z]{0,4}rf?[a-z]{0,4}\s+\/(\s|$|\*)/i, { capability: CAPABILITIES.SHELL }),
  rule("destructive_home_rm", "critical", "destructive",
    "recursive delete targeting the home directory",
    /\brm\s+-[a-z]{0,4}r[a-z]{0,4}\s+[^\n]{0,80}(\$HOME|~\/)/i, { capability: CAPABILITIES.SHELL }),
  rule("git_history_destruction", "high", "destructive",
    "destructive git operation that discards work or rewrites shared history",
    /\bgit\s+(push\s+(-f|--force)|reset\s+--hard|clean\s+-[a-z]{0,3}f|filter-branch)\b/i,
    { capability: CAPABILITIES.SHELL }),
  rule("system_overwrite", "critical", "destructive",
    "overwrites a system configuration file",
    />\s*\/etc\//i, { capability: CAPABILITIES.FILESYSTEM_WRITE }),
  rule("format_filesystem", "critical", "destructive",
    "formats a filesystem",
    /\bmkfs(\.\w+)?\b/i, { capability: CAPABILITIES.SHELL }),
  rule("disk_overwrite", "critical", "destructive",
    "raw disk write",
    /\bdd\s+[^\n]{0,120}of=\/dev\//i, { capability: CAPABILITIES.SHELL }),
  rule("python_rmtree", "high", "destructive",
    "shutil.rmtree on an absolute or root-relative path",
    /shutil\.rmtree\s*\(\s*["'/]/i, { capability: CAPABILITIES.FILESYSTEM_WRITE }),
  rule("truncate_system", "critical", "destructive",
    "truncates a system file to zero bytes",
    /\btruncate\s+-s\s*0\s+\//i, { capability: CAPABILITIES.FILESYSTEM_WRITE }),
  rule("insecure_perms", "medium", "destructive",
    "sets world-writable permissions",
    /\bchmod\s+(-R\s+)?777\b/i, { capability: CAPABILITIES.SHELL }),
  rule("kill_agent_process", "high", "destructive",
    "kills agent or supervisor processes",
    /\b(pkill|killall)\s+-?\w{0,8}\s*(node|openagi|hermes|systemd)\b/i,
    { capability: CAPABILITIES.SHELL }),

  // ── Persistence ──────────────────────────────────────────────────────────
  rule("ssmcp_backdoor", "critical", "persistence",
    "writes SSH authorized keys",
    /authorized_keys\b/i),
  rule("sudoers_mod", "critical", "persistence",
    "modifies sudoers, a privilege-escalation persistence",
    /\/etc\/sudoers|\bvisudo\b/i),
  rule("persistence_cron", "medium", "persistence",
    "modifies cron jobs",
    /\bcrontab\b|\/etc\/cron\.[a-z]+\//i),
  rule("shell_rc_mod", "medium", "persistence",
    "references a shell startup file",
    /\.(bashrc|zshrc|profile|basmcp_profile|basmcp_login|zprofile|zlogin)\b/i),
  rule("systemd_service", "medium", "persistence",
    "references or enables a systemd unit",
    /\bsystemctl\s+(enable|start|daemon-reload)\b|\.service\b/i),
  rule("init_script", "medium", "persistence",
    "references an init.d startup script",
    /\/etc\/init\.d\//i),
  rule("macos_launchd", "medium", "persistence",
    "macOS launch agent or daemon persistence",
    /\blaunchctl\s+load\b|LaunchAgents|LaunchDaemons/i),
  rule("windows_run_key", "high", "persistence",
    "Windows Run registry key persistence",
    /(CurrentVersion\\\\?Run|reg\s+add\s+[^\n]{0,80}\\Run)/i),
  rule("git_config_global", "medium", "persistence",
    "modifies global git configuration",
    /\bgit\s+config\s+--global\b/i),
  // Documentation names these paths constantly ("your CLAUDE.md lives at…").
  // Naming a path is not modifying it. The threat is a WRITE, so require a
  // write verb, a redirection, or an editing call on the same line.
  rule("agent_config_mod", "critical", "persistence",
    "writes agent instruction files, persisting behaviour across sessions",
    /(?:>>?\s*|\b(?:echo|cat|tee|write_file|sed\s+-i|printf|append|Add-Content|Set-Content)\b[^\n]{0,120})(AGENTS\.md|CLAUDE\.md|SOUL\.md|\.cursorrules|\.clinerules|GEMINI\.md)\b|\b(AGENTS\.md|CLAUDE\.md|SOUL\.md)\b[^\n]{0,40}\b(overwrite|append\s+to|inject|modify)\b/i,
    { capability: CAPABILITIES.FILESYSTEM_WRITE }),
  rule("agent_config_reference", "low", "persistence",
    "mentions an agent instruction file",
    /\b(AGENTS\.md|CLAUDE\.md|SOUL\.md|\.cursorrules|\.clinerules|GEMINI\.md)\b/i),
  rule("agent_runtime_config_mod", "critical", "persistence",
    "writes an agent runtime configuration file",
    /(?:>>?\s*|\b(?:echo|cat|tee|sed\s+-i|printf|write_file)\b[^\n]{0,120})[^\n]{0,80}(\.(openagi|hermes|zeroclaw)\/config\.(yaml|yml|json)|\.claude\/settings|\.codex\/config)/i,
    { capability: CAPABILITIES.FILESYSTEM_WRITE }),
  rule("agent_runtime_config_reference", "low", "persistence",
    "mentions an agent runtime configuration file",
    /\.(openagi|hermes|zeroclaw)\/config\.(yaml|yml|json)\b|\.claude\/settings|\.codex\/config/i),
  // A git hook runs automatically on commit/push with the developer's full
  // privileges. Writing one is arbitrary code execution on a schedule the
  // victim triggers themselves.
  rule("hook_installation", "critical", "persistence",
    "installs a git hook, which then executes on ordinary developer actions",
    /(?:>>?\s*|\b(?:cp|mv|echo|cat|tee|printf|install|write_file)\b[^\n]{0,120})\.git\/hooks\/(pre-commit|post-commit|pre-push|post-checkout|post-merge|pre-receive)\b/i,
    { capability: CAPABILITIES.FILESYSTEM_WRITE }),
  rule("hook_reference", "medium", "persistence",
    "references a git hook path",
    /\.git\/hooks\/[a-z-]{3,24}\b/i),

  // ── Network: shells, tunnels, beacons ────────────────────────────────────
  rule("basmcp_reverse_shell", "critical", "network",
    "bash reverse shell via /dev/tcp",
    /\/dev\/tcp\/[\w.$]/i, { capability: CAPABILITIES.NETWORK }),
  rule("reverse_shell", "critical", "network",
    "netcat or socat listener, a reverse-shell primitive",
    /\b(nc|ncat)\s+-[a-z]{0,4}[lp][a-z]{0,4}\b|\bsocat\b/i,
    { capability: CAPABILITIES.NETWORK }),
  rule("python_socket_oneliner", "critical", "network",
    "Python one-liner opening a socket",
    /python[23]?\s+-c\s+["'][^"']{0,200}\bimport\s+socket\b/i,
    { capability: CAPABILITIES.NETWORK }),
  rule("python_socket_connect", "high", "network",
    "Python socket connect to an arbitrary host",
    /socket\.(socket|connect)\s*\(/i, { capability: CAPABILITIES.NETWORK }),
  // Publishing a local service to the public internet from imported, untrusted
  // content turns the reviewer's machine into a reachable target.
  rule("tunnel_service", "critical", "network",
    "uses a tunnelling service to expose the host to the public internet",
    /\b(ngrok|localtunnel|serveo|cloudflared|pinggy)\b/i,
    { capability: CAPABILITIES.NETWORK }),
  rule("exfil_service", "high", "network",
    "references a known request-capture or webhook-testing endpoint",
    /\b(webhook\.site|requestbin\.\w+|pipedream\.net|hookbin\.com|interact\.sh|oast\.\w+|burpcollaborator\.net)\b/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.NETWORK_SINK }),
  rule("paste_service", "medium", "network",
    "references a paste service, a common staging area",
    /\b(pastebin\.com|hastebin\.com|ghostbin\.\w+|termbin\.com|0x0\.st|transfer\.sh)\b/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.NETWORK_SINK }),
  rule("bind_all_interfaces", "high", "network",
    "binds a listener to every interface",
    /\b0\.0\.0\.0:\d{2,5}\b|INADDR_ANY/i, { capability: CAPABILITIES.NETWORK }),
  // Loopback and private ranges are local development endpoints, not
  // attacker-controlled destinations.
  rule("hardcoded_ip_port", "medium", "network",
    "hardcoded external IP address and port",
    /\b(?!127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}\b/,
    { capability: CAPABILITIES.NETWORK }),
  rule("cloud_metadata_endpoint", "critical", "network",
    "queries the cloud instance metadata service, a credential-theft target",
    /169\.254\.169\.254|metadata\.google\.internal/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.CREDENTIAL_READ }),

  // ── Obfuscation and dynamic execution ────────────────────────────────────
  rule("base64_decode_pipe", "critical", "obfuscation",
    "base64 decode piped into an interpreter",
    /base64\s+(-d|--decode|-D)\b[^\n]{0,80}\|\s*(ba)?sh|\|\s*base64\s+(-d|--decode)\b[^\n]{0,40}\|/i,
    { capability: CAPABILITIES.SHELL, signal: SIGNALS.DYNAMIC_EXEC }),
  // Piping into a shell executes the piped bytes. Piping into a language
  // interpreter only executes them when the interpreter has no other program
  // source: `python3 -c '...'` and `python3 -m json.tool` read their PROGRAM
  // from argv and treat stdin as DATA, which is ordinary JSON plumbing and not
  // remote code execution. Requiring a bare interpreter keeps the rule on the
  // real attack shape.
  // A real pipeline separates the pipe from the previous word: `cmd | sh`.
  // An alternation in a usage string — `hermes completion bash|zsh|fish` — has
  // no space before the bar. Requiring the space keeps documentation out.
  rule("echo_pipe_exec", "critical", "obfuscation",
    "content piped directly into an interpreter that will execute it",
    /(?:^|\s)\|\s*(sudo\s+)?(ba|z|k)?sh\b|(?:^|\s)\|\s*(python[23]?|perl|ruby|node)\s*(?:$|[;&)]|\s+(?!-[cm]\b)-)/i,
    { capability: CAPABILITIES.SHELL, signal: SIGNALS.DYNAMIC_EXEC }),
  rule("eval_string", "high", "obfuscation",
    "eval() applied to a string literal",
    /\beval\s*\(\s*["'`]/, { signal: SIGNALS.DYNAMIC_EXEC }),
  // No space before the paren, and a closing paren on the same line: prose like
  // "avoid frequent eval (too slow)" is not a call site.
  rule("eval_dynamic", "high", "obfuscation",
    "eval() applied to a computed expression, so the executed code is not visible in the source",
    /\beval\((?!["'`]\s*\))[A-Za-z_$(][^\n]{0,120}\)/, { signal: SIGNALS.DYNAMIC_EXEC }),
  rule("exec_string", "high", "obfuscation",
    "exec() applied to a string literal",
    /\bexec\s*\(\s*["'`]/, { signal: SIGNALS.DYNAMIC_EXEC }),
  rule("exec_dynamic", "high", "obfuscation",
    "exec() applied to a computed expression, so the executed code is not visible in the source",
    /\bexec\((?!["'`]\s*\))[A-Za-z_$(][^\n]{0,120}\)/, { signal: SIGNALS.DYNAMIC_EXEC }),
  rule("js_function_constructor", "high", "obfuscation",
    "Function constructor used to build code at runtime",
    /new\s+Function\s*\(|Function\s*\(\s*["'`][^"'`]{0,120}["'`]\s*\)\s*\(/,
    { signal: SIGNALS.DYNAMIC_EXEC }),
  rule("python_compile_exec", "high", "obfuscation",
    "compile() in exec mode",
    /\bcompile\s*\([^)]{0,200},\s*["'][^"']{0,80}["']\s*,\s*["']exec["']\s*\)/i,
    { signal: SIGNALS.DYNAMIC_EXEC }),
  rule("python_getattr_builtins", "high", "obfuscation",
    "dynamic access to Python builtins, a sandbox-evasion technique",
    /getattr\s*\(\s*__builtins__|__builtins__\s*\[/),
  rule("python_import_dunder", "high", "obfuscation",
    "dynamic __import__ of a system module",
    /__import__\s*\(\s*["'](os|subprocess|socket|ctypes)["']\s*\)/i,
    { signal: SIGNALS.DYNAMIC_EXEC }),
  rule("js_base64", "medium", "obfuscation",
    "JavaScript base64 encode or decode",
    /\b(atob|btoa)\s*\(/, { signal: SIGNALS.ENCODE }),
  rule("node_buffer_base64", "medium", "obfuscation",
    "Buffer base64 conversion",
    /Buffer\.from\s*\([^)]{0,120}["']base64["']/i, { signal: SIGNALS.ENCODE }),
  rule("python_codecs_decode", "medium", "obfuscation",
    "codecs.decode, often ROT13 or hex unwrapping",
    /codecs\.decode\s*\(/i, { signal: SIGNALS.ENCODE }),
  rule("hex_encoded_string", "medium", "obfuscation",
    "chained hex escapes, a common payload wrapper",
    /(?:\\x[0-9a-f]{2}){6,}/i, { signal: SIGNALS.ENCODE }),
  rule("unicode_escape_chain", "medium", "obfuscation",
    "chained unicode escapes",
    /(?:\\u[0-9a-f]{4}){5,}/i, { signal: SIGNALS.ENCODE }),
  rule("js_char_code", "medium", "obfuscation",
    "string built from character codes",
    /String\.fromCharCode\s*\(|charCodeAt\s*\(/),
  rule("chr_building", "high", "obfuscation",
    "string built from chained chr() calls",
    /chr\s*\(\s*\d{1,3}\s*\)\s*\+\s*chr\s*\(\s*\d{1,3}/i),
  rule("string_reversal", "low", "obfuscation",
    "string reversal, sometimes used to hide a literal",
    /\[::-1\]|\.split\(["']{2}\)\.reverse\(\)/),
  rule("powershell_encoded", "critical", "obfuscation",
    "PowerShell encoded command",
    /powershell(\.exe)?\s+[^\n]{0,80}-(e|ec|enc|encodedcommand)\b/i,
    { capability: CAPABILITIES.SHELL, signal: SIGNALS.DYNAMIC_EXEC }),

  // ── Process execution ────────────────────────────────────────────────────
  rule("python_os_system", "high", "execution",
    "os.system(), an unguarded shell execution",
    /os\.system\s*\(/i, { capability: CAPABILITIES.SHELL }),
  rule("python_os_popen", "high", "execution",
    "os.popen(), a shell pipe execution",
    /os\.popen\s*\(/i, { capability: CAPABILITIES.SHELL }),
  rule("python_subprocess", "medium", "execution",
    "Python subprocess execution",
    /subprocess\.(run|call|Popen|check_output|check_call)\s*\(/i,
    { capability: CAPABILITIES.SHELL }),
  rule("node_child_process", "high", "execution",
    "Node child_process execution",
    /child_process|\b(execSync|spawnSync|execFileSync)\s*\(/i,
    { capability: CAPABILITIES.SHELL }),
  rule("java_runtime_exec", "high", "execution",
    "Java Runtime.exec()",
    /Runtime\.getRuntime\(\)\.exec\(/),
  rule("backtick_subshell", "medium", "execution",
    "command substitution inside a string",
    /`[^`\n]{0,120}\$\([^)\n]{1,120}\)[^`\n]{0,120}`/, { capability: CAPABILITIES.SHELL }),

  // ── Path traversal ───────────────────────────────────────────────────────
  rule("patmcp_traversal_deep", "high", "traversal",
    "deep relative path traversal",
    /(\.\.[\/\\]){3,}/),
  rule("patmcp_traversal", "medium", "traversal",
    "relative path traversal",
    /(\.\.[\/\\]){2}/),
  rule("system_passwd_access", "critical", "traversal",
    "references system password files",
    /\/etc\/(passwd|shadow)\b/i, { signal: SIGNALS.CREDENTIAL_READ }),
  // /proc/<pid>/environ is the process's environment verbatim — every API key
  // the process holds. Reading it is credential theft, not introspection.
  rule("proc_access", "critical", "traversal",
    "reads process environment or memory via /proc, exposing in-process secrets",
    /\/proc\/(self|\d+)\/(environ|mem)/i, { signal: SIGNALS.CREDENTIAL_READ }),
  rule("proc_cmdline_access", "medium", "traversal",
    "reads process command lines via /proc",
    /\/proc\/(self|\d+)\/cmdline/i),
  rule("dev_shm", "medium", "traversal",
    "references shared memory, a common staging area",
    /\/dev\/shm\//i),

  // ── Supply chain ─────────────────────────────────────────────────────────
  rule("curl_pipe_shell", "critical", "supply_chain",
    "curl piped straight into a shell",
    /\bcurl\s+[^\n|]{0,300}\|\s*(sudo\s+)?(ba|z|k)?sh\b/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.REMOTE_FETCH }),
  rule("wget_pipe_shell", "critical", "supply_chain",
    "wget piped straight into a shell",
    /\bwget\s+[^\n|]{0,300}\|\s*(sudo\s+)?(ba|z|k)?sh\b/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.REMOTE_FETCH }),
  // As above: only a bare interpreter executes what it is piped. `curl … |
  // python3 -m json.tool` is pretty-printing an API response.
  rule("curl_pipe_interpreter", "critical", "supply_chain",
    "remote content piped into a language interpreter that will execute it",
    /\b(curl|wget)\s+[^\n|]{0,300}\|\s*(python[23]?|perl|ruby|node)\s*(?:$|[;&)]|\s+(?!-[cm]\b)-)/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.REMOTE_FETCH }),
  // Fetching a resource and UPLOADING a body are different acts. An upload is a
  // data sink, and pairs with a credential read to form an exfiltration chain.
  rule("http_upload", "medium", "exfiltration",
    "uploads a request body to a remote host",
    /\b(curl|wget)\s+[^\n]{0,200}(-d\b|--data|-F\b|--form|-T\b|--upload-file|-X\s*(POST|PUT))/i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.NETWORK_SINK }),
  rule("remote_fetch", "medium", "supply_chain",
    "fetches a remote resource at runtime",
    /\b(curl|wget)\s+[^\n]{0,80}https?:\/\/|\b(requests\.get|httpx\.get|fetch)\s*\(\s*["']https?:\/\//i,
    { capability: CAPABILITIES.NETWORK, signal: SIGNALS.REMOTE_FETCH }),
  rule("git_clone", "medium", "supply_chain",
    "clones a git repository at runtime",
    /\bgit\s+clone\b/i, { capability: CAPABILITIES.NETWORK, signal: SIGNALS.REMOTE_FETCH }),
  rule("docker_pull_run", "medium", "supply_chain",
    "pulls or runs a container image at runtime",
    /\bdocker\s+(pull|run)\b/i, { capability: CAPABILITIES.SHELL }),
  rule("unpinned_pip_install", "medium", "supply_chain",
    "pip install without a pinned version",
    /\bpip3?\s+install\s+(?!-r\s)(?![^\n]{0,120}==)/i, { capability: CAPABILITIES.SHELL }),
  rule("unpinned_npm_install", "medium", "supply_chain",
    "npm install without a pinned version",
    /\bnpm\s+(install|i|add)\s+(?![^\n]{0,120}@\d)(?!$)/i, { capability: CAPABILITIES.SHELL }),
  rule("npm_lifecycle_script", "high", "supply_chain",
    "package lifecycle hook, which runs on install",
    /"(preinstall|postinstall|prepare)"\s*:/),
  rule("pep723_inline_deps", "low", "supply_chain",
    "PEP 723 inline dependency metadata; verify pinning",
    /#\s*\/\/\/\s*script/),
  rule("uv_run", "low", "supply_chain",
    "uv run, which may resolve and install dependencies implicitly",
    /\buv\s+run\b/i, { capability: CAPABILITIES.SHELL }),

  // ── Privilege escalation ─────────────────────────────────────────────────
  // Bare sudo is informational: package installs dominate real corpora. The
  // genuinely dangerous sudo shapes are covered by their own critical rules
  // (sudo rm -rf, chmod +s, NOPASSWD, sudo curl|sh).
  rule("sudo_usage", "low", "privilege_escalation",
    "invokes sudo",
    /\bsudo\s+\S/i, { capability: CAPABILITIES.SHELL }),
  rule("sudo_destructive", "critical", "privilege_escalation",
    "sudo combined with a destructive or code-fetching operation",
    /\bsudo\s+(rm\b|dd\b|mkfs|chown\s+-R\s+\/|chmod\s+-R\s+777|curl|wget)/i,
    { capability: CAPABILITIES.SHELL }),
  rule("nopasswd_sudo", "critical", "privilege_escalation",
    "passwordless sudoers entry",
    /\bNOPASSWD\b/),
  // `--disable-setuid-sandbox` is a Chromium launch flag that REMOVES a
  // privilege mechanism, so it must not read as privilege escalation.
  rule("setuid_setgid", "critical", "privilege_escalation",
    "setuid or setgid privilege mechanism",
    /\b(setuid|setgid|cap_setuid)\b(?!-sandbox)/i),
  rule("suid_bit", "critical", "privilege_escalation",
    "sets the SUID or SGID bit",
    /\bchmod\s+[ug]?\+s\b|\bchmod\s+[24]\d{3}\b/i),

  // ── Credential exposure inside the package itself ────────────────────────
  rule("embedded_private_key", "critical", "credential_exposure",
    "embedded private key",
    /-----BEGIN\s+([A-Z]+\s+)?PRIVATE\s+KEY-----/),
  rule("github_token_leaked", "critical", "credential_exposure",
    "GitHub token embedded in the package",
    /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/),
  rule("openai_key_leaked", "critical", "credential_exposure",
    "OpenAI-style API key embedded in the package",
    /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/),
  rule("anthropic_key_leaked", "critical", "credential_exposure",
    "Anthropic API key embedded in the package",
    /\bsk-ant-[A-Za-z0-9_-]{24,}/),
  rule("aws_access_key_leaked", "critical", "credential_exposure",
    "AWS access key id embedded in the package",
    /\b(AKIA|ASIA)[0-9A-Z]{16}\b/),
  rule("slack_token_leaked", "critical", "credential_exposure",
    "Slack token embedded in the package",
    /\bxox[abposr]-[A-Za-z0-9-]{10,}/),
  rule("google_key_leaked", "critical", "credential_exposure",
    "Google API key embedded in the package",
    /\bAIza[0-9A-Za-z_-]{35}\b/),
  rule("discord_token_leaked", "critical", "credential_exposure",
    "Discord bot token embedded in the package",
    /\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/),
  rule("hardcoded_secret", "high", "credential_exposure",
    "possible hardcoded credential assignment",
    /\b(api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|password)\b\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}["']/i),

  // ── Cryptocurrency mining ────────────────────────────────────────────────
  rule("crypto_mining", "critical", "mining",
    "cryptocurrency mining payload",
    /\b(xmrig|stratum\+tcp|cryptonight|coinhive|minerd|nicehash)\b/i),
  rule("wallet_file_access", "critical", "exfiltration",
    "reads a cryptocurrency wallet file",
    /\b(wallet\.dat|id_rsa|keystore\.json|\.electrum)\b/i, { signal: SIGNALS.CREDENTIAL_READ })
]);

// Correlation rules: signal sets that compose into a higher-order finding.
const CHAIN_RULES = Object.freeze([
  Object.freeze({
    id: "chain_credential_exfiltration",
    severity: "critical",
    category: "exfiltration",
    requires: [SIGNALS.CREDENTIAL_READ, SIGNALS.NETWORK_SINK],
    description:
      "reads credential material and sends data to the network in the same file"
  }),
  Object.freeze({
    id: "chain_remote_code_execution",
    severity: "critical",
    category: "supply_chain",
    requires: [SIGNALS.REMOTE_FETCH, SIGNALS.DYNAMIC_EXEC],
    description:
      "fetches remote content and evaluates code dynamically in the same file"
  }),
  Object.freeze({
    id: "chain_encoded_exfiltration",
    severity: "high",
    category: "exfiltration",
    requires: [SIGNALS.CREDENTIAL_READ, SIGNALS.ENCODE],
    description:
      "reads credential material and encodes it in the same file, hiding the payload"
  }),
  Object.freeze({
    id: "chain_encoded_execution",
    severity: "high",
    category: "obfuscation",
    requires: [SIGNALS.ENCODE, SIGNALS.DYNAMIC_EXEC],
    description:
      "decodes content and evaluates it dynamically in the same file"
  })
]);

// Tool-name fragments that grant a capability. Imported skills declare an
// explicit allowed_tools array, so content requiring a capability the manifest
// never declared is a mismatch worth surfacing.
const CAPABILITY_TOOL_HINTS = Object.freeze({
  [CAPABILITIES.SHELL]: ["shell", "bash", "exec", "command", "terminal", "process", "run"],
  [CAPABILITIES.NETWORK]: ["http", "fetch", "web", "browser", "net", "url", "request", "download", "search"],
  [CAPABILITIES.FILESYSTEM_WRITE]: ["write", "edit", "patch", "file", "fs", "apply"]
});

// Rules whose match depends on a `|` character, and which therefore must be
// suppressed inside markdown table rows.
const PIPE_DEPENDENT_RULES = new Set([
  "echo_pipe_exec",
  "curl_pipe_shell",
  "wget_pipe_shell",
  "curl_pipe_interpreter",
  "base64_decode_pipe",
  "dump_all_env"
]);

const RULES_DIGEST = createHash("sha256")
  .update(THREAT_SCANNER_VERSION)
  .update(JSON.stringify(THREAT_RULES.map((item) => [
    item.id, item.severity, item.category, String(item.pattern), item.capability, item.signal
  ])))
  .update(JSON.stringify(CHAIN_RULES.map((item) => [item.id, item.severity, item.requires])))
  .digest("hex");

export const THREAT_RULES_DIGEST = RULES_DIGEST;

// A credential sent to the vendor that ISSUED it is that credential's intended
// use: TENOR_API_KEY going to tenor.googleapis.com is how the Tenor API is
// called. Exfiltration is a secret going somewhere with no relationship to it.
// Correlating the variable's vendor prefix against the destination host
// separates the two without needing an allowlist of "good" domains.
const GENERIC_SECRET_WORDS = new Set([
  "api", "key", "token", "secret", "access", "auth", "private", "public",
  "client", "app", "user", "id", "prod", "dev", "test", "my", "the"
]);

const VENDOR_ALIASES = new Map(Object.entries({
  gh: "github", github: "github", openai: "openai", anthropic: "anthropic",
  claude: "anthropic", aws: "amazonaws", gcp: "googleapis", google: "googleapis",
  hf: "huggingface", huggingface: "huggingface", tenor: "tenor",
  notion: "notion", slack: "slack", discord: "discord", stripe: "stripe",
  linear: "linear", airtable: "airtable", telegram: "telegram",
  spotify: "spotify", cloudflare: "cloudflare", openrouter: "openrouter",
  groq: "groq", replicate: "replicate", modal: "modal", wandb: "wandb",
  xai: "x", twitter: "twitter", x: "x"
}));

// True when the line sends a secret to a host plausibly owned by the same
// vendor named in the secret's variable.
function secretMatchesDestination(line) {
  const secretNames = line.match(/[A-Z][A-Z0-9]{1,20}(?:_[A-Z0-9]+)*_(?:API_)?(?:KEY|TOKEN|SECRET)/g);
  if (!secretNames) return false;
  const hosts = line.match(/https?:\/\/([A-Za-z0-9.-]{3,120})/g);
  if (!hosts) return false;
  const hostText = hosts.join(" ").toLowerCase();
  for (const name of secretNames) {
    for (const part of name.toLowerCase().split("_")) {
      // Generic words carry no vendor identity. Matching them would let any
      // host containing "api" (e.g. googleapis.com) absorb any secret — the
      // suppression must key on the vendor, never on boilerplate.
      if (GENERIC_SECRET_WORDS.has(part)) continue;
      const vendor = VENDOR_ALIASES.get(part);
      // Only a known vendor token can authorize the suppression. An unknown
      // fragment is not evidence of ownership, so it fails closed.
      if (vendor && hostText.includes(vendor)) return true;
    }
  }
  return false;
}

// Rules that describe a secret leaving the machine, and which are therefore
// suppressed when the destination host belongs to the secret's own vendor.
const VENDOR_AWARE_RULES = new Set([
  "env_exfil_curl",
  "env_exfil_wget",
  "env_exfil_fetch",
  "env_exfil_httpx",
  "env_exfil_requests"
]);

function foldConfusables(text) {
  let out = "";
  for (const char of text) {
    if (INVISIBLE_CHARS.has(char)) continue;
    out += CONFUSABLES.get(char) ?? char;
  }
  return out.normalize("NFKC");
}

function redact(text) {
  return text
    .replace(/\b(sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abposr]-|AIza|AKIA|ASIA)[A-Za-z0-9_-]{4,}/g,
      (match, prefix) => `${prefix}\u2026REDACTED`)
    .replace(/(-----BEGIN\s+(?:[A-Z]+\s+)?PRIVATE\s+KEY-----)[\s\S]*/,
      "$1\u2026REDACTED")
    .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*["'])[^"']{8,}/gi,
      "$1\u2026REDACTED");
}

function evidence(line) {
  const collapsed = redact(line.trim()).replace(/\s+/g, " ");
  return collapsed.length > MAX_EVIDENCE_LENGTH
    ? `${collapsed.slice(0, MAX_EVIDENCE_LENGTH - 1)}\u2026`
    : collapsed;
}

function escalate(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index <= 0 ? "critical" : SEVERITY_ORDER[index - 1];
}

function normalizeFileEntries(files) {
  if (!Array.isArray(files)) throw new TypeError("scanSkillPackage requires a file array.");
  return files.map((file) => {
    const filePath = String(file?.path ?? "");
    if (!filePath) throw new TypeError("Every scanned file requires a path.");
    const content = Buffer.isBuffer(file?.content)
      ? file.content
      : Buffer.from(String(file?.content ?? ""), "utf8");
    return { path: filePath, content };
  });
}

function declaredCapabilities(allowedTools) {
  const tools = Array.isArray(allowedTools)
    ? allowedTools.map((tool) => String(tool).toLowerCase())
    : [];
  const granted = new Set();
  for (const [capability, hints] of Object.entries(CAPABILITY_TOOL_HINTS)) {
    if (tools.some((tool) => hints.some((hint) => tool.includes(hint)))) {
      granted.add(capability);
    }
  }
  return granted;
}

function extensionOf(filePath) {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

// A markdown table row is a sequence of `|`-delimited cells, not a shell
// pipeline. `| bash | zsh | fish |` and `| Bash commands | file tools |` are
// documentation; treating their pipes as execution produced the single largest
// false-positive class on a real skill corpus. A row must both start with `|`
// and carry two or more of them to qualify.
function isMarkdownTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  return (trimmed.match(/\|/g) ?? []).length >= 2;
}

function scanLine({ rawLine, foldedLine, filePath, lineNumber, findings, signals }) {
  const raw = rawLine.length > MAX_LINE_SCAN_LENGTH
    ? rawLine.slice(0, MAX_LINE_SCAN_LENGTH)
    : rawLine;
  const folded = foldedLine.length > MAX_LINE_SCAN_LENGTH
    ? foldedLine.slice(0, MAX_LINE_SCAN_LENGTH)
    : foldedLine;
  const foldedDiffers = folded !== raw;

  const tableRow = isMarkdownTableRow(raw);
  const vendorMatched = secretMatchesDestination(raw);

  for (const item of THREAT_RULES) {
    if (findings.length >= MAX_FINDINGS) return;
    // Pipe-driven execution rules cannot fire inside a markdown table row.
    if (tableRow && PIPE_DEPENDENT_RULES.has(item.id)) continue;
    // A secret sent to its own issuing vendor is authentication, not exfil.
    if (vendorMatched && VENDOR_AWARE_RULES.has(item.id)) continue;
    const matchedRaw = item.pattern.test(raw);
    const matchedFolded = !matchedRaw && foldedDiffers && item.pattern.test(folded);
    if (!matchedRaw && !matchedFolded) continue;

    // A rule that only fires after defanging means the author hid the payload
    // behind confusable or invisible characters. That is not an accident.
    const severity = matchedFolded ? escalate(item.severity) : item.severity;
    findings.push({
      ruleId: item.id,
      severity,
      category: item.category,
      path: filePath,
      line: lineNumber,
      evidence: evidence(matchedFolded ? folded : raw),
      description: matchedFolded
        ? `${item.description} (obfuscated with confusable or invisible characters)`
        : item.description,
      capability: item.capability,
      obfuscated: matchedFolded
    });
    if (item.signal) signals.add(item.signal);
  }
}

function scanTextFile({ filePath, text, findings, signals }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const limit = Math.min(lines.length, MAX_SCAN_LINES_PER_FILE);
  for (let index = 0; index < limit; index += 1) {
    if (findings.length >= MAX_FINDINGS) break;
    const rawLine = lines[index];
    const lineNumber = index + 1;
    const folded = foldConfusables(rawLine);

    for (const [char, label] of INVISIBLE_CHARS) {
      if (!rawLine.includes(char)) continue;
      // A BOM at the very start of a file is an encoding marker, not hidden
      // text — XML and XSD documents ship one routinely.
      if (char === "\ufeff" && lineNumber === 1 && rawLine.startsWith(char)
        && !rawLine.slice(1).includes(char)) {
        continue;
      }
      // Soft hyphen is legitimate typography in prose and PDF-derived text;
      // it is noted but does not drive a verdict on its own.
      const severity = BIDI_CONTROL_CHARS.has(char)
        ? "critical"
        : (char === "\u00ad" ? "low" : "high");
      findings.push({
        ruleId: BIDI_CONTROL_CHARS.has(char) ? "bidi_control_char" : "invisible_char",
        severity,
        category: "injection",
        path: filePath,
        line: lineNumber,
        evidence: `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} (${label})`,
        description: BIDI_CONTROL_CHARS.has(char)
          ? `bidirectional control character ${label} can reorder text so a reviewer sees different content than the agent`
          : `invisible character ${label} hides content from human review`,
        capability: null,
        obfuscated: true
      });
      break;
    }

    scanLine({ rawLine, foldedLine: folded, filePath, lineNumber, findings, signals });
  }

  if (lines.length > MAX_SCAN_LINES_PER_FILE) {
    findings.push({
      ruleId: "scan_truncated",
      severity: "medium",
      category: "structural",
      path: filePath,
      line: MAX_SCAN_LINES_PER_FILE,
      evidence: `${lines.length} lines`,
      description: `file exceeds ${MAX_SCAN_LINES_PER_FILE} lines; the remainder was not scanned`,
      capability: null,
      obfuscated: false
    });
  }
}

function verdictFor(findings) {
  let verdict = THREAT_VERDICTS.SAFE;
  for (const finding of findings) {
    if (finding.severity === "critical") return THREAT_VERDICTS.DANGEROUS;
    if (finding.severity === "high") verdict = THREAT_VERDICTS.CAUTION;
  }
  return verdict;
}

/**
 * Scan an in-memory skill package.
 *
 * @param {Array<{path: string, content: Buffer|string}>} files
 * @param {{allowedTools?: string[], skillName?: string}} [options]
 * @returns {object} deterministic scan result
 */
export function scanSkillPackage(files, options = {}) {
  const entries = normalizeFileEntries(files);
  const granted = declaredCapabilities(options.allowedTools);
  const findings = [];
  const capabilitiesUsed = new Set();

  for (const entry of entries) {
    const fileFindings = [];
    const signals = new Set();
    const extension = extensionOf(entry.path);

    if (BINARY_EXTENSIONS.has(extension)) {
      fileFindings.push({
        ruleId: "binary_artifact",
        severity: "critical",
        category: "structural",
        path: entry.path,
        line: 0,
        evidence: extension,
        description: `binary artifact (${extension}) cannot be reviewed and does not belong in a skill package`,
        capability: null,
        obfuscated: false
      });
    } else if (entry.content.length > MAX_SCAN_BYTES_PER_FILE) {
      fileFindings.push({
        ruleId: "oversized_file",
        severity: "medium",
        category: "structural",
        path: entry.path,
        line: 0,
        evidence: `${entry.content.length} bytes`,
        description: `file exceeds ${MAX_SCAN_BYTES_PER_FILE} bytes and was not scanned`,
        capability: null,
        obfuscated: false
      });
    } else {
      const text = entry.content.toString("utf8");
      const roundTrips = Buffer.compare(Buffer.from(text, "utf8"), entry.content) === 0;
      if (!roundTrips) {
        fileFindings.push({
          ruleId: "non_utf8_content",
          severity: "high",
          category: "structural",
          path: entry.path,
          line: 0,
          evidence: `${entry.content.length} bytes`,
          description: "file is not valid UTF-8 text and cannot be reviewed as source",
          capability: null,
          obfuscated: false
        });
      }
      scanTextFile({ filePath: entry.path, text, findings: fileFindings, signals });
    }

    for (const finding of fileFindings) {
      if (finding.capability) capabilitiesUsed.add(finding.capability);
    }

    for (const chain of CHAIN_RULES) {
      if (!chain.requires.every((signal) => signals.has(signal))) continue;
      fileFindings.push({
        ruleId: chain.id,
        severity: chain.severity,
        category: chain.category,
        path: entry.path,
        line: 0,
        evidence: chain.requires.join(" + "),
        description: chain.description,
        capability: null,
        obfuscated: false
      });
    }

    findings.push(...fileFindings);
  }

  // Reconciliation is only meaningful against an actual declaration. A package
  // with no declared tools at all is a manifest problem the import store
  // already rejects, not a per-capability mismatch to enumerate here.
  const hasDeclaration = Array.isArray(options.allowedTools)
    && options.allowedTools.length > 0;
  for (const capability of hasDeclaration ? capabilitiesUsed : []) {
    if (granted.has(capability)) continue;
    findings.push({
      ruleId: "undeclared_capability",
      severity: "high",
      category: "capability",
      path: "SKILL.md",
      line: 0,
      evidence: capability,
      description: `content requires the '${capability}' capability but allowed_tools declares no tool that grants it`,
      capability,
      obfuscated: false
    });
  }

  findings.sort((left, right) => (
    SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]
    || left.path.localeCompare(right.path)
    || left.line - right.line
    || left.ruleId.localeCompare(right.ruleId)
  ));

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;

  const verdict = verdictFor(findings);
  return {
    scannerVersion: THREAT_SCANNER_VERSION,
    rulesDigest: RULES_DIGEST,
    ruleCount: THREAT_RULES.length + CHAIN_RULES.length,
    verdict,
    counts,
    findingCount: findings.length,
    truncated: findings.length >= MAX_FINDINGS,
    capabilities: {
      declared: [...granted].sort(),
      required: [...capabilitiesUsed].sort(),
      undeclared: [...capabilitiesUsed].filter((item) => !granted.has(item)).sort()
    },
    findings
  };
}

/**
 * Canonical digest binding a verdict to the exact content that produced it.
 * An operator acknowledgement quotes this digest, so acknowledging one package
 * can never silently approve a different one.
 */
export function scanAcknowledgementDigest(scan, sourceHash) {
  return createHash("sha256")
    .update(THREAT_SCANNER_VERSION)
    .update("\u0000")
    .update(RULES_DIGEST)
    .update("\u0000")
    .update(String(sourceHash ?? ""))
    .update("\u0000")
    .update(String(scan?.verdict ?? ""))
    .update("\u0000")
    .update(JSON.stringify((scan?.findings ?? []).map((finding) => [
      finding.ruleId, finding.severity, finding.path, finding.line
    ])))
    .digest("hex");
}

export function compareVerdicts(left, right) {
  return (VERDICT_RANK[left] ?? 0) - (VERDICT_RANK[right] ?? 0);
}

export function summarizeScan(scan) {
  if (!scan) return "not scanned";
  if (scan.findingCount === 0) {
    return `${scan.verdict}: no findings across ${scan.ruleCount} rules`;
  }
  const parts = SEVERITY_ORDER
    .filter((severity) => scan.counts[severity] > 0)
    .map((severity) => `${scan.counts[severity]} ${severity}`);
  const top = scan.findings
    .slice(0, 3)
    .map((finding) => `${finding.ruleId}@${finding.path}:${finding.line}`)
    .join(", ");
  return `${scan.verdict}: ${parts.join(", ")} — ${top}`;
}
