/*
 * gestures.js - swipe right to save, swipe left to mark read.
 *
 * Two rules keep this smooth:
 *
 * The finger never waits on layout. `touch-action: pan-y` hands vertical
 * scrolling to the compositor, so nothing here calls preventDefault, and the
 * only thing written during a drag is a transform, batched to one write per
 * animation frame.
 *
 * Nothing that changes size changes during the drag. The hint is built once
 * per row and its text is rewritten only when the direction or the armed
 * state actually flips.
 */

import { store } from "./store.js";
import { el } from "./format.js";

const TRIGGER = 64; // px of travel that commits the action
const CLAIM = 10; // px before the gesture is ours rather than the scroller's
const MAX = 108; // rubber-band ceiling

export function createGestures(app) {
  return function bind(li, item) {
    const url = item.url;
    let startX = 0;
    let startY = 0;
    let offset = 0;
    let claimed = false;
    let settled = true;
    let frame = 0;
    let shownAction = "";
    let shownArmed = null;

    const hint = el("span", "lb-swipe-hint");
    hint.setAttribute("aria-hidden", "true");
    li.appendChild(hint);

    function paint() {
      frame = 0;
      li.style.transform = offset ? "translate3d(" + offset + "px,0,0)" : "";
      const action = offset > 0 ? "save" : "read";
      const armed = Math.abs(offset) >= TRIGGER;
      if (action === shownAction && armed === shownArmed) return;
      if (action !== shownAction) {
        li.setAttribute("data-lb-swipe", action);
        hint.textContent =
          action === "save"
            ? store.isSaved(url)
              ? "Unsave"
              : "Save"
            : store.isRead(url)
              ? "Unread"
              : "Read";
        shownAction = action;
      }
      if (armed !== shownArmed) {
        li.classList.toggle("lb-swipe-armed", armed);
        shownArmed = armed;
      }
    }

    function reset() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      offset = 0;
      claimed = false;
      shownAction = "";
      shownArmed = null;
      li.style.transform = "";
      li.classList.remove("lb-swiping", "lb-swipe-armed");
      li.removeAttribute("data-lb-swipe");
    }

    li.addEventListener(
      "touchstart",
      (event) => {
        // A touch that begins on the star is a tap on the star.
        if (event.touches.length !== 1 || event.target.closest(".lb-star")) {
          settled = true;
          return;
        }
        settled = false;
        claimed = false;
        offset = 0;
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
      },
      { passive: true },
    );

    li.addEventListener(
      "touchmove",
      (event) => {
        if (settled || event.touches.length !== 1) return;
        let dx = event.touches[0].clientX - startX;
        const dy = event.touches[0].clientY - startY;
        if (!claimed) {
          // A diagonal drag belongs to the scroller.
          if (Math.abs(dy) > Math.abs(dx)) {
            settled = true;
            return;
          }
          if (Math.abs(dx) < CLAIM) return;
          claimed = true;
          li.classList.add("lb-swiping");
          // Measure from the claim point so the row does not jump.
          startX += dx < 0 ? -CLAIM : CLAIM;
          dx = event.touches[0].clientX - startX;
        }
        offset = dx;
        if (Math.abs(offset) > TRIGGER) {
          const over = Math.abs(offset) - TRIGGER;
          offset = Math.sign(offset) * Math.min(MAX, TRIGGER + over * 0.3);
        }
        if (!frame) frame = requestAnimationFrame(paint);
      },
      { passive: true },
    );

    function finish() {
      if (settled || !claimed) {
        reset();
        return;
      }
      const committed = Math.abs(offset) >= TRIGGER;
      const action = offset > 0 ? "save" : "read";
      reset();
      if (!committed) return;
      if (navigator.vibrate) {
        try {
          navigator.vibrate(8);
        } catch (e) {
          /* a nicety, blocked in some contexts */
        }
      }
      if (action === "save") app.toggleSaved(item, li, true);
      else app.toggleRead(item, li);
    }

    li.addEventListener("touchend", finish, { passive: true });
    li.addEventListener("touchcancel", finish, { passive: true });
  };
}
