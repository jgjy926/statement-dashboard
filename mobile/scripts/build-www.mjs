// Builds mobile/www — the web bundle the Android app ships — from the same files
// GitHub Pages serves (index.html, app.css, js/). No source is forked: the phone
// app and the web app are the same code.
//
// Extras applied to the copy only:
//   - The Merchants tab is left out (merchant clean-up now runs through the local
//     enrichment flow on the PC), and so is the local LLM bridge (localhost:5057,
//     unreachable from a phone anyway): its config, Settings rows and health probe.
//     Each edit must match exactly — if the source drifts the build fails loudly
//     instead of shipping a half-patched app.
//   - Chart.js is downloaded into www/vendor so the app boots offline. Cached in
//     mobile/.vendor-cache; if the download fails the original CDN tag is kept.
import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const repo = resolve(mobile, '..');
const www = join(mobile, 'www');
const cacheDir = join(mobile, '.vendor-cache');

const exists = (p) => access(p).then(() => true, () => false);

async function download(url, name) {
  const cached = join(cacheDir, name);
  if (await exists(cached)) return readFile(cached);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(cached), { recursive: true });
  await writeFile(cached, buf);
  return buf;
}

// Apply [find, replace] edits to a copied file; every find must match.
async function patch(rel, edits) {
  const file = join(www, rel);
  let src = await readFile(file, 'utf8');
  for (const [find, repl] of edits) {
    const next = src.replace(find, repl);
    if (next === src) throw new Error(`build-www: ${rel} no longer matches ${find} — update scripts/build-www.mjs`);
    src = next;
  }
  await writeFile(file, src);
}

// [CDN url as written in index.html, local file name]
const scripts = [
  ['https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js', 'chart.umd.min.js'],
];

async function vendor(html) {
  await mkdir(join(www, 'vendor'), { recursive: true });
  for (const [url, name] of scripts) {
    if (!html.includes(`src="${url}"`)) continue;
    try {
      await writeFile(join(www, 'vendor', name), await download(url, name));
      html = html.replace(`src="${url}"`, `src="./vendor/${name}"`);
    } catch (e) { console.warn(`! keeping CDN for ${url}: ${e.message}`); }
  }
  return html;
}

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });
await cp(join(repo, 'js'), join(www, 'js'), {
  recursive: true,
  filter: (p) => !p.endsWith('merchants.js'),
});
await cp(join(repo, 'app.css'), join(www, 'app.css'));

// ---- drop the Merchants tab
await patch('js/app.js', [
  [/^import \* as merchants from "\.\/merchants\.js";\r?\n/m, ''],
  [/^ *merchants: \{ mod: merchants, label: "Merchants" \},\r?\n/m, ''],
  [/ *merchants: "🏷️",/, ''],
]);

// ---- drop the local LLM bridge
await patch('js/config.js', [
  [/\r?\n\/\/ Local LLM bridge[\s\S]*?export const LLM_BRIDGE = [^\n]*\n?/, '\n'],
]);
await patch('js/settings.js', [
  ['connection + LLM bridge health', 'connection'],
  ['import { API_BASE, LLM_BRIDGE } from "./config.js";', 'import { API_BASE } from "./config.js";'],
  [/ *<div class="kv"><span>LLM bridge<\/span>[^\n]*\n/, ''],
  [/ *<div class="kv"><span>Bridge URL<\/span>[^\n]*\n/, ''],
  [/ *<p class="hint">The LLM bridge[^\n]*\n/, ''],
  [/\r?\n *\/\/ Probe the local bridge[^\n]*\n *checkBridge\(\);\r?\n/, '\n'],
  [/\r?\nasync function checkBridge\(\) \{[\s\S]*$/, '\n'],
]);

let html = await readFile(join(repo, 'index.html'), 'utf8');
html = await vendor(html);
await writeFile(join(www, 'index.html'), html);

// Nothing in the bundle may still point at the removed pieces.
for (const rel of ['js/app.js', 'js/config.js', 'js/settings.js']) {
  const src = await readFile(join(www, rel), 'utf8');
  if (/merchants\.js|LLM_BRIDGE|llm_bridge|5057/.test(src)) throw new Error(`build-www: ${rel} still references Merchants/LLM`);
}
console.log(`www built from ${repo} (Merchants tab + LLM bridge excluded)`);
