// Cash Back tab: analytics (KPIs + 3/6/12-month trend) · by bank/card
// (clickable to filter) · transaction list. Period filter by year / month.
import { store, loadStore, formatMYR, formatDate, skeleton } from "./app.js";
import { monthlyBars } from "./charts.js";

let year = "";       // "" = all years
let month = "";      // "" = all months ("01".."12")
let trendWin = 6;    // 3 | 6 | 12
let selectedCard = null; // last4 filter for the list

const isCashback = (t) => t.tag === "Cash Back" && Number(t.amount) > 0;

function inPeriod(t) {
  const d = t.posting_date || t.transaction_date || "";
  return (!year || d.slice(0, 4) === year) && (!month || d.slice(5, 7) === month);
}

export async function render(container) {
  if (!store.raw) await loadStore();

  const allCB = store.rows.filter(isCashback);
  const cb = allCB.filter(inPeriod);

  // KPIs
  const total = cb.reduce((s, t) => s + Number(t.amount), 0);
  const monthsSpan = new Set(cb.map((t) => (t.posting_date || t.transaction_date || "").slice(0, 7))).size || 1;
  const monthlyAvg = total / monthsSpan;
  // Effective rate = cash back ÷ spend in the same period.
  const spend = store.rows
    .filter((t) => Number(t.amount) < 0 && inPeriod(t))
    .reduce((s, t) => s + Math.abs(Number(t.amount)), 0);
  const rate = spend ? (total / spend) * 100 : 0;

  // By bank → card
  const byBank = {};
  for (const t of cb) {
    const b = (byBank[t.bank_id] = byBank[t.bank_id] || { total: 0, cards: {} });
    b.total += Number(t.amount);
    const l4 = t.card?.last4 || "—";
    const c = (b.cards[l4] = b.cards[l4] || { total: 0, name: t.card?.name, network: t.card?.network });
    c.total += Number(t.amount);
  }
  const bestCard = Object.values(byBank)
    .flatMap((b) => Object.entries(b.cards).map(([l4, c]) => ({ l4, ...c })))
    .sort((a, b) => b.total - a.total)[0];

  // Years for the filter
  const years = [...new Set(allCB.map((t) => (t.posting_date || t.transaction_date || "").slice(0, 4)))].sort().reverse();

  const list = (selectedCard ? cb.filter((t) => (t.card?.last4 || "—") === selectedCard) : cb)
    .sort((a, b) =>
      (b.posting_date || b.transaction_date || "").localeCompare(a.posting_date || a.transaction_date || "")
    );

  container.innerHTML = `
    <div class="tab-head"><h1>Cash Back</h1></div>

    <div class="panel">
      <div class="cb-filters">
        <label>Year<select id="cb-year"><option value="">All</option>${years.map((y) => `<option value="${y}" ${y === year ? "selected" : ""}>${y}</option>`).join("")}</select></label>
        <label>Month<select id="cb-month"><option value="">All</option>${monthOptions(month)}</select></label>
      </div>
      <div class="cards-grid">
        <div class="stat-card"><div class="stat-lbl">Total earned</div><div class="stat-val">${formatMYR(total)}</div></div>
        <div class="stat-card"><div class="stat-lbl">Monthly avg</div><div class="stat-val">${formatMYR(monthlyAvg)}</div></div>
        <div class="stat-card"><div class="stat-lbl">Effective rate</div><div class="stat-val">${rate.toFixed(2)}%</div></div>
        <div class="stat-card"><div class="stat-lbl">Top card</div><div class="stat-val sm">${bestCard ? `••${bestCard.l4}<br><small>${formatMYR(bestCard.total)}</small>` : "—"}</div></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Trend</h2>
        <div class="seg" id="cb-trend">
          ${[3, 6, 12].map((w) => `<button data-w="${w}" class="${trendWin === w ? "on" : ""}">${w}M</button>`).join("")}
        </div>
      </div>
      <div class="chart-box"><canvas id="cb-bars"></canvas></div>
    </div>

    <div class="panel">
      <h2>By bank &amp; card</h2>
      <p class="hint">Tap a card to filter the list below.</p>
      ${Object.keys(byBank).length ? Object.entries(byBank).map(([bank, b]) => `
        <div class="cb-bank">
          <div class="cb-bank-head"><b>${store.config?.banks?.[bank]?.bank_name || bank}</b><span>${formatMYR(b.total)}</span></div>
          ${Object.entries(b.cards).map(([l4, c]) => `
            <div class="cb-card-row ${selectedCard === l4 ? "sel" : ""}" data-last4="${l4}">
              <span>${c.name || "Card"} ••${l4}</span><b>${formatMYR(c.total)}</b>
            </div>`).join("")}
        </div>`).join("") : `<div class="empty">No cash back in this period</div>`}
    </div>

    <div class="panel">
      <h2>Transactions ${selectedCard ? `<span class="count-pill">••${selectedCard}</span>` : ""}</h2>
      <ul class="list">
        ${list.length ? list.map((t) => `
          <li class="list-row">
            <div><strong>${t.merchant || t.description}</strong><div class="txn-sub">${formatDate(t.posting_date || t.transaction_date)} · ••${t.card?.last4 || "—"}</div></div>
            <div class="right txn-amt pos">${formatMYR(t.amount)}</div>
          </li>`).join("") : `<li class="empty">No cash back transactions</li>`}
      </ul>
    </div>
  `;

  monthlyBars(document.getElementById("cb-bars"), allCB, trendWin, "#34a853");

  document.getElementById("cb-year").addEventListener("change", (e) => { year = e.target.value; selectedCard = null; render(container); });
  document.getElementById("cb-month").addEventListener("change", (e) => { month = e.target.value; selectedCard = null; render(container); });
  container.querySelectorAll("#cb-trend button").forEach((b) =>
    b.addEventListener("click", () => { trendWin = Number(b.dataset.w); render(container); }));
  container.querySelectorAll(".cb-card-row").forEach((row) =>
    row.addEventListener("click", () => {
      selectedCard = selectedCard === row.dataset.last4 ? null : row.dataset.last4;
      render(container);
    }));
}

function monthOptions(sel) {
  return Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, "0");
    const name = new Date(2000, i, 1).toLocaleDateString("en-GB", { month: "long" });
    return `<option value="${m}" ${m === sel ? "selected" : ""}>${name}</option>`;
  }).join("");
}
