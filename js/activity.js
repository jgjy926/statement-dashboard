// Activity tab: everything that needs a look, in one place.
//   * Needs attention — cards still awaiting a statement (projected from each
//     card's cadence, see projectMissingStatements) plus statements whose last
//     parse FAILED and hasn't been followed by a good one.
//   * Parse log — one row per PDF the watcher processed: bank · card · which
//     statement, and whether it passed / failed / was a duplicate. Written by
//     the parser into transactions.json["parse_log"] (newest last).
import { store, loadStore } from "./app.js";
import { deriveCards } from "./api.js";
import { watchParts, monthYear, focusCard } from "./cards.js";

const WATCH_ORDER = { overdue: 0, awaiting: 1, dormant: 2 };
const STATUS = {
  passed: { icon: "✓", label: "Passed" },
  failed: { icon: "✕", label: "Failed" },
  duplicate: { icon: "↺", label: "Duplicate" },
};

let statusFilter = "all";
let bankFilter = "";

function bankName(id) {
  return store.config?.banks?.[id]?.bank_name || id || "Unknown bank";
}

function parseLog(raw) {
  return [...(raw?.parse_log || [])].reverse(); // newest first
}

// Cards awaiting a statement, most urgent first.
function awaitingCards(raw) {
  return deriveCards(raw)
    .filter((c) => c.stmt_watch && c.stmt_watch.missing.length) // not cleared-only
    .sort((a, b) => {
      const o = WATCH_ORDER[a.stmt_watch.status] - WATCH_ORDER[b.stmt_watch.status];
      if (o) return o;
      return (a.stmt_watch.missing[0].due_date || "").localeCompare(
        b.stmt_watch.missing[0].due_date || ""
      );
    });
}

// Failed parses not yet superseded: no later passed/duplicate run of the same
// PDF, nor (when the bank was detected) a later passed statement of that bank.
function openFailures(raw) {
  const log = parseLog(raw); // newest first
  const out = [];
  log.forEach((e, i) => {
    if (e.status !== "failed") return;
    const later = log.slice(0, i);
    const fixed = later.some((l) => l.status !== "failed" && (
      l.source_file === e.source_file ||
      (e.template_id && l.template_id === e.template_id && l.status === "passed")
    ));
    if (!fixed) out.push(e);
  });
  return out;
}

// Number shown on the Activity nav button.
export function attentionCount(raw) {
  if (!raw) return 0;
  return awaitingCards(raw).length + openFailures(raw).length;
}

function entryTitle(e) {
  const bank = e.bank_name || (e.bank_id ? bankName(e.bank_id) : null);
  const parts = [bank, e.card_name].filter(Boolean);
  return parts.length ? parts.join(" · ") : e.source_file || "Unknown statement";
}

function entrySub(e) {
  const bits = [];
  if (e.statement_date) bits.push(`${monthYear(e.statement_date)} statement`);
  if (e.card_last4) bits.push(`••${e.card_last4}`);
  if (e.status === "failed") bits.push(e.error || "parse failed");
  else bits.push(`${e.transaction_count ?? 0} txns`);
  return bits.join(" · ");
}

