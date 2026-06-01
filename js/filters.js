// Shared search + filter logic over a flat transaction array.
// Pure functions so Transactions / Cash Back / Instalments can all reuse them.

export function searchRows(rows, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((t) => {
    const amount = String(t.amount ?? "");
    return (
      (t.description || "").toLowerCase().includes(q) ||
      (t.merchant || "").toLowerCase().includes(q) ||
      amount.includes(q)
    );
  });
}

// criteria keys: bank, last4, tag, category, statementId, dateFrom, dateTo,
// entryType, minAmount, maxAmount. All optional; combined with AND logic.
export function applyFilters(rows, c = {}) {
  return rows.filter((t) => {
    if (c.bank && t.bank_id !== c.bank) return false;
    if (c.last4 && (t.card?.last4 || "") !== c.last4) return false;
    if (c.tag && t.tag !== c.tag) return false;
    if (c.category && (t.category || t.merchant_category || "") !== c.category) return false;
    if (c.statementId && t.statement_id !== c.statementId) return false;
    if (c.entryType && t.entry_type !== c.entryType) return false;

    const date = t.posting_date || t.transaction_date || "";
    if (c.dateFrom && date < c.dateFrom) return false;
    if (c.dateTo && date > c.dateTo) return false;

    // Amount filters compare absolute magnitude (spend size, ignoring sign).
    const abs = Math.abs(Number(t.amount) || 0);
    if (c.minAmount != null && c.minAmount !== "" && abs < Number(c.minAmount)) return false;
    if (c.maxAmount != null && c.maxAmount !== "" && abs > Number(c.maxAmount)) return false;
    return true;
  });
}

// Distinct option lists for building filter dropdowns from real data.
export function distinct(rows, fn) {
  return [...new Set(rows.map(fn).filter((v) => v != null && v !== ""))].sort();
}
