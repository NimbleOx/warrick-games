// The sharing cards: the 1200 × 630 pictures that chat apps and social sites show for a link
// (og:image). One for the hub, at hub/public/og.png, and one per game, at games/<slug>/public/og.png
// (served at /<slug>/og.png). Each game's name, blurb and icon come from its card on the hub page,
// and its logo colours from its stylesheet, so a new game gets its card by running this again:
//
//   npm run share-cards
//
// Text is set in the site's own fonts (in fonts/, with their licences), drawn by resvg.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const W = 1200;
const H = 630;
const fontFiles = ["PressStart2P-Regular.ttf", "IBMPlexMono-Regular.ttf", "IBMPlexMono-Medium.ttf"].map((f) =>
  path.join(here, "fonts", f),
);

const BG = "#0b0d17";
const TEXT = "#e9ecf8";
const MUTED = "#8d94b8";
// The hub's logo colours (hub/public/style.css).
const HUB_LOGO = { logo: "#ffd23f", shade: "#e2401c", deep: "#6b1208" };

const hubHtml = fs.readFileSync(path.join(root, "hub/public/index.html"), "utf8");
const games = [...hubHtml.matchAll(/<div class="game live">([\s\S]*?)<\/li>/g)].map(([, card]) => {
  const slug = card.match(/<a class="game-link" href="\/([\w-]+)\/">/)[1];
  return {
    slug,
    name: text(card.match(/<h2>([\s\S]*?)<\/h2>/)[1]),
    blurb: text(card.match(/<p>([\s\S]*?)<\/p>/)[1]),
    icon: fs.readFileSync(path.join(root, "hub/public/icons", `${slug}.svg`)),
  };
});
const tagline = text(hubHtml.match(/<p class="tagline">([\s\S]*?)<\/p>/)[1]);

render(hubCard(), path.join(root, "hub/public/og.png"));
for (const g of games) render(gameCard(g), path.join(root, "games", g.slug, "public/og.png"));
console.log(`Wrote the hub's card and ${games.length} game cards.`);

// ------------------------------------------------------------------ cards

function gameCard(g) {
  const colors = logoColors(g.slug);
  const x = 500;
  const words = g.name.toUpperCase().split(" ");
  const blurb = wrap(g.blurb, 37).slice(0, 4);
  return frame(`
    ${icon(g.icon, 80, 135, 360)}
    ${logo(words, x, 210, 56, 84, colors)}
    ${lines(blurb, x, 210 + 84 * (words.length - 1) + 92, 28, 42, MUTED, "IBM Plex Mono")}
    <text x="${x}" y="540" font-family="IBM Plex Mono" font-weight="500" font-size="26" fill="${TEXT}">warrick.games/${esc(g.slug)}</text>`);
}

function hubCard() {
  const cols = 5;
  const size = 92;
  const gap = 18;
  const gx = W - 80 - cols * size - (cols - 1) * gap;
  const gy = 135;
  const icons = games.map((g, i) => icon(g.icon, gx + (i % cols) * (size + gap), gy + Math.floor(i / cols) * (size + gap), size));
  return frame(`
    ${logo(["WARRICK", "GAMES"], 80, 210, 56, 84, HUB_LOGO)}
    ${lines(wrap(tagline, 30), 80, 390, 26, 40, MUTED, "IBM Plex Mono")}
    ${icons.join("")}
    <text x="80" y="540" font-family="IBM Plex Mono" font-weight="500" font-size="26" fill="${TEXT}">warrick.games</text>`);
}

/** The background every card shares: the hub's faint grid, fading out toward the bottom. */
function frame(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke="#3a4370" stroke-opacity="0.3" stroke-width="2"/>
    </pattern>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.1" stop-color="${BG}" stop-opacity="0"/>
      <stop offset="0.95" stop-color="${BG}" stop-opacity="1"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#fade)"/>
  ${body}
</svg>`;
}

/** Words stacked in the pixel font with the logo's two drop shadows, like the home screens. */
function logo(words, x, y, size, step, { logo, shade, deep }) {
  const k = Math.round(size / 14);
  const layer = (dx, fill) =>
    `<g font-family="Press Start 2P" font-size="${size}" fill="${fill}">${words
      .map((w, i) => `<text x="${x + dx}" y="${y + i * step + dx}">${esc(w)}</text>`)
      .join("")}</g>`;
  return layer(2 * k, deep) + layer(k, shade) + layer(0, logo);
}

function lines(rows, x, y, size, step, fill, family) {
  return `<g font-family="${family}" font-size="${size}" fill="${fill}">${rows
    .map((r, i) => `<text x="${x}" y="${y + i * step}">${esc(r)}</text>`)
    .join("")}</g>`;
}

function icon(svg, x, y, size) {
  return `<image x="${x}" y="${y}" width="${size}" height="${size}" href="data:image/svg+xml;base64,${svg.toString("base64")}"/>`;
}

// ------------------------------------------------------------------ helpers

function render(svg, out) {
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "IBM Plex Mono" },
  })
    .render()
    .asPng();
  fs.writeFileSync(out, png);
}

/** A game's logo colours from its stylesheet, resolving var(--…) against the kit's stylesheet. */
function logoColors(slug) {
  const vars = { ...cssVars("packages/kit/src/client/style.css"), ...cssVars(`games/${slug}/src/client/style.css`) };
  const get = (name) => {
    let v = vars[name];
    for (let i = 0; i < 5 && v?.startsWith("var("); i++) v = vars[v.slice(4, -1).trim()];
    return v;
  };
  return {
    logo: get("--logo") ?? HUB_LOGO.logo,
    shade: get("--logo-shade") ?? HUB_LOGO.shade,
    deep: get("--logo-deep") ?? HUB_LOGO.deep,
  };
}

/** The custom properties a stylesheet's :root sets. */
function cssVars(file) {
  const css = fs.readFileSync(path.join(root, file), "utf8");
  const block = css.match(/:root\s*{([\s\S]*?)}/)?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
}

/** Break text into lines of at most `width` characters (every font here is monospaced). */
function wrap(s, width) {
  const out = [];
  let line = "";
  for (const word of s.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** Markup to plain text. */
function text(html) {
  return html
    .replace(/<br\s*\/?>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&mdash;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
