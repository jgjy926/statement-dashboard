// Instalments tab: auto-detected plans (from ":NNN/NNN" progress in statement
// descriptions) plus manually managed plans (instalment_plans store, via the
// Worker). Both Instalment and Balance Transfer plans are shown.
//
// Progress model — a plan advances by STATEMENT DATES, not calendar months. An
// instalment is "billed" once the statement that carries it has been issued,
// so a plan only clears on the statement date of its final instalment:
//   * auto plans   -> the newest statement's counter is the truth; each further
//                     monthly statement date (projected from that statement's
//                     own date) that has passed bills one more instalment.
//                     Anchoring on the statement date matters: Maybank posts
//                     each charge ~a month before the statement date, so the
//                     posting month ran a cycle ahead and showed ":011/012"
//                     (Aug posting, Sep statement) as cleared in October, before
//                     the Oct statement carrying 012/012 was even issued.
//   * manual plans -> start_month entered once in the form; each month bills
//                     on the card's statement day (from its parsed statements;
//                     the 1st when the plan names no card).
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
function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// "YYYY-MM-DD" `n` months after `iso`, day clamped to the target month's length.
function addMonthsIso(iso, n) {
  const ym = addMonths(iso.slice(0, 7), n);
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const dim = new Date(y, m, 0).getDate();
  const day = Math.min(Number(iso.slice(8, 10)) || 1, dim);
  return `${ym}-${String(day).padStart(2, "0")}`;
}
function monthLabel(iso) {
  const d = new Date(`${String(iso).slice(0, 7)}-01T00:00:00`);
  return isNaN(d) ? iso : d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
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

// How far apart the two sides' inferred start months may sit and still be the
// same plan. The auto start is derived from a statement's posting date, so it
// can land a month either side of the month the user typed.
const START_SLACK_MONTHS = 1;

// True when a manually captured plan and an auto-detected one are the SAME
// commitment. The AUTO plan then wins and the manual placeholder drops out:
// the auto plan is read off the statement itself, so its amount, card and
// counter are the bank's own figures, while the manual row was only a
// stand-in the user typed before that statement existed.
//
// Name equality alone can never spot the pair: the user types their own label
// ("RHB 12 Mnh"), never the bank's raw description ("SMART MOVE BAL
// TRANSFER"), and usually leaves the card blank. So the plan showed up twice -
// and was counted twice in the monthly commitment and remaining totals - the
// moment the statement carrying its ":NNN/NNN" counter was parsed.
//
// Shape (same tenure, same monthly, same window, compatible card) is what
// actually identifies the pair. The start month is the discriminator that
// keeps genuinely different plans apart: a manual 133/6 starting 2026-07 must
// NOT be swallowed by an auto 133/6 that started 2025-11.
function coversAuto(manual, auto) {
  if (planKey(manual.name, manual.tenure, manual.last4, manual.monthly)
      === planKey(auto.name, auto.tenure, auto.last4, auto.monthly)) return true;
  if (Number(manual.tenure) !== Number(auto.tenure)) return false;
  if (Math.abs((Number(manual.monthly) || 0) - (Number(auto.monthly) || 0)) > 1) return false;
  // A manual plan naming a card must match it; one left blank covers any card.
  if (manual.last4 && manual.last4 !== auto.last4) return false;
  // Legacy manual plans with no start_month can only be matched by name above.
  if (!manual.start_month || !auto.start_month) return false;
  return Math.abs(monthsBetween(manual.start_month, auto.start_month)) <= START_SLACK_MONTHS;
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
    // The statement that billed this row, not its posting date (see header).
    const stmtDate = (t.statement_date || t.posting_date || t.transaction_date || "").slice(0, 10);
    const stmtMonth = toYM(stmtDate);
    const key = planKey(name, tenure, last4, monthly);
    const prev = groups.get(key);
    // Keep the row with the highest counter — the most recent statement.
    if (!prev || counter > prev._counter) {
      groups.set(key, {
        id: `auto:${key}`, source: "auto", name, monthly, tenure, tag: t.tag,
        last4, _counter: counter, _stmt_date: stmtDate || null,
        // Billing month of the first instalment (shown, and used to pair a
        // manual placeholder with this plan).
        start_month: stmtMonth ? addMonths(stmtMonth, -(counter - 1)) : null,
      });
    }
  }
  return [...groups.values()];
}

