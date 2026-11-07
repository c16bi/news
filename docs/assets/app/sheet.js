/*
 * sheet.js - read an article without leaving the page.
 *
 * Shows the article body the build harvested where there is one, and the
 * feed's own summary otherwise, with the original one tap away. Every piece
 * of article text is set as text, never markup: it is someone else's HTML.
 */

import { store } from "./store.js";
import { el, fullDate } from "./format.js";
import { badge } from "./logos.js";

// A body this long is the article; shorter is a summary.
const FULL_TEXT = 400;

export function createSheet(app) {
  let sheet = null;
  let lastFocus = null;

  function close() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    document.body.classList.remove("lb-sheet-open");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  function share(item) {
    if (navigator.share) {
      navigator.share({ title: item.title, url: item.url }).catch(() => {});
      return;
    }
    if (navigator.clipboard) {
      navigator.clipboard
        .writeText(item.url)
        .then(() => app.toast("Link copied to clipboard."))
        .catch(() => {});
    }
  }

  function open(item) {
    close();
    lastFocus = document.activeElement;

    sheet = el("div");
    sheet.id = "lb-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", item.title);

    const panel = el("div");
    panel.id = "lb-sheet-panel";

    const head = el("div", "lb-sheet-head");
    if (item.domain) head.appendChild(badge(item.domain));
    head.appendChild(
      el(
        "span",
        "lb-sheet-source",
        item.feedTitle ? item.feedTitle + " · " + item.domain : item.domain,
      ),
    );
    const closeBtn = el("button", "lb-sheet-close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", close);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    if (item.image) {
      const hero = el("img", "lb-sheet-image");
      hero.alt = "";
      hero.loading = "lazy";
      hero.addEventListener("error", () => hero.remove());
      hero.src = item.image;
      panel.appendChild(hero);
    }

    panel.appendChild(el("h2", "lb-sheet-title", item.title));
    panel.appendChild(
      el(
        "p",
        "lb-sheet-meta",
        (item.date ? fullDate(item.date) : "") +
          (item.author ? " · " + item.author : ""),
      ),
    );

    const body = el("div", "lb-sheet-body");
    const text = String(item.text || "").trim();
    if (text.length >= FULL_TEXT) {
      for (const para of text.split(/\n{2,}/)) {
        const line = para.trim();
        if (line) body.appendChild(el("p", null, line));
      }
      body.classList.add("lb-sheet-full");
    } else {
      body.textContent =
        text.replace(/\s+/g, " ") || "No preview available for this article.";
    }
    panel.appendChild(body);

    const actions = el("div", "lb-sheet-actions");
    const original = el("a", "lb-sheet-primary", "Open original ↗");
    original.href = item.url;
    original.target = "_blank";
    original.rel = "noopener";
    actions.appendChild(original);

    const saveBtn = el("button", "lb-sheet-action");
    saveBtn.type = "button";
    const paintSave = () => {
      const on = store.isSaved(item.url);
      saveBtn.textContent = on ? "★ Saved" : "☆ Save";
      saveBtn.setAttribute("aria-pressed", on ? "true" : "false");
    };
    paintSave();
    saveBtn.addEventListener("click", () => {
      app.toggleSaved(item, null);
      paintSave();
    });
    actions.appendChild(saveBtn);

    const shareBtn = el("button", "lb-sheet-action", "Share");
    shareBtn.type = "button";
    shareBtn.addEventListener("click", () => share(item));
    actions.appendChild(shareBtn);
    panel.appendChild(actions);

    sheet.appendChild(panel);
    sheet.addEventListener("click", (event) => {
      if (event.target === sheet) close();
    });
    document.body.appendChild(sheet);
    document.body.classList.add("lb-sheet-open");
    closeBtn.focus();

    app.markOpened(item.url);
  }

  return { open, close, isOpen: () => !!sheet };
}
