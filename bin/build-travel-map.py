#!/usr/bin/env python3
"""Rebuild the antique wall map on travel-map.html.

Renders assets/travel/world-map-{1200,2400}.jpg from Natural Earth coastlines
and rewrites the COUNTRIES array inside js/travel-map.js so the pins match.

Everything the page needs comes from bin/travel-source.json: one entry per
country, each with the visit-averaged coordinate the pin sits on and the list
of cities behind it. To add a country, add an entry there and re-run this.

    python3 bin/build-travel-map.py
    python3 bin/stamp-assets.py        # always, afterwards

The projection is Winkel Tripel, which is what National Geographic switched to
in 1998, so the sheet reads like the wall map in chapter 3 of The Last Convert
rather than a stretched Mercator. Pin positions are baked out as percentages
of the finished sheet, so the browser never has to project anything.

Needs Pillow. The Natural Earth coastline file (public domain) is downloaded
once to bin/.cache/ and reused.
"""

import json
import math
import pathlib
import re
import sys
import urllib.request

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "bin" / ".cache"
NE_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
          "master/geojson/ne_50m_admin_0_countries.geojson")

WIDTH = 2400          # the sheet the page loads first
DETAIL = 6000         # lazy-loaded once the reader zooms in; see js/travel-map.js
LAT_TOP, LAT_BOT = 86.0, -58.0   # crop Antarctica off the sheet, as wall maps do

OCEAN = (183, 201, 205)
LAND = (228, 213, 179)
LANDV = (206, 170, 112)          # countries he has been to
INK = (108, 88, 62)
COAST = (92, 74, 52)
GRAT = (168, 154, 128)

# ISO_A2 is "-99" for a few countries in Natural Earth; patch the ones we use.
NAME_FIX = {"France": "FR", "Norway": "NO", "Monaco": "MC",
            "Trinidad and Tobago": "TT"}

PHI1 = math.acos(2 / math.pi)


def winkel(lon, lat):
    lam, phi = math.radians(lon), math.radians(lat)
    a = math.acos(max(-1.0, min(1.0, math.cos(phi) * math.cos(lam / 2))))
    sinc = 1.0 if a == 0 else math.sin(a) / a
    x = 0.5 * (lam * math.cos(PHI1) + (2 * math.cos(phi) * math.sin(lam / 2)) / sinc)
    y = 0.5 * (phi + math.sin(phi) / sinc)
    return x, y


X0, X1 = winkel(-180, 0)[0], winkel(180, 0)[0]
Y0, Y1 = winkel(0, -90)[1], winkel(0, 90)[1]     # Y1 is up


def make_proj(w, h):
    s = min(w / (X1 - X0), h / (Y1 - Y0))
    ox = (w - s * (X1 - X0)) / 2
    oy = (h - s * (Y1 - Y0)) / 2

    def p(lon, lat):
        x, y = winkel(lon, lat)
        return ox + (x - X0) * s, oy + (Y1 - y) * s
    return p


