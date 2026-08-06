# Cerberus: sprite toggle + animation dev/debug menu

Requested by the Creator on the live dashboard, 2026-08-06.

Two features, both in `src/hosted-interface.js` (the pet widget is one IIFE
inside a server-side template literal — see "Hard constraints" before editing).

---

## Background you need

The pet has **5 forms** (`FORMS`, line 12301):

| stage | key   | draw fn          | art source |
|-------|-------|------------------|------------|
| 0 | pup   | `drawPupFront`   | procedural only |
| 1 | prime | `drawPrimeFront` | procedural only |
| 2 | ultra | `drawUltraFront` | procedural only |
| 3 | omega | `drawOmegaFront` | **sprite atlas**, procedural fallback |
| 4 | alpha | `drawAlphaFront` | **sprite atlas**, procedural fallback |

Render dispatch is at **line 15189-15193**. Only stages 3 and 4 call
`drawCerbSprite()` (line 14478); it returns `false` when the atlas isn't
ready/loaded, and the caller then falls through to the full procedural rig:

```js
var skelOK = drawCerbSprite(ctx, P, isAlpha ? "alpha" : "omega");   // L13656
if (!skelOK) {
  /* ... procedural body ... */
}
```

That `if (!skelOK)` fallback is the mechanism BOTH features exploit. It is
already written, already correct, and already exercised whenever the atlas
fetch fails. Do not rewrite it.

The atlas manifest (`cerbAtlas.manifest`, line 14420) has this shape:

```jsonc
{
  "cell": 128,
  "alias": { "idle":"idle", "running":"working", "review":"alert",
             "failed":"sleep", "waving":"victory", "jumping":"attack",
             "waiting":"alert" },
  "forms": {
    "omega": { "sha":"...", "cols":N, "frames": { "<name>": <slot> },
               "states": { "idle": { "seq":[names...], "loop":true, "hold":2 }, ... } },
    "alpha": { ... }
  }
}
```

Engine states (`STATES`, line 14848) are: `idle, running, review, failed,
waving, jumping, waiting`. Atlas rows are: `idle, working, alert, sleep,
victory, attack, walk`. `cerbAtlasRow(form, engineState, forceRow)` (line
14468) does the mapping. **`walk` has no alias** — it is only reachable via
the `forceRow` argument when the pet is physically moving.

---

## Feature 1 — Sprite art toggle

**Setting:** add `sprites: true` to the `settings` object at **line 14773**.
It persists automatically — `saveSettings()` serialises the whole object and
the loader at 14775-14777 copies any saved key that already exists in the
default. Do not touch the persistence code.

**Behaviour:**
- `sprites: true` (default) → current behaviour, atlas art on stages 3-4.
- `sprites: false` → `drawCerbSprite()` returns `false` immediately, so every
  form renders the procedural rig. Stages 0-2 are unaffected either way.

**Implementation:** one guard at the top of `drawCerbSprite` (line 14479):

```js
if (!settings.sprites) return false;
if (!cerbAtlas.ready || !cerbAtlas.images[form]) return false;
```

That is the entire behavioural change. Do **not** add a second code path, do
not branch at the call sites — the existing `!skelOK` fallback does the work.

**UI:** in `buildPanel()` (line 15046), add a row immediately after the
"Ember glow" row at **line 15085** (verified), using the existing `row()`/`toggle()`
helpers exactly as its neighbours do:

```js
var rS = row("Sprite art"); rS.appendChild(toggle(function(){return settings.sprites;}, function(v){settings.sprites=v;})); panel.appendChild(rS);
```

`toggle()` already calls `saveSettings()`, `applyCanvasStyle()` and
`updateHud()` on click, so no extra wiring is needed.

**Keep "Show pet" as-is.** It is a separate, existing toggle (`settings.enabled`)
and the Creator wants both: "Show pet" hides the widget entirely, "Sprite art"
switches between atlas and procedural art.

---

## Feature 2 — Animation dev/debug menu

A panel that lets the Creator **see every animation available for each
evolution** and play them on demand.

### Opening it

Add a `btn("Dev / animations", ...)` to `buildPanel()` after the existing
"Reset to pup" button (**line 15101**). It toggles a new overlay panel.

Also expose `window.cerbPetDevMenu = function(){...}` so it can be opened from
the console.

### What it must show

Build the contents **from `cerbAtlas.manifest` at open time** — never hardcode
row names, frame counts, or the state list. If the manifest gains a row the
menu must show it with no code change.

For the currently selected form, one section per atlas row:

