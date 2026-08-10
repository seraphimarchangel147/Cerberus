#!/usr/bin/env python3
"""Anatomy-gate sprite variants against the primary base (paired vision QA).

Usage:
    python3 anatomy_gate.py <form> <primary.png> <candidate.png> [candidate2.png ...]

Builds a side-by-side comparison strip (primary LEFT, candidate RIGHT) on the
engine background, asks a vision model panel (default: 3 votes, majority wins):
SAME ANATOMY / DIFFERENT SHAPES, plus decoration distinctiveness 1-10.
Ship criteria: SAME ANATOMY (majority) AND distinctiveness >= 4. Exits
non-zero if ANY candidate fails, so it composes into pipelines.

NEVER ship a DIFFERENT-SHAPES candidate — registration cannot repair anatomy
(measured: quadruped<->biped flips passed every attribute checklist).

Requires OPENROUTER_API_KEY (env or shared Hermes .env).
"""
import base64
import io
import json
import os
import re
import sys
import urllib.request

API = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "google/gemini-3.1-flash-image"
CELL = 128
BG = (18, 20, 26, 255)

QUESTION = (
    "Two registered game sprites of the same character, side by side at the "
    "same scale. Left is the PRIMARY/base character, right is a new VARIANT. "
    "Describe the BODY ANATOMY of each in one sentence: number of legs, "
    "quadruped vs bipedal stance, how the heads are carried, overall "
    "silhouette. Then answer exactly one of SAME ANATOMY (valid variant) or "
    "DIFFERENT SHAPES (identity break). Then give decoration distinctiveness "
    "as a single integer 1-10 with one-sentence reason."
)


def load_key():
    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        return key
    for cand in (os.path.expanduser("~/.hermes/.env"),
                 os.path.expanduser("~/.openclaw/.env")):
        try:
            with open(cand) as f:
                for line in f:
                    if line.startswith("OPENROUTER_API_KEY="):
                        return line.split("=", 1)[1].strip()
        except OSError:
            continue
    sys.exit("OPENROUTER_API_KEY not found in env or shared .env")


def strip_png(primary, candidate):
    """Side-by-side strip, both sides on the engine background.

    Unregistered candidates carry a SOLID MAGENTA background (RGB, opaque);
    key it out first so both sides compare on equal footing — otherwise the
    vision model reads the magenta block as the silhouette.
    """
    from PIL import Image
    import numpy as np
    out = Image.new("RGB", (CELL * 2 + 16, CELL + 20), BG)
    for j, path in enumerate((primary, candidate)):
        c = Image.open(path).convert("RGBA")
        a = np.array(c)
        r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
        mag = (r > 140) & (b > 140) & (g < r - 40) & (g < b - 40)
        if mag.mean() > 0.15:  # magenta-keyed generation background
            a[mag, 3] = 0
            c = Image.fromarray(a, "RGBA")
        o = Image.new("RGBA", (CELL, CELL), BG)
        o.alpha_composite(c.resize((CELL, CELL)) if c.size != (CELL, CELL) else c)
        out.paste(o.convert("RGB"), (8 + j * (CELL + 4), 10))
    buf = io.BytesIO()
    out.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def gate_one(primary, candidate, key, votes=3):
    """Ask the judge `votes` times and take a majority verdict.

    Single-judge variance is real and measured: the SAME winged variant was
    judged SAME ANATOMY twice and DIFFERENT SHAPES once (the wings 'expanded
    the silhouette'). Majority vote costs ~3x the judge latency (~12s) and
    eliminates both false rejects of good art and false ships of bad art.
    """
    b64 = strip_png(primary, candidate)
    payload = {"model": MODEL, "messages": [{"role": "user", "content": [
        {"type": "text", "text": QUESTION},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}]}
    same_votes, scores, texts = 0, [], []
    for _ in range(votes):
        req = urllib.request.Request(
            API, data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json"})
        resp = json.load(urllib.request.urlopen(req, timeout=120))
        text = resp["choices"][0]["message"]["content"].strip()
        texts.append(text)
        same = bool(re.search(r"SAME ANATOMY", text, re.I)) and not re.search(
            r"DIFFERENT SHAPES", text, re.I)
        if same:
            same_votes += 1
        m = re.search(r"distinctiveness[^\d\n]{0,40}?(\d+(?:\.\d+)?)", text, re.I)
        if not m:
            m = re.search(r"\b(\d+(?:\.\d+)?)\s*/\s*10\b", text)
        if m:
            scores.append(float(m.group(1)))
    same = same_votes * 2 > votes  # strict majority
    score = int(round(sum(scores) / len(scores))) if scores else 0
    return same, score, same_votes, votes, texts[-1]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--votes")]
    votes = 3
    for i, a in enumerate(sys.argv[1:]):
        if a.startswith("--votes="):
            votes = int(a.split("=", 1)[1])
        elif a == "--votes":
            votes = int(sys.argv[i + 2])
    if len(args) < 3:
        sys.exit(__doc__)
    form, primary, *candidates = args
    key = load_key()
    failed = False
    for cand in candidates:
        same, score, yea, total, text = gate_one(primary, cand, key, votes=votes)
        verdict = "SAME ANATOMY" if same else "DIFFERENT SHAPES"
        ok = same and score >= 4
        print(f"[{form}] {os.path.basename(cand)}: {verdict} "
              f"(vote {yea}/{total}), distinctiveness {score}/10 -> "
              f"{'SHIP' if ok else 'REJECT'}")
        print("  " + text.replace("\n", "\n  ")[:600])
        if not ok:
            failed = True
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
