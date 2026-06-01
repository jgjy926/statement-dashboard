// Overview tab: summary cards + donut + 6-month trend + upcoming due dates.
import { store, loadStore, formatMYR, formatDate, skeleton } from "./app.js";
import { deriveCards } from "./api.js";
import { donutByCategory, lineByMonth } from "./charts.js";

let range = "this"; // this | last | 3m | custom
let customFrom = "";
let customTo = "";

function rangeBounds() {
  const now = new Date();
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  if (range === "this") {
    const k = ym(now);
    return [`${k}-01`, `${k}-31`];
  }
  if (range === "last") {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const k = ym(d);
    return [`${k}-01`, `${k}-31`];
  }
  if (range === "3m") {
    const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    return [`${ym(start)}-01`, `${ym(now)}-31`];
  }
  return [customFrom || "0000-00-00", customTo || "9999-99-99"];
}

function inRange(t, from, to) {
  const d = t.posting_date || t.transaction_date || "";
  return d >= from && d <= to;
}

export async function render(container) {
  if (!store.raw) await loadStore();
  const [from, to] = rangeBounds();
  const rows = store.rows.filter((t) => inRange(t, from, to));

  const spend = rows.filter((t) => Number(t.amount) < 0)
    .reduce((s, t) => s + Math.abs(Number(t.amount)), 0);

  const cards = deriveCards(store.raw);
  // Paid cards no longer count toward what you still owe.
  const outstanding = cards
    .filter((c) => !c.paid)
    .reduce((s, c) => s + (Number(c.due_amount) || 0), 0);

  const todayIso = new Date().toISOString().slice(0, 10);
  const upcoming = cards
    .filter((c) => c.due_date && !c.paid)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const nextDue = upcoming.find((c) => c.due_date >= todayIso) || upcoming[0];

  container.innerHTML = `
    <div class="tab-head">
      <h1>Overview</h1>
      <div class="seg" id="range-seg">
        ${["this", "last", "3m", "custom"].map((r) =>
          `<button data-r="${r}" class="${range === r ? "on" : ""}">${
            { this: "This Month", last: "Last Month", "3m": "3M", custom: "Custom" }[r]
          }</button>`
        ).join("")}
      </div>
      <div class="custom-range ${range === "custom" ? "" : "hidden"}" id="custom-range">
        <input type="date" id="cf" value="${customFrom}"> →
        <input type="date" id="ct" value="${customTo}">
      </div>
    </div>

    <div class="cards-grid">
      <div class="stat-card"><div class="stat-lbl">Total spend</div><div class="stat-val">${formatMYR(-spend)}</div></div>
      <div class="stat-card"><div class="stat-lbl">Outstanding due</div><div class="stat-val">${formatMYR(outstanding)}</div></div>
      <div class="stat-card"><div class="stat-lbl">Next due date</div><div class="stat-val sm">${
        nextDue ? `${formatDate(nextDue.due_date)}<br><small>${formatMYR(nextDue.due_amount)}</small>` : "—"
      }</div></div>
    </div>

    <div class="panel"><h2>Spend by category</h2><div class="chart-box"><canvas id="donut"></canvas></div><div id="donut-empty"></div></div>
    <div class="panel"><h2>Spend trend (6 months)</h2><div class="chart-box"><canvas id="line"></canvas></div></div>

    <div class="panel">
      <h2>Upcoming due dates</h2>
      <ul class="list">
        ${upcoming.length ? upcoming.map((c) => `
          <li class="list-row">
            <div><strong>${c.name || c.bank_id}</strong> ••${c.last4}</div>
            <div class="right">${formatDate(c.due_date)}<br><small>${formatMYR(c.due_amount)}</small></div>
          </li>`).join("") : `<li class="empty">No upcoming due dates</li>`}
      </ul>
    </div>
  `;

  const had = donutByCategory(document.getElementById("donut"), rows);
  if (!had) document.getElementById("donut-empty").innerHTML = `<div class="empty">No spend in this period</div>`;
  lineByMonth(document.getElementById("line"), store.rows, 6);

  // Date filter wiring — re-render on change.
  container.querySelectorAll("#range-seg button").forEach((b) =>
    b.addEventListener("click", () => { range = b.dataset.r; render(container); })
  );
  if (range === "custom") {
    const rerun = () => {
      customFrom = document.getElementById("cf").value;
      customTo = document.getElementById("ct").value;
      render(container);
    };
    document.getElementById("cf").addEventListener("change", rerun);
    document.getElementById("ct").addEventListener("change", rerun);
  }
}
