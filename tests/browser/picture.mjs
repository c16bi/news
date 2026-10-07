/* A generated stand-in for a publisher's photograph: deterministic per URL,
   and padded past the service worker's minimum size for a real picture. */

import { createHash } from "node:crypto";

export function picture(name) {
  const h = parseInt(
    createHash("md5").update(name).digest("hex").slice(0, 6),
    16,
  );
  const hue = h % 360;
  const dots = Array.from(
    { length: 60 },
    (_, i) =>
      `<circle cx="${(h >> (i % 16)) % 1200}" cy="${(i * 37) % 675}" r="${8 + (i % 30)}" fill="#fff" opacity=".07"/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675" width="1200" height="675"><rect width="1200" height="675" fill="hsl(${hue} 35% 35%)"/>${dots}</svg>`;
}
