// Chart.js builders (Chart is global, loaded via CDN <script> in index.html).
// Charts are container-sized and responsive (maintainAspectRatio:false).

const PALETTE = [
  "#1a73e8", "#34a853", "#fb8c00", "#8e24aa", "#e53935",
  "#00897b", "#f9a825", "#6d4c41", "#3949ab", "#00acc1", "#7cb342",
];

const instances = {};

function reset(key, canvas) {
  if (instances[key]) instances[key].destroy();
  const Chart = window.Chart;
  return { Chart, ctx: canvas.getContext("2d") };
}

// rows: flat transactions (already filtered). Donut of spend by category.
export function donutByCategory(canvas, rows) {
  const { Chart } = reset("donut", canvas);
  const totals = {};
  for (const t of rows) {
    const amt = Number(t.amount) || 0;
    if (amt >= 0) continue; // spend only
    const cat = t.category || t.merchant_category || "Uncategorized";
    totals[cat] = (totals[cat] || 0) + Math.abs(amt);
  }
  const labels = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  const data = labels.map((l) => Math.round(totals[l] * 100) / 100);

  instances.donut = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]) }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (c) => `${c.label}: RM ${c.parsed.toLocaleString("en-MY", { minimumFractionDigits: 2 })}`,
          },
        },
      },
    },
  });
  return labels.length;
}

// Bar chart of a positive monthly series for the last `months` months.
// rows: transactions (already filtered to the relevant tag). Sums positive
// amounts per month. Returns nothing; sized to its container.
export function monthlyBars(canvas, rows, months = 6, color = "#34a853") {
  const { Chart } = reset("bars", canvas);
  const now = new Date();
  const keys = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const totals = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const t of rows) {
    const amt = Number(t.amount) || 0;
    if (amt <= 0) continue;
    const key = (t.transaction_date || t.posting_date || "").slice(0, 7);
    if (key in totals) totals[key] += amt;
  }
  const labels = keys.map((k) => {
    const [y, m] = k.split("-");
    return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
  });
  instances.bars = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ data: keys.map((k) => Math.round(totals[k] * 100) / 100), backgroundColor: color, borderRadius: 6 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `RM ${c.parsed.y.toLocaleString("en-MY", { minimumFractionDigits: 2 })}` } },
      },
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => "RM " + Number(v).toLocaleString("en-MY") } } },
    },
  });
}

// Line of total spend per month for the last `months` months.
export function lineByMonth(canvas, rows, months = 6) {
  const { Chart } = reset("line", canvas);

  // Build the trailing month buckets ending at the current month.
  const now = new Date();
  const keys = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const totals = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const t of rows) {
    const amt = Number(t.amount) || 0;
    if (amt >= 0) continue;
    const date = t.transaction_date || t.posting_date || "";
    const key = date.slice(0, 7);
    if (key in totals) totals[key] += Math.abs(amt);
  }
  const labels = keys.map((k) => {
    const [y, m] = k.split("-");
    return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
  });

  instances.line = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Spend",
        data: keys.map((k) => Math.round(totals[k] * 100) / 100),
        borderColor: "#1a73e8",
        backgroundColor: "rgba(26,115,232,0.12)",
        fill: true,
        tension: 0.3,
        pointRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: (v) => "RM " + Number(v).toLocaleString("en-MY") },
        },
      },
    },
  });
}
