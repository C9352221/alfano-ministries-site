// ── Travel map: an antique wall map with a push pin in every country ──
// The image is a Winkel Tripel projection of Natural Earth data (public
// domain), rendered offline by bin/ tooling and shipped as a flat JPEG. Pin
// positions are baked in as percentages of that sheet, so they stay correct at
// any display size and no projection maths has to run in the browser.
//
// The old GPS heatmap still exists at travel-heatmap.html; this page replaced
// it as the default because a 13MB Leaflet iframe is close to unusable on a
// phone, which is the whole reason for the rebuild.
(function () {
    'use strict';

    // <countries>  regenerate with: python3 bin/build-travel-map.py
    var COUNTRIES = [
  {"code": "US", "name": "United States", "region": "Americas", "x": 28.004, "y": 34.119, "cities": 81, "regions": 18, "top": ["Hillsborough County", "North Franklin Township", "Robinson Township", "Charlotte", "Orange County", "Lakeland"]},
  {"code": "GT", "name": "Guatemala", "region": "Americas", "x": 25.072, "y": 48.981, "cities": 8, "regions": 0, "top": ["San Andrés Semetabaj", "Mixco", "Santa Cruz Muluá", "San Juan Bautista", "Zaragoza", "Fray Bartolomé de las Casas"]},
  {"code": "CA", "name": "Canada", "region": "Americas", "x": 33.254, "y": 23.98, "cities": 5, "regions": 0, "top": ["Victoria", "Mississauga", "Rivière-Koksoak", "Bridgewater"]},
  {"code": "HN", "name": "Honduras", "region": "Americas", "x": 25.972, "y": 48.661, "cities": 4, "regions": 0, "top": ["El Progreso", "Santa Cruz de Yojoa", "El Rosario", "La Lima"]},
  {"code": "MX", "name": "Mexico", "region": "Americas", "x": 23.976, "y": 46.394, "cities": 3, "regions": 0, "top": ["San Cristóbal", "Tuxtla Gutiérrez", "Ciudad de México"]},
  {"code": "AR", "name": "Argentina", "region": "Americas", "x": 35.061, "y": 84.205, "cities": 2, "regions": 0, "top": ["Buenos Aires", "Mar del Plata"]},
  {"code": "TT", "name": "Trinidad & Tobago", "region": "Americas", "x": 33.049, "y": 52.331, "cities": 2, "regions": 0, "top": []},
  {"code": "IT", "name": "Italy", "region": "Europe", "x": 52.865, "y": 30.464, "cities": 13, "regions": 0, "top": ["San Felice sul Panaro", "Torino", "Bologna", "Roma", "Lucca", "Venezia"]},
  {"code": "AT", "name": "Austria", "region": "Europe", "x": 53.329, "y": 26.475, "cities": 10, "regions": 0, "top": ["Eben am Achensee", "Wien", "Hallwang", "Parndorf/Pandrof", "Michelhausen", "Asten"]},
  {"code": "DE", "name": "Germany", "region": "Europe", "x": 52.429, "y": 25.73, "cities": 10, "regions": 0, "top": ["Oberding", "Frankfurt am Main", "Bad Wiessee", "Teisendorf", "Prien am Chiemsee", "Saulheim"]},
  {"code": "HU", "name": "Hungary", "region": "Europe", "x": 54.313, "y": 26.719, "cities": 10, "regions": 0, "top": ["Budapest", "Balatonfüred", "Sárszentmihály", "Velence", "Komárom", "Monori járás"]},
  {"code": "SE", "name": "Sweden", "region": "Europe", "x": 53.39, "y": 19.591, "cities": 10, "regions": 0, "top": ["Stockholm", "Sigtuna kommun", "Malmö", "Norrköping", "Linköping", "Hässleholms kommun"]},
  {"code": "GB", "name": "United Kingdom", "region": "Europe", "x": 49.298, "y": 22.569, "cities": 9, "regions": 0, "top": ["Greater London", "Belfast", "Reading", "Ayrshire", "Mid and East Antrim District", "South Ayrshire"]},
  {"code": "FR", "name": "France", "region": "Europe", "x": 50.533, "y": 25.115, "cities": 7, "regions": 0, "top": ["Paris", "Tillé", "Seclin", "Peuplingues", "Bornel", "Vémars"]},
  {"code": "DK", "name": "Denmark", "region": "Europe", "x": 52.748, "y": 20.945, "cities": 3, "regions": 0, "top": ["København", "Hillerød Kommune", "Køge Kommune"]},
  {"code": "NL", "name": "Netherlands", "region": "Europe", "x": 51.086, "y": 23.364, "cities": 3, "regions": 0, "top": ["Hoofddorp", "Amsterdam", "Oosthuizen"]},
  {"code": "TR", "name": "Turkey", "region": "Europe", "x": 57.179, "y": 31.049, "cities": 3, "regions": 0, "top": ["Arnavutköy", "Pendik", "Istanbul"]},
  {"code": "CH", "name": "Switzerland", "region": "Europe", "x": 52.144, "y": 27.754, "cities": 2, "regions": 0, "top": ["Lugano", "Ascona"]},
  {"code": "IS", "name": "Iceland", "region": "Europe", "x": 45.469, "y": 15.197, "cities": 1, "regions": 0, "top": ["Suðurnesjabær"]},
  {"code": "IE", "name": "Ireland", "region": "Europe", "x": 48.588, "y": 22.66, "cities": 1, "regions": 0, "top": ["Dublin"]},
  {"code": "MC", "name": "Monaco", "region": "Europe", "x": 51.807, "y": 29.331, "cities": 1, "regions": 0, "top": ["Monte Carlo"]},
  {"code": "PL", "name": "Poland", "region": "Europe", "x": 54.784, "y": 23.368, "cities": 1, "regions": 0, "top": ["Warsaw"]},
  {"code": "PT", "name": "Portugal", "region": "Europe", "x": 47.708, "y": 32.776, "cities": 1, "regions": 0, "top": ["Lisboa"]},
  {"code": "AE", "name": "United Arab Emirates", "region": "Middle East", "x": 64.717, "y": 41.877, "cities": 1, "regions": 0, "top": ["Dubai"]},
  {"code": "MU", "name": "Mauritius", "region": "Africa", "x": 65.557, "y": 74.081, "cities": 0, "regions": 0, "top": []}
];
    // </countries>

    // MAX is capped at what the detail sheet can actually resolve; going
    // further only magnifies JPEG, it does not add map.
    var MIN = 1, MAX = 5;
    var vp = document.getElementById('wm-viewport');
    if (!vp) return;
    var canvas = document.getElementById('wm-canvas');
    var panel  = document.getElementById('wm-panel');
    var list   = document.getElementById('wm-list');
    var reset  = document.getElementById('wm-reset');
    var sheet  = document.getElementById('wm-sheet');

    // baseScale is the resting zoom: 1 on a desktop, but on a phone the frame
    // is taller than the sheet, so the map rests zoomed in far enough to fill
    // it. Everything below compares against baseScale rather than 1, so the
    // resting state is never treated as "the user zoomed in".
    var scale = 1, tx = 0, ty = 0, selected = null;
    var baseScale = 1, baseTx = 0, baseTy = 0;

    // ── render pins and the country list ──
    var pinEls = {};
    COUNTRIES.forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'wm-pin';
        b.style.left = c.x + '%';
        b.style.top  = c.y + '%';
        b.setAttribute('aria-label', c.name);
        b.innerHTML = '<span class="wm-pin-needle"></span><span class="wm-pin-head"></span>';
        var tag = document.createElement('span');
        tag.className = 'wm-pin-label';
        tag.textContent = c.name;      // textContent, so "Trinidad & Tobago" is safe
        b.appendChild(tag);
        b.addEventListener('click', function (e) { e.stopPropagation(); select(c, true); });
        canvas.appendChild(b);
        pinEls[c.code] = b;
    });

    var groups = {};
    COUNTRIES.forEach(function (c) { (groups[c.region] = groups[c.region] || []).push(c); });
    Object.keys(groups).forEach(function (region) {
        var h = document.createElement('h3');
        h.className = 'wm-list-head';
        h.textContent = region + ' \u00b7 ' + groups[region].length;
        list.appendChild(h);
        var row = document.createElement('div');
        row.className = 'wm-chips';
        groups[region].forEach(function (c) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'wm-chip';
            b.dataset.code = c.code;
            b.textContent = c.name;
            b.addEventListener('click', function () { select(c, true); });
            row.appendChild(b);
        });
        list.appendChild(row);
    });

    // ── detail sheet ──
    // The page opens on a 2400px sheet, which is plenty at resting zoom and
    // costs ~190KB. Zooming past that turns it to mush, so the first time the
    // reader zooms in, fetch the 6000px version and swap it in once it has
    // decoded. Nobody who only looks at the world view ever pays for it.
    var detailSrc = sheet.getAttribute('data-detail');
    var detailAsked = false;

    function loadDetail() {
        if (detailAsked || !detailSrc) return;
        detailAsked = true;
        var pre = new Image();
        pre.onload = function () {
            // srcset outranks src, so it has to go or the swap does nothing
            sheet.removeAttribute('srcset');
            sheet.removeAttribute('sizes');
            sheet.src = detailSrc;
        };
        pre.src = detailSrc;
    }

    // ── transform ──
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function apply() {
        // never pan the sheet past the point where the board shows through an
        // edge it should not; measured against the sheet, not the viewport,
        // because the two have different aspect ratios on a phone
        var maxX = Math.max(0, (canvas.clientWidth  * scale - vp.clientWidth)  / 2);
        var maxY = Math.max(0, (canvas.clientHeight * scale - vp.clientHeight) / 2);
        tx = clamp(tx, -maxX, maxX);
        ty = clamp(ty, -maxY, maxY);
        canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
        canvas.style.setProperty('--wm-inv', 1 / scale);
        // Only take the whole gesture once the user has zoomed past resting
        // scale. At rest touch-action stays pan-y so a thumb dragged up the
        // screen scrolls the page instead of being swallowed by the map.
        vp.classList.toggle('is-zoomed', scale > baseScale * 1.01);
        if (scale > baseScale * 1.2) loadDetail();
    }

    function pannable() {
        return (canvas.clientWidth  * scale - vp.clientWidth)  > 1 ||
               (canvas.clientHeight * scale - vp.clientHeight) > 1;
    }

    function zoomAt(next, cx, cy) {
        next = clamp(next, baseScale, MAX);
        var r = vp.getBoundingClientRect();
        // keep the point under the cursor fixed
        var px = (cx - r.left - r.width / 2 - tx) / scale;
        var py = (cy - r.top - r.height / 2 - ty) / scale;
        tx -= px * (next - scale);
        ty -= py * (next - scale);
        scale = next;
        apply();
    }

    function centreOn(c, next) {
        scale = clamp(next, baseScale, MAX);
        var w = canvas.clientWidth, h = canvas.clientHeight;
        tx = -((c.x / 100) * w - w / 2) * scale;
        ty = -((c.y / 100) * h - h / 2) * scale;
        canvas.classList.add('is-animating');
        apply();
        setTimeout(function () { canvas.classList.remove('is-animating'); }, 420);
    }

    function select(c, move) {
        selected = c;
        Object.keys(pinEls).forEach(function (k) {
            pinEls[k].classList.toggle('is-active', k === c.code);
        });
        list.querySelectorAll('.wm-chip').forEach(function (b) {
            b.classList.toggle('is-active', b.dataset.code === c.code);
        });
        var places = c.top.length
            ? '<p class="wm-places">' + c.top.join(' \u00b7 ') + (c.cities > c.top.length ? ' \u2026' : '') + '</p>'
            : '';
        // Countries with no logged GPS points get the pin and the name only;
        // "0 places" reads like a bug rather than like a place he has been.
        var count = c.cities
            ? '<p class="wm-count">' + c.cities + ' ' + (c.cities === 1 ? 'place' : 'places') +
              (c.regions ? ' across ' + c.regions + ' states' : '') + '</p>'
            : '';
        panel.innerHTML =
            '<div class="wm-panel-in">' +
              '<span class="wm-panel-eyebrow">Pinned</span>' +
              '<h3>' + c.name + '</h3>' +
              count +
              places +
            '</div>';
        panel.classList.add('is-open');
        if (move) centreOn(c, Math.max(scale, c.region === 'Europe' ? 4.5 : 2.6));
    }

    // ── pointer gestures ──
    var pts = {}, last = null, pinchStart = 0, scaleStart = 1, moved = 0;

    vp.addEventListener('pointerdown', function (e) {
        pts[e.pointerId] = { x: e.clientX, y: e.clientY };
        var ids = Object.keys(pts);
        if (ids.length === 1) { last = { x: e.clientX, y: e.clientY }; moved = 0; }
        if (ids.length === 2) {
            pinchStart = dist(); scaleStart = scale;
        }
        vp.setPointerCapture(e.pointerId);
    });

    vp.addEventListener('pointermove', function (e) {
        if (!pts[e.pointerId]) return;
        pts[e.pointerId] = { x: e.clientX, y: e.clientY };
        var ids = Object.keys(pts);
        if (ids.length === 2 && pinchStart > 0) {
            var mid = midpoint();
            zoomAt(scaleStart * (dist() / pinchStart), mid.x, mid.y);
        } else if (ids.length === 1 && last && pannable()) {
            tx += e.clientX - last.x;
            ty += e.clientY - last.y;
            moved += Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y);
            last = { x: e.clientX, y: e.clientY };
            apply();
        }
    });

    function release(e) {
        delete pts[e.pointerId];
        if (Object.keys(pts).length < 2) pinchStart = 0;
        if (Object.keys(pts).length === 0) last = null;
    }
    vp.addEventListener('pointerup', release);
    vp.addEventListener('pointercancel', release);

    function dist() {
        var v = Object.keys(pts).map(function (k) { return pts[k]; });
        return Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y);
    }
    function midpoint() {
        var v = Object.keys(pts).map(function (k) { return pts[k]; });
        return { x: (v[0].x + v[1].x) / 2, y: (v[0].y + v[1].y) / 2 };
    }

    vp.addEventListener('wheel', function (e) {
        if (!e.ctrlKey && scale <= baseScale * 1.01 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) return; // let the page scroll
        e.preventDefault();
        zoomAt(scale * (e.deltaY < 0 ? 1.16 : 1 / 1.16), e.clientX, e.clientY);
    }, { passive: false });

    vp.addEventListener('dblclick', function (e) {
        e.preventDefault();
        zoomAt(scale > baseScale * 1.5 ? baseScale : baseScale * 3.2, e.clientX, e.clientY);
    });

    document.getElementById('wm-in').addEventListener('click', function () {
        var r = vp.getBoundingClientRect();
        zoomAt(scale * 1.5, r.left + r.width / 2, r.top + r.height / 2);
    });
    document.getElementById('wm-out').addEventListener('click', function () {
        var r = vp.getBoundingClientRect();
        zoomAt(scale / 1.5, r.left + r.width / 2, r.top + r.height / 2);
    });
    reset.addEventListener('click', function () {
        scale = baseScale; tx = baseTx; ty = baseTy;
        selected = null;
        Object.keys(pinEls).forEach(function (k) { pinEls[k].classList.remove('is-active'); });
        list.querySelectorAll('.wm-chip').forEach(function (b) { b.classList.remove('is-active'); });
        panel.classList.remove('is-open');
        panel.innerHTML = '';
        canvas.classList.add('is-animating');
        apply();
        setTimeout(function () { canvas.classList.remove('is-animating'); }, 420);
    });

    // On a phone the frame is taller than the sheet, so open zoomed far enough
    // to fill it, centred on the middle of the pins rather than on the empty
    // Pacific that sits at the centre of the sheet.
    var FOCUS = COUNTRIES.reduce(function (a, c) {
        return { x: a.x + c.x / COUNTRIES.length, y: a.y + c.y / COUNTRIES.length };
    }, { x: 0, y: 0 });

    function initialView() {
        var cw = canvas.clientWidth, ch = canvas.clientHeight;
        if (!ch) return;
        baseScale = clamp(vp.clientHeight / ch, MIN, MAX);
        scale = baseScale;
        if (baseScale > 1.001) {
            tx = -((FOCUS.x / 100) * cw - cw / 2) * scale;
            ty = -((FOCUS.y / 100) * ch - ch / 2) * scale;
        } else {
            tx = 0; ty = 0;
        }
        apply();
        baseTx = tx; baseTy = ty;   // record post-clamp so Reset lands here exactly
    }

    window.addEventListener('resize', function () {
        scale <= baseScale * 1.01 ? initialView() : apply();
    });
    if (document.getElementById('wm-sheet').complete) initialView();
    else document.getElementById('wm-sheet').addEventListener('load', initialView);
    apply();
})();
