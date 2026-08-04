"""
Grade hand-cut racer art to match the official renders.

    python3 scripts/enhance-racer-art.py --report
    python3 scripts/enhance-racer-art.py --apply Arthur_vehicle Natasha_headshot

── Why this exists ────────────────────────────────────────────────────────────

Art cut from gameplay video is hazy: video compression, atmospheric fog and the
desert's warm bounce light all wash it out. Next to Beast and Rex — which are
official renders with true blacks and deep reds — it reads as faded.

The first attempt was one hand-tuned grade applied to everything
(`-modulate 102,138 -sigmoidal-contrast 4,47%`). It helped, but it was a guess,
and a guess applied uniformly to four images with four different problems.

── Why the existing art is the reference ──────────────────────────────────────

The 9 official assets already in assets-src define what "right" looks like for
this project, so they are measured and used as the target rather than any
absolute ideal. That makes this a matching operation with a real answer, not a
taste call: a new image is done when its black point, white point, tonal spread
and chroma sit where the official art's do.

── Why Lab and not RGB ────────────────────────────────────────────────────────

Stretching RGB channels independently is what makes auto-levels shift colour —
a red-dominated car has almost nothing in the blue channel, so normalising blue
to the same range invents a blue cast. In Lab, lightness is one axis and colour
is the other two, so tone can be stretched without touching hue, and chroma can
be scaled without touching brightness.

── Why raw and graded live in separate folders ────────────────────────────────

    assets-src/racers-raw/   hand-cut captures, untouched          ← input
    assets-src/racers/       official art + graded captures        ← output
                                    ↓ scripts/build-racer-art.mjs
    apps/web/src/assets/racers/*.webp

Grading in place was tried and it is a trap: a second run grades the already
graded file. That happened, and it was not obvious from looking — the result was
merely too saturated, not broken. It showed up only as a number, when a vehicle
measured 41.6 chroma against a 19.5 target. Reading from an input that is never
written to makes the pass idempotent, so re-running it is always safe.

── Why every adjustment is clamped ────────────────────────────────────────────

The statistics come from whatever pixels an image happens to contain. A car that
is genuinely darker than the reference average is not a defect to be corrected
into oblivion, so each correction has a ceiling. Clamps that bind are printed,
because a correction silently pinned at its limit means the measurement was not
describing what I assumed.
"""
import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
# Official art, AND where graded output lands — this is what build-racer-art.mjs reads.
SRC = ROOT / "assets-src" / "racers"
# Untouched hand-cut captures. Never written to.
RAW = ROOT / "assets-src" / "racers-raw"

# The official renders. Everything else gets matched to these.
REFERENCE = ["Beast", "Dee", "Driftking", "Hotty", "Rex", "Turboboy", "Twins", "UFO", "tailfin"]

# Ceilings, deliberately conservative. See the module docstring.
MAX_CHROMA_GAIN = 1.55
MAX_STRETCH = 2.2
CAST_STRENGTH = 0.8      # how much of the measured colour cast to remove
CLARITY_AMOUNT = 0.35
CLARITY_RADIUS = 3.0


def load(path: Path):
    """BGRA → float32 Lab plus an opaque-pixel mask."""
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    if img.shape[2] == 3:
        img = np.dstack([img, np.full(img.shape[:2], 255, np.uint8)])
    bgr = img[:, :, :3].astype(np.float32) / 255.0
    alpha = img[:, :, 3]
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    return lab, alpha, (alpha > 128)


