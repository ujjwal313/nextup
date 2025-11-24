const tmdbBase = "https://api.themoviedb.org/3";
const anilistUrl = "https://graphql.anilist.co";
const FALLBACK_POSTER =
  "https://placehold.co/200x300/0f172a/e5e7eb?text=No+Image";

const SHARED_TMDB_KEY = "";
let activeTMDBKey = SHARED_TMDB_KEY;

let currentDate = new Date();
let tvPage = 1;
let tvTotalPages = 1;
let tvLoading = false;

const tvObserver = new IntersectionObserver(
  (entries) => entries[0].isIntersecting && loadTV(activeTMDBKey),
  { rootMargin: "200px" }
);

const browser = window.browser || window.chrome;

document.addEventListener("DOMContentLoaded", () => {
  setupDate();
  setupTabs();
  setupApiKeyControls();
  setupDateButtons();

  browser.storage.sync.get(["tmdbApiKey"], ({ tmdbApiKey }) => {
    activeTMDBKey = tmdbApiKey || SHARED_TMDB_KEY;
    initializeLoad();
  });
});

function initializeLoad() {
  ["movies", "anime", "tv"].forEach((t) => {
    clearList(t);
    showLoader(t, true);
    showEmpty(t, false);
  });
  loadMovies(activeTMDBKey);
  loadTV(activeTMDBKey);
  loadAnime();
  const sentinel = document.createElement("div");
  sentinel.id = "tvSentinel";
  document.getElementById("tvList").appendChild(sentinel);
  tvObserver.observe(sentinel);
}

function setupDate() {
  document.getElementById("dateLabel").textContent =
    currentDate.toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
}

function setupDateButtons() {
  document.getElementById("prevDay").addEventListener("click", () => {
    currentDate.setDate(currentDate.getDate() - 1);
    onDateChange();
  });

  document.getElementById("nextDay").addEventListener("click", () => {
    currentDate.setDate(currentDate.getDate() + 1);
    onDateChange();
  });
}

function onDateChange() {
  setupDate();
  tvPage = 1;
  tvTotalPages = 1;
  tvLoading = false;

  ["movies", "anime", "tv"].forEach((t) => {
    clearList(t);
    showLoader(t, true);
    showEmpty(t, false);
  });

  loadMovies(activeTMDBKey);
  loadTV(activeTMDBKey);
  loadAnime();
  const sentinel = document.createElement("div");
  sentinel.id = "tvSentinel";
  document.getElementById("tvList").appendChild(sentinel);
  tvObserver.observe(sentinel);
}

function setupTabs() {
  document.querySelectorAll("#tabs button").forEach((btn) =>
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#tabs button")
        .forEach((t) => t.classList.remove("active"));
      document
        .querySelectorAll(".tab-panel")
        .forEach((p) => p.classList.remove("active"));

      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    })
  );
}

function setupApiKeyControls() {
  document.getElementById("saveApiKeyBtn").addEventListener("click", () => {
    const customKey = document.getElementById("tmdbApiKeyInput").value.trim();
    if (!customKey) return;

    browser.storage.sync.set({ tmdbApiKey: customKey }, () => {
      activeTMDBKey = customKey;
      document.getElementById("apiKeyStatus").innerText =
        "Key saved! Reloading...";
      setTimeout(() => window.location.reload(), 600);
    });
  });
}

function showLoader(type, show) {
  document.getElementById(`${type}Loader`).style.display = show
    ? "flex"
    : "none";
}

const showEmpty = (type, show) =>
  (document.getElementById(`${type}Empty`).style.display = show
    ? "block"
    : "none");

const clearList = (type) => {
  const el = document.getElementById(`${type}List`);
  el.textContent = "";
};

async function fetchWithKey(url) {
  const res = await fetch(url);
  if ([401, 403, 429, 500].includes(res.status)) {
    document.getElementById("apiKeySection").classList.remove("hidden");
    document.getElementById("apiKeyStatus").innerText =
      "API limit reached or invalid key. Enter personal TMDB key to continue.";
    throw new Error();
  }
  return res.json();
}

