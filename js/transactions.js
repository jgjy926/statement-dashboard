// Transactions tab: list, search, filter bar, row detail + edit.
import {
  store, loadStore, formatMYR, formatDate, tagChip, entryBadge,
  openSheet, closeSheet, showToast, TAG_COLORS,
} from "./app.js";
import { updateTransaction } from "./api.js";
import { searchRows, applyFilters, distinct } from "./filters.js";

let query = "";
let criteria = {};
let filtersOpen = false;

// Cards tab calls this before routing to #transactions to pre-filter by card.
export function setFilter(next) {
  criteria = { ...next };
  query = "";
  filtersOpen = true;
}

function rowHtml(t) {
  const amt = Number(t.amount) || 0;
  const cls = amt < 0 ? "neg" : "pos";
  return `
    <li class="txn-row" data-id="${t.id}">
      <div class="txn-main">
        <div class="txn-merchant">${t.merchant || t.description || "—"} ${entryBadge(t.entry_type)}</div>
        <div class="txn-sub">${formatDate(t.transaction_date || t.posting_date)} | ${t.card?.name || t.bank_id || "—"} · ••${t.card?.last4 || "—"}</div>
      </div>
      <div class="txn-right">
        <div class="txn-amt ${cls}">${formatMYR(amt)}</div>
        ${tagChip(t.tag)}
      </div>
    </li>`;
}

function optionList(values, selected) {
  return [`<option value="">All</option>`]
    .concat(values.map((v) => `<option value="${v}" ${v === selected ? "selected" : ""}>${v}</option>`))
    .join("");
}

export async function render(container) {
  if (!store.raw) await loadStore();
  const all = store.rows;

  const banks = distinct(all, (t) => t.bank_id);
  const last4s = distinct(all, (t) => t.card?.last4);
  const tags = distinct(all, (t) => t.tag);
  const cats = distinct(all, (t) => t.category || t.merchant_category);
  const types = distinct(all, (t) => t.entry_type);

  const filtered = applyFilters(searchRows(all, query), criteria);

  container.innerHTML = `
    <div class="tab-head"><h1>Transactions</h1></div>
    <div class="search-bar">
      <input id="q" type="search" placeholder="Search merchant, description, amount" value="${query}">
      <button id="toggle-filters" class="ghost-btn">Filters ${activeCount() ? `(${activeCount()})` : ""}</button>
    </div>

    <div class="filter-bar ${filtersOpen ? "" : "hidden"}" id="filter-bar">
      <label>Bank<select id="f-bank">${optionList(banks, criteria.bank)}</select></label>
      <label>Card<select id="f-card">${optionList(last4s, criteria.last4)}</select></label>
      <label>Tag<select id="f-tag">${optionList(tags, criteria.tag)}</select></label>
      <label>Category<select id="f-cat">${optionList(cats, criteria.category)}</select></label>
      <label>Type<select id="f-type">${optionList(types, criteria.entryType)}</select></label>
      <label>From<input type="date" id="f-from" value="${criteria.dateFrom || ""}"></label>
      <label>To<input type="date" id="f-to" value="${criteria.dateTo || ""}"></label>
      <label>Min<input type="number" id="f-min" value="${criteria.minAmount || ""}"></label>
      <label>Max<input type="number" id="f-max" value="${criteria.maxAmount || ""}"></label>
      <button id="clear-filters" class="ghost-btn">Clear</button>
    </div>

    <div class="count-line">${filtered.length} of ${all.length} transactions</div>
    <ul class="list txn-list">
      ${filtered.length ? filtered.map(rowHtml).join("") : `<li class="empty">No matching transactions</li>`}
    </ul>
  `;

  // Search (live).
  const q = document.getElementById("q");
  q.addEventListener("input", () => {
    query = q.value;
    rerenderList(container);
  });

  document.getElementById("toggle-filters").addEventListener("click", () => {
    filtersOpen = !filtersOpen;
    document.getElementById("filter-bar").classList.toggle("hidden", !filtersOpen);
  });

  const bind = (id, key, isNum) =>
    document.getElementById(id).addEventListener("change", (e) => {
      const v = e.target.value;
      if (v === "" || v == null) delete criteria[key];
      else criteria[key] = isNum ? v : v;
      rerenderList(container);
    });
  bind("f-bank", "bank"); bind("f-card", "last4"); bind("f-tag", "tag");
  bind("f-cat", "category"); bind("f-type", "entryType");
  bind("f-from", "dateFrom"); bind("f-to", "dateTo");
  bind("f-min", "minAmount", true); bind("f-max", "maxAmount", true);

  document.getElementById("clear-filters").addEventListener("click", () => {
    criteria = {}; query = ""; render(container);
  });

  wireRows(container);
}

