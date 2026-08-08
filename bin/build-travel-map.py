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

WIDTH = 2400
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


def render(visited, ss=3):
    full_h = round(WIDTH / ((X1 - X0) / (Y1 - Y0)))
    w, h = WIDTH * ss, full_h * ss
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
    img = img.resize((WIDTH, round(img.height / ss)), Image.LANCZOS)
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


def clean(name):
    return name.split(",")[0].strip()


def is_named(name):
    """A few points reverse-geocoded to bare coordinates; do not show those."""
    return not re.fullmatch(r"[-\d.\s]+", clean(name))


def main():
    src = json.loads((ROOT / "bin" / "travel-source.json").read_text())
    visited = {c["code"] for c in src}

    sheet, top, bot, full_h = render(visited)
    sheet = age(sheet)
    out = ROOT / "assets" / "travel"
    out.mkdir(parents=True, exist_ok=True)
    sheet.save(out / "world-map-2400.jpg", "JPEG", quality=84, optimize=True, progressive=True)
    small = sheet.resize((1200, round(sheet.height * 1200 / WIDTH)), Image.LANCZOS)
    small.save(out / "world-map-1200.jpg", "JPEG", quality=82, optimize=True, progressive=True)
    print(f"wrote assets/travel/world-map-2400.jpg  {WIDTH}x{sheet.height}"
          f"  aspect {WIDTH / sheet.height:.5f}")

    proj = make_proj(WIDTH, round(full_h))
    rows = []
    for c in src:
        x, y = proj(c["pin"]["lng"], c["pin"]["lat"])
        cities = [ci for s in c.get("states", []) for ci in s.get("cities", [])] \
            or c.get("cities", [])
        cities.sort(key=lambda ci: -ci.get("visits", 0))
        rows.append({
            "code": c["code"], "name": c["name"], "region": c["region"],
            "x": round(x / WIDTH * 100, 3),
            "y": round((y - top) / (bot - top) * 100, 3),
            "cities": len(cities),
            "regions": len(c.get("states", [])),
            "top": [clean(ci["name"]) for ci in cities if is_named(ci["name"])][:6],
        })

    order = {"Americas": 0, "Europe": 1}
    rows.sort(key=lambda r: (order.get(r["region"], 9), -r["cities"], r["name"]))
    block = "[\n" + ",\n".join(
        "  " + json.dumps(r, ensure_ascii=False) for r in rows) + "\n]"

    js = ROOT / "js" / "travel-map.js"
    text = js.read_text()
    new, n = re.subn(
        r"(// <countries>[^\n]*\n).*?(\n\s*// </countries>)",
        lambda m: m.group(1) + "    var COUNTRIES = " + block + ";" + m.group(2),
        text, flags=re.S)
    if n != 1:
        sys.exit("could not find the // <countries> markers in js/travel-map.js")
    js.write_text(new)

    total = sum(r["cities"] for r in rows)
    print(f"rewrote js/travel-map.js: {len(rows)} countries, {total} places")
    print("now run: python3 bin/stamp-assets.py")


if __name__ == "__main__":
    main()
