const tmdbBase = "https://api.themoviedb.org/3";
const anilistUrl = "https://graphql.anilist.co";
const FALLBACK_POSTER =
  "https://placehold.co/200x300/0f172a/e5e7eb?text=No+Image";

const SHARED_TMDB_KEY = "2bdc22ab6d3d6a671fcb53792dd10914";
let activeTMDBKey = SHARED_TMDB_KEY;

/** DEFAULTS */
let REGION_MODE = "GLOBAL";
let USER_COUNTRY = "US";

let currentDate = new Date();

/** Pagination state */
let tvPage = 1;
let tvTotalPages = 1;
let tvLoading = false;

let moviePage = 1;
let movieTotalPages = 1;
let movieLoading = false;

const browser = window.browser || window.chrome;

async function getUserCountry() {
  try {
    const res = await fetch("https://ipwho.is/");
    const data = await res.json();
    if (data.success && data.country_code) return data.country_code;
  } catch {
    // ignore and fall back
  }
  const locale = browser.i18n.getUILanguage();
  return (locale.split("-")[1] || "US").toUpperCase();
}

/** Only override defaults if user explicitly saved before */
function loadSavedSettings() {
  browser.storage.sync.get(["regionMode"], (data) => {
    if (data.regionMode) REGION_MODE = data.regionMode;
    // Update the dropdown to match stored value
    const regionSelect = document.getElementById("regionSelector");
    if (regionSelect) {
      regionSelect.value = REGION_MODE;
    }
  });
}

/* ================= TMDB FETCH WRAPPER ================= */