function parsedAt(e) {
  if (!e.at) return "";
  const d = new Date(e.at);
  if (isNaN(d)) return e.at;
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function logRow(e) {
  const st = STATUS[e.status] || { icon: "•", label: e.status };
  const warn = e.warning_count ? `<span class="act-warn">⚠ ${e.warning_count}</span>` : "";
  const details = [
    e.error ? `<div class="act-err">${esc(e.error)}</div>` : "",
    (e.warnings || []).length ? `<ul class="act-warnings">${e.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "",
    `<div class="act-file">${esc(e.source_file || "")}${e.template_id ? ` · ${esc(e.template_id)}` : ""}${e.backfilled ? " · from history" : ""}</div>`,
  ].join("");
  return `<details class="act-row ${e.status}">
    <summary>
      <span class="act-pill ${e.status}" title="${st.label}">${st.icon} ${st.label}</span>
      <span class="act-main">
        <span class="act-title">${esc(entryTitle(e))}</span>
        <span class="act-sub">${esc(entrySub(e))}</span>
      </span>
      <span class="act-side">${warn}<span class="act-when">${parsedAt(e)}</span></span>
    </summary>
    <div class="act-detail">${details}</div>
  </details>`;
}

function attentionPanel(raw) {
  const cards = awaitingCards(raw);
  const fails = openFailures(raw);
  const n = cards.length + fails.length;
  if (!n) {
    return `<div class="panel"><div class="panel-head"><h2>Needs attention</h2></div>
      <div class="act-clear">✓ All statements in and parsed</div></div>`;
  }
  const cardRows = cards.map((c) => {
    const p = watchParts(c.stmt_watch);
    return `<button class="attn-row ${c.stmt_watch.status}" data-bank="${c.bank_id}" data-last4="${c.last4}">
      <span class="attn-ico">${p.icon}</span>
      <span class="attn-main">
        <span class="attn-card">${esc(bankName(c.bank_id))} •••• ${c.last4}</span>
        <span class="attn-detail">${p.headline} · ${p.sub}${c.suggest_close ? " · looks finished, close it?" : ""}</span>
      </span>
      <span class="attn-go">›</span>
    </button>`;
  }).join("");
  const failRows = fails.map((e) => `<div class="attn-row overdue">
      <span class="attn-ico">✕</span>
      <span class="attn-main">
        <span class="attn-card">Parse failed · ${esc(entryTitle(e))}</span>
        <span class="attn-detail">${esc(e.error || "unknown error")} · ${parsedAt(e)}</span>
      </span>
    </div>`).join("");
  return `<div class="panel attn-panel">
    <div class="panel-head"><h2>Needs attention</h2><span class="count-pill">${n}</span></div>
    ${failRows}${cardRows}
  </div>`;
}

function logPanel(raw) {
  const all = parseLog(raw);
  if (!all.length) {
    return `<div class="panel"><h2>Parse log</h2>
      <div class="empty">No statements parsed yet — new PDFs show up here once the watcher processes them.</div></div>`;
  }
  const banks = [...new Set(all.map((e) => e.bank_id).filter(Boolean))].sort();
  const counts = { all: all.length, passed: 0, failed: 0, duplicate: 0 };
  for (const e of all) if (counts[e.status] != null) counts[e.status]++;
  const rows = all.filter((e) =>
    (statusFilter === "all" || e.status === statusFilter) &&
    (!bankFilter || e.bank_id === bankFilter)
  );
  const seg = ["all", "passed", "failed", "duplicate"]
    .filter((k) => k === "all" || counts[k])
    .map((k) => `<button data-status="${k}" class="${statusFilter === k ? "on" : ""}">${k === "all" ? "All" : STATUS[k].label} ${counts[k]}</button>`)
    .join("");
  return `<div class="panel">
    <div class="panel-head"><h2>Parse log</h2></div>
    <div class="act-filters">
      <div class="seg">${seg}</div>
      <select id="act-bank">
        <option value="">All banks</option>
        ${banks.map((b) => `<option value="${b}" ${bankFilter === b ? "selected" : ""}>${esc(bankName(b))}</option>`).join("")}
      </select>
    </div>
    ${rows.length ? rows.map(logRow).join("") : `<div class="empty">Nothing matches this filter</div>`}
  </div>`;
}

export async function render(container) {
  if (!store.raw) await loadStore();
  const raw = store.raw;
  container.innerHTML = `
    <div class="tab-head"><h1>Activity</h1></div>
    ${attentionPanel(raw)}
    ${logPanel(raw)}
  `;

  container.querySelectorAll(".attn-row[data-bank]").forEach((btn) =>
    btn.addEventListener("click", () => {
      focusCard(btn.dataset.bank, btn.dataset.last4);
      location.hash = "#cards";
    })
  );
  container.querySelectorAll(".act-filters .seg button").forEach((b) =>
    b.addEventListener("click", () => { statusFilter = b.dataset.status; render(container); })
  );
  container.querySelector("#act-bank")?.addEventListener("change", (e) => {
    bankFilter = e.target.value;
    render(container);
  });
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
