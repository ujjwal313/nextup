const tmdbBase = "https://api.themoviedb.org/3";
const anilistUrl = "https://graphql.anilist.co";

const browser = window.browser || window.chrome;

const FALLBACK_POSTER =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='300'>" +
      "<rect width='200' height='300' fill='#0f172a'/>" +
      "<text x='100' y='150' font-size='48' text-anchor='middle' dominant-baseline='central'>🎬</text>" +
      "</svg>"
  );

const SHARED_TMDB_KEY = "2bdc22ab6d3d6a671fcb53792dd10914";
let activeTMDBKey = SHARED_TMDB_KEY;

const DETAILS_LABEL = browser.i18n.getMessage("detailsLink");
const PROVIDER_ATTRIBUTION = browser.i18n.getMessage("providerAttribution");

/** DEFAULTS */
let REGION_MODE = "GLOBAL";
let USER_COUNTRY = "US";

const COUNTRY_TTL = 24 * 60 * 60 * 1000;

let currentDate = new Date();

/** Pagination state */
let tvPage = 1;
let tvTotalPages = 1;
let tvLoading = false;

let moviePage = 1;
let movieTotalPages = 1;
let movieLoading = false;

/** Load-cycle state: one controller per date/region view, aborted on change
 *  so stale responses never render into the wrong list. */
let loadController = null;
let currentLoadSignal = null;
let startedLoads = new Set();

/** Session cache: (type, date, region) → already-fetched items, so
 *  prev/next date navigation doesn't refetch. Capped so a long
 *  date-scrubbing session can't grow it unbounded. */
const sessionCache = new Map();
const SESSION_CACHE_MAX = 36; // ~12 dates × 3 tabs

/** Guards the stale-snapshot render from overwriting fresher network data. */
const freshRendered = { movies: false, tv: false, anime: false };

/** Search filters the loaded lists for the selected date — it never queries the APIs. */
let searchQuery = "";

const EMPTY_KEYS = { movies: "emptyMovies", tv: "emptyTv", anime: "emptyAnime" };

/* ================= COUNTRY DETECTION ================= */

async function detectCountry() {
  const res = await fetch("https://ipwho.is/", {
    signal: AbortSignal.timeout(3000),
  });
  const data = await res.json();
  if (data.success && data.country_code) return data.country_code;
  throw new Error("country lookup failed");
}

function localeCountry() {
  const locale = browser.i18n.getUILanguage();
  return (locale.split("-")[1] || "US").toUpperCase();
}

function saveCountry(code) {
  USER_COUNTRY = code;
  browser.storage.local.set({ userCountry: { code, ts: Date.now() } });
}

/** Never blocks the initial load unless LOCAL mode has no cached country. */
async function ensureCountry() {
  const { userCountry } = await browser.storage.local.get(["userCountry"]);

  if (userCountry?.code) {
    USER_COUNTRY = userCountry.code;
    if (Date.now() - (userCountry.ts || 0) > COUNTRY_TTL) {
      detectCountry().then(saveCountry).catch(() => {});
    }
    return;
  }

  if (REGION_MODE === "LOCAL") {
    try {
      saveCountry(await detectCountry());
    } catch {
      USER_COUNTRY = localeCountry();
    }
  } else {
    detectCountry()
      .then(saveCountry)
      .catch(() => {
        USER_COUNTRY = localeCountry();
      });
  }
}

/* ================= TMDB FETCH WRAPPER ================= */

async function fetchWithKey(url, signal) {
  const res = await fetch(url, { signal });
  if ([401, 403, 429, 500].includes(res.status)) {
    const section = document.getElementById("apiKeySection");
    const status = document.getElementById("apiKeyStatus");
    if (section) section.classList.remove("hidden");
    if (status) {
      status.innerText = browser.i18n.getMessage("apiKeyErrorStatus");
    }
    throw new Error("TMDB key error");
  }
  return res.json();
}

/* ================= INFINITE SCROLL OBSERVERS ================= */

const tvObserver = new IntersectionObserver(
  (entries) => {
    const entry = entries[0];
    if (entry.isIntersecting) {
      loadTV(activeTMDBKey);
    }
  },
  { rootMargin: "200px" }
);

const movieObserver = new IntersectionObserver(
  (entries) => {
    const entry = entries[0];
    if (entry.isIntersecting) {
      loadMovies(activeTMDBKey);
    }
  },
  { rootMargin: "200px" }
);

