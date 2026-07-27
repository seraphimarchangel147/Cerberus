def _state_file() -> Path:
    return get_hermes_home() / "skills" / ".curator_state"


def _default_state() -> Dict[str, Any]:
    return {
        "last_run_at": None,
        "last_run_duration_seconds": None,
        "last_run_summary": None,
        "last_run_summary_shown_at": None,
        "last_report_path": None,
        "paused": False,
        "run_count": 0,
    }


def load_state() -> Dict[str, Any]:
    path = _state_file()
    if not path.exists():
        return _default_state()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            base = _default_state()
            base.update({k: v for k, v in data.items() if k in base or k.startswith("_")})
            return base
    except (OSError, json.JSONDecodeError) as e:
        logger.debug("Failed to read curator state: %s", e)
    return _default_state()


def save_state(data: Dict[str, Any]) -> None:
    path = _state_file()
    try:
        atomic_json_write(path, data, indent=2, sort_keys=True)
    except Exception as e:
        logger.debug("Failed to save curator state: %s", e, exc_info=True)


def set_paused(paused: bool) -> None:
    state = load_state()
    state["paused"] = bool(paused)
    save_state(state)


def is_paused() -> bool:
    return bool(load_state().get("paused"))


# ---------------------------------------------------------------------------
# Config access
# ---------------------------------------------------------------------------

def _load_config() -> Dict[str, Any]:
    """Read curator.* config from ~/.hermes/config.yaml. Tolerates missing file."""
    try:
        from hermes_cli.config import load_config
        cfg = load_config()
    except Exception as e:
        logger.debug("Failed to load config for curator: %s", e)
        return {}
    if not isinstance(cfg, dict):
        return {}
    cur = cfg.get("curator") or {}
    if not isinstance(cur, dict):
        return {}
    return cur


def is_enabled() -> bool:
    """Default ON when no config says otherwise."""
    cfg = _load_config()
    return bool(cfg.get("enabled", True))


def get_interval_hours() -> int:
    cfg = _load_config()
    try:
        return int(cfg.get("interval_hours", DEFAULT_INTERVAL_HOURS))
    except (TypeError, ValueError):
        return DEFAULT_INTERVAL_HOURS


def get_min_idle_hours() -> float:
    cfg = _load_config()
    try:
        return float(cfg.get("min_idle_hours", DEFAULT_MIN_IDLE_HOURS))
    except (TypeError, ValueError):
        return DEFAULT_MIN_IDLE_HOURS


def get_stale_after_days() -> int:
    cfg = _load_config()
    try:
        return int(cfg.get("stale_after_days", DEFAULT_STALE_AFTER_DAYS))
    except (TypeError, ValueError):
        return DEFAULT_STALE_AFTER_DAYS


def get_archive_after_days() -> int:
    cfg = _load_config()
    try:
        return int(cfg.get("archive_after_days", DEFAULT_ARCHIVE_AFTER_DAYS))
    except (TypeError, ValueError):
        return DEFAULT_ARCHIVE_AFTER_DAYS


def get_prune_builtins() -> bool:
    """Whether the curator may prune (archive) bundled built-in skills too.

    ON by default. When on, built-ins become curation candidates and are
    archived after the same inactivity period as agent-created skills, with a
    suppression list keeping them archived across `hermes update` re-seeds.
    Hub-installed skills are never pruned regardless of this flag.
    """
    cfg = _load_config()
    return bool(cfg.get("prune_builtins", True))


def get_consolidate() -> bool:
    """Whether the curator runs its LLM consolidation (umbrella-building) pass.

    OFF by default. When off, a curator run does ONLY the deterministic
    inactivity prune (mark stale / archive long-unused skills) and skips the
    forked aux-model review entirely — no consolidation, no umbrella-building,
    no aux-model cost. Set ``curator.consolidate: true`` to opt back into the
    LLM pass that merges overlapping skills into class-level umbrellas.

    The explicit ``hermes curator run --consolidate`` flag overrides this for
    a single invocation regardless of the config value.
    """
    cfg = _load_config()
    return bool(cfg.get("consolidate", DEFAULT_CONSOLIDATE))


# ---------------------------------------------------------------------------
# Idle / interval check
# ---------------------------------------------------------------------------

