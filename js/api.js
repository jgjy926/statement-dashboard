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

// data = { bank_id, last4, cycles: ["YYYY-MM"], nil: true|false }
export function setCardNil(data) {
  return request("/card/nil", { method: "POST", body: data });
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
  // Newest first by posting_date (fall back to transaction_date).
  rows.sort((a, b) =>
    (b.posting_date || b.transaction_date || "").localeCompare(
      a.posting_date || a.transaction_date || ""
    )
  );
  return rows;
}

// Current annual-fee anniversary window for a card. `anniversaryMonth` is 1-12
// (the month the fee is charged). Returns the most recent occurrence of that
// month up to today as the window start, +12 months as the end, and whole
// months remaining until the window resets. Dates are ISO "YYYY-MM-DD" so they
// compare lexicographically against txn.posting_date.
export function anniversaryWindow(anniversaryMonth, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-12
  const startYear = m >= anniversaryMonth ? y : y - 1;
  const pad = (n) => String(n).padStart(2, "0");
  const startIso = `${startYear}-${pad(anniversaryMonth)}-01`;
  const endIso = `${startYear + 1}-${pad(anniversaryMonth)}-01`;
  const monthsLeft = (startYear + 1 - y) * 12 + (anniversaryMonth - m);
  return { startIso, endIso, monthsLeft: Math.max(0, monthsLeft) };
}

/* -------------------------------------------------- missing statements */

// Add `n` whole months to an ISO date, clamping the day to the target month's
// length (so a 31st never spills into the next month). Returns a Date.
function addMonthsIso(iso, n) {
  const base = new Date(`${iso.slice(0, 10)}T00:00:00`);
  const day = base.getDate();
  const d = new Date(base.getFullYear(), base.getMonth() + n, 1);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInMonth));
  return d;
}

const toIso = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Statements are monthly, so from a card's newest statement we can project the
// cycles that *should* have arrived by now. Any projected statement date on or
// before today with no matching statement is "missing" (awaited) — unless the
// user has flagged that billing month as no-spend (`nilSet`, a Set of "YYYY-MM"),
// in which case it is settled, not awaited. We infer the month step from the
// median gap between statements and the due-date offset from the median
// (statement → due) span, so each bank's own cadence drives the prediction.
// `entries` = [{ sd, dd }] ISO strings for one card, any order.
//
// Returns null when up to date, else:
//   { status: "awaiting" | "overdue" | "dormant" | "cleared",
//     missing: [{ statement_date, due_date, ym }],  // oldest first, awaited
//     nil:     [{ statement_date, due_date, ym }],  // in-range, no-spend
//     last_statement_date }
// "overdue" = the oldest missing cycle's due date has already passed;
// "dormant" = 3+ cycles awaited (card likely closed) → muted, not urgent;
// "cleared" = nothing awaited but recent cycles were marked no-spend.
export function projectMissingStatements(entries, nilSet = new Set(), now = new Date()) {
  const dated = entries
    .filter((e) => e.sd)
    .map((e) => ({ sd: e.sd.slice(0, 10), dd: e.dd ? e.dd.slice(0, 10) : null }))
    .sort((a, b) => a.sd.localeCompare(b.sd));
  if (!dated.length) return null;

  const gaps = [];
  for (let i = 1; i < dated.length; i++) {
    const days = (new Date(dated[i].sd) - new Date(dated[i - 1].sd)) / 86400000;
    if (days > 0) gaps.push(days);
  }
  const stepMonths = Math.max(1, Math.round((median(gaps) ?? 30.44) / 30.44));

  const offsets = dated
    .filter((e) => e.dd && e.dd > e.sd)
    .map((e) => (new Date(e.dd) - new Date(e.sd)) / 86400000);
  const dueOffsetDays = Math.round(median(offsets) ?? 20);

  const todayIso = toIso(now);
  const lastSd = dated[dated.length - 1].sd;
  const missing = [];
  const nil = [];
  let guard = 0;
  let next = addMonthsIso(lastSd, stepMonths);
  while (toIso(next) <= todayIso && guard < 24) {
    const sdIso = toIso(next);
    const ym = sdIso.slice(0, 7);
    const due = new Date(next);
    due.setDate(due.getDate() + dueOffsetDays);
    const dueIso = toIso(due);
    const cycle = { statement_date: sdIso, due_date: dueIso, ym, overdue: dueIso < todayIso };
    (nilSet.has(ym) ? nil : missing).push(cycle);
    next = addMonthsIso(sdIso, stepMonths);
    guard++;
  }
  if (!missing.length && !nil.length) return null;

  let status;
  if (!missing.length) status = "cleared";
  else if (missing.length >= 3) status = "dormant";
  else status = missing[0].due_date < todayIso ? "overdue" : "awaiting";
  return { status, missing, nil, last_statement_date: lastSd };
}

