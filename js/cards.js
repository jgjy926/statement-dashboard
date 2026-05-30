// Cards tab: all cards grouped by bank, derived from statements.
import { store, loadStore, formatMYR, formatDate, showToast } from "./app.js";
import { deriveCards, setCardPaid } from "./api.js";
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

function cardHtml(c) {
  const usage = c.credit_limit
    ? Math.min(100, Math.round((Math.abs(c.closing_balance || 0) / c.credit_limit) * 100))
    : null;
  const hasDue = Number(c.due_amount) > 0;
  return `
    <div class="credit-card ${c.paid ? "is-paid" : ""}" data-bank="${c.bank_id}" data-last4="${c.last4}">
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
      ${hasDue ? `<button class="paid-toggle" data-stmt="${c.due_statement_id}" data-last4="${c.last4}" data-paid="${c.paid ? 1 : 0}">
        ${c.paid ? "↩︎ Unpaid" : "✓ Paid"}</button>` : ""}
    </div>`;
}

export async function render(container) {
  if (!store.raw) await loadStore();
  const cards = deriveCards(store.raw);

  const byBank = {};
  for (const c of cards) (byBank[c.bank_id] = byBank[c.bank_id] || []).push(c);

  container.innerHTML = `
    <div class="tab-head"><h1>Cards</h1></div>
    ${Object.keys(byBank).length ? Object.entries(byBank).map(([bank, list]) => `
      <div class="panel">
        <h2>${(store.config?.banks?.[bank]?.bank_name) || bank}</h2>
        <div class="cards-col">${list.map(cardHtml).join("")}</div>
      </div>`).join("") : `<div class="empty">No cards found</div>`}
  `;

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
}
