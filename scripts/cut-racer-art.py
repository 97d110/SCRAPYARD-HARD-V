"""
Cut vehicles out of BlazeRush gameplay screenshots.

The backgrounds are blurred desert — a gradient, not a flat colour — so a fuzz
threshold on one sampled colour is the wrong tool: the olive background and the
vehicles' grey panels sit close together in luminance, and any threshold loose
enough to take the background also eats the rollcage.

GrabCut instead models foreground and background as colour mixtures and adds a
smoothness term, so it can separate "greyish thing in the middle" from "olive
gradient around the edge" using position as evidence, not just colour.

Usage:  python3 cut.py [slug ...]
"""
import sys
import cv2
import numpy as np
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "src"
OUT = HERE / "out"
LOOK = HERE / "look"

# Per-image knobs. Everything here was read off a coordinate grid overlay of the
# source, not guessed — see look/grid-*.png.
CONFIG = {
    "arthur_vehicle": {
        # A red HUD sliver rides the right edge, past the rear thruster.
        "crop": (0, 0, 378, 236),
        "band": 10, "bg_at": 2.0, "fg_at": 6.0,
    },
    "matthew-hell_vehicle": {
        # The "Matthew Hell" name banner sits over the bottom of the tyres.
        # Cropping costs ~15px of tyre; leaving it in costs a strip of text.
        "crop": (0, 0, 421, 293),
        "band": 10, "bg_at": 2.0, "fg_at": 6.0,
    },
    "natasha_vehicle": {
        "crop": (0, 0, 408, 279),
        "band": 10, "bg_at": 2.0, "fg_at": 6.0,
    },
    "vera_vehicle": {
        "crop": (0, 0, 430, 286),
        "band": 10, "bg_at": 2.0, "fg_at": 6.0,
    },
    # Portraits: painted icons on a near-flat dark backdrop, so a much thinner
    # reference band is enough and the thresholds can be tighter.
    "arthur_portrait": {"crop": (0, 0, 119, 116), "band": 4, "bg_at": 2.5, "fg_at": 5.0},
    "matthew-hell_portrait": {"crop": (0, 0, 123, 120), "band": 4, "bg_at": 2.5, "fg_at": 5.0},
    "natasha_portrait": {"crop": (0, 0, 117, 118), "band": 4, "bg_at": 2.5, "fg_at": 5.0},
    "vera_portrait": {"crop": (0, 0, 116, 118), "band": 4, "bg_at": 2.5, "fg_at": 5.0},
}

ITERS = 8


def largest_component(mask: np.ndarray) -> np.ndarray:
    """
    Keep only the biggest blob.

    Blurred background often leaves a few stray islands that happen to look like
    foreground. A vehicle is one connected object, so anything not attached to
    the main mass is noise by definition.
    """
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        return mask
    # Row 0 is the background label, so skip it before taking the max area.
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return np.where(labels == biggest, 255, 0).astype(np.uint8)


def fill_holes(mask: np.ndarray, img: np.ndarray, bg_colour: np.ndarray) -> np.ndarray:
    """
    Close interior gaps — a cockpit window or a shadowed vent reads as
    background by colour, but a hole punched through a car is never wanted.

    Flood-filling the OUTSIDE and inverting is what separates an interior hole
    from real background: real background is reachable from the border, an
    interior hole isn't.
    """
    h, w = mask.shape
    ff = np.zeros((h + 2, w + 2), np.uint8)
    outside = mask.copy()
    cv2.floodFill(outside, ff, (0, 0), 255)
    holes = cv2.bitwise_not(outside)

    # ...but "enclosed by the silhouette" is NOT the same as "part of the
    # vehicle". The gap between a jet's wings, or between two wheels, is
    # enclosed and is still sky. Filling every hole blindly is what put tan
    # wedges through the middle of three of these four vehicles on the first
    # pass, so each hole now has to earn it on two independent counts.
    out = mask.copy()
    n, labels, stats, _ = cv2.connectedComponentsWithStats(holes, connectivity=8)
    area_limit = 0.01 * float((mask > 0).sum())
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        blob = labels == i
        # How close is this hole to the colour of the known background? A vent
        # is dark or metallic; trapped sky is the same olive as the border.
        distance = np.linalg.norm(img[blob].mean(axis=0) - bg_colour)
        if area <= area_limit and distance > 40:
            out[blob] = 255
    return out