def _parse_iso(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return None


def should_run_now(now: Optional[datetime] = None) -> bool:
    """Return True if the curator should run immediately.

    Gates:
      - curator.enabled == True
      - not paused
      - last_run_at present AND older than interval_hours

    First-run behavior: when there is no ``last_run_at`` (fresh install, or
    install that predates the curator), we DO NOT run immediately. The
    curator is designed to run after at least ``interval_hours`` (7 days by
    default) of skill activity, not on the first background tick after
    ``hermes update``. On first observation we seed ``last_run_at`` to "now"
    and defer the first real pass by one full interval. Users who want to
    run it sooner can always invoke ``hermes curator run`` (with or without
    ``--dry-run``) explicitly — that path bypasses this gate.

    The idle check (min_idle_hours) is applied at the call site where we know
    whether an agent is actively running — here we only enforce the static
    gates.
    """
    if not is_enabled():
        return False
    if is_paused():
        return False

    state = load_state()
    last = _parse_iso(state.get("last_run_at"))
    if last is None:
        # Never run before. Seed state so we wait a full interval before the
        # first real pass. Report-only; do not auto-mutate the library the
        # very first time a gateway ticks after an update.
        if now is None:
            now = datetime.now(timezone.utc)
        try:
            state["last_run_at"] = now.isoformat()
            state["last_run_summary"] = (
                "deferred first run — curator seeded, will run after one "
                "interval; use `hermes curator run --dry-run` to preview now"
            )
            save_state(state)
        except Exception as e:  # pragma: no cover — best-effort persistence
            logger.debug("Failed to seed curator last_run_at: %s", e)
        return False

    if now is None:
        now = datetime.now(timezone.utc)
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    interval = timedelta(hours=get_interval_hours())
    return (now - last) >= interval


# ---------------------------------------------------------------------------
# Automatic state transitions (pure function, no LLM)
# ---------------------------------------------------------------------------

def _cron_referenced_skills() -> Set[str]:
    """Skill names referenced by any cron job (incl. paused/disabled).

    Best-effort: a cron-module import error or corrupt jobs store must never
    break the curator, so any failure yields an empty set (no protection,
    but no crash).
    """
    try:
        from cron.jobs import referenced_skill_names as _refs
        return _refs()
    except Exception as e:
        logger.debug("Curator could not read cron skill references: %s", e, exc_info=True)
        return set()


def apply_automatic_transitions(now: Optional[datetime] = None) -> Dict[str, int]:
    """Walk every curator-managed skill and move active/stale/archived based on
    the latest real activity timestamp. Pinned skills are never touched.

    Built-ins (eligible only when ``curator.prune_builtins`` is on) are seeded
    with a baseline record the first time they're seen so their inactivity
    clock starts NOW rather than at epoch — a long-unused built-in is therefore
    archived only after a fresh ``archive_after_days`` of non-use, not on the
    first pass after the flag flips on.

    Returns a counter dict describing what changed.
    """
    from tools import skill_usage as _u

    if now is None:
        now = datetime.now(timezone.utc)
    stale_cutoff = now - timedelta(days=get_stale_after_days())
    archive_cutoff = now - timedelta(days=get_archive_after_days())

    cron_referenced = _cron_referenced_skills()

    counts = {"marked_stale": 0, "archived": 0, "reactivated": 0, "checked": 0, "seeded": 0}

    for row in _u.agent_created_report():
        counts["checked"] += 1
        name = row["name"]
        if row.get("pinned"):
            continue

        # A skill referenced by any cron job (incl. paused/disabled) is in
        # use by definition — resuming or the next fire must find it. The
        # scheduler only bumps usage when a job actually fires, so jobs that
        # fire less often than archive_after_days, paused jobs, and far-future
        # one-shots would otherwise have their skills aged out from under
        # them. Treat referenced skills like pinned: never auto-transition.
        if name in cron_referenced:
            continue

        # First sight of a curation-eligible skill with no persisted record
        # (e.g. a newly-eligible built-in): anchor its clock to now and defer.
        if not row.get("_persisted", True):
            _u.seed_record_if_missing(name)
            counts["seeded"] += 1
            continue

        last_activity = _parse_iso(row.get("last_activity_at"))
        # If never active, treat created_at as the anchor so new skills don't
        # immediately archive themselves.
        anchor = last_activity or _parse_iso(row.get("created_at")) or now
        if anchor.tzinfo is None:
            anchor = anchor.replace(tzinfo=timezone.utc)

        current = row.get("state", _u.STATE_ACTIVE)

        # Never-used skills (use_count == 0) get a grace floor: don't archive
        # one until it is at least stale_after_days old. A use=0 skill is
        # absence of evidence, not evidence of staleness — a skill created
        # recently may simply not have had its trigger come up yet.
        never_used = int(row.get("use_count", 0) or 0) == 0
        if never_used and anchor > stale_cutoff:
            # Younger than the stale window — leave it alone entirely.
            if current == _u.STATE_STALE:
                _u.set_state(name, _u.STATE_ACTIVE)
                counts["reactivated"] += 1
            continue

        if anchor <= archive_cutoff and current != _u.STATE_ARCHIVED:
            ok, _msg = _u.archive_skill(name)
            if ok:
                counts["archived"] += 1
        elif anchor <= stale_cutoff and current == _u.STATE_ACTIVE:
            _u.set_state(name, _u.STATE_STALE)
            counts["marked_stale"] += 1
        elif anchor > stale_cutoff and current == _u.STATE_STALE:
            # Skill got used again after being marked stale — reactivate.
            _u.set_state(name, _u.STATE_ACTIVE)
            counts["reactivated"] += 1

    return counts


# ---------------------------------------------------------------------------
# Review prompt for the forked agent
# ---------------------------------------------------------------------------

CURATOR_DRY_RUN_BANNER = (
    "═══════════════════════════════════════════════════════════════\n"
    "DRY-RUN — REPORT ONLY. DO NOT MUTATE THE SKILL LIBRARY.\n"
    "═══════════════════════════════════════════════════════════════\n"
    "\n"
    "This is a PREVIEW pass. Follow every instruction below EXCEPT:\n"
    "\n"
    "  • DO NOT call skill_manage with action=patch, create, delete, "
    "write_file, or remove_file.\n"
    "  • DO NOT call terminal to mv skill directories into .archive/.\n"
    "  • DO NOT call terminal to mv, cp, rm, or rewrite any file under "
