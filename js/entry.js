// Manual Entry tab: add a transaction → POST /entry.
import { store, loadStore, showToast } from "./app.js";
import { postManualEntry, deriveCards } from "./api.js";

// Credit tags store a positive amount; everything else is spend (negative).
// Matches the parser's convention (see transaction_parser.py).
const CREDIT_TAGS = new Set(["Cash Back", "Payment", "Refund"]);

function signedAmount(tag, magnitude) {
  const m = Math.abs(Number(magnitude) || 0);
  return CREDIT_TAGS.has(tag) ? m : -m;
}

export async function render(container) {
  if (!store.raw) await loadStore();

  const cards = deriveCards(store.raw);
  const banks = [...new Set(cards.map((c) => c.bank_id))];
  const tags = store.config?.tags?.fixed || [];
  const cats = [...new Set(store.rows.map((t) => t.category || t.merchant_category).filter(Boolean))].sort();
  const today = new Date().toISOString().slice(0, 10);

  const bankOpts = banks.map((b) =>
    `<option value="${b}">${store.config?.banks?.[b]?.bank_name || b}</option>`).join("");
  const tagOpts = tags.map((t) => `<option value="${t}">${t}</option>`).join("");

  container.innerHTML = `
    <div class="tab-head"><h1>Add transaction</h1></div>
    <form id="entry-form" class="form">
      <label>Date *<input type="date" id="m-date" value="${today}" required></label>
      <label>Bank *<select id="m-bank" required><option value="">Select…</option>${bankOpts}</select></label>
      <label>Card *<select id="m-card" required><option value="">Select bank first</option></select></label>
      <div id="new-card-fields" hidden>
        <label>New card name *<input id="m-newname" placeholder="e.g. PB UTAR Debit"></label>
        <label>Last 4 digits *<input id="m-newlast4" maxlength="4" inputmode="numeric" placeholder="1234"></label>
        <label>Network<input id="m-newnet" placeholder="e.g. Mastercard"></label>
      </div>
      <label>Description *<input id="m-desc" required></label>
      <label>Amount (RM) *<input type="number" step="0.01" min="0" id="m-amt" required></label>
      <label>Tag *<select id="m-tag" required><option value="">Select…</option>${tagOpts}</select></label>
      <label>Category<input id="m-cat" list="cat-list"><datalist id="cat-list">${
        cats.map((c) => `<option value="${c}">`).join("")}</datalist></label>

      <details class="adv"><summary>Foreign currency (optional)</summary>
        <label>Original amount<input type="number" step="0.01" id="m-oamt"></label>
        <label>Original currency<input id="m-ocur" placeholder="e.g. USD"></label>
        <label>Exchange rate<input type="number" step="0.000001" id="m-rate" readonly></label>
      </details>

      <label>Notes<textarea id="m-notes"></textarea></label>
      <div class="form-actions"><button type="submit" class="primary-btn">Save entry</button></div>
    </form>
  `;

  const bankSel = document.getElementById("m-bank");
  const cardSel = document.getElementById("m-card");
  const newCardFields = document.getElementById("new-card-fields");

  // Sentinel value for the "add a card that has no parsed statement yet" option.
  const NEW_CARD = "__new__";

  function toggleNewCard() {
    newCardFields.hidden = cardSel.value !== NEW_CARD;
  }

  function refreshCards() {
    const list = cards.filter((c) => c.bank_id === bankSel.value);
    const opts = list
      .map((c) => `<option value="${c.last4}">${c.name || c.last4} ••${c.last4} (${c.network || "?"})</option>`)
      .join("");
    cardSel.innerHTML = (bankSel.value ? opts : "") + `<option value="${NEW_CARD}">+ Add new card…</option>`;
    toggleNewCard();
  }
  bankSel.addEventListener("change", refreshCards);
  cardSel.addEventListener("change", toggleNewCard);

  // Auto-calc exchange rate when both amount and original amount are present.
  const recalcRate = () => {
    const amt = parseFloat(document.getElementById("m-amt").value);
    const oamt = parseFloat(document.getElementById("m-oamt").value);
    const rateEl = document.getElementById("m-rate");
    rateEl.value = amt > 0 && oamt > 0 ? (amt / oamt).toFixed(6) : "";
  };
  document.getElementById("m-amt").addEventListener("input", recalcRate);
  document.getElementById("m-oamt").addEventListener("input", recalcRate);

  document.getElementById("entry-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submit(cards, container);
  });
}

async function submit(cards, container) {
  const val = (id) => document.getElementById(id).value.trim();
  const required = { "m-date": "Date", "m-bank": "Bank", "m-card": "Card", "m-desc": "Description", "m-amt": "Amount", "m-tag": "Tag" };
  for (const [id, label] of Object.entries(required)) {
    if (!val(id)) { showToast(`${label} is required`, "error"); return; }
  }

  const bank = val("m-bank");
  const tag = val("m-tag");

  // Resolve the card: either an existing one (picked by last4) or a brand-new
  // one typed into the new-card fields (for a card with no parsed statement).
  let last4, cardInfo;
  if (val("m-card") === "__new__") {
    const name = val("m-newname");
    last4 = val("m-newlast4");
    if (!name) { showToast("New card name is required", "error"); return; }
    if (!/^\d{4}$/.test(last4)) { showToast("Last 4 digits must be 4 numbers", "error"); return; }
    cardInfo = { last4, network: val("m-newnet") || null, name };
  } else {
    last4 = val("m-card");
    const card = cards.find((c) => c.bank_id === bank && c.last4 === last4);
    cardInfo = { last4, network: card?.network || null, name: card?.name || null };
  }

  const payload = {
    date: val("m-date"),
    bank_id: bank,
    card: cardInfo,
    description: val("m-desc"),
    amount: signedAmount(tag, val("m-amt")),
    currency: "MYR",
    tag,
    category: val("m-cat") || null,
    notes: val("m-notes") || "",
    original_amount: parseFloat(val("m-oamt")) || null,
    original_currency: val("m-ocur") || null,
    exchange_rate: parseFloat(val("m-rate")) || null,
  };

  const btn = container.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await postManualEntry(payload);
    store.raw = null;
    await loadStore();
    showToast("Entry saved");
    render(container); // clears the form
  } catch {
    btn.disabled = false; btn.textContent = "Save entry";
  }
}
