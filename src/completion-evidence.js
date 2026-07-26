const CONTRACT_VERSION = 1;
const MAX_NUDGES = 1;

const CHANGE_VERB_RE = /\b(?:add|build|change|convert|create|delete|deploy|edit|fix|implement|install|integrate|make|migrate|modify|optimi[sz]e|patch|refactor|remove|repair|replace|rewrite|speed\s+up|update|upgrade|wire)\b/iu;
const STRONG_CHANGE_VERB_RE = /\b(?:build|deploy|edit|fix|implement|migrate|patch|refactor|repair|rewrite)\b/iu;
const CODE_TARGET_RE = /\b(?:api|app|application|branch|bug|button|class|cli|code|component|config(?:uration)?|css|dashboard|endpoint|error|feature|file|function|handler|harness|html|implementation|integration|issue|javascript|logging|logs?|module|node|page|project|provider|repo(?:sitory)?|route|script|server|skill|source|stylesheet|tool|typescript|ui|website|workflow)\b/iu;
const UI_TARGET_RE = /\b(?:button|canvas|component|control|css|dashboard|dialog|form|html|layout|menu|modal|page|screen|screenshot|tab|ui|visual|website)\b/iu;
const VERIFY_VERB_RE = /\b(?:audit|check|diagnose|lint|qa|run\s+(?:the\s+)?tests?|test|validate|verify)\b/iu;
const CODE_CHECK_RE = /\b(?:lint|lsp\s+diagnostics?|qa|run\s+(?:the\s+)?tests?|test\s+(?:lane|suite))\b/iu;
const EXPLANATION_ONLY_RE = /^\s*(?:(?:can|could|would)\s+you\s+)?(?:analy[sz]e|compare|describe|design|document|explain|inspect|plan|recommend|research|review|summari[sz]e|tell|what|why|how)\b/iu;
const COMPLETION_CLAIM_RE = /\b(?:added|all\s+green|built|changed|complete(?:d)?|created|deleted|deployed|done|finished|fixed|implemented|installed|integrated|made\s+the\s+(?:changes?|fix|update)|migrated|modified|now\s+working|optimi[sz]ed|patched|refactored|removed|repaired|resolved|rewrote|tests?\s+(?:all\s+)?pass(?:ed|ing)?|updated|upgraded|verified|wrote)\b/iu;
const NEGATED_COMPLETION_RE = /\b(?:can\s+not|cannot|can't|could\s+not|couldn't|did\s+not|didn't|failed\s+to|have\s+not|haven't|no\s+changes?\s+(?:were\s+)?made|no\s+files?\s+(?:were\s+)?(?:changed|modified|written)|not\s+(?:been\s+)?(?:able|complete|completed|done|fixed|implemented|verified)|nothing\s+changed|unable)\b/iu;
const VERIFY_TOOL_RE = /^(?:code_(?:lint|test|verify)|lsp_diagnostics|qa_run)$/u;
const MUTATION_EXCLUSION_RE = /^(?:code_lint|code_test|code_verify|lsp_diagnostics|qa_(?:artifact|run|status))$/u;
const PROJECT_MUTATION_TOOL_RE = /^(?:code_(?:edit|write)|coder_apply|write_file)$/u;
const VISUAL_TOOL_RE = /^qa_run$/u;

export function createCompletionContract(value, options = {}) {
  const text = String(value ?? "").trim();
  const channel = String(options.channel ?? "chat").trim().toLowerCase();
  if (
    !text
    || ["autopilot", "cron"].includes(channel)
    || options.referenceOnly === true
  ) {
    return null;
  }

  const hasChange = CHANGE_VERB_RE.test(text)
    && (STRONG_CHANGE_VERB_RE.test(text) || CODE_TARGET_RE.test(text));
  const verificationVerb = VERIFY_VERB_RE.test(text);
  const hasVerification = verificationVerb
    && (
      CODE_TARGET_RE.test(text)
      || UI_TARGET_RE.test(text)
      || CODE_CHECK_RE.test(text)
    );
  if (!hasChange && !hasVerification) return null;
  if (!hasChange && EXPLANATION_ONLY_RE.test(text) && !hasVerification) return null;

  const visualTarget = UI_TARGET_RE.test(text);
  const visual = hasChange && visualTarget;
  const kind = visual
    ? "ui-change"
    : hasChange
      ? "code-change"
      : visualTarget
        ? "ui-verification"
        : "verification";
  const requirements = hasChange
    ? visual
      ? ["mutation", "verification", "visual"]
      : ["mutation", "verification"]
    : visualTarget
      ? ["verification", "visual"]
      : ["verification"];

  return Object.freeze({
    version: CONTRACT_VERSION,
    kind,
    requirements: Object.freeze(requirements),
    maxNudges: MAX_NUDGES
  });
}

