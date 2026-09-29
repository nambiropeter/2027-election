/* KPolls Kenya - poll page controller.
 *
 * Talks to one backend, chosen by window.KPOLLS_CONFIG.apiBase. The previous
 * version read the poll from Supabase but posted votes to a relative /api/vote
 * that did not exist on static hosting, so every vote failed; everything here
 * goes through resolveUrl() so the read and write paths cannot drift apart
 * again.
 */

(function () {
  "use strict";

  var CONFIG = window.KPOLLS_CONFIG || {};
  var TOKEN_KEY = "kpolls_voter_token";
  var CONSENT_KEY = "kpolls_ad_consent";
  var THEME_KEY = "kpolls_theme";
  var TOKEN_HEADER = "x-voter-token";

  var state = {
    pollId: null,
    options: [],
    totalVotes: 0,
    hasVoted: false,
    votedOptionId: null,
    countryAllowed: true,
    country: "--",
    submitting: false,
    loaded: false,
  };

  var el = {};
  var refreshTimer = null;

  // --- storage (private mode and blocked cookies must not break the page) ---

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_) {
      /* Storage unavailable: the cookie fallback still carries the session. */
    }
  }

  // --- api ------------------------------------------------------------------

  function resolveUrl(path) {
    var base = (CONFIG.apiBase || "").replace(/\/+$/, "");
    return base ? base + path : "/api" + path;
  }

  function requestHeaders(includeJson) {
    var headers = {};
    if (includeJson) {
      headers["Content-Type"] = "application/json";
    }

    var token = storageGet(TOKEN_KEY);
    if (token) {
      headers[TOKEN_HEADER] = token;
    }

    if (CONFIG.supabaseAnonKey) {
      headers.apikey = CONFIG.supabaseAnonKey;
      headers.Authorization = "Bearer " + CONFIG.supabaseAnonKey;
    }

    return headers;
  }

  /**
   * Always resolves to { ok, status, data }. A 404 HTML page or an empty body
   * used to throw inside response.json() and surface as "Network error";
   * parsing defensively keeps the real status visible.
   */
  function request(path, options) {
    var settings = options || {};
    return fetch(resolveUrl(path), {
      method: settings.method || "GET",
      headers: requestHeaders(Boolean(settings.body)),
      body: settings.body ? JSON.stringify(settings.body) : undefined,
      credentials: "include",
      cache: "no-store",
    }).then(function (response) {
      var headerToken = response.headers.get(TOKEN_HEADER);
      if (headerToken) {
        storageSet(TOKEN_KEY, headerToken);
      }

      return response.text().then(function (text) {
        var data = {};
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (_) {
            data = { error: "Unexpected response from the server." };
          }
        }

        if (data && data.token) {
          storageSet(TOKEN_KEY, data.token);
        }

        return { ok: response.ok, status: response.status, data: data };
      });
    });
  }

  // --- rendering helpers ----------------------------------------------------

  function icon(paths, extraClass) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    if (extraClass) {
      svg.setAttribute("class", extraClass);
    }

    paths.forEach(function (d) {
      var node = document.createElementNS("http://www.w3.org/2000/svg", "path");
      node.setAttribute("d", d);
      svg.appendChild(node);
    });

    return svg;
  }

  var ICONS = {
    check: ["M20 6 9 17l-5-5"],
    alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L14.7 3.9a2 2 0 0 0-3.4 0z"],
    info: ["M12 16v-4", "M12 8h.01", "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"],
    crown: ["m3 7 4.5 4L12 5l4.5 6L21 7l-2 11H5L3 7z"],
  };

  /** Splits "Name - descriptor" into a bold name and a muted note. */
  function splitLabel(label) {
    var separator = label.indexOf(" - ");
    if (separator === -1) {
      return { name: label, note: "" };
    }
    return {
      name: label.slice(0, separator),
      note: label.slice(separator + 3),
    };
  }

  function percentOf(votes, total) {
    return total > 0 ? (votes / total) * 100 : 0;
  }

  function formatNumber(value) {
    return value.toLocaleString("en-KE");
  }

  function showAlert(kind, message) {
    el.alert.className = "alert alert-" + kind;
    el.alert.textContent = "";
    el.alert.appendChild(icon(kind === "ok" ? ICONS.check : kind === "warn" ? ICONS.info : ICONS.alert));
    var text = document.createElement("span");
    text.textContent = message;
    el.alert.appendChild(text);
    el.alert.hidden = false;
    el.alert.setAttribute("role", kind === "error" ? "alert" : "status");
  }

  function clearAlert() {
    el.alert.hidden = true;
  }

  // --- ballot ---------------------------------------------------------------

  function renderBallot() {
    el.options.textContent = "";

    state.options.forEach(function (option) {
      var parts = splitLabel(option.label);

      var label = document.createElement("label");
      label.className = "option";

      var input = document.createElement("input");
      input.type = "radio";
      input.name = "option";
      input.value = String(option.id);
      input.addEventListener("change", function () {
        el.submit.disabled = false;
        clearAlert();
      });

      var dot = document.createElement("span");
      dot.className = "dot";

      var body = document.createElement("span");
      body.className = "option-body";

      var name = document.createElement("span");
      name.className = "option-name";
      name.textContent = parts.name;
      body.appendChild(name);

      if (parts.note) {
        var note = document.createElement("span");
        note.className = "option-note";
        note.textContent = parts.note;
        body.appendChild(note);
      }

      label.appendChild(input);
      label.appendChild(dot);
      label.appendChild(body);
      el.options.appendChild(label);
    });
  }

  // --- results --------------------------------------------------------------

  /**
   * One horizontal bar per candidate, sorted by share.
   *
   * Every bar uses the same hue on purpose: this is a single series, and
   * magnitude is already carried by bar length. Colouring each candidate
   * differently would double-encode length as hue and make the chart harder to
   * read, so identity comes from the label and from the "Your vote" / "Leading"
   * pills rather than from colour.
   */
  function renderResults() {
    var sorted = state.options.slice().sort(function (a, b) {
      return b.votes - a.votes || a.id - b.id;
    });

    var leaderVotes = sorted.length ? sorted[0].votes : 0;

    el.total.textContent = "";
    var strong = document.createElement("strong");
    strong.textContent = formatNumber(state.totalVotes);
    el.total.appendChild(strong);
    el.total.appendChild(
      document.createTextNode(" " + (state.totalVotes === 1 ? "vote" : "votes") + " cast")
    );

    el.bars.textContent = "";

    sorted.forEach(function (option) {
      var parts = splitLabel(option.label);
      var pct = percentOf(option.votes, state.totalVotes);
      var isMine = state.votedOptionId === option.id;
      var isLeader = state.totalVotes > 0 && option.votes === leaderVotes;

      var row = document.createElement("div");
      row.className = "bar-row" + (isMine ? " is-mine" : "");

      var head = document.createElement("div");
      head.className = "bar-label";

      var name = document.createElement("div");
      name.className = "bar-name";
      var nameText = document.createElement("span");
      nameText.textContent = parts.name;
      name.appendChild(nameText);

      if (isMine) {
        var minePill = document.createElement("span");
        minePill.className = "pill pill-mine";
        minePill.appendChild(icon(ICONS.check));
        minePill.appendChild(document.createTextNode("Your vote"));
        name.appendChild(minePill);
      }

      if (isLeader && !isMine) {
        var leadPill = document.createElement("span");
        leadPill.className = "pill";
        leadPill.textContent = "Leading";
        name.appendChild(leadPill);
      }

      var value = document.createElement("div");
      value.className = "bar-value";
      value.textContent = pct.toFixed(1) + "%";
      var count = document.createElement("span");
      count.textContent = formatNumber(option.votes);
      value.appendChild(count);

      head.appendChild(name);
      head.appendChild(value);

      var track = document.createElement("div");
      track.className = "bar-track";
      track.setAttribute("role", "img");
      track.setAttribute(
        "aria-label",
        parts.name + ": " + formatNumber(option.votes) + " votes, " + pct.toFixed(1) + " percent"
      );

      var fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.width = "0%";
      track.appendChild(fill);

      row.appendChild(head);
      row.appendChild(track);
      el.bars.appendChild(row);

      // Next frame so the transition runs from 0 rather than snapping.
      window.requestAnimationFrame(function () {
        fill.style.width = pct + "%";
      });
    });

    el.updated.textContent = "Updated " + new Date().toLocaleTimeString("en-KE", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // --- view state -----------------------------------------------------------

  function render() {
    el.question.textContent = state.question || "";
    el.skeleton.hidden = true;

    if (state.hasVoted) {
      el.ballotWrap.hidden = true;
      el.results.hidden = false;
      renderResults();
      startRefresh();
      return;
    }

    el.ballotWrap.hidden = false;
    el.results.hidden = true;
    renderBallot();

    if (!state.countryAllowed) {
      el.submit.disabled = true;
      showAlert(
        "warn",
        "Voting is open to Kenyan connections only. You can still follow the results."
      );
      el.results.hidden = false;
      renderResults();
    } else {
      el.submit.disabled = true;
    }
  }

  function applyPayload(data) {
    if (typeof data.pollId === "number") state.pollId = data.pollId;
    if (typeof data.question === "string") state.question = data.question;
    if (Array.isArray(data.options)) state.options = data.options;
    if (typeof data.totalVotes === "number") state.totalVotes = data.totalVotes;
    if (typeof data.hasVoted === "boolean") state.hasVoted = data.hasVoted;
    if (data.votedOptionId !== undefined) state.votedOptionId = data.votedOptionId;
    if (typeof data.countryAllowed === "boolean") state.countryAllowed = data.countryAllowed;
    if (typeof data.country === "string") state.country = data.country;
  }

  // --- data flow ------------------------------------------------------------

  function loadPoll() {
    return request("/poll").then(function (result) {
      if (!result.ok) {
        // The classic misconfiguration: the page is on static hosting with no
        // API beside it, so /api/poll resolves to the 404 page. Say so plainly
        // instead of reporting a generic failure.
        if (result.status === 404 && !CONFIG.apiBase) {
          throw new Error(
            "No poll API found at this address. Set apiBase in /assets/config.js " +
              "to your Supabase Functions URL, or serve this page from the API itself."
          );
        }

        throw new Error(result.data.error || "Could not load the poll.");
      }
      applyPayload(result.data);
      state.loaded = true;
      render();
    });
  }

  /** Tally-only refresh. Falls back to /poll on backends without /results. */
  function refreshResults() {
    return request("/results")
      .then(function (result) {
        if (!result.ok) {
          return request("/poll");
        }
        return result;
      })
      .then(function (result) {
        if (!result.ok) return;
        applyPayload(result.data);
        if (state.hasVoted || !state.countryAllowed) {
          renderResults();
        }
      })
      .catch(function () {
        /* A failed background refresh must not disturb the page. */
      });
  }

  function startRefresh() {
    stopRefresh();
    var seconds = Number(CONFIG.refreshSeconds) || 20;
    refreshTimer = window.setInterval(function () {
      if (!document.hidden) {
        refreshResults();
      }
    }, seconds * 1000);
  }

  function stopRefresh() {
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function submitVote(event) {
    event.preventDefault();
    if (state.submitting) return;

    var checked = el.options.querySelector("input[name=option]:checked");
    if (!checked) {
      showAlert("error", "Select a candidate first.");
      return;
    }

    state.submitting = true;
    el.submit.disabled = true;
    el.submit.textContent = "";
    var spinner = document.createElement("span");
    spinner.className = "spinner";
    el.submit.appendChild(spinner);
    el.submit.appendChild(document.createTextNode("Submitting"));
    clearAlert();

    request("/vote", { method: "POST", body: { optionId: Number(checked.value) } })
      .then(function (result) {
        if (result.ok) {
          state.hasVoted = true;
          state.votedOptionId = result.data.votedOptionId;
          applyPayload(result.data);
          render();
          showAlert("ok", "Your vote has been recorded. Thank you for taking part.");
          return;
        }

        // The server already holds a vote for this device: show it rather than
        // pretending the vote is still open.
        if (result.status === 409) {
          state.hasVoted = true;
          if (result.data.votedOptionId != null) {
            state.votedOptionId = result.data.votedOptionId;
          }
          return refreshResults().then(function () {
            render();
            showAlert("warn", result.data.error || "You have already voted in this poll.");
          });
        }

        // Expired or missing token: mint a fresh one so the retry can work.
        if (result.status === 401) {
          return loadPoll().then(function () {
            showAlert("error", "Your session expired. Please choose again and resubmit.");
          });
        }

        showAlert("error", result.data.error || "Could not record your vote. Try again.");
      })
      .catch(function () {
        showAlert("error", "Network problem. Check your connection and try again.");
      })
      .finally(function () {
        state.submitting = false;
        el.submit.textContent = "Submit my vote";
        el.submit.disabled = state.hasVoted || !el.options.querySelector("input:checked");
      });
  }

  // --- theme ----------------------------------------------------------------

  function initTheme() {
    var saved = storageGet(THEME_KEY);
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }

    el.themeToggle.addEventListener("click", function () {
      var current = document.documentElement.getAttribute("data-theme");
      if (!current) {
        current = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      var next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      storageSet(THEME_KEY, next);
    });
  }

  // --- ads ------------------------------------------------------------------

  function adsEnabled() {
    var client = CONFIG.adsenseClient || "";
    return client.indexOf("ca-pub-") === 0 && client.indexOf("REPLACE_WITH") === -1;
  }

  function loadAds(consent) {
    if (!adsEnabled()) return;

    if (consent === "denied") {
      window.adsbygoogle = window.adsbygoogle || [];
      window.adsbygoogle.requestNonPersonalizedAds = 1;
    }

    if (!document.querySelector("script[data-adsense-loader]")) {
      var script = document.createElement("script");
      script.async = true;
      script.crossOrigin = "anonymous";
      script.setAttribute("data-adsense-loader", "true");
      script.src =
        "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" +
        encodeURIComponent(CONFIG.adsenseClient);
      document.head.appendChild(script);
    }

    el.adSlot.hidden = false;
    var ins = el.adSlot.querySelector(".adsbygoogle");
    if (ins) {
      ins.setAttribute("data-ad-client", CONFIG.adsenseClient);
      ins.setAttribute("data-ad-slot", CONFIG.adsenseSlot || "");
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch (_) {
        /* Library not settled yet. */
      }
    }
  }

  function initConsent() {
    if (!adsEnabled()) {
      el.consent.hidden = true;
      el.adSlot.hidden = true;
      return;
    }

    var saved = storageGet(CONSENT_KEY);
    if (saved === "granted" || saved === "denied") {
      loadAds(saved);
      return;
    }

    el.consent.hidden = false;

    function choose(choice) {
      storageSet(CONSENT_KEY, choice);
      el.consent.hidden = true;
      loadAds(choice);
    }

    el.consentAccept.addEventListener("click", function () { choose("granted"); });
    el.consentDecline.addEventListener("click", function () { choose("denied"); });
  }

  // --- boot -----------------------------------------------------------------

  function init() {
    el = {
      question: document.getElementById("question"),
      skeleton: document.getElementById("skeleton"),
      ballotWrap: document.getElementById("ballot-wrap"),
      options: document.getElementById("options"),
      submit: document.getElementById("submit"),
      alert: document.getElementById("alert"),
      results: document.getElementById("results"),
      bars: document.getElementById("bars"),
      total: document.getElementById("total"),
      updated: document.getElementById("updated"),
      form: document.getElementById("poll-form"),
      adSlot: document.getElementById("ad-slot"),
      consent: document.getElementById("consent"),
      consentAccept: document.getElementById("consent-accept"),
      consentDecline: document.getElementById("consent-decline"),
      themeToggle: document.getElementById("theme-toggle"),
      refresh: document.getElementById("refresh"),
    };

    initTheme();
    initConsent();

    el.form.addEventListener("submit", submitVote);
    el.refresh.addEventListener("click", function () {
      el.refresh.disabled = true;
      refreshResults().finally(function () {
        el.refresh.disabled = false;
      });
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state.hasVoted) {
        refreshResults();
      }
    });

    loadPoll().catch(function (error) {
      el.skeleton.hidden = true;
      el.question.textContent = "The poll could not be loaded";
      showAlert("error", error.message || "Please refresh the page to try again.");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