function resetSentinel(type) {
  const listId = type === "tv" ? "tvList" : "moviesList";
  const sentinelId = type === "tv" ? "tvSentinel" : "movieSentinel";
  const observer = type === "tv" ? tvObserver : movieObserver;

  const container = document.getElementById(listId);
  if (!container) return;

  const old = document.getElementById(sentinelId);
  if (old) {
    observer.unobserve(old);
    old.remove();
  }

  const sentinel = document.createElement("div");
  sentinel.id = sentinelId;
  sentinel.style.height = "1px";
  container.appendChild(sentinel);

  requestAnimationFrame(() => observer.observe(sentinel));
}

/* ================= STREAMING PROVIDERS ================= */

/** (mediaType, id, country) → {link, providers} — stable data, kept for the session. */
const providerCache = new Map();

/** Providers and TV episode info are per-title TMDB requests, so only
 *  fetch for cards that actually scroll into view. */
const providerObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      providerObserver.unobserve(entry.target);
      const row = entry.target.querySelector(".providers");
      if (row) loadProviders(row);
      const subtitle = entry.target.querySelector(".subtitle[data-id]");
      if (subtitle) loadEpisodeInfo(subtitle);
    });
  },
  { rootMargin: "100px" }
);

/** Streaming only (flatrate/free/ads) — rent/buy isn't "watch tonight".
 *  Trimmed to the 4 logos we render before anything is cached. */
function extractProviders(region) {
  const seen = new Set();
  const providers = []
    .concat(region?.flatrate || [], region?.free || [], region?.ads || [])
    .filter((p) => !seen.has(p.provider_id) && seen.add(p.provider_id))
    .slice(0, 4)
    .map((p) => ({
      name: p.provider_name,
      logo: p.logo_path ? `https://image.tmdb.org/t/p/w45${p.logo_path}` : null,
    }));
  return { link: region?.link, providers };
}

async function loadProviders(row) {
  const { id, mediaType } = row.dataset;

  let data;
  if (mediaType === "tv") {
    // Rides the episode-info request (append_to_response) — no extra call
    try {
      data = (await getTvInfo(id)).providerData;
    } catch {
      return;
    }
  } else {
    const key = `${mediaType}:${id}:${USER_COUNTRY}`;
    data = providerCache.get(key);
    if (data === undefined) {
      try {
        const res = await fetch(
          `${tmdbBase}/${mediaType}/${id}/watch/providers?api_key=${activeTMDBKey}`,
          { signal: currentLoadSignal }
        );
        const json = await res.json();
        data = extractProviders(
          json?.results?.[USER_COUNTRY] || json?.results?.US
        );
        providerCache.set(key, data);
      } catch {
        return; // aborted or failed — leave the row empty, cards are secondary UI
      }
    }
  }

  if (!row.isConnected || !data.providers.length) return;

  const anchor = document.createElement("a");
  anchor.href = data.link || row.dataset.fallbackLink;
  anchor.target = "_blank";
  anchor.className = "provider-group";
  data.providers.forEach((p) => {
    if (!p.logo) return;
    const img = document.createElement("img");
    img.src = p.logo;
    img.alt = p.name;
    img.title = p.name;
    img.loading = "lazy";
    img.width = 18;
    img.height = 18;
    anchor.appendChild(img);
  });
  if (anchor.children.length) row.appendChild(anchor);
}

/* ================= TV SHOW INFO (episodes + providers) ================= */

/** id → Promise of {episodes, providerData}. Discover only says a show airs
 *  on the date; which episode takes /tv/{id} for the season pointers, then
 *  /tv/{id}/season/{n} to match by air_date. Providers piggyback on the
 *  details call via append_to_response. Both are trimmed before caching —
 *  the raw season payload carries full crew/guest lists (~90x the size). */
const tvInfoCache = new Map();