export function completionToolPreferences(contract) {
  if (!validContract(contract)) return Object.freeze([]);
  if (contract.kind === "ui-change") {
    return Object.freeze([
      "coder_start",
      "coder_apply",
      "coder_status",
      "code_verify",
      "qa_run",
      "qa_status"
    ]);
  }
  if (contract.kind === "ui-verification") {
    return Object.freeze([
      "qa_run",
      "qa_status",
      "qa_artifact"
    ]);
  }
  if (contract.kind === "code-change") {
    return Object.freeze([
      "coder_start",
      "coder_apply",
      "coder_status",
      "code_verify"
    ]);
  }
  return Object.freeze([
    "code_verify",
    "code_test",
    "code_lint"
  ]);
}

export function assessCompletionEvidence(
  contract,
  toolCalls = [],
  _toolRegistry = null,
  options = {}
) {
  if (!validContract(contract)) return null;
  let mutations = 0;
  let verifications = 0;
  let visuals = 0;

  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const name = safeToolName(call?.name);
    const invocation = call?.result;
    if (!name || !successfulInvocation(invocation)) continue;
    const result = invocation?.result;
    const outcome = invocation?.outcome;
    const verification = verificationPassed(name, result, outcome);
    const visual = (VISUAL_TOOL_RE.test(name) && verification)
      || (name === "coder_apply" && structuredVisualPassed(result));
    const mutation = projectMutationPassed(name, outcome);

    if (mutation) mutations += 1;
    if (verification) verifications += 1;
    if (visual) visuals += 1;
  }

  const available = {
    mutation: mutations > 0,
    verification: verifications > 0,
    visual: visuals > 0
  };
  const missing = contract.requirements.filter((name) => !available[name]);
  const nudges = boundedNudges(options.nudges);
  return Object.freeze({
    version: CONTRACT_VERSION,
    required: true,
    kind: contract.kind,
    status: missing.length === 0 ? "verified" : "incomplete",
    missing: Object.freeze(missing),
    mutationCount: mutations,
    verificationCount: verifications,
    visualCount: visuals,
    nudges
  });
}

function projectMutationPassed(name, outcome) {
  if (
    MUTATION_EXCLUSION_RE.test(name)
    || outcome?.changed !== true
  ) {
    return false;
  }
  return PROJECT_MUTATION_TOOL_RE.test(name);
}

export function completionEvidenceDecision({
  contract,
  toolCalls = [],
  toolRegistry = null,
  assistantText = "",
  nudges = 0,
  canContinue = true
} = {}) {
  const report = assessCompletionEvidence(
    contract,
    toolCalls,
    toolRegistry,
    { nudges }
  );
  if (!report) {
    return Object.freeze({
      report: null,
      claimsCompletion: false,
      continue: false
    });
  }
  const claimsCompletion = assistantClaimsCompletion(assistantText);
  const continueTurn = Boolean(
    report.status !== "verified"
    && claimsCompletion
    && canContinue
    && report.nudges < contract.maxNudges
  );
  return Object.freeze({
    report,
    claimsCompletion,
    continue: continueTurn
  });
}

export function completionEvidenceNudge(report) {
  const missing = requirementLabels(report?.missing);
  return [
    "[completion-evidence]",
    "Do not claim completion yet.",
    `This request still needs ${missing}.`,
    "Use the appropriate project tools now and rely only on successful semantic receipts.",
    "A failed, blocked, pending, or unverified call is not evidence.",
    "If the required authority or capability is unavailable, say so clearly instead of claiming success.",
    "[/completion-evidence]"
  ].join(" ");
}

export function appendCompletionEvidenceWarning(text, report) {
  const value = String(text ?? "").trim();
  if (!report || report.status !== "incomplete") return value;
  const warning = `Completion evidence: incomplete - missing ${requirementLabels(report.missing)}.`;
  if (!value) return warning;
  if (value.includes("Completion evidence: incomplete")) return value;
  return `${value}\n\n${warning}`;
}

