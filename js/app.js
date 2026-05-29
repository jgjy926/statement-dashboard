// App shell: shared conventions, components, tab routing, init.
import { fetchData, fetchConfig, flattenTransactions } from "./api.js";

import * as overview from "./overview.js";
import * as transactions from "./transactions.js";
import * as cards from "./cards.js";
import * as entry from "./entry.js";
import * as merchants from "./merchants.js";
import * as cashback from "./cashback.js";
import * as instalments from "./instalments.js";
import * as settings from "./settings.js";

/* ----------------------------------------------- §2 shared conventions */

// Tag → color (matches app.css CSS vars; keep both in sync).
export const TAG_COLORS = {
  Expenses: "#1a73e8",
  "Cash Back": "#34a853",
  Payment: "#00897b",
  Refund: "#fb8c00",
  Fees: "#e53935",
  Instalment: "#8e24aa",
  "Balance Transfer": "#f9a825",
};

// entry_type → badge (text shown next to the icon; automated shows nothing).
export const ENTRY_BADGES = {
  automated: null,
  manual: { icon: "🖊️", label: "manual" },
  adjusted: { icon: "✏️", label: "adjusted" },
};

export function formatMYR(amount) {
  const n = Number(amount) || 0;
  const sign = n < 0 ? "-" : "";
  return `${sign}RM ${Math.abs(n).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function tagChip(tag) {
  if (!tag) return "";
  const color = TAG_COLORS[tag] || "#5f6368";
  return `<span class="chip" style="--chip:${color}">${tag}</span>`;
}

export function entryBadge(entryType) {
  const b = ENTRY_BADGES[entryType];
  if (!b) return "";
  return `<span class="badge" title="${b.label}">${b.icon}</span>`;
}

/* ------------------------------------------------------- shared store */
// Cache the Worker responses so tabs don't each refetch. Call refresh() to
// reload from the Worker (used by pull-to-refresh and Settings sync).
export const store = {
  raw: null, // /data response
  rows: [], // flattened transactions
  config: null, // /config response
};

export async function loadStore() {
  const [raw, config] = await Promise.all([fetchData(), fetchConfig()]);
  store.raw = raw;
  store.rows = flattenTransactions(raw);
  store.config = config;
  return store;
}

/* ----------------------------------------------- shared components */

let toastTimer = null;
export function showToast(message, variant = "success") {
  const host = document.getElementById("toast");
  if (!host) return;
  host.textContent = message;
  host.className = `toast show ${variant}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (host.className = "toast"), 3200);
}

export function skeleton(lines = 5) {
  const items = Array.from({ length: lines }, () => `<div class="skel-row"></div>`).join("");
  return `<div class="skeleton">${items}</div>`;
}

// Bottom sheet: slide-up panel for detail/edit views.
export function openSheet(contentNode) {
  const overlay = document.getElementById("sheet-overlay");
  const sheet = document.getElementById("sheet");
  sheet.innerHTML = "";
  sheet.appendChild(contentNode);
  overlay.classList.add("show");
  sheet.classList.add("show");
}
export function closeSheet() {
  document.getElementById("sheet-overlay").classList.remove("show");
  document.getElementById("sheet").classList.remove("show");
}

/* --------------------------------------------------------- routing */

const TABS = {
  overview: { mod: overview, label: "Overview" },
  cards: { mod: cards, label: "Cards" },
  transactions: { mod: transactions, label: "Transactions" },
  add: { mod: entry, label: "Add" },
  merchants: { mod: merchants, label: "Merchants" },
  cashback: { mod: cashback, label: "Cash Back" },
  instalments: { mod: instalments, label: "Instalments" },
  settings: { mod: settings, label: "Settings" },
};

let currentTab = null;

function currentRoute() {
  const hash = (location.hash || "#overview").replace(/^#/, "");
  return TABS[hash] ? hash : "overview";
}

async function renderRoute() {
  const name = currentRoute();
  currentTab = name;
  const main = document.getElementById("view");

  // Highlight active nav button.
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });

  main.innerHTML = skeleton(6);
  try {
    await TABS[name].mod.render(main);
  } catch (err) {
    main.innerHTML = `<div class="empty">Could not load this tab.<br><small>${err.message}</small></div>`;
  }
}

// Pull-to-refresh: drag down at scrollTop===0 to reload the current tab.
function wirePullToRefresh() {
  const view = document.getElementById("view");
  let startY = null;
  const indicator = document.getElementById("ptr");

  view.addEventListener("touchstart", (e) => {
    startY = view.scrollTop <= 0 ? e.touches[0].clientY : null;
  }, { passive: true });

  view.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) indicator.style.height = `${Math.min(dy / 2, 56)}px`;
  }, { passive: true });

  view.addEventListener("touchend", async (e) => {
    if (startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;
    indicator.style.height = "0px";
    startY = null;
    if (dy > 90) {
      store.raw = null; // force reload
      await renderRoute();
      showToast("Refreshed");
    }
  });
}

function init() {
  // Build nav.
  const nav = document.getElementById("nav");
  const icons = {
    overview: "📊", cards: "💳", transactions: "📋", add: "➕",
    merchants: "🏷️", cashback: "💰", instalments: "📅", settings: "⚙️",
  };
  nav.innerHTML = Object.entries(TABS)
    .map(([k, t]) =>
      `<a class="nav-btn" data-tab="${k}" href="#${k}"><span class="nav-ico">${icons[k]}</span><span class="nav-lbl">${t.label}</span></a>`
    )
    .join("");

  document.getElementById("sheet-overlay").addEventListener("click", closeSheet);
  window.addEventListener("hashchange", renderRoute);
  wirePullToRefresh();
  renderRoute();
}

document.addEventListener("DOMContentLoaded", init);