// Instalment / BT charges the auto detector can't follow because the bank prints
// no ":NNN/NNN" counter (Public Bank: "NESH PUCHONG …", "EBANK BALANCE
// TRANSFER …"), across every bank. Grouped like plans; any group a manual plan
// already covers drops out, so what's left is a commitment nobody is tracking.
function untrackedCharges(manual) {
  const groups = new Map();
  for (const t of store.rows || []) {
    if (!["Instalment", "Balance Transfer"].includes(t.tag)) continue;
    if (PROGRESS_RE.test(t.description || "")) continue; // auto plan handles it
    const amount = Number(t.amount) || 0;
    if (amount >= 0) continue;
    const monthly = Math.abs(amount);
    const last4 = t.card?.last4 || "";
    const name = (t.description || "").trim();
    const key = `${name.toLowerCase()}|${last4}|${Math.round(monthly)}`;
    const sd = (t.statement_date || t.posting_date || "").slice(0, 10);
    const g = groups.get(key) || {
      key, name, monthly, last4, tag: t.tag, bank_id: t.bank_id, dates: new Set(),
    };
    if (sd) g.dates.add(sd);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => {
      const dates = [...g.dates].sort();
      return { ...g, count: dates.length, first: dates[0] || null, last: dates[dates.length - 1] || null };
    })
    .filter((g) => !manual.some((m) =>
      m.tag === g.tag &&
      (!m.last4 || m.last4 === g.last4) &&
      Math.abs((Number(m.monthly) || 0) - g.monthly) <= 1
    ))
    .sort((a, b) => (b.last || "").localeCompare(a.last || ""));
}

function untrackedHtml(list) {
  if (!list.length) return "";
  const bank = (id) => store.config?.banks?.[id]?.bank_name || id || "";
  return `<div class="panel untracked">
    <div class="panel-head"><h2>Charges with no plan</h2><span class="count-pill">${list.length}</span></div>
    <div class="field-hint">These banks print no "month X of Y" on the statement, so progress can't be read automatically. Track one as a plan to count it in the totals.</div>
    ${list.map((g, i) => `<div class="untracked-row">
      <div class="untracked-main">
        <strong>${esc(g.name)}</strong> ${tagChip(g.tag)}
        <div class="plan-meta">${esc(bank(g.bank_id))}${g.last4 ? ` ••${g.last4}` : ""} · ${formatMYR(g.monthly)} ·
          on ${g.count} statement${g.count === 1 ? "" : "s"}${g.first ? ` since ${monthLabel(g.first)}` : ""}${g.last && g.last !== g.first ? ` · last ${monthLabel(g.last)}` : ""}</div>
      </div>
      <button class="ghost-btn" data-track="${i}">Track as plan</button>
    </div>`).join("")}
  </div>`;
}

function manualPlans() {
  return (store.raw?.instalment_plans || []).map((p) => ({ ...p, source: "manual" }));
}

// Day of month a card's statements are issued on (its newest parsed statement),
// or null when the card has none.
function statementDay(last4) {
  if (!last4) return null;
  let newest = null;
  for (const s of store.raw?.statements || []) {
    if (s.statement_type === "manual" || !s.statement_date) continue;
    const onCard = s.card_last4 === last4 || (s.cards || []).some((c) => c.last4 === last4);
    if (onCard && (!newest || s.statement_date > newest)) newest = s.statement_date;
  }
  return newest ? Number(newest.slice(8, 10)) : null;
}

// Resolve a plan's live position by statement dates (see header): how many
// instalments are billed as of today, the statement date the final one bills
// on (`final_date`), and the next statement date still to come.
function billedByStatements(p, tenure) {
  const today = todayIso();
  if (p.source === "auto" && p._stmt_date) {
    // Counter as printed, then one more per projected statement date passed.
    let current = p._counter;
    while (current < tenure && addMonthsIso(p._stmt_date, current - p._counter + 1) <= today) current++;
    return {
      current,
      final_date: addMonthsIso(p._stmt_date, tenure - p._counter),
      next_date: current < tenure ? addMonthsIso(p._stmt_date, current - p._counter + 1) : null,
      projected: current > p._counter, // past the newest parsed statement
    };
  }
  if (p.start_month) {
    const day = String(statementDay(p.last4) || 1).padStart(2, "0");
    const first = `${p.start_month}-${day}`;
    let current = 0;
    while (current < tenure && addMonthsIso(first, current) <= today) current++;
    return {
      current,
      final_date: addMonthsIso(first, tenure - 1),
      next_date: current < tenure ? addMonthsIso(first, current) : null,
    };
  }
  // Legacy manual plans with no start_month: the stored counter.
  return { current: typeof p.current === "number" ? p.current : (p._counter || 0) };
}

