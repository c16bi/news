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
Default template allows basic level of color customization, if you want to change color theme edit `./templates/default/config.toml` file and update color values to those that suit your needs

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
(see `--template-path` in `.github/workflows/workflow.yml`). It is a copy of the
default template plus a few files that layer on top of the upstream bundle:

| File | What it does |
| --- | --- |
| `include/assets/custom.css` | Restyles the article list, feed headers, toolbar and mobile layout. Written entirely against the theme variables, so all nine built-in themes still work. |
| `include/assets/custom.js` | Adds behaviour the prebuilt SPA does not have — timestamps, read tracking, saved articles, keyboard navigation, service worker registration. |
| `include/sw.js` | Service worker, so the page installs as an app and works offline. |
| `include/assets/site.webmanifest` | Web app manifest (name, icons, standalone display, theme colour). |

`index.hbs` is the stock one with a stylesheet `<link>`, a script `<script>`, a
manifest `<link>` and a few extra `<meta>` tags added. Nothing in
`index.js`/`index.css` is patched, so upstream template updates stay easy to
take.

### What the layer adds

- **Relative timestamps** on every article (`5h`, `2d`, `1w`), with the exact
  publication date on hover. `custom.js` wraps `fetch` and reads the feed JSON
  the app is already downloading, so this costs no extra requests.
- **Read tracking.** Opening an article dims it. Press `u` (or the ◎ button) to
  hide everything you have read.
- **Save for later.** Click the ★ on any row, then press `v` (or the ★ button)
  to show only saved articles.
- **New since your last visit** — those rows get an accent-coloured timestamp
  and a dot, and the dock shows a count.
- **Publisher logos** on each source chip, with a coloured monogram underneath
  as the resting state — see below.
- **Keyboard navigation**: `j`/`k` move, `o` or `Enter` opens, `s` saves, `m`
  toggles read, `/` focuses search, `g`/`G` jump to top/bottom, `?` shows the
  full list.
- **Four article layouts**, switchable from the tab bar at the bottom of the
  page or with `[` / `]`. The choice is remembered.
- Reading progress bar, back-to-top button, focus rings, `prefers-reduced-motion`
  support and a print stylesheet.
- **In-app article previews.** Tapping a headline opens a sheet inside the app
  with the source, image, date and the feed's summary, plus Open original,
  Save and Share. Toggle it with `r` or the ☐ button in the dock.
- **Installable and offline-capable** — see below.

Read state, saved articles, the chosen layout and filter preferences live in
`localStorage` under the `liveboat-custom:` prefix — they are per-browser and
never leave the device. Read state older than 60 days is pruned automatically.

### Layouts

| Layout | What it is |
| --- | --- |
| **Compact** | Dense one-line rows with a timestamp column. The default. |
| **Cards** | Each article a bordered card; two columns from 900px up. |
| **Digest** | The newest article in each feed leads at display size, the rest follow as a list. |
| **Reader** | Narrow serif column, no chips or badges, feed names as uppercase kickers. |
| **Discover** | Image-led cards in the style of a phone news feed. Phone-first. |

Discover is the only layout that pulls in remote images, so nothing is fetched
unless it is selected. Images come from each item's RSS `enclosureUrl` — the
enclosure mime type in these feeds is unreliable (usually absent or
`text/plain` even for JPEGs), so the file extension decides. A failed load
removes the element rather than leaving a broken frame.

**Coverage is uneven, and it follows the source rather than the topic.** Of the
articles in a recent build, about 43% carried an image: NYT, the Guardian,
CyclingNews and Autosport supply one nearly every time, while Bloomberg, the
FT, the Economist and the BBC feeds supply none at all. The Finance section is
therefore entirely text cards. Discover is built for that mix — a card with no
image gets a larger headline instead of an empty frame.

Every layout is pure CSS keyed off `data-lb-layout` on `<body>` — the DOM the
SPA renders is identical in all four, so adding another is a block of CSS and
one entry in the `LAYOUTS` array in `custom.js`. The attribute is used rather
than a class because switching theme clears `body.className`.

### Theme

The SPA reads its theme from `localStorage` at startup and falls back to
`default`. `custom.js` runs before it (classic script, ahead of the deferred
module) and seeds that key with **`seabreeze`** when the reader has never chosen
one — so a first visit is Seabreeze, and any explicit pick from the dropdown,
including "Default Theme", wins from then on.