async function fetchWithKey(url) {
  const res = await fetch(url);
  if ([401, 403, 429, 500].includes(res.status)) {
    const section = document.getElementById("apiKeySection");
    const status = document.getElementById("apiKeyStatus");
    if (section) section.classList.remove("hidden");
    if (status) {
      status.innerText =
        "API limit reached or invalid key. Enter personal TMDB key to continue.";
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

/* ================= INIT ================= */

document.addEventListener("DOMContentLoaded", async () => {
  USER_COUNTRY = await getUserCountry();
  loadSavedSettings();

  setupRegionSelector();
  setupDate();
  setupTabs();
  setupApiKeyControls();
  setupDateButtons();

  browser.storage.sync.get(["tmdbApiKey"], async ({ tmdbApiKey }) => {
    activeTMDBKey = tmdbApiKey || SHARED_TMDB_KEY;
    initializeLoad();
  });
});

/* ================= REGION SELECTOR ================= */

function setupRegionSelector() {
  const regionSelect = document.getElementById("regionSelector");
  if (!regionSelect) return;

  // Listen for changes
  regionSelect.addEventListener("change", (e) => {
    REGION_MODE = e.target.value;
    // Save immediately
    browser.storage.sync.set({ regionMode: REGION_MODE }, () => {
      // Reload lists
      initializeLoad();
    });
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

function dateYMD() {
  return currentDate.toISOString().split("T")[0];
}

function onDateChange() {
  setupDate();
  initializeLoad();
}

/* ================= INITIAL LOAD RESET ================= */

function initializeLoad() {
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

  loadMovies(activeTMDBKey);
  loadTV(activeTMDBKey);
  loadAnime();
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

  saveBtn.addEventListener("click", () => {
    const customKey = (input.value || "").trim();
    if (!customKey) return;

    browser.storage.sync.set({ tmdbApiKey: customKey }, () => {
      activeTMDBKey = customKey;
      if (status) status.innerText = "Key saved! Reloading...";
      if (section) section.classList.add("hidden");
      setTimeout(() => window.location.reload(), 600);
    });
  });
}

/* ================= MOVIES (INFINITE) ================= */

async function loadMovies(apiKey) {
  if (movieLoading || moviePage > movieTotalPages) return;
  movieLoading = true;

  try {
    const regionFilter =
      REGION_MODE === "LOCAL" ? `&with_origin_country=${USER_COUNTRY}` : "";

    const url =
      `${tmdbBase}/discover/movie?api_key=${apiKey}` +
      regionFilter +
      `&primary_release_date.gte=${dateYMD()}` +
      `&primary_release_date.lte=${dateYMD()}` +
      `&sort_by=popularity.desc&page=${moviePage}`;

    const { results = [], total_pages = 1 } = await fetchWithKey(url);

    // If no results on the first page, show the empty message
    if ((!results || results.length === 0) && moviePage === 1) {
      showEmpty("movies", true);
      return;
    }

    movieTotalPages = total_pages;
    moviePage++;

    const items = results.map((m) => ({
      title: m.title,
      poster: m.poster_path
        ? `https://image.tmdb.org/t/p/w200${m.poster_path}`
        : FALLBACK_POSTER,
      overview: m.overview,
      extra: m.vote_average ? `⭐ ${m.vote_average.toFixed(1)}` : "",
      link: `https://www.themoviedb.org/movie/${m.id}`,
    }));

    appendItems("movies", items);
    resetSentinel("movies");
  } catch {
    showError("movies", "Error loading movies");
  } finally {
    showLoader("movies", false);
    movieLoading = false;
  }
}

/* ================= TV (INFINITE) ================= */

async function loadTV(apiKey) {
  if (tvLoading || tvPage > tvTotalPages) return;
  tvLoading = true;

  try {
    const regionFilter =
      REGION_MODE === "LOCAL" ? `&with_origin_country=${USER_COUNTRY}` : "";

    const url =
      `${tmdbBase}/discover/tv?api_key=${apiKey}` +
      regionFilter +
      `&air_date.gte=${dateYMD()}` +
      `&air_date.lte=${dateYMD()}` +
      `&page=${tvPage}`;

    const { results = [], total_pages = 1 } = await fetchWithKey(url);

    // If no results on the first page, show the empty message
    if ((!results || results.length === 0) && tvPage === 1) {
      showEmpty("tv", true);
      return;
    }

    tvTotalPages = total_pages;
    tvPage++;

    const items = results.map((show) => ({
      title: show.name,
      poster: show.poster_path
        ? `https://image.tmdb.org/t/p/w200${show.poster_path}`
        : FALLBACK_POSTER,
      overview: show.overview,
      extra: show.vote_average ? `⭐ ${show.vote_average.toFixed(1)}` : "",
      link: `https://www.themoviedb.org/tv/${show.id}`,
    }));

    appendItems("tv", items);
    resetSentinel("tv");
  } catch {
    showError("tv", "Error loading TV shows");
  } finally {
    showLoader("tv", false);
    tvLoading = false;
  }
}

/* ================= ANIME ================= */

async function loadAnime() {
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
            airingAt
            timeUntilAiring
            episode
            media {
              title { romaji english }
              coverImage { medium }
              siteUrl
              season
            }
          }
        }
      }
    `;

    const res = await fetch(anilistUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { from: start, to: end } }),
    });

    const json = await res.json();
    const schedules = json?.data?.Page?.airingSchedules ?? [];

    const items = schedules.map((s) => {
      // --- ADDED COUNTDOWN LOGIC HERE ---
      const sec = s.timeUntilAiring;
      const hours = Math.floor(sec / 3600);
      const mins = Math.floor((sec % 3600) / 60);
      const timeStr = sec > 0 ? `⏱️ ${hours}h ${mins}m` : "Aired";

      return {
        title: s.media?.title?.english || s.media?.title?.romaji || "Untitled",
        poster: s.media?.coverImage?.medium || FALLBACK_POSTER,
        overview: `Episode ${s.episode}`,
        extra: timeStr, // Connected the countdown string here
        link: s.media?.siteUrl,
      };
    });

    renderItems("anime", items);
  } catch {
    showError("anime", "Error loading anime");
  } finally {
    showLoader("anime", false);
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
}

function createCard(item) {
  const card = document.createElement("div");
  card.className = "card";

  const img = document.createElement("img");
  img.className = "poster";
  img.src = item.poster || FALLBACK_POSTER;
  img.loading = "lazy";

  const details = document.createElement("div");
  details.className = "details";

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = item.title;

  const overview = document.createElement("div");
  overview.className = "overview";
  overview.textContent = item.overview || "";

  const timer = document.createElement("div");
  timer.className = "timer";
  timer.textContent = item.extra || "";

  const link = document.createElement("a");
  link.href = item.link;
  link.target = "_blank";
  link.textContent = "Details";

  details.append(title, overview, timer, link);
  card.append(img, details);
  return card;
}

function showError(type, message) {
  showLoader(type, false);
  const container = document.getElementById(`${type}List`);
  if (!container) return;
  container.textContent = "";
  const emptyDiv = document.createElement("div");
  emptyDiv.className = "empty";
  emptyDiv.textContent = message;
  container.appendChild(emptyDiv);
}
