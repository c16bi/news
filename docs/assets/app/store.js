/*
 * store.js - everything the reader keeps in this browser.
 *
 * The keys are the ones the previous front end used, so switching over loses
 * nothing: read state, saved articles, layout and theme all carry across.
 */

const NS = "liveboat-custom:";
const THEME_KEY = "liveboat-default-theme";
const READ_RETENTION_DAYS = 60;
const MAX_SAVED = 500;

export const DEFAULT_THEME = "seabreeze";

export const THEMES = [
  ["default", "Default"],
  ["mono", "Mono"],
  ["plain", "Plain"],
  ["soldark", "Solarized Dark"],
  ["sollight", "Solarized Light"],
  ["tokyo", "Tokyo Night"],
  ["seabreeze", "Seabreeze"],
  ["gameboy", "Gameboy"],
  ["sunset", "Sunset"],
];

export const LAYOUTS = [
  { id: "compact", label: "Compact", hint: "Dense one-line rows" },
  { id: "reader", label: "Reader", hint: "Minimal, generous type, no chips" },
  { id: "e1", label: "Mixed", hint: "Newest first, pictures where they exist" },
  { id: "e2", label: "Leads", hint: "Each day opens with its best picture" },
  {
    id: "f1",
    label: "Bleed",
    hint: "Pictures span the screen, words underneath",
  },
  {
    id: "f2",
    label: "Edge",
    hint: "Picture flush off the right, list stays dense",
  },
  { id: "f3", label: "Immersive", hint: "Headline set over the picture" },
  {
    id: "f4",
    label: "Broadsheet",
    hint: "One picture a day, then a tight list",
  },
];

// Layouts that show pictures; everything else never asks for one.
export const IMAGE_LAYOUTS = new Set(["e1", "e2", "f1", "f2", "f3", "f4"]);
// Layouts that open each day with one picture and run the rest as text.
export const LEAD_LAYOUTS = new Set(["e2", "f4"]);
export const EDITORIAL_LAYOUTS = new Set(["e1", "e2"]);

/* Cards, Digest and Discover were retired when the picker was cut down.
   Anyone still on one lands on the layout that replaced it rather than on
   Compact, which would look like their choice had been thrown away. */
const RETIRED_LAYOUTS = { cards: "f2", digest: "e2", discover: "f1" };

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
  } catch (e) {
    /* quota or private mode - state is best effort */
  }
}

const startedAt = Date.now();

// url -> unix seconds when it was marked read
const read = load("read", {});
const cutoff = startedAt / 1000 - READ_RETENTION_DAYS * 86400;
let pruned = false;
for (const url of Object.keys(read)) {
  if (!(read[url] > cutoff)) {
    delete read[url];
    pruned = true;
  }
}
if (pruned) save("read", read);

// url -> {t: saved-at, title, domain, date?}
const saved = load("saved", {});

const prefs = load("prefs", {});
if (RETIRED_LAYOUTS[prefs.layout]) {
  prefs.layout = RETIRED_LAYOUTS[prefs.layout];
  save("prefs", prefs);
}

// The previous visit, for marking what is new; then this visit becomes it.
const lastVisit = load("lastVisit", 0);
save("lastVisit", Math.floor(startedAt / 1000));

export const store = {
  startedAt,
  lastVisit,
  read,
  saved,
  prefs,

  isRead: (url) => !!read[url],
  isSaved: (url) => !!saved[url],

  setRead(url, on) {
    if (on) read[url] = Math.floor(Date.now() / 1000);
    else delete read[url];
    save("read", read);
  },

  toggleSaved(url, details) {
    if (saved[url]) {
      delete saved[url];
    } else {
      const keys = Object.keys(saved);
      if (keys.length >= MAX_SAVED) {
        keys
          .sort((a, b) => (saved[a].t || 0) - (saved[b].t || 0))
          .slice(0, keys.length - MAX_SAVED + 1)
          .forEach((k) => delete saved[k]);
      }
      saved[url] = { t: Math.floor(Date.now() / 1000), ...details };
    }
    save("saved", saved);
    return !!saved[url];
  },

  setPref(key, value) {
    prefs[key] = value;
    save("prefs", prefs);
  },

  layout() {
    return LAYOUTS.some((l) => l.id === prefs.layout)
      ? prefs.layout
      : "compact";
  },

  inApp: () => prefs.inAppReader !== false,
  grouping: () => prefs.group !== false,

  theme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t && THEMES.some(([id]) => id === t)) return t;
    } catch (e) {
      /* private mode */
    }
    return DEFAULT_THEME;
  },

  setTheme(id) {
    try {
      localStorage.setItem(THEME_KEY, id);
    } catch (e) {
      /* private mode - the choice lasts for this page only */
    }
  },

  icons: load("icons", {}),
  saveIcons() {
    save("icons", this.icons);
  },
};
