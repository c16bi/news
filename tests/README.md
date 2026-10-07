# Tests

Two suites, both run on every pull request by `.github/workflows/test.yml`.

## Build scripts (Python, standard library only)

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
```

| File | Covers |
| --- | --- |
| `test_stories.py` | Grouping the same story across outlets. The cases in `data/story_cases.json` are real articles from the live feed, pinned with the text the grouping actually sees. |
| `test_build_river.py` | The day-bucketed river: what is merged and what is left out, byte-identical output when nothing changed (newsboat renumbers every item each build), one day file changing per new story, picture and text selection, and unsafe URLs never reaching the page. |
| `test_harvest_articles.py` | Pulling an article's body and picture off its page. |

## The page (Playwright)

```sh
cd tests/browser
npm ci
npx playwright install chromium   # once
npx playwright test
```

On a machine that already has Chromium, skip the install and point at it:
`PW_CHROMIUM=/path/to/chromium npx playwright test`.

The site under test is built from `fixtures/` by `render_site.py`: real feed
data, trimmed, rendered through the same `index.hbs` and the same
`scripts/build_river.py` the hourly workflow runs. No Liveboat and no network
are needed. Publisher pictures are answered with generated stand-ins.

| File | Covers |
| --- | --- |
| `layouts.spec.mjs` | All eight layouts at phone and laptop widths; which ones load pictures, and how many; retired layouts landing on their replacements; theme and layout being remembered. |
| `reading.spec.mjs` | The in-app reader, saving, swipes with undo, hide-read, saved-only (including articles that have left the feed), keyboard shortcuts. |
| `stories.spec.mjs` | Grouped stories: one row, the other outlets behind it, turning grouping off, search never hiding a match inside a group. |
| `search.spec.mjs` | Search words, `t:` tags, empty results, one source at a time. |
| `safety.spec.mjs` | Markup and `javascript:` links injected into the feed are shown as text or dropped, never run. |
| `data.spec.mjs` | Counted at the server: after a rebuild, a revisit downloads only the day that changed. Also the live refresh of an open page, and the fallback when the river is missing. |
| `offline.spec.mjs` | With the network cut: the feed, the pictures already scrolled past and full articles all still there; the picture cache cap. |

`data.spec.mjs` rebuilds the site the server is serving to simulate an hourly
build, which is why the suite runs on one worker.
