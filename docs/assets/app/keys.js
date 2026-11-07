/* keys.js - keyboard shortcuts. Press ? on the page for the list. */

import { store } from "./store.js";
import { prefersReducedMotion } from "./format.js";

export function bindKeys(app) {
  function current() {
    return document.querySelector("#app li.feed-item.lb-cursor");
  }

  function move(delta) {
    const rows = app.feed.visibleRows();
    if (!rows.length) return;
    const at = rows.indexOf(current());
    let next = at === -1 ? (delta > 0 ? 0 : rows.length - 1) : at + delta;
    next = Math.max(0, Math.min(rows.length - 1, next));
    rows.forEach((li) => li.classList.remove("lb-cursor"));
    rows[next].classList.add("lb-cursor");
    rows[next].scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }

  function typing(event) {
    const t = event.target;
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      t.isContentEditable
    );
  }

  function itemOf(li) {
    return li && app.data.byUrl.get(li.dataset.lbUrl);
  }

  function scrollTo(top) {
    window.scrollTo({
      top,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "Escape") {
      if (app.sheet.isOpen()) return app.sheet.close();
      if (app.chrome.helpOpen()) return app.chrome.toggleHelp();
      if (app.chrome.settingsOpen()) return app.chrome.toggleSettings(false);
      if (typing(event)) return event.target.blur();
      const sel = current();
      if (sel) sel.classList.remove("lb-cursor");
      return;
    }
    if (typing(event)) return;

    const sel = current();
    switch (event.key) {
      case "j":
        event.preventDefault();
        move(1);
        break;
      case "k":
        event.preventDefault();
        move(-1);
        break;
      case "o":
      case "Enter": {
        const item = itemOf(sel);
        if (!item) return;
        event.preventDefault();
        app.open(item, null);
        break;
      }
      case "s": {
        const item = itemOf(sel);
        if (!item) return;
        event.preventDefault();
        app.toggleSaved(item, sel);
        break;
      }
      case "m": {
        const item = itemOf(sel);
        if (!item) return;
        event.preventDefault();
        app.toggleRead(item, sel, true);
        break;
      }
      case "u":
        event.preventDefault();
        app.chrome.setFilter("hideRead", !store.prefs.hideRead);
        break;
      case "v":
        event.preventDefault();
        app.chrome.setFilter("savedOnly", !store.prefs.savedOnly);
        break;
      case "r":
        event.preventDefault();
        store.setPref("inAppReader", !store.inApp());
        app.chrome.applyLayout();
        app.chrome.toast(
          store.inApp() ? "Articles open here" : "Articles open in a new tab",
        );
        break;
      case ",":
        event.preventDefault();
        app.chrome.toggleSettings();
        break;
      case "/":
        event.preventDefault();
        app.chrome.focusSearch();
        break;
      case "g":
        event.preventDefault();
        scrollTo(0);
        break;
      case "G":
        event.preventDefault();
        scrollTo(document.body.scrollHeight);
        break;
      case "[":
        event.preventDefault();
        app.chrome.cycleLayout(-1);
        break;
      case "]":
        event.preventDefault();
        app.chrome.cycleLayout(1);
        break;
      case "?":
        event.preventDefault();
        app.chrome.toggleHelp();
        break;
    }
  });
}
