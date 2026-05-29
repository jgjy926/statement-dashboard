// Instalments tab: auto-detected plans (from ":NNN/NNN" in descriptions) plus
// manually managed plans (instalment_plans store via the Worker).
import {
  store, loadStore, formatMYR, formatDate, tagChip,
  openSheet, closeSheet, showToast,
} from "./app.js";
import { createInstalmentPlan, updateInstalmentPlan, deleteInstalmentPlan } from "./api.js";

const PROGRESS_RE = /:\s*(\d+)\s*\/\s*(\d+)/; // e.g. ":007/012"

// Group instalment/BT transactions into plans by name + monthly amount.
function autoPlans() {
  const groups = new Map();
  for (const t of store.rows) {
    if (!["Instalment", "Balance Transfer"].includes(t.tag)) continue;
    const m = (t.description || "").match(PROGRESS_RE);
    if (!m) continue;
    const current = Number(m[1]);
    const tenure = Number(m[2]);
    const monthly = Math.abs(Number(t.amount) || 0);
    const name = (t.description || "").split(":")[0].trim();
    const key = `${name}|${monthly}|${tenure}`;
    const prev = groups.get(key);
    if (!prev || current > prev.current) {
      groups.set(key, {
        id: key, source: "auto", name, monthly, tenure, current,
        tag: t.tag, last4: t.card?.last4, last_date: t.transaction_date || t.posting_date,
      });
    }
  }
  return [...groups.values()];
}

function manualPlans() {
  return (store.raw?.instalment_plans || []).map((p) => ({ ...p, source: "manual" }));
}

function planMetrics(p) {
  const total = p.monthly * p.tenure;
  const paid = p.monthly * p.current;
  const remaining = Math.max(0, total - paid);
  const pct = p.tenure ? Math.min(100, Math.round((p.current / p.tenure) * 100)) : 0;
  const done = p.current >= p.tenure;
  return { total, paid, remaining, pct, done };
}

export async function render(container) {
  if (!store.raw) await loadStore();
  const plans = [...autoPlans(), ...manualPlans()].sort((a, b) => a.name.localeCompare(b.name));

  const active = plans.filter((p) => p.current < p.tenure);
  const monthlyCommit = active.reduce((s, p) => s + p.monthly, 0);
  const totalRemaining = plans.reduce((s, p) => s + planMetrics(p).remaining, 0);

  container.innerHTML = `
    <div class="tab-head"><h1>Instalments</h1><button id="add-plan" class="ghost-btn">➕ Add plan</button></div>
    <div class="cards-grid">
      <div class="stat-card"><div class="stat-lbl">Active plans</div><div class="stat-val">${active.length}</div></div>
      <div class="stat-card"><div class="stat-lbl">Monthly commitment</div><div class="stat-val">${formatMYR(monthlyCommit)}</div></div>
      <div class="stat-card"><div class="stat-lbl">Total remaining</div><div class="stat-val">${formatMYR(totalRemaining)}</div></div>
    </div>
    ${plans.length ? plans.map(planHtml).join("") : `<div class="empty">No instalment plans found</div>`}
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
  const { total, paid, remaining, pct, done } = planMetrics(p);
  return `
    <div class="plan-card">
      <div class="plan-head">
        <div><strong>${p.name}</strong> ${tagChip(p.tag)}</div>
        <span class="plan-src ${p.source}">${p.source === "auto" ? "auto" : "manual"}</span>
      </div>
      <div class="plan-meta">
        ${p.last4 ? `••${p.last4} · ` : ""}${formatMYR(p.monthly)}/mo · ${done ? "completed" : `month ${p.current} of ${p.tenure}`}
      </div>
      <div class="plan-bar"><div class="plan-fill ${done ? "done" : ""}" style="width:${pct}%"></div></div>
      <div class="plan-figures">
        <span><i>Paid</i> ${formatMYR(paid)}</span>
        <span><i>Remaining</i> ${formatMYR(remaining)}</span>
        <span><i>Total</i> ${formatMYR(total)}</span>
        <span class="plan-pct">${pct}%</span>
      </div>
      ${p.source === "manual" ? `<div class="plan-actions">
        <button class="ghost-btn" data-edit="${p.id}">Edit</button>
        <button class="ghost-btn danger" data-del="${p.id}">Delete</button>
      </div>` : ""}
    </div>`;
}

function openForm(plan, container) {
  const isEdit = !!plan;
  const cards = [...new Set(store.rows.map((t) => t.card?.last4).filter(Boolean))];
  const node = document.createElement("div");
  node.className = "sheet-content";
  node.innerHTML = `
    <div class="sheet-head"><h2>${isEdit ? "Edit" : "Add"} plan</h2><button id="sheet-close" class="icon-btn">✕</button></div>
    <label>Name<input id="p-name" value="${esc(plan?.name)}"></label>
    <label>Monthly amount (RM)<input id="p-monthly" type="number" step="0.01" value="${plan?.monthly ?? ""}"></label>
    <label>Tenure (months)<input id="p-tenure" type="number" value="${plan?.tenure ?? ""}"></label>
    <label>Current month<input id="p-current" type="number" value="${plan?.current ?? 0}"></label>
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
    current: Number(v("#p-current")) || 0,
    tag: v("#p-tag"),
    last4: v("#p-card") || null,
    note: v("#p-note"),
  };
  if (!payload.name || !payload.monthly || !payload.tenure) {
    showToast("Name, monthly amount and tenure are required", "error");
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
