#!/usr/bin/env python3
"""Generate a reference-locked sprite variant via OpenRouter (Gemini image).

Usage:
    python3 generate_variant.py <primary_base.png> <out.png> "<decoration>" \
        [--form omega|alpha] [--model google/gemini-3.1-flash-image]

The primary base is passed as an IMAGE REFERENCE — text-only identity
prompts flip anatomy (quadruped<->biped), measured over three wasted
generation cycles. The prompt locks anatomy, stance, leg count, head
arrangement, and HEIGHT, and changes ONLY the decoration you pass.

Background is SOLID PURE MAGENTA (#FF00FF) for downstream chroma keying
(register_variants.py uses the magenta key).

Requires OPENROUTER_API_KEY — read from env or parsed out of the shared
Hermes .env (~/.hermes/.env).
"""
import argparse
import base64
import json
import os
import sys
import urllib.request

API = "https://openrouter.ai/api/v1/chat/completions"

PROMPT = (
    "The attached image is the EXACT character I want a new costume variant of. "
    "Reproduce THIS SAME creature with IDENTICAL anatomy, IDENTICAL stance, "
    "IDENTICAL number of legs and head arrangement, and IDENTICAL proportions "
    "AND HEIGHT — the head tops must reach the SAME height as in the reference, "
    "and the feet must sit at the same low position. Do NOT make it smaller, "
    "shorter, or squat. Change ONLY the decoration listed below. Output: one "
    "pixel-art sprite on a SOLID PURE MAGENTA (#FF00FF) background, nothing "
    "else in frame, character centered, full body head-to-toe with the same "
    "tall stature as the reference, no text, no watermark, no border.\n\n"
    "New decoration ONLY (anatomy + height stay identical to reference): {deco}"
)

PALETTE_HINT = {
    "alpha": (
        " Keep the palette strictly cyan/blue/steel/white — no warm colors "
        "(red/orange/yellow)."
    ),
    "omega": (
        " Keep the palette warm: magma red/orange/gold/ember — this is the "
        "volcanic form."
    ),
}


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("primary", help="path to the primary base sprite (image reference)")
    ap.add_argument("out", help="output PNG path")
    ap.add_argument("decoration", help="what is NEW; anatomy stays identical")
    ap.add_argument("--form", choices=["omega", "alpha"], default=None)
    ap.add_argument("--model", default="google/gemini-3.1-flash-image")
    args = ap.parse_args()

    deco = args.decoration + (PALETTE_HINT.get(args.form) or "")
    with open(args.primary, "rb") as f:
        ref_b64 = base64.b64encode(f.read()).decode()

    payload = {
        "model": args.model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT.format(deco=deco)},
            {"type": "image_url",
             "image_url": {"url": f"data:image/png;base64,{ref_b64}"}},
        ]}],
        "modalities": ["image", "text"],
    }
    req = urllib.request.Request(
        API, data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {load_key()}",
                 "Content-Type": "application/json"})
    try:
        resp = json.load(urllib.request.urlopen(req, timeout=240))
    except urllib.error.HTTPError as e:
        sys.exit(f"OpenRouter HTTP {e.code}: {e.read().decode()[:300]}")

    imgs = resp["choices"][0]["message"].get("images") or []
    if not imgs:
        sys.exit(f"no image returned: {json.dumps(resp)[:300]}")
    raw = base64.b64decode(imgs[0]["image_url"]["url"].split(",", 1)[1])
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "wb") as f:
        f.write(raw)
    print(f"generated {args.out} ({len(raw)} bytes) — anatomy-gate it before registering")


if __name__ == "__main__":
    main()
