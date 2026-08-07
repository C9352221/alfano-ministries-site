/**
 * Audio library gate — shared by listen*.html and library.html
 *
 * The ElevenLabs project IDs are NOT in page source. They come back from the
 * audio-access worker only after it verifies a signed token against the
 * entitlement store, and the player is built in JavaScript from that response.
 *
 * Markup contract:
 *   [data-gate="loading"]   shown while the unlock call is in flight
 *   [data-gate="locked"]    partner invitation + "email me a link" form
 *   [data-gate="unlocked"]  empty container the player is mounted into
 *   [data-book="<slug>"]    on a listen page, which book to mount
 *   [data-gate-form]        the sign-in form
 *   [data-gate-msg]         status line for that form
 *   [data-account-email]    filled with the signed-in address
 */
(function () {
  "use strict";

  var ENDPOINT = "https://audio-access.alfanoministries.workers.dev";
  var HELPER = "https://elevenlabs.io/player/audioNativeHelper.js";
  var PLAYER_URL = "https://elevenlabs.io/player/index.html";
  var TOKEN_KEY = "am_audio_token";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }

  /* ---------- token handling ---------- */

  function store(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* private mode */ } }
  function fetchStored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function drop(key) { try { localStorage.removeItem(key); } catch (e) { /* private mode */ } }

  // A token arriving as ?t= is saved, then stripped from the address bar so it
  // does not end up in a screenshot, a shared link, or the browser history entry.
  function takeToken() {
    var url = new URL(window.location.href);
    var t = url.searchParams.get("t");
    if (t) {
      store(TOKEN_KEY, t);
      url.searchParams.delete("t");
      history.replaceState(null, "", url.pathname + (url.search || "") + (url.hash || ""));
      return t;
    }
    return fetchStored(TOKEN_KEY);
  }

  function post(path, body) {
    return fetch(ENDPOINT + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        return { status: r.status, data: data };
      });
    });
  }

  /* ---------- player ---------- */

  function mountPlayer(container, publicUserId, projectId) {
    var d = document.createElement("div");
    d.id = "elevenlabs-audionative-widget";
    d.setAttribute("data-height", "90");
    d.setAttribute("data-width", "100%");
    d.setAttribute("data-frameborder", "no");
    d.setAttribute("data-scrolling", "no");
    d.setAttribute("data-publicuserid", publicUserId);
    d.setAttribute("data-playerurl", PLAYER_URL);
    d.setAttribute("data-projectid", projectId);
    d.textContent = "Loading the audiobook player...";
    container.appendChild(d);

    // The helper scans the DOM for the widget as it loads, so it has to be
    // added after the div exists. A static tag in the page would run too early.
    var s = document.createElement("script");
    s.src = HELPER;
    s.type = "text/javascript";
    document.body.appendChild(s);
  }

  /* ---------- states ---------- */

  function setState(name) {
    $$("[data-gate]").forEach(function (el) {
      if (el.getAttribute("data-gate") === name) show(el); else hide(el);
    });
  }

  function renderUnlocked(payload) {
    var slot = $('[data-gate="unlocked"]');
    var host = $("[data-book]");
    var slug = host && host.getAttribute("data-book");

    if (slot && slug) {
      var book = null;
      (payload.books || []).forEach(function (b) { if (b.slug === slug) book = b; });
      if (!book) {
        // Signed in, but this page's book was not in the entitlement response.
        setState("locked");
        return;
      }
      mountPlayer(slot, payload.publicUserId, book.projectId);
    }

    $$("[data-account-email]").forEach(function (el) { el.textContent = payload.email || ""; });
    setState("unlocked");
  }

  /* ---------- sign-in form ---------- */

  function wireForm() {
    var form = $("[data-gate-form]");
    if (!form) return;
    var msg = $("[data-gate-msg]");

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = form.querySelector('input[type="email"]');
      var btn = form.querySelector("button");
      var email = (input && input.value || "").trim();

      if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
        if (msg) { msg.textContent = "Please enter a valid email address."; msg.className = "gate-msg gate-msg-error"; }
        return;
      }

      if (btn) { btn.disabled = true; btn.textContent = "Sending..."; }
      if (msg) { msg.textContent = ""; msg.className = "gate-msg"; }

      post("/request", { email: email }).then(function (res) {
        if (msg) {
          msg.textContent = (res.data && res.data.message) || "If that email has access, a sign-in link is on its way.";
          msg.className = "gate-msg gate-msg-ok";
        }
        if (btn) { btn.disabled = false; btn.textContent = "Send my sign-in link"; }
        form.reset();
      }).catch(function () {
        if (msg) { msg.textContent = "Something went wrong. Please try again in a moment."; msg.className = "gate-msg gate-msg-error"; }
        if (btn) { btn.disabled = false; btn.textContent = "Send my sign-in link"; }
      });
    });
  }

  /* ---------- boot ---------- */

  function init() {
    wireForm();

    var token = takeToken();
    if (!token) { setState("locked"); return; }

    setState("loading");
    post("/unlock", { token: token }).then(function (res) {
      if (res.status === 200 && res.data && res.data.unlocked) {
        renderUnlocked(res.data);
        return;
      }
      // 401 invalid / 403 lapsed: the stored token is worthless either way.
      drop(TOKEN_KEY);
      setState("locked");
      if (res.status === 403) {
        var msg = $("[data-gate-msg]");
        if (msg) {
          msg.textContent = "Your access has ended. Renew your partnership to listen again.";
          msg.className = "gate-msg gate-msg-error";
        }
      }
    }).catch(function () {
      setState("locked");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
