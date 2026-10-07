<h2 align="center">
<img align="center" width="70" height="70" src="./assets/logo.png"><br/>
<br/>
Liveboat Github Runner
</h2>

### See it in [Action](https://konrad.website/liveboat-github-runner)

<br/>
This is template repository for <a href="https://github.com/exaroth/liveboat">Liveboat</a> feed generator, use it to configure and deploy feed websites on Github Pages. Follow instructions below for more details.

## Installation

Prerequisites: 
- List of RSS urls you want to follow, see [Liveboat url file breakdown](#liveboat-url-file-breakdown) section below for more information about adding links to the page.
- Github account

__STEP 1__ Create new Github repository from `liveboat-github-runner` template

- Click `Use this template` in the upper right corner
- Select repository name and privacy settings

> [!NOTE]
> Repository can be private or public however note that hosting project pages from private repos is only available for Github Pro users.

- After the repository has been created use `git clone` to download it

__STEP 2__ Update configuration and urls file
- `cd` into the cloned repository
 
- First edit `./config/liveboat-config.toml` file, update `title` and most importantly `site_path` - this option needs to be set to `/<repo_name>/` where `repo_name` corresponds to repository name created in Step 1.

- Next replace feeds url in `./config/urls` with those you want to follow - If you're existing Newsboat user simply copy contents of the `urls` file (typically stored at `~/.newsboat/urls`)

> [!NOTE]
> Order of the URLs does matter as it will reflect order of feeds in generated page.

- Commit all the changes and `git push` them back to remote
 
__STEP 3__ Update settings for the repository

1. Go to `Settings->Actions->General` page within the repo created in Step 1. In `Workflow Permissions` section set `Read and write permissions` and click `Save`.
![screenshot1](./assets/screen1.png)
2. Still in Project Settings go to `Pages` tab and under `Build and deployment`, set `Source` to `Deploy from branch`, set `Branch name` to `master` and select `/docs` as the folder to deploy Pages from. Click `Save`.
![screenshot2](./assets/screen2.png)

__STEP 4__ Finally going back to terminal execute
``` sh
git tag build && git push --tags
```
To execute page rebuild job.

> [!TIP]
> Pushing any tag starting with `build` will execute page rebuild.

> [!TIP]
> This repo also enables `workflow_dispatch`, so a rebuild can be started
> without a tag: Actions tab → **Liveboat feed build** → **Run workflow**.

__DONE__ Wait until Github Action finishes execution, then navigate to the repo Github Page `https:://<username>.github.io/<repo_name>` and verify everything is as expected.

## Changing page appearance
Default template allows basic level of color customization, if you want to change color theme edit `./templates/default/config.toml` file (this repo builds from `./templates/custom`, so edit `./templates/custom/config.toml` here) and update color values to those that suit your needs

```
[template_settings]
text-color = "#c7cfcc"
highlight-color = "#73bed3"
accent-color = "#3c5e8b"
background-color = "#181818"
custom-color = "#f3a833"
autoreload = "1"
```

For more advanced template modifications see [Template development guide](https://github.com/exaroth/liveboat/tree/develop/templates).

> [!IMPORTANT]
> When using modified version of default template do not replace contents of `./templates/default` as these might be overwritten during update, instead put it in separate directory and update `--template-path` value in `.github/workflows/workflow.yml` file.

## The `templates/custom` template

This repo builds from `./templates/custom` rather than `./templates/default`
(see `--template-path` in `.github/workflows/workflow.yml`). It is its own
front end: Liveboat still fetches the feeds and writes them to `docs/feeds/`,
but the page that reads them is written here, not the prebuilt app Liveboat
ships.

| File | What it does |
| --- | --- |
| `index.hbs` | The page shell. Header, search box and theme are in the markup, so they paint before any script runs. |
| `include/assets/app/*.js` | The reader, as plain ES modules with no build step: `main.js` boots it; `data.js` loads the feed, `feed.js` renders it, `chrome.js` is search and settings, plus `sheet.js`, `gestures.js`, `keys.js`, `logos.js`, `offline.js`, `store.js`, `format.js`. |
| `include/assets/base.css` | Theme palettes, typography and the page column. |
| `include/assets/custom.css` | Rows, the eight layouts, and everything interactive. |
| `include/sw.js` | Service worker, so the page installs as an app and works offline. |
| `include/assets/site.webmanifest` | Web app manifest (name, icons, standalone display, theme colour). |

The build also runs four scripts after Liveboat:

| Script | What it does |
| --- | --- |
| `scripts/harvest_articles.py` | Reads each article's page once for its picture and its text, since most feeds send neither. Cached in `config/article-cache.json`. |
| `scripts/harvest_icons.py` | Reads each publisher's declared logo. Cached in `config/icon-cache.json`. |
| `scripts/build_river.py` | Merges every source into one feed, split by day, for the page to load (below). |
| `scripts/report_empty_feeds.py` | Warns on the run summary when a source stops producing. |

### The river

Liveboat's per-feed files are not what the page loads. Loaded as-is, a visit
after any hourly rebuild downloaded all of them again - 1.1 MB compressed -
because every file changed every build: newsboat's cache is rebuilt from
scratch each run, so every item is renumbered; the topic feeds (Finance,
News, Tech, Politics, Sport) repeat the source feeds' items; and every
`_archive` file duplicated its live feed.

`build_river.py` writes `docs/river/` instead: one file per UTC day, holding
that day's stories with their picture and text already chosen, plus an index
listing each day with a hash of its contents. The page requests each day as
`river/<day>.json?v=<hash>`, so a day that has not changed is the same URL as
last time and comes from the cache. Measured on real consecutive builds, a
revisit downloads 54-91 KB instead of 281-284 KB. If this step ever fails,
the workflow removes the river and the page falls back to Liveboat's own
files.

### The same story from several outlets

When the BBC, the Guardian and the NYT all report something, it is one row
with the others behind an "Also covered by" line. `scripts/stories.py` finds
these groups at build time - TF-IDF over the headline and opening text, but
only across different outlets, only within 48 hours, and only when the
reports share a name (a person, company, place or product) unless the wording
is near-identical. It is tuned to miss rather than merge wrongly: a missed
group is a duplicate row, a wrong one hides a story. Grouping can be turned
off in settings, and search always shows every match on its own row.

### What the reader does

- **One feed, newest first,** grouped by your own day.
- **Read tracking.** Opening an article dims it; hide-read drops what you
  have opened.
- **Save for later**, with a saved-only view that keeps articles that have
  since left the feed.
- **Swipes**: right to save, left to mark read, each with Undo.
- **In-app reading**: the article body where the build could get it, the
  feed's summary otherwise, with Open original, Save and Share.
- **Search** across headlines and source names, with `t:` to filter by tag
  (`t:sport`, `t:f1,cycling`).
- **One source at a time**, from settings.
- **New since your last visit**, counted on the dock.
- **Live refresh**: an open page notices a new build and adds it in place,
  keeping your scroll position.
- **Keyboard**: `j`/`k` move, `o` opens, `s` saves, `m` marks read, `/`
  searches, `[`/`]` change layout, `?` lists the rest.

Read state, saved articles and preferences live in `localStorage` under the
`liveboat-custom:` prefix. They are per-browser and never leave the device.
Read state older than 60 days is pruned.

### Layouts

| Layout | What it is |
| --- | --- |
| **Compact** | Dense rows with a timestamp column. |
| **Reader** | Narrow column, generous type, no chips or badges. |
| **Mixed** | Newest first, a picture beside each story that has one. |
| **Leads** | Each day opens with its best picture; the rest are a list. |
| **Bleed** | Pictures span the screen, words underneath. |
| **Edge** | Picture flush off the right edge, list stays dense. |
| **Immersive** | Headline set over the picture. |
| **Broadsheet** | One full-width picture a day, then a tight serif list. |

Only the picture layouts load remote images, and Leads and Broadsheet load one
per day. Every layout is CSS keyed off `data-lb-layout` on `<body>`; adding one
is a block of CSS and an entry in `LAYOUTS` in `app/store.js`.

### Theme

Nine themes, chosen in settings; a first visit gets **Seabreeze**. Theme and
layout are applied by a small inline script before the first paint, so a dark
theme never flashes light while the page loads. The light themes derive their
surfaces and hairlines from the text colour rather than the accent, which in
Seabreeze sits within a few percent of the background.

### Publisher logos

`harvest_icons.py` reads each publisher's declared icon from its own page
head, and that answer wins. Publishers that refuse the build often do not
refuse the reader, so for those the browser tries `/apple-touch-icon.png`,
`/apple-touch-icon-precomposed.png` and `/favicon.ico` itself, keeping the
first that is at least 32px and remembering the result per domain for 30 days.
A coloured monogram sits underneath and shows whenever there is no logo.

### Progressive web app and offline

The page is installable ("Add to Home Screen" on iOS, "Install app" on
Chrome/Edge/Android) and works offline.

`include/sw.js` is emitted to `docs/sw.js` - the site root, because a service
worker can only control pages at or below its own path and GitHub Pages will
not serve the `Service-Worker-Allowed` header that would relax that.

| Request | Strategy |
| --- | --- |
| Page navigation | Network first, cached shell as the offline fallback |
| `assets/*` | Stale-while-revalidate, matched exactly on `?bt=<build time>` |
| `river/*?v=<hash>` | Cache first - the hash is the content, so a hit is current |
| `river/index.json` | Network first, cached copy as the offline fallback |
| Pictures, any origin | Cache first, capped at 160, quota-safe |

Every module is listed in an import map with the build time in its URL, so
one build's page can never run with another build's modules out of the cache.
`index.hbs` carries a small inline recovery snippet that asks the worker to
update and reloads when a new worker replaces an old one - code served from a
stale cache cannot rescue itself.

### Tests

`tests/` holds the Python tests for the build scripts and a Playwright suite
for the page, both run on every pull request. See `tests/README.md`.

### Upstream template updates

`make update` updates `./templates/default` and the Liveboat binary; it never
touches `./templates/custom`, which no longer derives from the default
template. Upstream changes to Liveboat's own front end do not apply here.

## Liveboat URL file breakdown
This section goes over basic Newsboat URL file syntax which Liveboat uses for parsing RSS links. For more detailed overview see [Newsboat documentation page](https://newsboat.org/releases/2.10.2/docs/newsboat.html)

##### Basic example
You can simply add urls to Atom/RSS feeds, one per line, eg.
```
https://hnrss.org/best
https://access.acast.com/rss/theeconomistmorningbriefing/default
```
##### Adding custom titles
Above example will work just fine however feed titles might not be exactly what you want, this can be alleviated by overwriting them, this is done by adding ` "~<Title>"` for the line eg.
```
https://hnrss.org/best "~HN" 
https://access.acast.com/rss/theeconomistmorningbriefing/default "~Daily Brief"
```

##### Aggregating feeds
You can group related feeds using tags and query feeds, to tag particular feed simply append tag name to the line, and create new query feed with matching tags via `query:` syntax. Example:

```
https://hnrss.org/best "~HN" dev
http://blog.golang.org/feed.atom "~Golang Blog" dev

"query:Dev News:tags # \"dev\""
```
This will result in 3 feeds being displayed, `HN` `Golang Blog` and `Dev News` latter containing results from first 2 feeds. If you'd like to only see aggregated feed and not the other ones, add `!` to the lines of the feeds you want to hide, like so:

```
https://hnrss.org/best "~HN" ! dev
http://blog.golang.org/feed.atom "~Golang Blog" ! dev

"query:Dev News:tags # \"dev\""
```

This will result showing only `Dev News` feed on the page. 

You can also add additional filtering options to query feeds, for example to show only articles from last 2 days:

```
https://hnrss.org/best "~HN" ! dev
http://blog.golang.org/feed.atom "~Golang Blog" ! dev

"query:Dev News:tags # \"dev\" and age <= 2"
```
See Newsboat documentation for list of all available filtering options.

## Newsboat cache persistence

By default Newsboat cache file containing feed data is not being persisted in between feed rebuilds - this means that only articles retrieved during current Newsboat reload will be processed. To change that set `PERSIST_NEWSBOAT_CACHE` to `1` within `./config/page_options` file, this will cause Newsboat db cache to be saved after every update. Additionally set `NEWSBOAT_CACHE_RETENTION_DAYS` to number of days articles will be stored in db (ideally this should match `keep-articles-days` in `./config/newsboat-config` file).

## Changing build time intervals
By default feed page will be rebuilt every hour, if you want to change it edit `.github/workflows/workflow.yml` and update schedule definition
```
  schedule:
    - cron: "0 * * * *"

```
## Template updates

In order to manually update templates supplied with Liveboat execute `make update`, alternatively you can enable automatic updates by setting `ENABLE_AUTOMATIC_UPDATES` to `1` in `./config/page_options` file which will check for new version during every page rebuild.

## License
Liveboat is provided under MIT License, see `LICENSE` file for details
