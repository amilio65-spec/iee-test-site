// Compiles every *.dc.html page into a fully self-contained static HTML file in
// ./standalone/. Each output page has no external dependencies: no support.js /
// React runtime, images inlined as data URIs, the brain iframe embedded via
// srcdoc, and fonts (Inter, Michroma, Material Symbols icons) embedded.
// Links between pages still work when the files sit together in one folder.
//
// Usage:  node build/build-standalone.mjs
// Fonts are downloaded once and cached in build/font-cache/ so later builds
// work offline.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'standalone');
const FONT_CACHE = path.join(ROOT, 'build', 'font-cache');
const BRAIN_FILE = 'brain-exploded-view.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const KEEP_SUBSETS = new Set(['latin', 'latin-ext']);

const MIME = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

const PAGE_TITLES = {
  'index': 'Home',
  'cloud-solutions': 'Cloud Services',
};

const warnings = [];
const warn = (msg) => { warnings.push(msg); console.warn('  ! ' + msg); };

const read = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
const outName = (dcName) => dcName.replace(/\.dc\.html$/i, '.html');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// ---------- local asset inlining ----------

const dataUriCache = new Map();
function dataUri(relPath) {
  let clean = relPath.split(/[?#]/)[0];
  try { clean = decodeURIComponent(clean); } catch {}
  const abs = path.join(ROOT, clean);
  if (dataUriCache.has(abs)) return dataUriCache.get(abs);
  if (!fs.existsSync(abs)) { warn(`missing asset: ${relPath}`); return null; }
  const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const uri = `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
  dataUriCache.set(abs, uri);
  return uri;
}

const isExternal = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u);

function rewritePageLinks(html) {
  // foo.dc.html(#x|?y) -> foo.html
  return html.replace(/([\w-]+)\.dc\.html(?=["'#?\s)])/g, '$1.html');
}

function inlineAssets(html) {
  html = html.replace(/\b(src|poster)=(["'])([^"']+)\2/gi, (m, attr, q, url) => {
    if (isExternal(url) || url.split(/[?#]/)[0] === BRAIN_FILE || /\.html?$/i.test(url.split(/[?#]/)[0])) return m;
    const uri = dataUri(url);
    return uri ? `${attr}=${q}${uri}${q}` : m;
  });
  html = html.replace(/url\((['"]?)([^'")]+)\1\)/gi, (m, q, url) => {
    if (isExternal(url.trim())) return m;
    const uri = dataUri(url.trim());
    return uri ? `url('${uri}')` : m;
  });
  return html;
}

// ---------- brain iframe ----------

let brainSrcdoc = null;
function brainDoc() {
  if (brainSrcdoc) return brainSrcdoc;
  let html = read(path.join(ROOT, BRAIN_FILE));
  // The page is embedded with ?transparent=1; srcdoc has no query string, so
  // apply the transparent background directly.
  html = html.replace(/<\/head>/i, '<style>html,body{background:transparent !important;}</style>\n</head>');
  html = inlineAssets(rewritePageLinks(html));
  brainSrcdoc = escAttr(html);
  return brainSrcdoc;
}

function embedBrain(html) {
  return html.replace(/<iframe\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi, (m, pre, q, url, post) => {
    if (url.split(/[?#]/)[0] !== BRAIN_FILE) return m;
    return `<iframe${pre}srcdoc="${brainDoc()}"${post}>`;
  });
}

// ---------- fonts ----------

async function fetchCached(url, kind) {
  fs.mkdirSync(FONT_CACHE, { recursive: true });
  const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const file = path.join(FONT_CACHE, `${key}.${kind}`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}

// Turns a Google Fonts css2 URL into inline @font-face rules with embedded
// woff2 data. Keeps only latin/latin-ext subsets and merges the duplicate
// per-weight rules Google emits for variable fonts into one weight range.
async function inlineGoogleFontCss(cssUrl) {
  const css = (await fetchCached(cssUrl, 'css')).toString('utf8');
  const groups = new Map();
  const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const subset = m[1];
    if (subset && !KEEP_SUBSETS.has(subset)) continue;
    const body = m[2];
    const prop = (name) => (body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`)) || [])[1]?.trim();
    const src = (body.match(/url\(([^)]+)\)/) || [])[1];
    if (!src) continue;
    const key = prop('font-family') + '|' + src;
    const weight = Number(prop('font-weight')) || 400;
    const g = groups.get(key);
    if (g) { g.min = Math.min(g.min, weight); g.max = Math.max(g.max, weight); continue; }
    groups.set(key, {
      family: prop('font-family'), style: prop('font-style') || 'normal', src,
      range: prop('unicode-range'), min: weight, max: weight,
    });
  }
  const rules = [];
  for (const g of groups.values()) {
    const b64 = (await fetchCached(g.src, 'woff2')).toString('base64');
    rules.push(`@font-face{font-family:${g.family};font-style:${g.style};font-weight:${g.min === g.max ? g.min : `${g.min} ${g.max}`};font-display:block;` +
      `src:url(data:font/woff2;base64,${b64}) format('woff2');${g.range ? `unicode-range:${g.range};` : ''}}`);
  }
  return rules.join('\n');
}