// One card per (bank_id, last4), enriched with the latest statement's balances.
// Cards come from statements[].cards[] plus the statement's headline card.
export function deriveCards(data) {
  const byKey = new Map();
  const paidStatus = data.paid_status || {};
  const nilStatements = data.nil_statements || {};
  // Per-card statement/due dates, for projecting which cycles are still awaited.
  const stmtDatesByKey = new Map();

  const statements = [...(data.statements || [])].sort((a, b) =>
    (a.statement_date || "").localeCompare(b.statement_date || "")
  );

  for (const stmt of statements) {
    if (stmt.statement_type === "manual") continue; // synthetic bucket, no card
    const cardList = (stmt.cards && stmt.cards.length)
      ? stmt.cards
      : [{ last4: stmt.card_last4, network: stmt.card_network, name: stmt.card_id }];

    // The statement's headline balances belong to its primary card (card_last4).
    // If that number matches no card in the list (e.g. a mis-detected header),
    // the figures would be orphaned and vanish from the UI — so fall back to the
    // first non-supplementary card as the primary.
    const hasPrimary = cardList.some((c) => c.last4 === stmt.card_last4);
    const fallbackPrimary = hasPrimary
      ? stmt.card_last4
      : (cardList.find((c) => !c.is_supplementary) || cardList[0] || {}).last4;

    for (const c of cardList) {
      if (!c.last4) continue;
      const key = `${stmt.bank_id}:${c.last4}`;
      const isPrimary = c.last4 === fallbackPrimary;
      // Track this card's statement cadence for missing-cycle projection.
      (stmtDatesByKey.get(key) || stmtDatesByKey.set(key, []).get(key)).push({
        sd: stmt.statement_date,
        dd: stmt.due_date,
      });
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
        // Bank-printed sub-total for this card this statement (newest wins).
        period_subtotal: c.period_subtotal ?? prev.period_subtotal,
        // Which statement this card's current due belongs to (for the paid flag).
        due_statement_id: isPrimary ? stmt.statement_id : prev.due_statement_id,
        // Newest statement ANY card appears in — keys the per-card paid flag so
        // every (non-supp) card, not just the statement primary, can be toggled.
        cycle_statement_id: stmt.statement_id,
        // Annual-fee waiver (sweep) settings, stamped per card by the parser.
        anniversary_month: c.anniversary_month ?? prev.anniversary_month,
        required_swipes: c.required_swipes ?? prev.required_swipes,
        min_swipe_amount: c.min_swipe_amount ?? prev.min_swipe_amount,
      });
    }
  }

  // Manual-only cards: the synthetic manual bucket has no statement-level card,
  // but each manual txn carries its own card. Surface those so a manually-tracked
  // card (e.g. a debit card with no parsed statement) still appears in the Cards
  // tab and the Add form's card picker. Skip any card already seen in a statement.
  for (const stmt of statements) {
    if (stmt.statement_type !== "manual") continue;
    for (const t of stmt.transactions || []) {
      const l4 = t.card?.last4;
      const bank = t.bank_id || stmt.bank_id;
      if (!l4 || !bank) continue;
      const key = `${bank}:${l4}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        bank_id: bank,
        last4: l4,
        network: t.card?.network || null,
        name: t.card?.name || l4,
        is_supplementary: false,
        manual_only: true,
      });
    }
  }

  // Per-cycle anniversary window for cards that track a fee waiver, keyed the
  // same way as spendByKey so the txn loop below can tally swipes in one pass.
  const windowByKey = {};
  for (const [key, c] of byKey) {
    if (c.anniversary_month && c.required_swipes) {
      windowByKey[key] = anniversaryWindow(c.anniversary_month);
    }
  }

  // Per-card spend for the CURRENT cycle (the newest statement the card appears
  // in — its cycle_statement_id) and qualifying swipe count for the annual-fee
  // waiver. "Spent" is the computed twin of the bank-printed period_subtotal:
  // one statement's debits, NOT an all-time running total across every cycle.
  // Consolidated statements carry one shared due/limit on the primary card, so
  // this per-card figure is the only meaningful spend for supps. Manual-only
  // cards have no statement cycle, so they fall back to summing all their debits.
  const spendByKey = {};
  const sweepByKey = {};
  for (const stmt of data.statements || []) {
    for (const t of stmt.transactions || []) {
      const l4 = t.card?.last4 || stmt.card_last4;
      if (!l4) continue;
      const amt = Number(t.amount) || 0;
      if (amt >= 0) continue; // debits only
      const key = `${t.bank_id || stmt.bank_id}:${l4}`;
      const card = byKey.get(key);
      if (!card || !card.cycle_statement_id || stmt.statement_id === card.cycle_statement_id) {
        spendByKey[key] = (spendByKey[key] || 0) + Math.abs(amt);
      }

      // A "swipe" = a debit inside the card's current anniversary window that
      // clears any minimum-per-transaction the bank requires.
      const win = windowByKey[key];
      if (win) {
        const d = t.posting_date || t.transaction_date || "";
        const min = byKey.get(key).min_swipe_amount || 0;
        if (d >= win.startIso && d < win.endIso && Math.abs(amt) >= min) {
          sweepByKey[key] = (sweepByKey[key] || 0) + 1;
        }
      }
    }
  }

  // Attach the per-cycle paid flag (key = "<cycle_statement_id>:<last4>") and
  // sweep progress.
  const cards = [...byKey.values()];
  for (const c of cards) {
    const pk = `${c.cycle_statement_id}:${c.last4}`;
    c.paid = !!(paidStatus[pk] && paidStatus[pk].paid);
    c.spend = spendByKey[`${c.bank_id}:${c.last4}`] || 0;
    if (c.required_swipes) {
      const key = `${c.bank_id}:${c.last4}`;
      c.sweeps = sweepByKey[key] || 0;
      c.sweeps_pending = Math.max(0, c.required_swipes - c.sweeps);
      c.months_left = windowByKey[key] ? windowByKey[key].monthsLeft : null;
    }
    // Which statement cycles this card is still awaiting. Supplementary cards
    // ride the primary's consolidated bill, so only flag the primary to avoid
    // duplicate warnings within a bank; manual-only cards have no cadence.
    if (!c.is_supplementary && !c.manual_only) {
      const prefix = `${c.bank_id}:${c.last4}:`;
      const nilSet = new Set(
        Object.keys(nilStatements)
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length))
      );
      c.stmt_watch = projectMissingStatements(
        stmtDatesByKey.get(`${c.bank_id}:${c.last4}`) || [],
        nilSet
      );
    }
  }
  return cards;
}
