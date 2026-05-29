// All Worker calls live here. The dashboard never touches Koofr directly.
import { API_BASE, AUTH_SECRET } from "./config.js";
import { showToast } from "./app.js";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Single shared request helper: injects auth, encodes/decodes JSON, checks ok,
// and surfaces any failure as an error toast (never fails silently).
async function request(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${AUTH_SECRET}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    showToast(`Network error: ${networkErr.message}`, "error");
    throw new ApiError(networkErr.message, 0);
  }

  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // non-JSON body; leave payload null
    }
  }

  if (!res.ok) {
    const msg = (payload && payload.error) || `Request failed (HTTP ${res.status})`;
    showToast(msg, "error");
    throw new ApiError(msg, res.status);
  }
  return payload;
}

/* ----------------------------------------------------------------- reads */

// Returns the raw transactions.json: { meta, instalment_plans, statements }.
export function fetchData() {
  return request("/data");
}

export function fetchConfig() {
  return request("/config"); // { tags, banks }
}

export function fetchMerchants() {
  return request("/merchants"); // { meta, merchants }
}

export function fetchInstalmentPlans() {
  return request("/instalment/plans"); // []
}

/* ---------------------------------------------------------------- writes */

export function postManualEntry(data) {
  return request("/entry", { method: "POST", body: data });
}

export function updateTransaction(data) {
  return request("/update", { method: "POST", body: data });
}

export function createInstalmentPlan(data) {
  return request("/instalment/create", { method: "POST", body: data });
}

export function updateInstalmentPlan(data) {
  return request("/instalment/update", { method: "POST", body: data });
}

export function deleteInstalmentPlan(id) {
  return request("/instalment/delete", { method: "POST", body: { id } });
}

export function setCardPaid(data) {
  return request("/card/paid", { method: "POST", body: data });
}

export function saveMerchantRule(data) {
  return request("/merchant/rule", { method: "POST", body: data });
}

export function deleteMerchantRule(keyword) {
  return request("/merchant/delete", { method: "POST", body: { keyword } });
}

/* ------------------------------------------------------- derived helpers */

// The stored shape nests transactions under statements[]. The dashboard works
// with a flat list, so we attach statement context to every row and keep the
// transaction's own keys untouched (no renaming).
export function flattenTransactions(data) {
  const rows = [];
  for (const stmt of data.statements || []) {
    for (const txn of stmt.transactions || []) {
      rows.push({
        ...txn,
        bank_id: txn.bank_id || stmt.bank_id,
        statement_id: stmt.statement_id,
        statement_date: stmt.statement_date || null,
        // card object is on the txn; fall back to statement-level fields.
        card: txn.card || {
          last4: stmt.card_last4,
          network: stmt.card_network,
        },
      });
    }
  }
  // Newest first by transaction_date (fall back to posting_date).
  rows.sort((a, b) =>
    (b.transaction_date || b.posting_date || "").localeCompare(
      a.transaction_date || a.posting_date || ""
    )
  );
  return rows;
}

// One card per (bank_id, last4), enriched with the latest statement's balances.
// Cards come from statements[].cards[] plus the statement's headline card.
export function deriveCards(data) {
  const byKey = new Map();
  const paidStatus = data.paid_status || {};

  const statements = [...(data.statements || [])].sort((a, b) =>
    (a.statement_date || "").localeCompare(b.statement_date || "")
  );

  for (const stmt of statements) {
    if (stmt.statement_type === "manual") continue; // synthetic bucket, no card
    const cardList = (stmt.cards && stmt.cards.length)
      ? stmt.cards
      : [{ last4: stmt.card_last4, network: stmt.card_network, name: stmt.card_id }];

    for (const c of cardList) {
      if (!c.last4) continue;
      const key = `${stmt.bank_id}:${c.last4}`;
      const isPrimary = c.last4 === stmt.card_last4;
      // Later (newer) statements overwrite, so the freshest balances win.
      const prev = byKey.get(key) || {};
      byKey.set(key, {
        bank_id: stmt.bank_id,
        last4: c.last4,
        network: c.network,
        name: c.name || prev.name,
        is_supplementary: c.is_supplementary ?? prev.is_supplementary ?? false,
        // Statement-level balances apply to the primary card of that statement.
        credit_limit: isPrimary ? stmt.credit_limit : prev.credit_limit,
        closing_balance: isPrimary ? stmt.closing_balance : prev.closing_balance,
        due_date: isPrimary ? stmt.due_date : prev.due_date,
        due_amount: isPrimary ? stmt.due_amount : prev.due_amount,
        minimum_payment: isPrimary ? stmt.minimum_payment : prev.minimum_payment,
        // Which statement this card's current due belongs to (for the paid flag).
        due_statement_id: isPrimary ? stmt.statement_id : prev.due_statement_id,
      });
    }
  }

  // Attach the per-cycle paid flag (key = "<due_statement_id>:<last4>").
  const cards = [...byKey.values()];
  for (const c of cards) {
    const pk = `${c.due_statement_id}:${c.last4}`;
    c.paid = !!(paidStatus[pk] && paidStatus[pk].paid);
  }
  return cards;
}