function collectIcons(templates) {
  const icons = new Set();
  for (const t of templates) {
    for (const m of t.matchAll(/class="[^"]*\bmaterial-symbols-outlined\b[^"]*"[^>]*>\s*([a-z0-9_]+)\s*</g)) icons.add(m[1]);
  }
  return [...icons].sort();
}

// ---------- page compile ----------

function splitDc(src, file) {
  const open = /<x-dc(?:\s[^>]*)?>/i.exec(src);
  const close = src.lastIndexOf('</x-dc>');
  if (!open || close < 0) throw new Error(`${file}: no <x-dc> block`);
  let template = src.slice(open.index + open[0].length, close);
  let helmet = '';
  template = template.replace(/<helmet>([\s\S]*?)<\/helmet>/i, (_, h) => { helmet = h; return ''; });
  let after = src.slice(close + '</x-dc>'.length).replace(/<\/body>[\s\S]*$/i, '');
  after = after.replace(/<script[^>]*data-dc-script[^>]*>[\s\S]*?<\/script>/gi, '');
  return { helmet, template, after };
}

function titleFor(file) {
  const base = file.replace(/\.dc\.html$/i, '');
  const name = PAGE_TITLES[base] || base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `${name} | IEE — Intelligence Everywhere Enterprise`;
}

async function main() {
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.dc.html')).sort();
  const pages = files.map((f) => ({ file: f, ...splitDc(read(path.join(ROOT, f)), f) }));

  // Build one shared font stylesheet covering every page.
  const icons = collectIcons(pages.map((p) => p.template));
  const fontUrls = new Set();
  for (const p of pages) {
    for (const m of p.helmet.matchAll(/<link[^>]+href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"[^>]*>/g)) {
      let url = m[1].replace(/&amp;/g, '&');
      if (/Material\+Symbols/.test(url)) url = url.replace(/&icon_names=[^&]*/, '') + `&icon_names=${icons.join(',')}`;
      fontUrls.add(url);
    }
  }
  console.log(`Embedding fonts (${icons.length} icons: ${icons.join(', ')})`);
  const fontCss = (await Promise.all([...fontUrls].map(inlineGoogleFontCss))).join('\n');

  fs.mkdirSync(OUT, { recursive: true });
  for (const p of pages) {
    const head = p.helmet
      .replace(/<meta name="design_doc_mode"[^>]*>\s*/gi, '')
      .replace(/<link[^>]+(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>\s*/gi, '')
      .trim();
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleFor(p.file)}</title>
<style>
${fontCss}
</style>
${head}
</head>
<body>
${p.template.trim()}
${p.after.trim()}
</body>
</html>
`;
    html = embedBrain(inlineAssets(rewritePageLinks(html)));
    const dest = path.join(OUT, outName(p.file));
    fs.writeFileSync(dest, html);
    console.log(`  ${outName(p.file).padEnd(34)} ${(Buffer.byteLength(html) / 1024).toFixed(0).padStart(6)} KB`);
  }

  if (warnings.length) console.log(`\nDone with ${warnings.length} warning(s).`);
  else console.log(`\nDone. ${pages.length} standalone pages written to ${path.relative(ROOT, OUT)}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