async function fetchTvInfo(id, signal) {
  const details = await (
    await fetch(
      `${tmdbBase}/tv/${id}?api_key=${activeTMDBKey}&append_to_response=watch/providers`,
      { signal }
    )
  ).json();

  const seasonNumbers = new Set();
  if (details.last_episode_to_air) {
    seasonNumbers.add(details.last_episode_to_air.season_number);
  }
  if (details.next_episode_to_air) {
    seasonNumbers.add(details.next_episode_to_air.season_number);
  }

  const seasons = await Promise.all(
    [...seasonNumbers].map((sn) =>
      fetch(`${tmdbBase}/tv/${id}/season/${sn}?api_key=${activeTMDBKey}`, {
        signal,
      }).then((r) => r.json())
    )
  );
  const episodes = seasons.flatMap((season) =>
    (season.episodes || []).map((e) => ({
      season_number: e.season_number,
      episode_number: e.episode_number,
      air_date: e.air_date,
    }))
  );

  const providerResults = details["watch/providers"]?.results;
  const providerData = extractProviders(
    providerResults?.[USER_COUNTRY] || providerResults?.US
  );

  return { episodes, providerData };
}

function getTvInfo(id) {
  let promise = tvInfoCache.get(id);
  if (!promise) {
    promise = fetchTvInfo(id, currentLoadSignal);
    tvInfoCache.set(id, promise);
    promise.catch(() => tvInfoCache.delete(id));
  }
  return promise;
}

async function loadEpisodeInfo(subtitleEl) {
  const { id, date } = subtitleEl.dataset;

  let episodes;
  try {
    episodes = (await getTvInfo(id)).episodes;
  } catch {
    return; // aborted or failed — the card just keeps no episode line
  }

  const airing = episodes.filter((e) => e.air_date === date);
  if (!airing.length || !subtitleEl.isConnected) return;

  const first = airing[0];
  const last = airing[airing.length - 1];
  let label = browser.i18n.getMessage("seasonEpisodeLabel", [
    String(first.season_number),
    String(first.episode_number),
  ]);
  if (airing.length > 1) {
    label += `–E${last.episode_number}`;
  }
  subtitleEl.textContent = label;
}

/** The overview renders 2-line-clamped (~90 chars visible); storing full
 *  descriptions just bloats the caches and snapshots. */
const OVERVIEW_MAX = 200;

function clip(text) {
  if (!text) return "";
  if (text.length <= OVERVIEW_MAX) return text;
  return text.slice(0, OVERVIEW_MAX).trimEnd() + "…";
}

/** AniList descriptions are HTML — parse in an inert document (nothing
 *  executes) and take the text. */
const htmlParser = new DOMParser();

function htmlToText(html) {
  if (!html) return "";
  const withSpaces = html.replace(/<br\s*\/?>/gi, " ");
  return htmlParser
    .parseFromString(withSpaces, "text/html")
    .body.textContent.trim();
}

/** AniList externalLinks arrive with the schedule query — no extra request. */
function renderAnimeProviders(row, providers) {
  providers.forEach((p) => {
    const a = document.createElement("a");
    a.href = p.url;
    a.target = "_blank";
    a.title = p.name;
    if (p.icon) {
      const img = document.createElement("img");
      img.src = p.icon;
      img.alt = p.name;
      img.loading = "lazy";
      img.width = 18;
      img.height = 18;
      // AniList icons are white glyphs on transparency — invisible on light
      // cards without their brand-color chip behind them
      img.className = "provider-chip";
      img.style.background = p.color || "#334155";
      a.appendChild(img);
    } else {
      a.textContent = p.name;
      a.className = "provider-text";
    }
    row.appendChild(a);
  });
}

/* ================= SEARCH (current date only) ================= */

function setupSearch() {
  const input = document.getElementById("searchInput");
  if (!input) return;

  input.addEventListener("input", () => {
    searchQuery = input.value.trim().toLowerCase();
    applyFilter();
  });
}

function applyFilterType(type) {
  const list = document.getElementById(`${type}List`);
  const emptyEl = document.getElementById(`${type}Empty`);
  if (!list) return;

  const cards = list.querySelectorAll(".card");
  let visible = 0;
  cards.forEach((card) => {
    const match = !searchQuery || (card.dataset.search || "").includes(searchQuery);
    card.classList.toggle("hidden", !match);
    if (match) visible++;
  });

  // With everything filtered out, hidden cards free the sentinel into view,
  // so infinite scroll keeps pulling the rest of the day's pages on its own.
  if (!emptyEl || !cards.length) return;
  if (searchQuery && !visible) {
    emptyEl.textContent = browser.i18n.getMessage("emptySearch");
    showEmpty(type, true);
  } else {
    emptyEl.textContent = browser.i18n.getMessage(EMPTY_KEYS[type]);
    showEmpty(type, false);
  }
}

function applyFilter() {
  ["movies", "tv", "anime"].forEach(applyFilterType);
}