function withDerived(p) {
  const tenure = Number(p.tenure) || 0;
  const billed = billedByStatements(p, tenure);
  const current = Math.max(0, Math.min(tenure, billed.current));

  const monthly = Number(p.monthly) || 0;
  const total = monthly * tenure;
  const paid = monthly * current;
  const remaining = Math.max(0, total - paid);
  const pct = tenure ? Math.min(100, Math.round((current / tenure) * 100)) : 0;
  const done = tenure > 0 && current >= tenure;
  return {
    ...p, tenure, monthly, current, total, paid, remaining, pct, done,
    final_date: billed.final_date || null, next_date: billed.next_date || null,
    projected: !!billed.projected,
  };
}

export async function render(container) {
  if (!store.raw) await loadStore();

  // The statement is the source of truth: once a parsed row carries the plan's
  // ":NNN/NNN" counter, the auto plan wins and the placeholder the user
  // captured by hand before that statement arrived drops out of the list and
  // the totals (see coversAuto).
  const auto = autoPlans().map(withDerived);
  const supersededBy = new Map(); // auto plan id -> manual plans it replaced
  const manual = manualPlans().map(withDerived).filter((m) => {
    const twin = auto.find((a) => coversAuto(m, a));
    if (!twin) return true;
    supersededBy.set(twin.id, [...(supersededBy.get(twin.id) || []), m]);
    return false;
  });
  // Name the replaced plan on the surviving card. The manual record still
  // exists on the server, so the card also carries its delete action -
  // otherwise a superseded plan would be stranded: never listed, never
  // editable, never removable.
  for (const a of auto) a.supersedes = supersededBy.get(a.id) || [];

  const all = [...manual, ...auto].sort((a, b) => a.name.localeCompare(b.name));
  const active = all.filter((p) => !p.done);
  const completed = all.filter((p) => p.done);
  const monthlyCommit = active.reduce((s, p) => s + p.monthly, 0);
  const totalRemaining = active.reduce((s, p) => s + p.remaining, 0);
  const untracked = untrackedCharges(manualPlans());

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
    ${untrackedHtml(untracked)}
  `;

  document.getElementById("add-plan").addEventListener("click", () => openForm(null, container));
  // Pre-fill a new manual plan from an untracked charge; the first statement
  // it appeared on is the start month (editable — the user knows the tenure).
  container.querySelectorAll("[data-track]").forEach((b) =>
    b.addEventListener("click", () => {
      const g = untracked[Number(b.dataset.track)];
      openForm(null, container, {
        name: g.name, monthly: g.monthly, tag: g.tag, last4: g.last4 || null,
        start_month: g.first ? g.first.slice(0, 7) : null,
      });
    }));
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
        ${p.final_date ? ` · ${p.done ? "cleared on" : "last on"} ${monthLabel(p.final_date)} statement` : ""}
        ${p.projected && !p.done ? `<span class="plan-note">counted past the last parsed statement</span>` : ""}
        ${p.supersedes?.length ? `<span class="plan-note">replaces your manual ${p.supersedes.map((m) => `"${esc(m.name)}"`).join(", ")}</span>` : ""}
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
      </div>` : p.supersedes?.length ? `<div class="plan-actions">
        ${p.supersedes.map((m) => `<button class="ghost-btn danger" data-del="${m.id}">Delete manual "${esc(m.name)}"</button>`).join("")}
      </div>` : ""}
    </div>`;
}

function openForm(plan, container, prefill = null) {
  const isEdit = !!plan;
  const values = plan || prefill;
  const cards = [...new Set((store.rows || []).map((t) => t.card?.last4).filter(Boolean))];
  const node = document.createElement("div");
  node.className = "sheet-content";
  node.innerHTML = `
    <div class="sheet-head"><h2>${isEdit ? "Edit" : "Add"} plan</h2><button id="sheet-close" class="icon-btn">✕</button></div>
    <label>Name<input id="p-name" value="${esc(values?.name)}"></label>
    <label>Monthly amount (RM)<input id="p-monthly" type="number" step="0.01" value="${values?.monthly ?? ""}"></label>
    <label>Tenure (months)<input id="p-tenure" type="number" value="${values?.tenure ?? ""}"></label>
    <label>Start month<input id="p-start" type="month" value="${esc(values?.start_month)}"></label>
    <div class="field-hint">The remaining balance and completion are calculated from the start month automatically.</div>
    <label>Tag<select id="p-tag">
      <option value="Instalment" ${values?.tag === "Instalment" ? "selected" : ""}>Instalment</option>
      <option value="Balance Transfer" ${values?.tag === "Balance Transfer" ? "selected" : ""}>Balance Transfer</option>
    </select></label>
    <label>Card<select id="p-card"><option value="">—</option>${cards.map((l) => `<option value="${l}" ${values?.last4 === l ? "selected" : ""}>••${l}</option>`).join("")}</select></label>
    <label>Note<textarea id="p-note">${esc(values?.note)}</textarea></label>
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