The light themes need different treatment from the dark ones: Seabreeze's accent
(`#d7d7db`) sits within a few percent of its background (`#e1e2e7`), so
accent-tinted surfaces and hairlines vanish. `custom.css` derives those from the
text colour instead for `seabreeze`, `sollight`, `plain` and `gameboy`.

### Publisher logos

Neither newsboat nor Liveboat keeps the RSS channel `<image>`, so a masthead has
to come from the web. `custom.js` asks the publisher's own site rather than
going through a favicon service, so no third party learns what you read:

1. `https://<domain>/apple-touch-icon.png` (normally 180px)
2. `…/apple-touch-icon-precomposed.png`
3. `…/favicon.ico`

The first image that decodes at 32px or wider wins; anything smaller looks worse
than the monogram, so it is rejected. The outcome per domain — including "none
available" — is cached in `localStorage` for 30 days, so the failed probes are
not repeated on every visit. There are only about twenty domains in the whole
feed list.

The monogram stays in the DOM underneath and shows through whenever a publisher
has no usable icon, refuses the request, or you are offline. A load failure
while offline is deliberately *not* remembered, since it says nothing about the
publisher.

### Reading without leaving the app

Following a link from an installed PWA hands you to the system browser, and you
lose your place in the feed. The article sheet keeps you inside the app: it
shows what the feed already gave us, with the original one tap away.

That summary is the whole limit of it — these are RSS feeds, not full article
text, so the sheet is a preview rather than a reader. Bloomberg supplies a solid
paragraph, the NYT an abstract, and a few feeds nothing at all. Turn it off with
`r` and headlines go straight to the browser again.

On phones the floating dock and layout tabs slide away while you scroll down and
return on any upward scroll, so they are not sitting on top of the feed while
reading.

### Progressive web app

The page is installable: "Add to Home Screen" on iOS, "Install app" on
Chrome/Edge/Android. It then opens without browser chrome, with its own icon.

`include/sw.js` is emitted to `docs/sw.js` — the site root rather than
`docs/assets/`, because a service worker can only control pages at or below its
own path and GitHub Pages will not serve the `Service-Worker-Allowed` header
that would relax that. It is registered from `custom.js` using
`window.sitePath`, so it follows `site_path` automatically.

Caching is chosen around the hourly rebuild, and around the fact that Liveboat
cache-busts with query strings rather than hashed filenames:

| Request | Strategy |
| --- | --- |
| Page navigation | Network first, cached shell as the offline fallback |
| `assets/*` | Stale-while-revalidate — instant paint, refresh behind it |
| `feeds/*`, `channels/*` | Network first, cached copy as the offline fallback |

So online you always read current news; offline you read whatever you last
loaded, with an "Offline" banner at the top of the page.

Asset matching is deliberately **exact**, not `ignoreSearch`. Because Liveboat
cache-busts with `?bt=<build time>`, an exact match means "same build", so a
hit is known-current and a new build correctly misses and goes to the network.
Matching loosely lets the first entry the cache ever saw answer for every later
build, which pins the reader to it permanently — that is exactly what v1 of the
worker did. `ignoreSearch` survives only as the offline fallback, where a stale
asset beats none, and each write drops the other variants of that path so the
cache holds one copy per asset.

`index.hbs` also carries a small inline recovery snippet. It has to be inline:
the page is served network-first, so that snippet is always the newest code
even while the worker is handing out a stale `custom.js`. It asks the
registration to update and reloads the moment a new worker claims the page —
a cached bundle cannot rescue itself. The feed cache is
capped at 60 entries and old cache versions are deleted on activation. When a
new worker takes over an existing one, a toast offers a reload rather than
pulling the page out from under you.

`site.webmanifest` uses relative URLs (`start_url` and `scope` are `../` from
`assets/`), so it resolves correctly regardless of `site_path`. The manifest is
copied verbatim rather than templated — only `index.hbs` goes through
Handlebars — so its `name` is the one thing that has to be kept in step with
`title` in `./config/liveboat-config.toml` by hand.

### Taking an upstream template update

`make update` overwrites `./templates/default`. To carry that into our template:

``` sh
make update
make sync-template
```

`make sync-template` recreates `./templates/custom` from `./templates/default`
and re-injects the override `<link>`/`<script>` and the extra `<meta>` tags.
`custom.css`, `custom.js`, `sw.js`, `site.webmanifest`, the 512px icon and
`config.toml` are preserved as-is. The script is idempotent, so running it twice
is safe.

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