/* ================= I18N ================= */

function localizeStaticHtml() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const msg = browser.i18n.getMessage(el.getAttribute("data-i18n"));
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const msg = browser.i18n.getMessage(el.getAttribute("data-i18n-placeholder"));
    if (msg) el.placeholder = msg;
  });
}

/* ================= INIT ================= */

document.addEventListener("DOMContentLoaded", async () => {
  localizeStaticHtml();

  setupRegionSelector();
  setupDate();
  setupTabs();
  setupApiKeyControls();
  setupDateButtons();
  setupSearch();

  const { regionMode, tmdbApiKey } = await browser.storage.sync.get([
    "regionMode",
    "tmdbApiKey",
  ]);

  if (regionMode) {
    REGION_MODE = regionMode;
    const regionSelect = document.getElementById("regionSelector");
    if (regionSelect) regionSelect.value = REGION_MODE;
  }
  activeTMDBKey = tmdbApiKey || SHARED_TMDB_KEY;

  await ensureCountry();
  initializeLoad();
  renderSnapshots();
});

/* ================= REGION SELECTOR ================= */

function setupRegionSelector() {
  const regionSelect = document.getElementById("regionSelector");
  if (!regionSelect) return;

  regionSelect.addEventListener("change", async (e) => {
    REGION_MODE = e.target.value;
    await browser.storage.sync.set({ regionMode: REGION_MODE });
    initializeLoad();
  });
}

/* ================= DATE HANDLING ================= */

function setupDate() {
  const el = document.getElementById("dateLabel");
  if (!el) return;
  el.textContent = currentDate.toDateString();
}

function setupDateButtons() {
  const prev = document.getElementById("prevDay");
  const next = document.getElementById("nextDay");

  if (prev) {
    prev.addEventListener("click", () => {
      currentDate.setDate(currentDate.getDate() - 1);
      onDateChange();
    });
  }

  if (next) {
    next.addEventListener("click", () => {
      currentDate.setDate(currentDate.getDate() + 1);
      onDateChange();
    });
  }
}

/** Local-time YMD — toISOString() is UTC and disagrees with the
 *  displayed date near midnight for users east of UTC. */
