# Azazel Task Brief — Stage System + HUD Polish

## Context
Melee Web is at `~/projects/melee-web/index.html` (~2829 lines, single-file). 
Currently has only Battlefield as the stage. Need to add5 more stages with a stage select screen, 
upgrade the HUD from HTML overlay to canvas-rendered, and build a results screen.

## YOUR TASKS

### 1. Multi-Stage System (PRIMARY)
Add a `STAGES` dictionary (replace single `STAGE` constant) with6 stages:

```
const STAGES = {
  battlefield: { /* already exists */ },
  finalDestination: { ... },
  dreamLand: { ... },
  yoshisStory: { ... },
  fountainOfDreams: { ... },
  pokemonStadium: { ... },
};
```

Each stage needs:
- `main: { x, y, w, h }` — main platform
- `platL: { x, y, w, h }` — left platform (null if none)
- `platR: { x, y, w, h }` — right platform (null if none)
- `platM: { x, y, w, h }` — middle platform (null if none, used by Battlefield)
- `ledgeL: { x, y, dir }` — left ledge grab point
- `ledgeR: { x, y, dir }` — right ledge grab point
- `blastLeft, blastRight, blastTop, blastBottom` — blast zone distances
- `name` — display name
- `bgGradient` — array of {stop, color} for background
- `platformColor` — hex string for platform fill
- `platformEdge` — hex string for platform edge highlight
- `hasRandall` — bool (Yoshi's Story only — the cloud platform that moves)
- `hasFountain` — bool (Fountain of Dreams — platforms move up/down)
- `transformLayouts` — array (Pokémon Stadium — platform configs that cycle)

**Stage data from decomp (gr/types.h, grGdScript):**

| Stage | Main Width | Main Y | Plat Height | Notes |
|-------|-----------|--------|-------------|-------|
| Battlefield | 116 | 0 | 55 | 3 plat layout (already exists) |
| Final Destination | 180 | 0 | N/A | Flat, no platforms |
| Dream Land | 255 | 0 | 80 | Huge stage, Windbox |
| Yoshi's Story | 140 | 0 | 42 | Randall cloud moves on timer |
| Fountain of Dreams | 120 | 0 | 45 | Side plats wave up/down |
| Pokémon Stadium | 160 | 0 | 40 | Transforms every ~30s |

**All blast zones:**
- Standard: left=-224, right=224, top=200, bottom=-110 (decomp: Battlefield/Dream Land)
- Dream Land: left=-255, right=255, top=250, bottom=-123
- FD: left=-230, right=230, top=200, bottom=-110

### 2. Stage Select Screen (PRIMARY)
Add `gameState === 'stageSelect'` between CSS and playing.

Layout: 2×3 grid of stage thumbnails (canvas-rendered silhouettes).
- Each thumbnail: ~120×80px, shows platform layout as white silhouette on dark bg
- Cursor-based selection (same P1 WASD/J, P2 Arrows/Numpad controls)
- Selected stage highlighted with glow border
- Both players confirm → transition to playing
- Background: dark blue (#0a1628) matching CSS

Flow: CSS → both confirm characters → Stage Select → both confirm stage → Playing

### 3. Canvas HUD (SECONDARY)
Replace the HTML div-based HUD with canvas-rendered:
- **Percent display**: Big bold numbers at bottom-left (P1) and bottom-right (P2), Melee-style
  - White text, black outline, ~48px font
  - Damage number + "%" symbol
  - Background plate with slight transparency matching player color
- **Stock icons**: Small colored squares below percent display (one per remaining stock)
  - Player color with white border
- **Center timer**: MM:SS format at top center (optional, add `matchTime` setting)

Remove the HTML `.damage` and `.stocks` divs. All rendering on canvas.

### 4. Results Screen (SECONDARY)
Add `gameState === 'results'` after game over:

- Dark overlay (0.8 alpha)
- Winner character name in large text, centered
- "WINS!" below
- Stats panel: KO count, falls, self-destructs, total damage dealt per player
- "PRESS [R] REMATCH / [T] STAGE SELECT / [ESC] CHARACTER SELECT"
- Canvas-rendered, no HTML overlay

### 5. Update References
After adding STAGES, update ALL references from `STAGE.xxx` to use current stage:
- `getPlatforms()` — return current stage's platforms
- `STAGE.main`, `STAGE.platL`, `STAGE.platR` references → `currentStage.main`, etc.
- Blast zone references → use current stage
- Ledge references → use current stage
- Add `let currentStage = STAGES.battlefield;` as default

### 6. drawStage() Enhancement
Update `drawStage()` to use current stage's visual theme:
- Background gradient from `currentStage.bgGradient`
- Platform colors from `currentStage.platformColor` / `currentStage.platformEdge`
- Stage-specific decorations (Dream Land trees, Fountain water, etc.) — skip if too complex, just use correct colors

## CONSTRAINTS
- Single-file: everything stays in index.html
- Don't break existing10 characters or871 tests
- Decomp is the blueprint — match Melee's layouts and feel
- Keep the creator modal / custom character system working
- Commit with descriptive messages

## FILES TO READ FIRST
- `~/projects/melee-web/index.html` — the game (read lines 240-260 for STAGE, 1590-1600 for getPlatforms, 2520-2555 for drawStage, 2712-2717 for drawHUD, 2756-2768 for gameOver, 2770-2829 for gameLoop)
- `~/projects/melee-web/test-mechanics.js` — test harness (DON'T break existing tests)

## DONE WHEN
-6 stages selectable and playable
- Stage select screen works with cursor selection
- HUD is canvas-rendered (no HTML divs for damage/stocks)
- Results screen shows winner + stats
- `node test-mechanics.js` still passes all871 tests
- All changes committed to git
