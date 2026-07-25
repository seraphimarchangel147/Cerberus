# Cerberus Dashboard — Visual Redesign Brief
**Owner:** Levi 🌊 (design + asset generation + motion)
**Requested by:** Creator, via Seraphim
**Target:** Azazel's openAGI daemon dashboard, served at `http://127.0.0.1:43210`

---

## The ask

Redesign the Cerberus dashboard frontend in a **TRON: ARES** visual language —
red-on-black holographic HUD. Creator explicitly wants **3D effects and motion
design for all the holographic interactive elements**, plus generated assets.

Reference images are in `design/references/`:

| File | What to take from it |
|---|---|
| `01-tron-ares-site-layout.webp` | Full-page composition, ultra-dark canvas, neon circuit-trace dividers, tiny red pill buttons with glow |
| `02-holographic-hud-volumetric.jpeg` | Volumetric 3D holo-projection over a grid plane — the hero treatment |
| `03-tron-ares-biometric-hud.jpeg` | Live-telemetry readout style: labelled metrics, thin connector lines, sparklines, scanline/glitch texture |
| `04-terminal-azr-screen.webp` | Ultra-wide terminal aesthetic, monospace micro-type, QR/barcode glyphs, `→E.AZR` marker chrome |
| `05-laser-control-console.webp` | **The most important one for panel layout** — grid of status cards (`L00…L02`, `85V`, `OFFLINE` pills), a modal with a progress bar (`REBOOTING LASERS`), dense header/footer telemetry strips |
| `06-tron-ares-badge-system.webp` | Line-art badge/frame system: chamfered corners, wireframe blobs/globes, halftone, barcode strips — use for empty states, section headers, loaders |
| `07-cerberus-logo.webp` | The Cerberus three-wolf mark + wordmark. Canonical brand. |

---

## Hard technical constraints (do not break these)

1. **Single file.** The entire UI is `src/hosted-interface.js` (~6000 lines) — a JS
   template literal that emits one self-contained HTML doc. Inline `<style>` +
   inline `<script>`. **No build step, no npm deps, no external CDN at runtime.**
   Assets must be inlined (data-URI / inline SVG) or served from the daemon.
2. **Do not touch tab wiring.** Tab switching keys off `data-tab` attributes
   (`document.querySelectorAll("nav button[data-tab]")`, ~line 2789). All 19 tabs
   must keep rendering. Restyle the buttons; don't rename the keys.
3. **Do not touch auth.** `isLoopbackPeer` bypass for local, token gate for remote
   nodes + secrets API. Leave it alone.
4. **Do not rename** the FS path `Application Support/OpenAGI/inbox` or any
   `OPENAGI_*` env var. Rebrand user-facing strings only (already done → "Cerberus").
5. **Theme via the existing CSS custom properties** at lines ~2305–2371
   (`--bg`, `--panel`, `--accent`, `--line`, `--rail-w`, etc.). Retheming through
   the token block is far safer than rewriting rules. Current accent is green
   `#6fe1b1` → goes red.
6. **Performance:** this runs alongside Azazel's live brain on a 12GB-capped WSL box.
   Motion must be GPU-cheap — `transform`/`opacity` only, no layout thrash, no
   perpetual full-screen canvas at 60fps. Respect `prefers-reduced-motion`.
7. **Work on a branch** off `main` (`0da0b9d`). Suggested: `feat/cerberus-tron-ui`.
   Do **not** merge or restart `openagi-azazel` yourself — that interrupts Azazel's
   running brain. Hand the branch back and Creator approves the deploy.

---

## Design direction

**Palette** — near-black base, single red accent, sparing white.
```
--bg:      #050506   /* near-black, slight cool cast */
--panel:   #0c0d10
--line:    #23262c / red-tinted #3a0f12 for active edges
--accent:  #ff2b2b  (glow: #ff5a4a, deep: #7a0b0b)
--text:    #e6e8ea
--muted:   #6e7681
```
Red is *emissive*, not fill — glow, edge-light, scanlines. Keep large areas black.

**Type** — geometric wide-tracked uppercase for headings (TRON style), monospace
for all telemetry/numbers. System-font stack or inlined webfont only.

**Chrome** — chamfered/notched panel corners (clip-path), 1px emissive borders,
corner ticks, barcode + serial-number micro-labels on panels (see refs 04/06).

### Motion / 3D work (the part Creator specifically called out)
- **Hero holo-projection** on the Chat/landing pane — volumetric grid + the Cerberus
  mark rendered as a floating 3D wireframe (CSS 3D transforms or a small inline
  WebGL/Three-free raw-GL shim; no npm).
- **Nav rail** — active tab gets a travelling light-trail down the rail edge.
- **Panels** — enter with a HUD "materialise" (scanline sweep + chromatic split, ~180ms).
- **Buttons/pills** — hover = glow bloom + subtle 3D tilt; press = flash.
- **Status pills** (`online`/`offline`) — the `05` reference's `OFFLINE` treatment;
  pulsing emissive dot.
- **Loading/long ops** — the `REBOOTING LASERS` modal pattern: bordered dialog,
  segmented progress bar, streaming monospace log beneath.
- **Ambient** — very slow drifting grid/circuit background, low opacity, pausable.

### Asset generation (your lane)
- Cerberus wolf mark as **clean inline SVG** (trace from `07`), plus a wireframe /
  line-art variant for the holo hero.
- Icon set for the 19 nav tabs — replace the emoji with line-art HUD glyphs.
- Frame/badge SVG system from ref `06` for empty states and section headers.
- Loader/spinner, scanline + halftone textures (as CSS gradients or tiny inline SVG).

---

## Scope order (ship incrementally, each independently reviewable)
1. **Token retheme** — palette + type + chamfered chrome via the CSS var block. Fastest win.
2. **Nav rail + topbar** — brand mark, HUD glyph icons, light-trail active state.
3. **Panel system** — cards, status pills, tables, modals in the ref-`05` console idiom.
4. **Motion layer** — panel materialise, hover/press, ambient grid.
5. **Holo hero** — the 3D Cerberus projection.

---

## Verification required before handoff
- `node --check src/hosted-interface.js` clean.
- Existing suites green (auth / hosted / moa).
- Screenshot every one of the 19 tabs on a **throwaway instance** (not the live
  daemon on 43210) and confirm zero console errors on tab switch.
- Confirm the sessions sidebar still hides correctly on full-width tabs.
- Confirm the <820px collapse (icons-only rail) still works.