- row name (`idle`, `working`, `alert`, `sleep`, `victory`, `attack`, `walk`)
- frame count (`spec.seq.length`), `loop` flag, `hold` value
- computed duration in seconds. `P.flick` advances in 60Hz tick units and the
  index formula at line 14493 is
  `Math.floor((P.flick - start) / (TICKS_PER_FRAME * spec.hold))`, so:
  `seconds = seq.length * spec.hold * TICKS_PER_FRAME / 60`.
  Read `TICKS_PER_FRAME` (line 12326) from source — do NOT hardcode 2, and note
  there is no `ATLAS_HOLD` variable in this file (it appears only in a comment).
- which engine states alias to it (invert `manifest.alias`), or the literal
  text `no alias — forceRow only` for `walk`
- a **Play** button that drives that row live

### Form selector

A row of 5 buttons (Pup/Prime/Ultra/Omega/Alpha) reusing `FORMS` and the
existing `FORM_COLOR` array. Selecting one calls `setForm(idx)`.

For stages 0-2 (no atlas art) the section list must be replaced by an explicit
line: `procedural only — no atlas rows for this form`. **Do not show an empty
panel or fabricate rows.** This is the exact confusion that caused the
Creator's original bug report and the menu must make it obvious.

### Play buttons

Play must work for **every** row, including ones with no alias:

- For an aliased row, `setState(<engine state>)` is enough.
- For `walk` (and any future unaliased row) that is not reachable via
  `setState`, add a dev-only override. Suggested minimal approach: a variable
  `devForceRow` (default `null`) consulted inside `cerbAtlasRow` — when set, it
  wins over the normal alias lookup. Add a **Stop / resume live state** button
  that clears it. Guard it so it can never be set unless the dev menu opened.

While a row is forced, the menu should display the live frame name and index
from the same source `__cerbProbe` uses (`cerbSprLastFrame` / `cerbSprLastIdx`,
lines 14502-14503 (verified)), refreshed on a timer while the menu is open. Clear the
timer when it closes.

### Styling

Match the existing panel: dark background, `rgba(224,69,26,*)` borders,
`#e8b84a` / `#ffd97a` text, `font-family:inherit`. Scrollable, `z-index` above
the pet canvas (canvas is 9999). Keep it under ~320px wide.

---

## Hard constraints

1. **The client code lives inside a JS template literal.** A backtick anywhere
   in your added code or comments breaks the whole page parse. Use plain
   quotes. Prefer `x=34..70` over typographic dashes.
2. **After every edit run BOTH:**
   ```bash
   node --check src/hosted-interface.js
   curl -s http://127.0.0.1:43210/ -o /tmp/d.html   # if a daemon is up
   ```
   `node --check` on the server module is **necessary but not sufficient** —
   it parses the client code as data. Extract the inline script from a live
   render and check that too:
   ```bash
   node -e "const fs=require('fs'),h=fs.readFileSync('/tmp/d.html','utf8');const m=h.match(/<script[^>]*>([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/b.js',m[1])" && node --check /tmp/b.js
   ```
   A duplicate top-level `const`/`let` blacks out the entire dashboard with a
   green backend. This has happened before on this exact file.
3. **ASCII only** in identifiers. Byte-scan added lines for characters >127.
4. **No new dependencies.** `package.json` has `"dependencies": {}` and it
   stays that way.
5. **Do not touch** `cerberus/sprites/**` (the atlas pipeline), the walk-latch
   displacement guard at line 15277, or the default `stage:3`.
6. Run `node scripts/run-tests.mjs 0` — baseline is **2281 pass, 0 fail**.
   It must still be 0 fail; the count may only go up.

## Deliverables

- Feature 1 and Feature 2 implemented in `src/hosted-interface.js`
- Tests if any logic is extractable; at minimum do not regress the suite
- A `CHANGES.md` entry describing both features
- Commit to branch `codex/cerberus-sprite-toggle-devmenu`, push it

## Verification you must run and paste the output of

```bash
node --check src/hosted-interface.js
node --check /tmp/b.js                    # extracted inline client bundle
node scripts/run-tests.mjs 0 2>&1 | tail -6
```

Then confirm by measurement, not by eye:
- with `settings.sprites=false`, `drawCerbSprite` returns false for both
  omega and alpha (the procedural rig renders)
- the dev menu lists **7 rows** for omega and alpha, and shows the
  "procedural only" line for pup/prime/ultra
- Play works for `walk`, the one row with no alias

## Completion marker

Finish by appending this literal line as the last line of your CHANGES.md
entry:

SPRITE TOGGLE AND DEV MENU COMPLETE