function ymd(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function dateYMD() {
  return ymd(currentDate);
}

function onDateChange() {
  setupDate();
  initializeLoad();
}

/* ================= LOAD ORCHESTRATION ================= */

function getActiveTab() {
  const btn = document.querySelector("#tabs button.active");
  return btn ? btn.dataset.tab : "movies";
}

function regionKey() {
  return REGION_MODE === "LOCAL" ? `LOCAL:${USER_COUNTRY}` : "GLOBAL";
}

function cacheKey(type) {
  return `${type}|${dateYMD()}|${regionKey()}`;
}

function updateCache(type, items, replace, extra) {
  const key = cacheKey(type);
  const prevItems = (!replace && sessionCache.get(key)?.items) || [];
  sessionCache.delete(key); // re-insert so Map order doubles as LRU order
  sessionCache.set(key, Object.assign({ items: prevItems.concat(items) }, extra));
  while (sessionCache.size > SESSION_CACHE_MAX) {
    sessionCache.delete(sessionCache.keys().next().value);
  }
}

/** Kick off a load for one tab, at most once per load cycle.
 *  Serves from the session cache when this (date, region) was already fetched. */
function startLoad(type) {
  if (startedLoads.has(type)) return Promise.resolve();
  startedLoads.add(type);

  const entry = sessionCache.get(cacheKey(type));
  if (entry) {
    if (type === "movies") {
      moviePage = entry.page;
      movieTotalPages = entry.totalPages;
    } else if (type === "tv") {
      tvPage = entry.page;
      tvTotalPages = entry.totalPages;
    }
    renderItems(type, entry.items);
    freshRendered[type] = true;
    if (type !== "anime" && entry.items.length) resetSentinel(type);
    return Promise.resolve();
  }

  if (type === "movies") return loadMovies(activeTMDBKey);
  if (type === "tv") return loadTV(activeTMDBKey);
  return loadAnime();
}

function initializeLoad() {
  // Cancel any in-flight requests from the previous date/region view
  if (loadController) loadController.abort();
  loadController = new AbortController();
  currentLoadSignal = loadController.signal;
  startedLoads = new Set();

  // Drop refs to cards/sentinels about to be cleared — renderItems wipes
  // them from the DOM without unobserving, so this is where they'd leak
  providerObserver.disconnect();
  tvObserver.disconnect();
  movieObserver.disconnect();

  // Reset pagination state
  tvPage = 1;
  tvTotalPages = 1;
  tvLoading = false;

  moviePage = 1;
  movieTotalPages = 1;
  movieLoading = false;

  // Clear lists and show loaders
  ["movies", "tv", "anime"].forEach((t) => {
    clearList(t);
    showLoader(t, true);
    showEmpty(t, false);
  });

  // Visible tab first; the hidden tabs load once it has painted
  const signal = currentLoadSignal;
  startLoad(getActiveTab()).finally(() => {
    if (signal.aborted) return;
    ["movies", "tv", "anime"].forEach((t) => startLoad(t));
  });
}

/* ================= SNAPSHOT (stale-while-revalidate) ================= */

/** Persist today's first page so the next popup open paints instantly. */
function saveSnapshot(type, items) {
  if (dateYMD() !== ymd(new Date())) return;
  browser.storage.local.set({
    ["snap_" + type]: { date: dateYMD(), region: regionKey(), items },
  });
}

async function renderSnapshots() {
  const data = await browser.storage.local.get([
    "snap_movies",
    "snap_tv",
    "snap_anime",
  ]);
  const today = ymd(new Date());

  ["movies", "tv", "anime"].forEach((type) => {
    const snap = data["snap_" + type];
    if (!snap || snap.date !== today || snap.region !== regionKey()) return;
    if (freshRendered[type] || !snap.items?.length) return;
    // No sentinel: stale content shouldn't paginate, the fresh page-1
    // render replaces it and re-arms infinite scroll.
    renderItems(type, snap.items);
  });
}

/* ================= UI HELPERS ================= */

function showLoader(type, show) {
  const el = document.getElementById(`${type}Loader`);
  if (el) el.style.display = show ? "flex" : "none";
}

function showEmpty(type, show) {
  const el = document.getElementById(`${type}Empty`);
  if (!el) return;

  if (show) {
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function clearList(type) {
  const el = document.getElementById(`${type}List`);
  if (el) el.textContent = "";
}

/* ================= TABS ================= */

function setupTabs() {
  const buttons = document.querySelectorAll("#tabs button");
  const panels = document.querySelectorAll(".tab-panel");

  if (!buttons.length || !panels.length) return;

  buttons.forEach((btn) =>
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.tab;

      buttons.forEach((b) => b.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));

      btn.classList.add("active");
      const panel = document.getElementById(targetId);
      if (panel) panel.classList.add("active");

      if (searchQuery) {
        const searchInput = document.getElementById("searchInput");
        if (searchInput) searchInput.value = "";
        searchQuery = "";
        applyFilter();
      }

      // In case the deferred background load hasn't reached this tab yet
      startLoad(targetId);
    })
  );
}

/* ================= API KEY CONTROLS ================= */

function setupApiKeyControls() {
  const saveBtn = document.getElementById("saveApiKeyBtn");
  const input = document.getElementById("tmdbApiKeyInput");
  const status = document.getElementById("apiKeyStatus");
  const section = document.getElementById("apiKeySection");

  if (!saveBtn) return;

  saveBtn.addEventListener("click", async () => {
    const customKey = (input.value || "").trim();
    if (!customKey) return;

    await browser.storage.sync.set({ tmdbApiKey: customKey });
    activeTMDBKey = customKey;
    if (status) status.innerText = browser.i18n.getMessage("apiKeySavedStatus");
    if (section) section.classList.add("hidden");
    setTimeout(() => window.location.reload(), 600);
  });
}

/* ================= MOVIES (INFINITE) ================= */

