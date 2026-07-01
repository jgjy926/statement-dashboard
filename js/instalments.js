// Instalments tab: auto-detected plans (from ":NNN/NNN" progress in statement
// descriptions) plus manually managed plans (instalment_plans store, via the
// Worker). Both Instalment and Balance Transfer plans are shown.
//
// Progress model — the plan's month is derived from a start_month anchor and the
// CURRENT calendar month, so a plan advances on its own between statements and
// completes automatically:
//   * auto plans   -> start_month inferred from the statement that carried the
//                     counter:  start = statementMonth - (counter - 1)
//   * manual plans -> start_month entered once in the form
//   current = clamp(monthsBetween(start_month, thisMonth) + 1, 0, tenure)
// Completed plans (current >= tenure) drop out of the active commitment/remaining
// totals and move to a separate "Completed" section.
import {
  store, loadStore, formatMYR, tagChip,
  openSheet, closeSheet, showToast,
} from "./app.js";
import { createInstalmentPlan, updateInstalmentPlan, deleteInstalmentPlan } from "./api.js";

const PROGRESS_RE = /:\s*(\d+)\s*\/\s*(\d+)/; // e.g. ":007/012"

// --- month helpers (all months are "YYYY-MM" strings) -----------------------
function toYM(dateStr) {
  const m = String(dateStr || "").match(/(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}
function monthsBetween(a, b) {
  const A = toYM(a), B = toYM(b);
  if (!A || !B) return 0;
  const [ay, am] = A.split("-").map(Number);
  const [by, bm] = B.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}
function addMonths(ym, delta) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}
function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// A plan groups by merchant + tenure + card + ROUNDED monthly. Rounding to the
// nearest ringgit tolerates the sen-level drift within one plan (e.g. MUSEE
// 133.33 / 133.35 → both 133) while keeping genuinely distinct plans apart —
// e.g. three "BALANCE TRANSFER PLAN G" on the same card for 420 / 200 / 300 are
// three separate plans, not one. (Grouping on exact amount split MUSEE; grouping
// without amount at all merged the three BTs — this is the middle ground.)
function planKey(name, tenure, last4, monthly) {
  const amt = Math.round(Number(monthly) || 0);
  return `${(name || "").toLowerCase().trim()}|${tenure}|${last4 || ""}|${amt}`;
}

// Group Instalment/BT transactions that carry a ":NNN/NNN" counter into plans.
function autoPlans() {
  const groups = new Map();
  for (const t of store.rows || []) {
    if (!["Instalment", "Balance Transfer"].includes(t.tag)) continue;
    const m = (t.description || "").match(PROGRESS_RE);
    if (!m) continue;
    const counter = Number(m[1]);
    const tenure = Number(m[2]);
    const monthly = Math.abs(Number(t.amount) || 0);
    const name = (t.description || "").split(":")[0].trim();
    const last4 = t.card?.last4 || "";
    const stmtMonth = toYM(t.posting_date || t.transaction_date);
    const key = planKey(name, tenure, last4, monthly);
    const prev = groups.get(key);
    // Keep the row with the highest counter — the most recent statement.
    if (!prev || counter > prev._counter) {
      groups.set(key, {
        id: `auto:${key}`, source: "auto", name, monthly, tenure, tag: t.tag,
        last4, _counter: counter,
        // Anchor the plan's start so `current` can advance by real months.
        start_month: stmtMonth ? addMonths(stmtMonth, -(counter - 1)) : null,
      });
    }
  }
  return [...groups.values()];
}

function manualPlans() {
  return (store.raw?.instalment_plans || []).map((p) => ({ ...p, source: "manual" }));
}

// Resolve a plan's live position from its start_month and the current month.
// Falls back to a stored `current` for legacy manual plans that predate
// start_month, and finally to the last statement counter for an auto plan whose
// start couldn't be inferred.
function withDerived(p) {
  const tenure = Number(p.tenure) || 0;
  let current;
  if (p.start_month) current = monthsBetween(p.start_month, thisMonth()) + 1;
  else if (typeof p.current === "number") current = p.current;
  else current = p._counter || 0;
  current = Math.max(0, Math.min(tenure, current));

  const monthly = Number(p.monthly) || 0;
  const total = monthly * tenure;
  const paid = monthly * current;
  const remaining = Math.max(0, total - paid);
  const pct = tenure ? Math.min(100, Math.round((current / tenure) * 100)) : 0;
  const done = tenure > 0 && current >= tenure;
  return { ...p, tenure, monthly, current, total, paid, remaining, pct, done };
}

export async function render(container) {
  if (!store.raw) await loadStore();

  // Manual plans win over an auto plan for the same merchant+tenure+card, so a
  // manually managed plan isn't double-counted against its auto twin.
  const manual = manualPlans().map(withDerived);
  const manualKeys = new Set(manual.map((p) => planKey(p.name, p.tenure, p.last4, p.monthly)));
  const auto = autoPlans().map(withDerived)
    .filter((p) => !manualKeys.has(planKey(p.name, p.tenure, p.last4, p.monthly)));

  const all = [...manual, ...auto].sort((a, b) => a.name.localeCompare(b.name));
  const active = all.filter((p) => !p.done);
  const completed = all.filter((p) => p.done);
  const monthlyCommit = active.reduce((s, p) => s + p.monthly, 0);
  const totalRemaining = active.reduce((s, p) => s + p.remaining, 0);

  container.innerHTML = `
    <div class="tab-head"><h1>Instalments</h1><button id="add-plan" class="ghost-btn">➕ Add plan</button></div>
    <div class="cards-grid">
      <div class="stat-card"><div class="stat-lbl">Active plans</div><div class="stat-val">${active.length}</div></div>
      <div class="stat-card"><div class="stat-lbl">Monthly commitment</div><div class="stat-val">${formatMYR(monthlyCommit)}</div></div>
      <div class="stat-card"><div class="stat-lbl">Total remaining</div><div class="stat-val">${formatMYR(totalRemaining)}</div></div>
    </div>
    ${active.length ? active.map(planHtml).join("") : `<div class="empty">No active instalment plans</div>`}
    ${completed.length ? `
      <details class="completed-block" ${completed.length <= 4 ? "open" : ""}>
        <summary>Completed (${completed.length})</summary>
        ${completed.map(planHtml).join("")}
      </details>` : ""}
  `;

  document.getElementById("add-plan").addEventListener("click", () => openForm(null, container));
  container.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      const p = manualPlans().find((x) => x.id === b.dataset.edit);
      openForm(p, container);
    }));
  container.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => removePlan(b.dataset.del, container)));
}

