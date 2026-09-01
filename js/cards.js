// Cards tab: all cards grouped by bank, derived from statements.
import { store, loadStore, formatMYR, formatDate, showToast } from "./app.js";
import { deriveCards, setCardPaid, setCardNil } from "./api.js";
import { setFilter } from "./transactions.js";

const NETWORK = {
  visa: { label: "VISA", cls: "visa" },
  mastercard: { label: "Mastercard", cls: "mc" },
  amex: { label: "AMEX", cls: "amex" },
};

function netBadge(network) {
  const n = NETWORK[(network || "").toLowerCase()] || { label: network || "Card", cls: "generic" };
  return `<span class="net ${n.cls}">${n.label}</span>`;
}

function monthYear(iso) {
  const d = new Date(`${(iso || "").slice(0, 10)}T00:00:00`);
  if (isNaN(d)) return iso || "—";
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

// A short month like "Aug" (no year), for compact buttons.
function monthShort(iso) {
  const d = new Date(`${(iso || "").slice(0, 10)}T00:00:00`);
  if (isNaN(d)) return iso || "";
  return d.toLocaleDateString("en-GB", { month: "short" });
}

// Turn a card's awaited cycles into display parts. The headline names the
// NEWEST awaited cycle (the "current" statement the Nil button clears); older
// unbilled cycles are summarised as "+N earlier". `target` is the cycle the
// Nil action acts on. Shared by the per-card banner and the top summary.
function watchParts(w) {
  const m = w.missing;
  const newest = m[m.length - 1];
  const earlier = m.length - 1;
  const earlierNote = earlier ? ` · +${earlier} earlier` : "";

  if (w.status === "dormant") {
    return {
      icon: "⋯",
      headline: `No statement since ${monthYear(w.last_statement_date)}`,
      sub: `${m.length} cycles behind`,
      target: newest,
    };
  }
  const headline = newest.overdue
    ? `${monthYear(newest.statement_date)} statement overdue`
    : `Awaiting ${monthYear(newest.statement_date)} statement`;
  return {
    icon: newest.overdue ? "⚠" : "⏳",
    headline: `${headline}${earlierNote}`,
    sub: `${newest.overdue ? "was due" : "due ~"} ${formatDate(newest.due_date)}`,
    target: newest,
  };
}

// The full missing/no-spend block for a card: the awaited banner (with a Nil
// button that clears the current cycle) and/or a confirmed no-spend note (with
// Undo). Both can show at once when a card is part-cleared, part-awaited.
function missingBanner(c) {
  const w = c.stmt_watch;
  if (!w) return "";
  const attrs = `data-bank="${c.bank_id}" data-last4="${c.last4}"`;
  let html = "";

  if (w.missing.length) {
    const p = watchParts(w);
    html += `<div class="cc-missing ${w.status}">
      <span class="ccm-ico">${p.icon}</span>
      <span class="ccm-txt"><b>${p.headline}</b><i>${p.sub}</i></span>
      <button class="ccm-nil" ${attrs} data-cycle="${p.target.ym}"
        title="No spend this cycle — clear ${monthYear(p.target.statement_date)}">Nil ${monthShort(p.target.statement_date)}</button>
    </div>`;
  }

  if (w.nil.length) {
    const months = w.nil.map((n) => monthYear(n.statement_date)).join(", ");
    const cycles = w.nil.map((n) => n.ym).join(",");
    html += `<div class="cc-missing cleared">
      <span class="ccm-ico">✓</span>
      <span class="ccm-txt"><b>No spend confirmed</b><i>${months}</i></span>
      <button class="ccm-undo" ${attrs} data-cycles="${cycles}">Undo</button>
    </div>`;
  }
  return html;
}

function cardHtml(c) {
  const usage = c.credit_limit
    ? Math.min(100, Math.round((Math.abs(c.closing_balance || 0) / c.credit_limit) * 100))
    : null;
  const hasDue = Number(c.due_amount) > 0;
  return `
    <div class="credit-card ${c.paid ? "is-paid" : ""}" id="card-${c.bank_id}-${c.last4}" data-bank="${c.bank_id}" data-last4="${c.last4}">
      <div class="cc-head">
        <span class="cc-title">${c.name || "Card"}</span>
        <span class="cc-tags">
          ${c.paid ? `<span class="paid-badge">PAID</span>` : ""}
          ${c.is_supplementary ? `<span class="supp">SUPP</span>` : ""}
          ${netBadge(c.network)}
        </span>
      </div>
      <div class="cc-num">•••• ${c.last4}</div>
      <div class="cc-figures">
        ${hasDue ? `<span><i>Due</i> ${formatMYR(c.due_amount)}</span>
        <span><i>by</i> ${formatDate(c.due_date)}</span>` : ""}
        ${c.period_subtotal != null
          ? `<span><i>Statement</i> ${formatMYR(c.period_subtotal)}</span>`
          : `<span><i>Spent</i> ${formatMYR(c.spend)}</span>`}
        ${hasDue && c.credit_limit ? `<span><i>Limit</i> ${formatMYR(c.credit_limit)}</span>` : ""}
      </div>
      ${usage != null ? `<div class="usage"><div class="usage-fill" style="width:${usage}%"></div></div>` : ""}
      ${missingBanner(c)}
      ${c.required_swipes ? `<div class="sweep">
        <span><i>Sweeps</i> ${c.sweeps}/${c.required_swipes}</span>
        <span><i>To waive</i> ${c.sweeps_pending}</span>
        ${c.months_left != null ? `<span><i>Resets in</i> ${c.months_left}mo</span>` : ""}
      </div>` : ""}
      ${!c.is_supplementary ? `<button class="paid-toggle" data-stmt="${c.cycle_statement_id}" data-last4="${c.last4}" data-paid="${c.paid ? 1 : 0}">
        ${c.paid ? "↩︎ Unpaid" : "✓ Paid"}</button>` : ""}
    </div>`;
}

// Top-of-tab roundup of every card awaiting a statement, most urgent first, so
// the gap is visible without scrolling each bank panel.
const WATCH_ORDER = { overdue: 0, awaiting: 1, dormant: 2 };

function attentionPanel(cards) {
  const watched = cards
    .filter((c) => c.stmt_watch && c.stmt_watch.missing.length) // exclude cleared-only
    .sort((a, b) => {
      const o = WATCH_ORDER[a.stmt_watch.status] - WATCH_ORDER[b.stmt_watch.status];
      if (o) return o;
      return (a.stmt_watch.missing[0].due_date || "").localeCompare(
        b.stmt_watch.missing[0].due_date || ""
      );
    });
  if (!watched.length) return "";

  const rows = watched.map((c) => {
    const p = watchParts(c.stmt_watch);
    const bank = store.config?.banks?.[c.bank_id]?.bank_name || c.bank_id;
    return `<button class="attn-row ${c.stmt_watch.status}" data-target="card-${c.bank_id}-${c.last4}">
      <span class="attn-ico">${p.icon}</span>
      <span class="attn-main">
        <span class="attn-card">${bank} •••• ${c.last4}</span>
        <span class="attn-detail">${p.headline} · ${p.sub}</span>
      </span>
      <span class="attn-go">›</span>
    </button>`;
  }).join("");

  return `<div class="panel attn-panel">
    <div class="panel-head">
      <h2>Statements awaiting</h2>
      <span class="count-pill">${watched.length}</span>
    </div>
    ${rows}
  </div>`;
}

export async function render(container) {
  if (!store.raw) await loadStore();
  const cards = deriveCards(store.raw);

  const byBank = {};
  for (const c of cards) (byBank[c.bank_id] = byBank[c.bank_id] || []).push(c);

  container.innerHTML = `
    <div class="tab-head"><h1>Cards</h1></div>
    ${attentionPanel(cards)}
    ${Object.keys(byBank).length ? Object.entries(byBank).map(([bank, list]) => `
      <div class="panel">
        <h2>${(store.config?.banks?.[bank]?.bank_name) || bank}</h2>
        <div class="cards-col">${list.map(cardHtml).join("")}</div>
      </div>`).join("") : `<div class="empty">No cards found</div>`}
  `;

  // Summary row → scroll to (and briefly flash) the matching card.
  container.querySelectorAll(".attn-row").forEach((btn) =>
    btn.addEventListener("click", () => {
      const el = container.querySelector(`#${CSS.escape(btn.dataset.target)}`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1600);
    })
  );

  // Tap a card → open Transactions pre-filtered to that card.
  container.querySelectorAll(".credit-card").forEach((el) =>
    el.addEventListener("click", () => {
      setFilter({ bank: el.dataset.bank, last4: el.dataset.last4 });
      location.hash = "#transactions";
    })
  );

  // Paid toggle — must not also trigger the card's tap-to-filter.
  container.querySelectorAll(".paid-toggle").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const paid = btn.dataset.paid === "1";
      btn.disabled = true;
      try {
        await setCardPaid({
          statement_id: btn.dataset.stmt,
          last4: btn.dataset.last4,
          paid: !paid,
        });
        store.raw = null;
        await loadStore();
        showToast(paid ? "Marked unpaid" : "Marked paid");
        render(container);
      } catch {
        btn.disabled = false;
      }
    })
  );

  // "Nil <month>" → mark the current awaited cycle as no-spend; "Undo" → clear
  // the no-spend marks again. Both must not trigger the card's tap-to-filter.
  const nilWrite = async (btn, cycles, nil) => {
    btn.disabled = true;
    try {
      await setCardNil({ bank_id: btn.dataset.bank, last4: btn.dataset.last4, cycles, nil });
      store.raw = null;
      await loadStore();
      showToast(nil ? "Marked no-spend" : "No-spend removed");
      render(container);
    } catch {
      btn.disabled = false;
    }
  };
  container.querySelectorAll(".ccm-nil").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      nilWrite(btn, [btn.dataset.cycle], true);
    })
  );
  container.querySelectorAll(".ccm-undo").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      nilWrite(btn, btn.dataset.cycles.split(","), false);
    })
  );
}