export function assistantClaimsCompletion(value) {
  const text = String(value ?? "");
  return COMPLETION_CLAIM_RE.test(text) && !NEGATED_COMPLETION_RE.test(text);
}

function successfulInvocation(invocation) {
  if (!invocation || invocation.ok !== true) return false;
  const status = String(invocation.outcome?.status ?? "succeeded")
    .trim()
    .toLowerCase();
  return status === "succeeded";
}

function verificationPassed(name, result, outcome) {
  const structured = name === "coder_apply"
    && hasStructuredVerification(result);
  if (!VERIFY_TOOL_RE.test(name) && !structured) {
    return false;
  }
  if (outcome?.verification?.status === "passed") return true;
  return passedResult(result);
}

function hasStructuredVerification(result) {
  return Boolean(
    result
    && typeof result === "object"
    && !Array.isArray(result)
    && (
      result.verification
      || result.acceptance
      || result.run?.verification
      || result.run?.acceptance
    )
  );
}

function passedResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result === true;
  }
  if (result.ok === false || result.success === false || result.error) return false;
  if (result.run?.verification || result.run?.acceptance) {
    return (
      nestedPassed(result.run?.verification)
      && nestedPassed(result.run?.acceptance)
      && String(result.run?.state ?? "").trim().toLowerCase() === "passed"
    );
  }
  if (result.verification && !nestedPassed(result.verification)) return false;
  if (result.acceptance && !nestedPassed(result.acceptance)) return false;
  if (Array.isArray(result.results) && result.results.length > 0) {
    const resultsPassed = result.results.every((item) => (
      item?.ok === true
      || ["ok", "passed", "success", "succeeded"].includes(
        String(item?.status ?? "").trim().toLowerCase()
      )
    ));
    if (!resultsPassed) return false;
  }
  const status = String(result.status ?? "").trim().toLowerCase();
  if (["failed", "failure", "blocked", "cancelled", "pending"].includes(status)) {
    return false;
  }
  if (["ok", "passed", "success", "succeeded", "complete", "completed"].includes(status)) {
    return true;
  }
  if (result.ok === true || result.success === true) return true;
  if (nestedPassed(result.verification)) return true;
  if (nestedPassed(result.acceptance)) return true;
  if (Array.isArray(result.results) && result.results.length > 0) {
    return true;
  }
  return false;
}

function structuredVisualPassed(result) {
  const run = result?.run;
  if (
    !run
    || String(run.state ?? "").trim().toLowerCase() !== "passed"
    || !nestedPassed(run.acceptance)
    || !nestedPassed(run.verification)
  ) {
    return false;
  }
  const results = Array.isArray(run.verification?.results)
    ? run.verification.results
    : [];
  return results.some((item) => (
    item?.type === "qa"
    && item?.ok === true
    && item?.evidence?.browserPassed === true
    && item?.evidence?.visualPassed === true
  ));
}

function nestedPassed(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.ok === false || value.passed === false || value.error) return false;
  const status = String(value.status ?? "").trim().toLowerCase();
  return value.ok === true
    || value.passed === true
    || ["ok", "passed", "success", "succeeded", "complete", "completed"].includes(status);
}

function safeToolName(value) {
  const name = String(value ?? "").trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name) ? name : null;
}

function validContract(value) {
  return Boolean(
    value
    && value.version === CONTRACT_VERSION
    && ["code-change", "ui-change", "ui-verification", "verification"].includes(value.kind)
    && Array.isArray(value.requirements)
    && value.requirements.length > 0
    && value.requirements.every((name) => (
      ["mutation", "verification", "visual"].includes(name)
    ))
    && Number.isInteger(value.maxNudges)
    && value.maxNudges >= 0
    && value.maxNudges <= MAX_NUDGES
  );
}

function requirementLabels(value) {
  const labels = {
    mutation: "a successful project change",
    verification: "passing verification",
    visual: "passing browser and visual QA"
  };
  const names = Array.isArray(value) ? value : [];
  const rendered = names.map((name) => labels[name]).filter(Boolean);
  if (rendered.length === 0) return "the required evidence";
  if (rendered.length === 1) return rendered[0];
  if (rendered.length === 2) return `${rendered[0]} and ${rendered[1]}`;
  return `${rendered.slice(0, -1).join(", ")}, and ${rendered.at(-1)}`;
}

function boundedNudges(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return 0;
  return Math.min(number, MAX_NUDGES);
}