def cut(name: str, cfg: dict):
    img = cv2.imread(str(SRC / f"{name}.png"), cv2.IMREAD_COLOR)
    x0, y0, x1, y1 = cfg["crop"]
    img = img[y0:y1, x0:x1]
    h, w = img.shape[:2]

    band = cfg["band"]
    edge = np.zeros((h, w), bool)
    edge[:band, :] = edge[-band:, :] = True
    edge[:, :band] = edge[:, -band:] = True

    # How background-like is every pixel?
    #
    # Mahalanobis distance, in Lab, from the colour distribution of the border
    # band. Two reasons for that rather than plain RGB distance to one sampled
    # colour: the background is a blurred gradient, so its *spread* is as
    # informative as its centre and the covariance captures it; and Lab
    # separates lightness from hue, which is the whole difficulty here — olive
    # sand and a grey rollcage sit at nearly the same brightness and are far
    # apart only in a and b.
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float64)
    band_lab = lab[edge]
    mu = band_lab.mean(axis=0)
    cov = np.cov(band_lab.T) + np.eye(3) * 1e-3
    delta = (lab - mu).reshape(-1, 3)
    d = np.sqrt(np.einsum('ij,jk,ik->i', delta, np.linalg.inv(cov), delta)).reshape(h, w)

    # Seeds from that distance, NOT from a central rectangle. A geometric core
    # was the first attempt and it failed for a specific reason worth keeping
    # written down: a rectangle over the middle of a jet also covers the sky
    # between its wings, so asserting it as definite foreground trained the
    # foreground model on sand and every tan pixel in the frame came along.
    mask = np.full((h, w), cv2.GC_PR_FGD, np.uint8)
    mask[d < cfg["bg_at"]] = cv2.GC_PR_BGD
    mask[d > cfg["fg_at"]] = cv2.GC_FGD
    # The band stays hard background regardless — it is the reference, so it
    # cannot be allowed to argue with itself.
    mask[edge] = cv2.GC_BGD

    bg_colour = np.median(img[edge], axis=0)
    print(f"  {name}: d percentiles "
          f"p50={np.percentile(d, 50):.1f} p75={np.percentile(d, 75):.1f} "
          f"p90={np.percentile(d, 90):.1f}  "
          f"seeded bg={100 * (mask == cv2.GC_PR_BGD).mean():.0f}% "
          f"fg={100 * (mask == cv2.GC_FGD).mean():.0f}%")

    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(img, mask, None, bgd, fgd, ITERS, cv2.GC_INIT_WITH_MASK)

    solid = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    solid = cv2.morphologyEx(solid, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    solid = cv2.morphologyEx(solid, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    solid = largest_component(solid)
    solid = fill_holes(solid, img, bg_colour)

    # Pull the edge in by a pixel before feathering. GrabCut's boundary sits ON
    # the last background pixel, so without this every silhouette keeps a thin
    # olive rim — which is exactly the halo that makes a cut-out look cut out.
    alpha = cv2.erode(solid, np.ones((3, 3), np.uint8), iterations=1)
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)

    rgba = np.dstack([img, alpha])
    ys, xs = np.nonzero(alpha > 8)
    if len(ys) == 0:
        print(f"  {name}: FAILED — empty mask")
        return None
    rgba = rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

    OUT.mkdir(exist_ok=True)
    cv2.imwrite(str(OUT / f"{name}.png"), rgba)

    kept = float((alpha > 128).mean())
    print(f"  {name}: {w}x{h} → {rgba.shape[1]}x{rgba.shape[0]}  kept {kept:.0%}")
    return solid


def main():
    names = sys.argv[1:] or list(CONFIG)
    LOOK.mkdir(exist_ok=True)
    for name in names:
        cut(name, CONFIG[name])


if __name__ == "__main__":
    main()