async function loadMovies(apiKey) {
  if (movieLoading || moviePage > movieTotalPages) return;
  movieLoading = true;

  const signal = currentLoadSignal;
  const isFirstPage = moviePage === 1;

  try {
    const regionFilter =
      REGION_MODE === "LOCAL" ? `&with_origin_country=${USER_COUNTRY}` : "";

    const url =
      `${tmdbBase}/discover/movie?api_key=${apiKey}` +
      regionFilter +
      `&primary_release_date.gte=${dateYMD()}` +
      `&primary_release_date.lte=${dateYMD()}` +
      `&sort_by=popularity.desc&page=${moviePage}`;

    const { results = [], total_pages = 1 } = await fetchWithKey(url, signal);
    if (signal?.aborted) return;

    movieTotalPages = total_pages;
    moviePage++;

    const items = results.map((m) => ({
      id: m.id,
      mediaType: "movie",
      title: m.title,
      searchText: `${m.title || ""} ${m.original_title || ""}`,
      poster: m.poster_path
        ? `https://image.tmdb.org/t/p/w154${m.poster_path}`
        : FALLBACK_POSTER,
      overview: clip(m.overview),
      extra: m.vote_average ? `⭐ ${m.vote_average.toFixed(1)}` : "",
      link: `https://www.themoviedb.org/movie/${m.id}`,
    }));

    if (isFirstPage) {
      renderItems("movies", items);
      freshRendered.movies = true;
      saveSnapshot("movies", items);
    } else {
      appendItems("movies", items);
    }

    updateCache("movies", items, isFirstPage, {
      page: moviePage,
      totalPages: movieTotalPages,
    });
    if (items.length && moviePage <= movieTotalPages) resetSentinel("movies");
  } catch (err) {
    if (err?.name !== "AbortError") {
      showError("movies", browser.i18n.getMessage("errorMovies"));
    }
  } finally {
    // Skip UI/state resets for aborted cycles — a newer cycle owns them now
    if (signal === currentLoadSignal) {
      showLoader("movies", false);
      movieLoading = false;
    }
  }
}

/* ================= TV (INFINITE) ================= */

async function loadTV(apiKey) {
  if (tvLoading || tvPage > tvTotalPages) return;
  tvLoading = true;

  const signal = currentLoadSignal;
  const isFirstPage = tvPage === 1;

  try {
    const regionFilter =
      REGION_MODE === "LOCAL" ? `&with_origin_country=${USER_COUNTRY}` : "";

    const url =
      `${tmdbBase}/discover/tv?api_key=${apiKey}` +
      regionFilter +
      `&air_date.gte=${dateYMD()}` +
      `&air_date.lte=${dateYMD()}` +
      `&sort_by=popularity.desc&page=${tvPage}`;

    const { results = [], total_pages = 1 } = await fetchWithKey(url, signal);
    if (signal?.aborted) return;

    tvTotalPages = total_pages;
    tvPage++;

    const items = results.map((show) => ({
      id: show.id,
      mediaType: "tv",
      title: show.name,
      searchText: `${show.name || ""} ${show.original_name || ""}`,
      poster: show.poster_path
        ? `https://image.tmdb.org/t/p/w154${show.poster_path}`
        : FALLBACK_POSTER,
      overview: clip(show.overview),
      extra: show.vote_average ? `⭐ ${show.vote_average.toFixed(1)}` : "",
      link: `https://www.themoviedb.org/tv/${show.id}`,
    }));

    if (isFirstPage) {
      renderItems("tv", items);
      freshRendered.tv = true;
      saveSnapshot("tv", items);
    } else {
      appendItems("tv", items);
    }

    updateCache("tv", items, isFirstPage, {
      page: tvPage,
      totalPages: tvTotalPages,
    });
    if (items.length && tvPage <= tvTotalPages) resetSentinel("tv");
  } catch (err) {
    if (err?.name !== "AbortError") {
      showError("tv", browser.i18n.getMessage("errorTv"));
    }
  } finally {
    if (signal === currentLoadSignal) {
      showLoader("tv", false);
      tvLoading = false;
    }
  }
}

/* ================= ANIME ================= */

