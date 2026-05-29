// Settings tab: data status, manual refresh, connection + LLM bridge health.
import { store, loadStore, showToast, formatDate } from "./app.js";
import { API_BASE, LLM_BRIDGE } from "./config.js";

export async function render(container) {
  if (!store.raw) await loadStore();
  const meta = store.raw?.meta || {};
  const rules = store.config?.tags?.learned?.length || 0;

  container.innerHTML = `
    <div class="tab-head"><h1>Settings</h1></div>
    <div class="panel">
      <h2>Data</h2>
      <div class="kv"><span>Transactions</span><b>${store.rows.length}</b></div>
      <div class="kv"><span>Statements</span><b>${store.raw?.statements?.length || 0}</b></div>
      <div class="kv"><span>Instalment plans</span><b>${store.raw?.instalment_plans?.length || 0}</b></div>
      <div class="kv"><span>Learned tag rules</span><b>${rules}</b></div>
      <div class="kv"><span>Last updated</span><b>${meta.last_updated ? formatDate(meta.last_updated) : "—"}</b></div>
      <button id="refresh-btn" class="primary-btn">Refresh from server</button>
    </div>
    <div class="panel">
      <h2>Connection</h2>
      <div class="kv"><span>API</span><b class="mono">${API_BASE}</b></div>
      <div class="kv"><span>LLM bridge</span><b id="bridge-status">checking…</b></div>
      <div class="kv"><span>Bridge URL</span><b class="mono">${LLM_BRIDGE}</b></div>
      <p class="hint">The LLM bridge only works when the dashboard is opened on the PC running <code>python llm_bridge.py</code>.</p>
    </div>
  `;

  document.getElementById("refresh-btn").addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.textContent = "Refreshing…";
    store.raw = null;
    await loadStore();
    showToast("Data refreshed");
    render(container);
  });

  // Probe the local bridge without blocking render.
  checkBridge();
}

async function checkBridge() {
  const el = document.getElementById("bridge-status");
  if (!el) return;
  try {
    const res = await fetch(`${LLM_BRIDGE}/health`, { signal: AbortSignal.timeout(2500) });
    const ok = res.ok && (await res.json()).ok;
    el.textContent = ok ? "🟢 online" : "🔴 unreachable";
  } catch {
    el.textContent = "🔴 offline";
  }
}