function activeCount() {
  return Object.values(criteria).filter((v) => v !== "" && v != null).length;
}

function rerenderList(container) {
  const filtered = applyFilters(searchRows(store.rows, query), criteria);
  container.querySelector(".count-line").textContent =
    `${filtered.length} of ${store.rows.length} transactions`;
  container.querySelector(".txn-list").innerHTML =
    filtered.length ? filtered.map(rowHtml).join("") : `<li class="empty">No matching transactions</li>`;
  const tf = document.getElementById("toggle-filters");
  tf.textContent = `Filters ${activeCount() ? `(${activeCount()})` : ""}`;
  wireRows(container);
}

function wireRows(container) {
  container.querySelectorAll(".txn-row").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.id, container))
  );
}

function openDetail(id, container) {
  const t = store.rows.find((r) => r.id === id);
  if (!t) return;
  const node = document.createElement("div");
  node.className = "sheet-content";
  node.innerHTML = detailView(t);
  node.querySelector("#sheet-close").addEventListener("click", closeSheet);
  node.querySelector("#edit-btn").addEventListener("click", () => {
    node.innerHTML = editView(t);
    node.querySelector("#cancel-btn").addEventListener("click", closeSheet);
    node.querySelector("#save-btn").addEventListener("click", () => saveEdit(t, node, container));
  });
  openSheet(node);
}

function field(label, value) {
  return `<div class="kv"><span>${label}</span><b>${value ?? "—"}</b></div>`;
}

function detailView(t) {
  return `
    <div class="sheet-head"><h2>${t.merchant || t.description}</h2><button id="sheet-close" class="icon-btn">✕</button></div>
    ${field("Amount", formatMYR(t.amount))}
    ${field("Date", formatDate(t.transaction_date || t.posting_date))}
    ${field("Description", t.description)}
    ${field("Tag", t.tag)}
    ${field("Category", t.category || t.merchant_category)}
    ${field("Bank / Card", `${t.bank_id || "—"} · ••${t.card?.last4 || "—"} (${t.card?.network || "—"})`)}
    ${field("Currency", t.currency)}
    ${field("Original", t.original_amount ? `${t.original_amount} ${t.original_currency || ""}` : "—")}
    ${field("Entry type", t.entry_type)}
    ${field("Notes", t.notes)}
    <button id="edit-btn" class="primary-btn">Edit</button>
  `;
}

function editView(t) {
  const tagOpts = (store.config?.tags?.fixed || Object.keys(TAG_COLORS))
    .map((tg) => `<option value="${tg}" ${tg === t.tag ? "selected" : ""}>${tg}</option>`).join("");
  return `
    <div class="sheet-head"><h2>Edit transaction</h2></div>
    <label>Description<input id="e-desc" value="${(t.description || "").replace(/"/g, "&quot;")}"></label>
    <label>Amount<input id="e-amt" type="number" step="0.01" value="${t.amount}"></label>
    <label>Tag<select id="e-tag">${tagOpts}</select></label>
    <label>Category<input id="e-cat" value="${t.category || ""}"></label>
    <label>Notes<textarea id="e-notes">${t.notes || ""}</textarea></label>
    <div class="sheet-actions">
      <button id="cancel-btn" class="ghost-btn">Cancel</button>
      <button id="save-btn" class="primary-btn">Save</button>
    </div>
  `;
}

async function saveEdit(t, node, container) {
  const payload = {
    id: t.id,
    description: node.querySelector("#e-desc").value,
    amount: node.querySelector("#e-amt").value,
    tag: node.querySelector("#e-tag").value,
    category: node.querySelector("#e-cat").value,
    notes: node.querySelector("#e-notes").value,
  };
  const btn = node.querySelector("#save-btn");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await updateTransaction(payload);
    store.raw = null; // force reload so the edit (and adjusted badge) shows
    await loadStore();
    closeSheet();
    showToast("Transaction updated");
    render(container);
  } catch {
    btn.disabled = false; btn.textContent = "Save";
  }
}
