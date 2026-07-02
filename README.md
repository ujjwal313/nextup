# NextUp — Movies, TV & Anime Release Calendar

A lightweight browser extension that shows what's releasing **today** — movies, TV episodes, and anime — right from your toolbar. Pick any date, see everything dropping that day, and find out where you can stream it.

> Movie night decided in one click. No accounts, no tracking, ~30 KB.

<!-- TODO: add screenshot/GIF here — assets in store-assets/ -->

## Features

- **Three tabs, one date** — theatrical & digital movie releases (TMDB), TV episodes airing (TMDB), and anime episodes with airing countdowns (AniList)
- **Date scrubbing** — step backward or forward through any day's releases
- **Where to watch** — streaming provider logos on every card (data by JustWatch via TMDB; direct Crunchyroll/Netflix links for anime)
- **Season & episode info** — TV cards resolve exactly which episode airs that day (S19 E7), anime cards show episode number and countdown
- **Search the day** — filter the selected date's releases by title, including original-language titles
- **Global or regional** — see worldwide releases or only your country's
- **Instant open** — today's lineup is cached and paints immediately while fresh data loads behind it
- **Light & dark** — follows your device theme, WCAG AA contrast in both
- **6 languages** — English, Español, Português (BR), Français, Deutsch, Nederlands

## Privacy

No accounts, no analytics, no browsing access. The extension talks to exactly three services:

| Endpoint | Purpose |
|---|---|
| `api.themoviedb.org` | Movie & TV release data |
| `graphql.anilist.co` | Anime airing schedules |
| `ipwho.is` | One-time country detection for regional mode (cached 24 h) |

Settings and cached data live in your browser's extension storage and never leave it.

## Install

**Chrome Web Store:** *(link)* — or load it yourself:

1. Clone this repo
2. Open `chrome://extensions`, enable **Developer mode**
3. **Load unpacked** → select the project folder

Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick `manifest.json`.
Edge: `edge://extensions` → **Load unpacked**.

## Development

Plain HTML/CSS/JS, Manifest V3, no build step. The popup is the whole app:

```
manifest.json      MV3 manifest (Chrome + Firefox)
popup.html/js/css  the popup UI and all logic
_locales/          UI strings (en, es, pt_BR, fr, de, nl)
assets/            shipped icons
store-assets/      promo images — not packaged
pack.ps1           builds dist/nextup-v{version}.zip for store upload
```

Edit, then reopen the popup to see JS/CSS changes; hit reload on the extension card for manifest or locale changes. Debug via right-click inside the popup → Inspect.

**Adding a language:** copy `_locales/en/messages.json` to `_locales/<code>/` and translate the `message` values — key set must match `en` exactly.

**Packaging:** `./pack.ps1` produces the store-ready zip in `dist/`.

**Using your own TMDB key:** the popup prompts for a personal API key if the shared one is rate-limited; it's stored in extension sync storage.

## Credits

- Movie/TV data: [TMDB](https://www.themoviedb.org) — this product uses the TMDB API but is not endorsed or certified by TMDB
- Watch-provider data: [JustWatch](https://www.justwatch.com) via TMDB
- Anime data: [AniList](https://anilist.co)