async function loadAnime() {
  const signal = currentLoadSignal;

  try {
    const start =
      new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        currentDate.getDate()
      ).getTime() / 1000;
    const end = start + 86400;

    const query = `
      query ($from: Int, $to: Int) {
        Page(page: 1, perPage: 100) {
          airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
            timeUntilAiring
            episode
            media {
              title { romaji english }
              coverImage { medium }
              siteUrl
              description
              externalLinks { site url type icon color }
            }
          }
        }
      }
    `;

    const res = await fetch(anilistUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { from: start, to: end } }),
      signal,
    });

    const json = await res.json();
    if (signal?.aborted) return;

    const schedules = json?.data?.Page?.airingSchedules ?? [];

    const items = schedules.map((s) => {
      const sec = s.timeUntilAiring;
      const hours = Math.floor(sec / 3600);
      const mins = Math.floor((sec % 3600) / 60);
      const timeStr =
        sec > 0 ? `⏱️ ${hours}h ${mins}m` : browser.i18n.getMessage("airedLabel");

      return {
        title:
          s.media?.title?.english ||
          s.media?.title?.romaji ||
          browser.i18n.getMessage("untitledLabel"),
        searchText: `${s.media?.title?.english || ""} ${s.media?.title?.romaji || ""}`,
        poster: s.media?.coverImage?.medium || FALLBACK_POSTER,
        subtitle: browser.i18n.getMessage("episodeLabel", [String(s.episode)]),
        overview: clip(htmlToText(s.media?.description)),
        extra: timeStr,
        link: s.media?.siteUrl,
        providers: (s.media?.externalLinks || [])
          .filter((l) => l.type === "STREAMING" && l.url)
          .slice(0, 4)
          .map((l) => ({ name: l.site, url: l.url, icon: l.icon, color: l.color })),
      };
    });

    renderItems("anime", items);
    freshRendered.anime = true;
    updateCache("anime", items, true, {});
    saveSnapshot("anime", items);
  } catch (err) {
    if (err?.name !== "AbortError") {
      showError("anime", browser.i18n.getMessage("errorAnime"));
    }
  } finally {
    if (signal === currentLoadSignal) {
      showLoader("anime", false);
    }
  }
}

/* ================= RENDER HELPERS ================= */

function appendItems(type, items) {
  const container = document.getElementById(`${type}List`);
  if (!container || !items || !items.length) return;

  showEmpty(type, false);

  const fragment = document.createDocumentFragment();
  items.forEach((item) => fragment.appendChild(createCard(item)));
  container.appendChild(fragment);

  if (searchQuery) applyFilterType(type);
}

function renderItems(type, items) {
  const container = document.getElementById(`${type}List`);
  if (!container) return;

  showLoader(type, false);
  container.innerHTML = "";

  if (!items || !items.length) {
    showEmpty(type, true);
    return;
  }

  showEmpty(type, false);
  const fragment = document.createDocumentFragment();
  items.forEach((item) => fragment.appendChild(createCard(item)));
  container.appendChild(fragment);

  if (searchQuery) applyFilterType(type);
}

function createCard(item) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.search = (item.searchText || item.title || "").toLowerCase();

  const img = document.createElement("img");
  img.className = "poster";
  img.src = item.poster || FALLBACK_POSTER;
  img.loading = "lazy";

  const details = document.createElement("div");
  details.className = "details";

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = item.title;

  let subtitle = null;
  if (item.subtitle) {
    subtitle = document.createElement("div");
    subtitle.className = "subtitle";
    subtitle.textContent = item.subtitle;
  } else if (item.mediaType === "tv" && item.id) {
    // Filled lazily with "S2 E5 · name" when the card scrolls into view
    subtitle = document.createElement("div");
    subtitle.className = "subtitle";
    subtitle.dataset.id = item.id;
    subtitle.dataset.date = dateYMD();
  }

  const overview = document.createElement("div");
  overview.className = "overview";
  overview.textContent = item.overview || "";

  const timer = document.createElement("div");
  timer.className = "timer";
  timer.textContent = item.extra || "";

  const providers = document.createElement("div");
  providers.className = "providers";
  providers.title = PROVIDER_ATTRIBUTION;
  if (item.providers) {
    // Anime: streaming links came with the schedule query
    renderAnimeProviders(providers, item.providers);
  } else if (item.id && item.mediaType) {
    // Movies/TV: lazy-fetched from TMDB when the card scrolls into view
    providers.dataset.id = item.id;
    providers.dataset.mediaType = item.mediaType;
    providers.dataset.fallbackLink = `${item.link}/watch`;
    providerObserver.observe(card);
  }

  const link = document.createElement("a");
  link.href = item.link;
  link.target = "_blank";
  link.textContent = DETAILS_LABEL;

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.append(link, providers);

  if (subtitle) {
    details.append(title, subtitle, overview, timer, actions);
  } else {
    details.append(title, overview, timer, actions);
  }
  card.append(img, details);
  return card;
}

function showError(type, message) {
  showLoader(type, false);
  const container = document.getElementById(`${type}List`);
  if (!container) return;
  // Keep stale-but-usable content (snapshot render) if the refresh failed
  if (container.querySelector(".card")) return;
  container.textContent = "";
  const emptyDiv = document.createElement("div");
  emptyDiv.className = "empty";
  emptyDiv.textContent = message;
  container.appendChild(emptyDiv);
}