function planHtml(p) {
  return `
    <div class="plan-card">
      <div class="plan-head">
        <div><strong>${esc(p.name)}</strong> ${tagChip(p.tag)}</div>
        <span class="plan-src ${p.source}">${p.source === "auto" ? "auto" : "manual"}</span>
      </div>
      <div class="plan-meta">
        ${p.last4 ? `••${p.last4} · ` : ""}${formatMYR(p.monthly)}/mo ·
        ${p.done ? "completed" : `month ${p.current} of ${p.tenure}`}
        ${p.start_month ? ` · from ${p.start_month}` : ""}
      </div>
      <div class="plan-bar"><div class="plan-fill ${p.done ? "done" : ""}" style="width:${p.pct}%"></div></div>
      <div class="plan-figures">
        <span><i>Paid</i> ${formatMYR(p.paid)}</span>
        <span><i>Remaining</i> ${formatMYR(p.remaining)}</span>
        <span><i>Total</i> ${formatMYR(p.total)}</span>
        <span class="plan-pct">${p.pct}%</span>
      </div>
      ${p.source === "manual" ? `<div class="plan-actions">
        <button class="ghost-btn" data-edit="${p.id}">Edit</button>
        <button class="ghost-btn danger" data-del="${p.id}">Delete</button>
      </div>` : ""}
    </div>`;
}

function openForm(plan, container) {
  const isEdit = !!plan;
  const cards = [...new Set((store.rows || []).map((t) => t.card?.last4).filter(Boolean))];
  const node = document.createElement("div");
  node.className = "sheet-content";
  node.innerHTML = `
    <div class="sheet-head"><h2>${isEdit ? "Edit" : "Add"} plan</h2><button id="sheet-close" class="icon-btn">✕</button></div>
    <label>Name<input id="p-name" value="${esc(plan?.name)}"></label>
    <label>Monthly amount (RM)<input id="p-monthly" type="number" step="0.01" value="${plan?.monthly ?? ""}"></label>
    <label>Tenure (months)<input id="p-tenure" type="number" value="${plan?.tenure ?? ""}"></label>
    <label>Start month<input id="p-start" type="month" value="${esc(plan?.start_month)}"></label>
    <div class="field-hint">The remaining balance and completion are calculated from the start month automatically.</div>
    <label>Tag<select id="p-tag">
      <option value="Instalment" ${plan?.tag === "Instalment" ? "selected" : ""}>Instalment</option>
      <option value="Balance Transfer" ${plan?.tag === "Balance Transfer" ? "selected" : ""}>Balance Transfer</option>
    </select></label>
    <label>Card<select id="p-card"><option value="">—</option>${cards.map((l) => `<option value="${l}" ${plan?.last4 === l ? "selected" : ""}>••${l}</option>`).join("")}</select></label>
    <label>Note<textarea id="p-note">${esc(plan?.note)}</textarea></label>
    <div class="sheet-actions">
      <button id="p-cancel" class="ghost-btn">Cancel</button>
      <button id="p-save" class="primary-btn">${isEdit ? "Save" : "Create"}</button>
    </div>
  `;
  node.querySelector("#sheet-close").addEventListener("click", closeSheet);
  node.querySelector("#p-cancel").addEventListener("click", closeSheet);
  node.querySelector("#p-save").addEventListener("click", () => savePlan(plan, node, container));
  openSheet(node);
}

async function savePlan(plan, node, container) {
  const v = (id) => node.querySelector(id).value.trim();
  const payload = {
    name: v("#p-name"),
    monthly: Number(v("#p-monthly")),
    tenure: Number(v("#p-tenure")),
    start_month: v("#p-start") || null,
    tag: v("#p-tag"),
    last4: v("#p-card") || null,
    note: v("#p-note"),
  };
  if (!payload.name || !payload.monthly || !payload.tenure) {
    showToast("Name, monthly amount and tenure are required", "error");
    return;
  }
  if (!payload.start_month) {
    showToast("Start month is required so the remaining can be calculated", "error");
    return;
  }
  const btn = node.querySelector("#p-save");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    if (plan) await updateInstalmentPlan({ id: plan.id, ...payload });
    else await createInstalmentPlan(payload);
    store.raw = null;
    await loadStore();
    closeSheet();
    showToast(plan ? "Plan updated" : "Plan created");
    render(container);
  } catch {
    btn.disabled = false; btn.textContent = plan ? "Save" : "Create";
  }
}

async function removePlan(id, container) {
  try {
    await deleteInstalmentPlan(id);
    store.raw = null;
    await loadStore();
    showToast("Plan deleted");
    render(container);
  } catch { /* toast shown by api */ }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