def stats(lab: np.ndarray, opaque: np.ndarray) -> dict:
    """
    Describe an image's tone and colour.

    Measured over OPAQUE pixels only. This is not a detail: a cut-out vehicle is
    ~60% transparent, and transparent pixels carry whatever BGR happened to sit
    under them. Including them makes every number describe the discarded
    background as much as the subject.
    """
    L = lab[:, :, 0][opaque]
    a = lab[:, :, 1][opaque]
    b = lab[:, :, 2][opaque]
    chroma = np.hypot(a, b)
    # "Neutral" pixels are where a colour cast is visible as a cast rather than
    # as the subject's own colour, so the cast is estimated from those alone.
    neutral = chroma < 12
    return {
        "n": int(opaque.sum()),
        "L_lo": float(np.percentile(L, 0.5)),
        "L_med": float(np.percentile(L, 50)),
        "L_hi": float(np.percentile(L, 99.5)),
        "L_std": float(L.std()),
        "chroma": float(chroma.mean()),
        "cast_a": float(a[neutral].mean()) if neutral.sum() > 50 else 0.0,
        "cast_b": float(b[neutral].mean()) if neutral.sum() > 50 else 0.0,
        "neutral_frac": float(neutral.mean()),
    }


def reference(kind: str) -> dict:
    """Pooled statistics for one kind of asset across all the official art."""
    rows = []
    for name in REFERENCE:
        path = SRC / f"{name}_{kind}.png"
        if not path.exists():
            continue
        lab, _, opaque = load(path)
        rows.append(stats(lab, opaque))
    if not rows:
        raise SystemExit(f"no reference art found for kind={kind}")
    # Median across images, not mean: one unusually dark render shouldn't set
    # the target for everything else.
    return {k: float(np.median([r[k] for r in rows])) for k in rows[0] if k != "n"} | {
        "images": len(rows)
    }


def enhance(lab: np.ndarray, opaque: np.ndarray, ref: dict, notes: list) -> np.ndarray:
    src = stats(lab, opaque)
    out = lab.copy()
    L, a, b = out[:, :, 0], out[:, :, 1], out[:, :, 2]

    # 1. Neutralise the colour cast, by shifting the a/b of near-neutral pixels
    #    toward 0. The desert bounce light is the reason grey rollcages read
    #    olive; correcting it here is why the chroma boost in step 4 can then
    #    deepen colour rather than deepen the cast.
    if src["neutral_frac"] > 0.02:
        a -= CAST_STRENGTH * (src["cast_a"] - ref["cast_a"])
        b -= CAST_STRENGTH * (src["cast_b"] - ref["cast_b"])
    else:
        notes.append("no neutral pixels to estimate cast from — skipped WB")

    # 2. Clarity: local contrast on lightness only. Video softening is the last
    #    thing separating these from the crisp renders.
    #
    #    Deliberately BEFORE the levels pass. Unsharp masking overshoots on both
    #    sides of an edge, so running it last drove the darkest pixels below the
    #    black point I had just set — every image reported a black point of 0.0
    #    instead of the reference's 1.8, and shadow detail was being clipped away
    #    after the work to place it. Levels last means the endpoints are exact.
    blur = cv2.GaussianBlur(L, (0, 0), CLARITY_RADIUS)
    L[:] = L + CLARITY_AMOUNT * (L - blur)

    # 3. Black and white point. Video-captured art never reaches true black, so
    #    this is the adjustment that does most of the visible work.
    now = stats(out, opaque)
    span_src = max(now["L_hi"] - now["L_lo"], 1e-3)
    stretch = (ref["L_hi"] - ref["L_lo"]) / span_src
    if stretch > MAX_STRETCH:
        notes.append(f"stretch CLAMPED {stretch:.2f}→{MAX_STRETCH}")
        stretch = MAX_STRETCH
    L[:] = (L - now["L_lo"]) * stretch + ref["L_lo"]

    # 4. Gamma so the midtone lands where the reference's does. Levels alone fix
    #    the endpoints and leave the middle wherever it fell.
    lo, hi = ref["L_lo"], ref["L_hi"]
    norm = np.clip((L - lo) / max(hi - lo, 1e-3), 0, 1)
    med_now = np.clip((np.percentile(L[opaque], 50) - lo) / max(hi - lo, 1e-3), 1e-3, 0.999)
    med_ref = np.clip((ref["L_med"] - lo) / max(hi - lo, 1e-3), 1e-3, 0.999)
    gamma_want = np.log(med_ref) / np.log(med_now)
    gamma = float(np.clip(gamma_want, 0.6, 1.7))
    if abs(gamma - gamma_want) > 0.01:
        notes.append(f"gamma CLAMPED {gamma_want:.2f}→{gamma:.2f} "
                     f"(midtone will land above target)")
    L[:] = np.power(norm, gamma) * (hi - lo) + lo

    # 5. Chroma. Scaling a and b together is a saturation change that leaves hue
    #    alone, which `-modulate`'s HSL saturation does not — that one pushes
    #    already-vivid reds until they clip, and clipped red loses its shading.
    have = stats(out, opaque)["chroma"]
    gain_want = ref["chroma"] / max(have, 1e-3)
    gain = min(gain_want, MAX_CHROMA_GAIN)
    if gain_want > MAX_CHROMA_GAIN:
        notes.append(f"chroma gain CLAMPED {gain_want:.2f}→{MAX_CHROMA_GAIN}")
    if gain < 1.0:
        # The reference chroma is a median across nine vehicles, several of them
        # largely black. A genuinely vivid car sits above it legitimately, and
        # dragging it down to the average would be matching the wrong thing.
        notes.append(f"already above target chroma (would be {gain_want:.2f}) — left alone")
        gain = 1.0
    a *= gain
    b *= gain

    np.clip(L, 0, 100, out=L)
    np.clip(a, -127, 127, out=a)
    np.clip(b, -127, 127, out=b)
    return out