def rings(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"][0]]
    if geom["type"] == "MultiPolygon":
        return [poly[0] for poly in geom["coordinates"]]
    return []


def coastlines():
    CACHE.mkdir(exist_ok=True)
    local = CACHE / "ne_50m_admin_0_countries.geojson"
    if not local.exists():
        print(f"downloading {NE_URL}")
        urllib.request.urlretrieve(NE_URL, local)
    feats = []
    for f in json.loads(local.read_text())["features"]:
        props = f["properties"]
        name = props.get("NAME") or props.get("ADMIN") or ""
        if name == "Antarctica":
            continue
        code = props.get("ISO_A2") or "-99"
        if code in ("-99", "", None):
            code = NAME_FIX.get(name, "-99")
        feats.append((code, f["geometry"]))
    return feats


def render(visited, width=WIDTH, ss=3):
    full_h = round(width / ((X1 - X0) / (Y1 - Y0)))
    w, h = width * ss, full_h * ss
    proj = make_proj(w, h)
    img = Image.new("RGB", (w, h), OCEAN)
    d = ImageDraw.Draw(img)

    feats = coastlines()
    seen = set()
    for code, geom in feats:
        if code in visited:
            seen.add(code)
        fill = LANDV if code in visited else LAND
        for ring in rings(geom):
            pts = [proj(x, y) for x, y in ring]
            if len(pts) > 2:
                d.polygon(pts, fill=fill, outline=INK)
    for code, geom in feats:                       # darker engraved coast
        for ring in rings(geom):
            pts = [proj(x, y) for x, y in ring]
            if len(pts) > 2:
                d.line(pts + [pts[0]], fill=COAST, width=max(1, ss // 2))

    missing = visited - seen
    if missing:
        print(f"warning: no polygon matched {sorted(missing)} (pins still fine)")

    g = Image.new("RGB", (w, h), (255, 255, 255))
    gd = ImageDraw.Draw(g)
    for lon in range(-180, 181, 20):
        gd.line([proj(lon, la) for la in range(-58, 87)], fill=GRAT, width=ss)
    for lat in range(-40, 81, 20):
        gd.line([proj(lo, lat) for lo in range(-180, 181, 2)], fill=GRAT, width=ss)
    gd.line([proj(lo, 0) for lo in range(-180, 181, 2)], fill=INK, width=ss * 2)
    img = ImageChops.multiply(img, g)

    top, bot = proj(0, LAT_TOP)[1], proj(0, LAT_BOT)[1]
    img = img.crop((0, int(top), w, int(bot)))
    img = img.resize((width, round(img.height / ss)), Image.LANCZOS)
    return img, top / ss, bot / ss, full_h


def age(img):
    """Paper stain, grain and edge darkening. Radii scale with the image."""
    w, h = img.size
    n = Image.effect_noise((max(1, w // 10), max(1, h // 10)), 36)
    n = n.resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(w / 200))
    img = ImageChops.multiply(img, Image.merge("RGB", (n, n, n)).point(lambda v: 214 + v * 0.16))
    g = Image.effect_noise((w, h), 7).point(lambda v: 226 + v * 0.11)
    img = ImageChops.multiply(img, Image.merge("RGB", (g, g, g)))
    v = Image.new("L", (w, h), 0)
    ImageDraw.Draw(v).rectangle([w * 0.02, h * 0.03, w * 0.98, h * 0.97], fill=255)
    v = v.filter(ImageFilter.GaussianBlur(min(w, h) / 16)).point(lambda p: 212 + p * 0.17)
    return ImageChops.multiply(img, Image.merge("RGB", (v, v, v)))


def country_path(geom, proj, top, budget=9000):
    """SVG path for a country, in sheet pixel space, for the highlight overlay.

    Tolerance is raised per country until the path fits the budget, so Canada's
    Arctic archipelago cannot quietly cost 36KB while Monaco costs 40 bytes.
    The shapes only ever sit under a translucent wash, so coarse is fine; what
    matters is that the total stays small enough to inline.
    """
    tol = 0.8
    while True:
        parts = []
        for ring in rings(geom):
            pts = []
            for lon, lat in ring:
                x, y = proj(lon, lat)
                y -= top
                if pts and abs(x - pts[-1][0]) < tol and abs(y - pts[-1][1]) < tol:
                    continue
                pts.append((x, y))
            if len(pts) < 3:
                continue
            xs = [q[0] for q in pts]
            ys = [q[1] for q in pts]
            if max(xs) - min(xs) < 1.2 and max(ys) - min(ys) < 1.2:
                continue        # an islet too small to see even zoomed in
            parts.append("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in pts) + "Z")
        d = "".join(parts)
        if len(d) <= budget or tol > 6:
            return d
        tol *= 1.6


def draw_pins(sheet, rows, ss=4):
    """Bake push pins onto a copy of the sheet, for the teaser on marketplace.

    The live map draws its pins as HTML so they stay crisp and clickable; this
    is the flat version for pages that only link through to it.
    """
    W, H = sheet.size
    r = max(5, round(W / 150))          # head radius, scaled to the sheet
    lay = Image.new("RGBA", (W * ss, H * ss), (0, 0, 0, 0))
    shadow = Image.new("RGBA", lay.size, (0, 0, 0, 0))
    sd, R = ImageDraw.Draw(shadow), r * ss
    spots = [((row["x"] / 100) * W * ss, (row["y"] / 100) * H * ss) for row in rows]
    for x, y in spots:
        sd.ellipse([x - R * 0.4, y - R * 0.55 + R * 0.75,
                    x + R * 1.6, y + R * 0.8 + R * 0.75], fill=(60, 45, 30, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(R * 0.35))
    lay = Image.alpha_composite(lay, shadow)
    d = ImageDraw.Draw(lay)
    for x, y in spots:
        d.line([(x, y), (x + R * 0.30, y + R * 1.5)], fill=(70, 60, 50, 220),
               width=max(1, int(R * 0.16)))
        d.ellipse([x - R, y - R, x + R, y + R], fill=(176, 42, 36),
                  outline=(74, 20, 16, 255), width=max(1, int(R * 0.10)))
        d.ellipse([x - R * 0.52, y - R * 0.62, x - R * 0.02, y - R * 0.14],
                  fill=(238, 133, 122, 210))
    out = sheet.convert("RGBA")
    out.alpha_composite(lay.resize((W, H), Image.LANCZOS))
    return out.convert("RGB")


def clean(name):
    return name.split(",")[0].strip()


def is_named(name):
    """A few points reverse-geocoded to bare coordinates; do not show those."""
    return not re.fullmatch(r"[-\d.\s]+", clean(name))


def main():
    src = json.loads((ROOT / "bin" / "travel-source.json").read_text())
    # sub-regions like Hawaii are pinned but are not countries, so they have no
    # ISO code to tint or draw a shape for
    visited = {c["code"] for c in src if "part_of" not in c}

    out = ROOT / "assets" / "travel"
    out.mkdir(parents=True, exist_ok=True)

    # One geometry pass at detail resolution, then age each size separately so
    # the paper grain is sized for the sheet it lands on rather than being
    # smoothed away by the downscale.
    big, top_d, bot_d, _ = render(visited, DETAIL, ss=2)
    age(big).save(out / f"world-map-{DETAIL}.jpg", "JPEG",
                  quality=78, optimize=True, progressive=True)
    print(f"wrote world-map-{DETAIL}.jpg  {big.width}x{big.height}")

    sheet = age(big.resize((WIDTH, round(big.height * WIDTH / DETAIL)), Image.LANCZOS))
    sheet.save(out / "world-map-2400.jpg", "JPEG", quality=84, optimize=True, progressive=True)
    small = age(big.resize((1200, round(big.height * 1200 / DETAIL)), Image.LANCZOS))
    small.save(out / "world-map-1200.jpg", "JPEG", quality=82, optimize=True, progressive=True)
    del big
    print(f"wrote world-map-2400.jpg  {WIDTH}x{sheet.height}"
          f"  aspect {WIDTH / sheet.height:.5f}")

    top, bot, full_h = top_d * WIDTH / DETAIL, bot_d * WIDTH / DETAIL, \
        round(WIDTH / ((X1 - X0) / (Y1 - Y0)))

    proj = make_proj(WIDTH, full_h)
    shapes = {}
    for code, geom in coastlines():
        if code in visited:
            shapes[code] = shapes.get(code, "") + country_path(geom, proj, top)

    by_code = {c["code"]: c for c in src}
    rows = []
    for c in src:
        x, y = proj(c["pin"]["lng"], c["pin"]["lat"])
        parent = by_code.get(c.get("part_of"))
        if parent:
            # a region pinned inside a country it does not replace, e.g. Hawaii.
            # Its cities belong to the parent and are already counted there.
            state = next((st for st in parent.get("states", [])
                          if st["name"] == c.get("state")), None)
            cities, regions = (state or {}).get("cities", []), 0
        else:
            cities = [ci for st in c.get("states", []) for ci in st.get("cities", [])] \
                or c.get("cities", [])
            regions = len(c.get("states", []))
        cities = sorted(cities, key=lambda ci: -ci.get("visits", 0))
        row = {
            "code": c["code"], "name": c["name"], "region": c["region"],
            "x": round(x / WIDTH * 100, 3),
            "y": round((y - top) / (bot - top) * 100, 3),
            "cities": len(cities),
            "regions": regions,
            # every place, not a top-six: the card is the record of where he
            # actually went, and a truncated list just raises the question
            "places": [clean(ci["name"]) for ci in cities if is_named(ci["name"])],
            # the handful the geocoder only ever gave coordinates for, so the
            # count and the list cannot silently disagree
            "unnamed": sum(1 for ci in cities if not is_named(ci["name"])),
            "d": shapes.get(c["code"], ""),
        }
        if parent:
            row["partOf"] = parent["name"]
        rows.append(row)

    order = {"Americas": 0, "Europe": 1, "Middle East": 2, "Africa": 3}
    rows.sort(key=lambda r: (order.get(r["region"], 9), -r["cities"], r["name"]))
    block = ("{\n  \"viewBox\": \"0 0 %d %.2f\",\n  \"list\": [\n"
             % (WIDTH, bot - top)) + ",\n".join(
        "    " + json.dumps(r, ensure_ascii=False) for r in rows) + "\n  ]\n}"

    pinned = draw_pins(small, rows)
    pinned.save(out / "world-map-pinned-1200.jpg", "JPEG",
                quality=84, optimize=True, progressive=True)
    print(f"wrote world-map-pinned-1200.jpg  {pinned.width}x{pinned.height}")

    js = ROOT / "js" / "travel-map.js"
    text = js.read_text()
    new, n = re.subn(
        r"(// <countries>[^\n]*\n).*?(\n\s*// </countries>)",
        lambda m: m.group(1) + "    var MAPDATA = " + block + ";" + m.group(2),
        text, flags=re.S)
    if n != 1:
        sys.exit("could not find the // <countries> markers in js/travel-map.js")
    js.write_text(new)

    countries = [r for r in rows if "partOf" not in r]
    total = sum(r["cities"] for r in countries)   # sub-regions would double count
    shape_kb = sum(len(r["d"]) for r in rows) / 1024
    noshape = [r["code"] for r in rows if not r["d"]]
    print(f"rewrote js/travel-map.js: {len(countries)} countries, {total} places, "
          f"{len(rows)} pins, {shape_kb:.1f}KB of highlight shapes")
    print(f"  headline for travel-map.html: {len(countries)} countries \u00b7 {total} places")
    if noshape:
        print(f"warning: no highlight shape for {noshape}")
    print("now run: python3 bin/stamp-assets.py")


if __name__ == "__main__":
    main()
