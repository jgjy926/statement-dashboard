// Merchants tab: pick a merchant from a dropdown, then edit keyword / clean
// name / category and save a rule. Category is customizable (free text). An
// optional LLM button asks the local Python bridge (Ollama) to suggest a
// category. Saving a rule writes merchant_cache.json and re-applies to
// existing transactions via the Worker.
import { store, loadStore, showToast } from "./app.js";
import { fetchMerchants, saveMerchantRule, deleteMerchantRule } from "./api.js";
import { LLM_BRIDGE } from "./config.js";

const BASE_CATEGORIES = [
  "Food & Beverage", "Transport", "Shopping", "Travel", "Entertainment",
  "Utilities", "Healthcare", "Education", "Financial", "Government", "Other",
];

let cache = null;
let items = []; // combined dropdown items

function titleCase(s) {
  return (s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Guess a stable keyword: chunk before the first dash or 2+ spaces.
function guessKeyword(desc) {
  const head = (desc || "").split(/[-–]|\s{2,}/)[0].trim();
  return (head || desc || "").toUpperCase().slice(0, 40);
}

// Descriptions with no clean rule yet (merchant still equals the raw text, or
// flagged needs_review), deduped by guessed keyword.
function suggestions() {
  const seen = new Set();
  const out = [];
  for (const t of store.rows) {
    if (t.entry_type === "manual" || t.entry_type === "adjusted") continue;
    const raw = (t.description || "").trim().toUpperCase();
    const merch = (t.merchant || "").trim().toUpperCase();
    if (!(merch === raw || t.merchant_needs_review === true)) continue;
    const kw = guessKeyword(t.description);
    if (!kw || seen.has(kw)) continue;
    seen.add(kw);
    out.push({ type: "sugg", keyword: kw, sample: t.description, name: titleCase(kw), category: "" });
  }
  for (const s of out) {
    s.count = store.rows.filter((t) => (t.description || "").toUpperCase().includes(s.keyword)).length;
  }
  return out.sort((a, b) => b.count - a.count);
}

// Tag dropdown options (fixed + custom tags from config). Blank = leave as-is.
function tagOptions(selected) {
  const tags = [
    ...(store.config?.tags?.fixed || []),
    ...(store.config?.tags?.custom || []),
  ];
  return [`<option value="">— leave unchanged —</option>`]
    .concat(tags.map((t) => `<option value="${t}" ${t === selected ? "selected" : ""}>${t}</option>`))
    .join("");
}

// Existing learned tag for a keyword (so the editor pre-fills it).
function learnedTag(keyword) {
  const kw = (keyword || "").toUpperCase();
  const rule = (store.config?.tags?.learned || []).find(
    (r) => (r.keyword || "").toUpperCase() === kw
  );
  return rule ? rule.tag : "";
}

function allCategories(rules) {
  const set = new Set(BASE_CATEGORIES);
  rules.forEach((r) => r.category && set.add(r.category));
  store.rows.forEach((t) => (t.category || t.merchant_category) && set.add(t.category || t.merchant_category));
  return [...set].sort();
}

export async function render(container) {
  if (!store.raw) await loadStore();
  if (!cache) cache = await fetchMerchants();
  const rules = (cache.merchants || []).map((r) => ({
    type: "rule", keyword: r.keyword, name: r.merchant_name || "",
    category: r.category || "", times_matched: r.times_matched ?? 0,
    needs_review: r.needs_review, sample: r.keyword,
  }));
  const sugg = suggestions();
  items = [...sugg, ...rules];
  const cats = allCategories(rules);

  container.innerHTML = `
    <div class="tab-head"><h1>Merchants</h1></div>
    <div class="panel">
      <label class="block-label">Select a merchant
        <select id="merch-select">
          <option value="">— choose —</option>
          <optgroup label="Needs cleanup (${sugg.length})">
            ${sugg.map((s, i) => `<option value="${i}">${s.keyword} · ${s.count} txn</option>`).join("")}
          </optgroup>
          <optgroup label="Existing rules (${rules.length})">
            ${rules.map((r, i) => `<option value="${sugg.length + i}">${r.name || r.keyword}</option>`).join("")}
          </optgroup>
        </select>
      </label>
      <div id="merch-editor" class="merch-editor hidden"></div>
    </div>
    <datalist id="cat-list">${cats.map((c) => `<option value="${c}">`).join("")}</datalist>
  `;

  document.getElementById("merch-select").addEventListener("change", (e) => {
    const idx = e.target.value;
    if (idx === "") { document.getElementById("merch-editor").classList.add("hidden"); return; }
    renderEditor(items[Number(idx)], container);
  });
}

function renderEditor(item, container) {
  const ed = document.getElementById("merch-editor");
  ed.classList.remove("hidden");
  ed.innerHTML = `
    ${item.type === "sugg"
      ? `<div class="rule-sample">${item.sample} <span class="match-count">${item.count} match${item.count === 1 ? "" : "es"}</span></div>`
      : `<div class="rule-sample"><b>${item.name || item.keyword}</b> <span class="match-count">${item.times_matched} matched</span></div>`}
    <label>Keyword<input class="r-kw" value="${escapeAttr(item.keyword)}" ${item.type === "rule" ? "readonly" : ""}></label>
    <label>Clean name<input class="r-name" value="${escapeAttr(item.name)}"></label>
    <label>Category
      <div class="cat-row">
        <input class="r-cat" list="cat-list" value="${escapeAttr(item.category)}" placeholder="pick or type a new one">
        <button class="ghost-btn r-llm" title="Ask local LLM">🤖 Suggest</button>
      </div>
    </label>
    <label>Tag <small>(optional — applies to all matches)</small>
      <select class="r-tag">${tagOptions(learnedTag(item.keyword))}</select>
    </label>
    <div class="rule-actions">
      ${item.type === "rule" ? `<button class="ghost-btn r-del">Delete</button>` : ""}
      <button class="primary-btn r-save">Save rule</button>
    </div>
  `;
  ed.querySelector(".r-save").addEventListener("click", () => saveRule(ed, container));
  const del = ed.querySelector(".r-del");
  if (del) del.addEventListener("click", () => removeRule(ed, container));
  ed.querySelector(".r-llm").addEventListener("click", (e) => suggestViaLLM(e.target, item, ed));
}

async function suggestViaLLM(btn, item, ed) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = "🤖 …";
  try {
    const res = await fetch(`${LLM_BRIDGE}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: item.sample || item.keyword }),
    });
    if (!res.ok) throw new Error("bridge error");
    const data = await res.json();
    if (data.category) ed.querySelector(".r-cat").value = data.category;
    if (data.merchant_name && !ed.querySelector(".r-name").value) {
      ed.querySelector(".r-name").value = data.merchant_name;
    }
    showToast(data.category ? `LLM suggests: ${data.category}` : "LLM had no suggestion");
  } catch {
    showToast("LLM bridge not reachable — run python llm_bridge.py on this PC", "error");
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

async function saveRule(ed, container) {
  const keyword = ed.querySelector(".r-kw").value.trim();
  const merchant_name = ed.querySelector(".r-name").value.trim();
  const category = ed.querySelector(".r-cat").value.trim() || null;
  const tag = ed.querySelector(".r-tag").value || null;
  if (!keyword || !merchant_name) {
    showToast("Keyword and clean name are required", "error");
    return;
  }
  const btn = ed.querySelector(".r-save");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const res = await saveMerchantRule({ keyword, merchant_name, category, tag });
    cache = null; store.raw = null;
    await loadStore();
    showToast(`Rule saved · ${res.matched} transaction${res.matched === 1 ? "" : "s"} updated`);
    render(container);
  } catch {
    btn.disabled = false; btn.textContent = "Save rule";
  }
}

async function removeRule(ed, container) {
  const keyword = ed.querySelector(".r-kw").value.trim();
  const btn = ed.querySelector(".r-del");
  btn.disabled = true;
  try {
    await deleteMerchantRule(keyword);
    cache = null;
    showToast("Rule deleted");
    render(container);
  } catch {
    btn.disabled = false;
  }
}

function escapeAttr(s) {
  return String(s == null ? "" : s).replace(/"/g, "&quot;");
}