def write(lab: np.ndarray, alpha: np.ndarray, path: Path):
    bgr = np.clip(cv2.cvtColor(lab, cv2.COLOR_LAB2BGR), 0, 1)
    cv2.imwrite(str(path), np.dstack([(bgr * 255).round().astype(np.uint8), alpha]))


def row(label: str, s: dict) -> str:
    return (f"  {label:22s} black {s['L_lo']:5.1f}  mid {s['L_med']:5.1f}  "
            f"white {s['L_hi']:5.1f}  spread {s['L_std']:5.1f}  "
            f"chroma {s['chroma']:5.1f}  cast a{s['cast_a']:+5.1f} b{s['cast_b']:+5.1f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*", help="e.g. Arthur_vehicle (default: everything in racers-raw)")
    ap.add_argument("--apply", action="store_true", help="write the files, not just measure")
    ap.add_argument("--out", default=None, help=f"where to write (default: {SRC})")
    args = ap.parse_args()

    if not RAW.exists():
        raise SystemExit(f"no raw captures at {RAW}")
    targets = args.names or sorted(p.stem for p in RAW.glob("*.png"))

    refs = {}
    for kind in ("portrait", "headshot", "vehicle"):
        # Head-shots are matched against the official PORTRAITS: different
        # framing, same question — does this look like it belongs here.
        refs[kind] = reference("portrait" if kind == "headshot" else kind)

    for kind in ("portrait", "vehicle"):
        print(f"\nREFERENCE  {kind}  ({refs[kind]['images']} official assets, median)")
        print(row(kind, refs[kind]))

    out_dir = Path(args.out) if args.out else SRC
    out_dir.mkdir(parents=True, exist_ok=True)

    print()
    for stem in targets:
        kind = stem.rsplit("_", 1)[-1]
        if kind not in refs:
            print(f"  {stem}: unknown kind '{kind}', skipped")
            continue
        path = RAW / f"{stem}.png"
        lab, alpha, opaque = load(path)
        before = stats(lab, opaque)
        notes: list = []
        graded = enhance(lab, opaque, refs[kind], notes)
        after = stats(graded, opaque)

        print(f"{stem}   ({before['n']:,} opaque px)")
        print(row("before", before))
        print(row("after", after))
        print(row("target", refs[kind]))
        for n in notes:
            print(f"    note: {n}")
        if args.apply:
            write(graded, alpha, out_dir / f"{stem}.png")
            print(f"    written → {out_dir / f'{stem}.png'}")
        print()

    if not args.apply:
        print("Measure-only. Re-run with --apply to write.", file=sys.stderr)


if __name__ == "__main__":
    main()
