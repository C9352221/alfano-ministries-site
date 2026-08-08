#!/usr/bin/env python3
"""Stamp css/js links with a content hash so deploys never serve mismatched assets.

GitHub Pages serves every asset with cache-control: max-age=600. HTML is
revalidated far more eagerly than the CSS it depends on, so for up to ten
minutes after a deploy a returning visitor can pair brand-new HTML with a
ten-minute-old stylesheet. That is what broke library.html: the page arrived
with .library-shelf markup while the browser still held a style.css that had
no .library-shelf rules, so the whole shelf rendered as unstyled text.

Appending ?v=<hash of the file> makes the URL change whenever the content
changes, so a new page can never request a stale stylesheet.

Run this after any edit to css/style.css or js/*.js, before committing.
"""

import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# The audiobook covers are here for the same reason: all three were rebuilt
# from portrait to square, and a cached portrait against the new markup gives
# ragged card heights on library.html and media.html.
ASSETS = [
    "css/style.css",
    "js/main.js",
    "js/audio-library.js",
    "js/travel-map.js",
    "assets/books/faith-to-build-audiobook.jpg",
    "assets/books/go-audiobook.jpg",
    "assets/books/wiser-audiobook.jpg",
]


def short_hash(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:10]


def main() -> int:
    versions = {}
    for asset in ASSETS:
        p = ROOT / asset
        if not p.exists():
            print(f"missing asset, skipping: {asset}")
            continue
        versions[asset] = short_hash(p)

    changed = []
    for html in sorted(ROOT.glob("*.html")):
        text = original = html.read_text(encoding="utf-8")
        for asset, ver in versions.items():
            # match the asset path with or without an existing ?v= stamp
            text = re.sub(
                re.escape(asset) + r"(?:\?v=[0-9a-f]+)?",
                f"{asset}?v={ver}",
                text,
            )
        if text != original:
            html.write_text(text, encoding="utf-8")
            changed.append(html.name)

    for asset, ver in versions.items():
        print(f"{asset:<24} v={ver}")
    print(f"\nstamped {len(changed)} file(s)")
    if changed:
        print("  " + ", ".join(changed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