function dateYMD() {
  return `${currentDate.getFullYear()}-${String(
    currentDate.getMonth() + 1
  ).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;
}

async function loadMovies(apiKey) {
  try {
    const url =
      `${tmdbBase}/discover/movie?api_key=${apiKey}` +
      `&primary_release_date.gte=${dateYMD()}` +
      `&primary_release_date.lte=${dateYMD()}` +
      `&sort_by=popularity.desc`;

    const { results = [] } = await fetchWithKey(url);

    renderItems(
      "movies",
      results.map((m) => ({
        title: m.title,
        poster: m.poster_path
          ? `https://image.tmdb.org/t/p/w200${m.poster_path}`
          : FALLBACK_POSTER,
        overview: m.overview,
        extra: m.vote_average ? `⭐ ${m.vote_average.toFixed(1)}` : "",
        link: `https://www.themoviedb.org/movie/${m.id}`,
      }))
    );
  } catch {
    showError("movies", "Error loading movies");
  }
}

async function loadTV(apiKey) {
  if (tvLoading || tvPage > tvTotalPages) return;
  tvLoading = true;

  try {
    const url = `${tmdbBase}/discover/tv?api_key=${apiKey}&air_date.gte=${dateYMD()}&air_date.lte=${dateYMD()}&page=${tvPage}`;
    const { results = [], total_pages } = await fetchWithKey(url);

    tvTotalPages = total_pages;
    tvPage++;

    appendItems(
      "tv",
      results.map((show) => ({
        title: show.name,
        poster: show.poster_path
          ? `https://image.tmdb.org/t/p/w200${show.poster_path}`
          : FALLBACK_POSTER,
        overview: show.overview,
        extra: show.vote_average ? `⭐ ${show.vote_average.toFixed(1)}` : "",
        link: `https://www.themoviedb.org/tv/${show.id}`,
      }))
    );
  } catch {
    showError("tv", "Error loading TV shows");
  } finally {
    showLoader("tv", false);
    tvLoading = false;
  }
}

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
              id
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

    const items = schedules
      .map((s) => ({
        title: s.media?.title?.english || s.media?.title?.romaji || "Untitled",
        poster: s.media?.coverImage?.medium || FALLBACK_POSTER,
        countdown: formatCountdown(s.timeUntilAiring),
        episode: s.episode,
        season: s.media?.season,
        link: s.media?.siteUrl,
        airingAtUnix: s.airingAt,
      }))
      .sort((a, b) => a.airingAtUnix - b.airingAtUnix);

    renderItems("anime", items);
  } catch {
    showError("anime", "Error loading anime");
  }
}

function formatCountdown(sec) {
  return sec == null || sec <= 0
    ? "Aired"
    : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function renderItems(type, items) {
  const container = document.getElementById(`${type}List`);
  showLoader(type, false);

  if (!items || !items.length) {
    container.innerHTML = "";
    showEmpty(type, true);
    return;
  }

  showEmpty(type, false);
  container.innerHTML = "";
  items.forEach((item) => container.appendChild(createCard(item)));
}

function appendItems(type, items) {
  const container = document.getElementById(`${type}List`);
  showEmpty(type, false);

  items.forEach((item) => container.appendChild(createCard(item)));

  const sentinel = document.getElementById("tvSentinel");
  if (sentinel && container.lastElementChild !== sentinel) {
    container.appendChild(sentinel);
  }
}

function createCard(item) {
  const card = document.createElement("div");
  card.className = "card";

  const img = Object.assign(document.createElement("img"), {
    className: "poster",
    src: item.poster,
    loading: "lazy",
  });

  const details = document.createElement("div");
  details.className = "details";

  const title = Object.assign(document.createElement("div"), {
    className: "title",
    textContent: item.title,
  });

  const overview = Object.assign(document.createElement("div"), {
    className: "overview",
    textContent: item.overview || "",
  });

  const badges = Object.assign(document.createElement("div"), {
    className: "badges",
  });

  if (item.episode) {
    const episodeBadge = Object.assign(document.createElement("span"), {
      className: "badge episode-badge",
      textContent: `EP ${item.episode}`,
    });
    badges.appendChild(episodeBadge);
  }

  if (item.season) {
    const seasonBadge = Object.assign(document.createElement("span"), {
      className: "badge season-badge",
      textContent: String(item.season),
    });
    badges.appendChild(seasonBadge);
  }

  const timer = document.createElement("div");
  timer.className = "timer";
  timer.textContent = item.countdown || item.extra || "";

  const link = Object.assign(document.createElement("a"), {
    href: item.link,
    target: "_blank",
    textContent: "Details",
  });

  details.append(title, overview, badges, timer, link);
  card.append(img, details);
  return card;
}

function showError(type, message) {
  showLoader(type, false);
  const container = document.getElementById(`${type}List`);
  container.textContent = "";
  const emptyDiv = Object.assign(document.createElement("div"), {
    className: "empty",
    textContent: message,
  });

  container.appendChild(emptyDiv);
}
