// Android (Capacitor) app glue. A no-op in the browser.
//
// - Hardware Back closes the open bottom sheet, then returns to Overview, then
//   backgrounds the app (never kills it).
// - Coming back to the app after a while re-reads the Worker, so numbers from a
//   statement parsed on the PC in the meantime show up without pull-to-refresh.
import { closeSheet } from "./app.js";

const RESUME_REFRESH_MS = 2 * 60 * 1000;

function nativeApp() {
  const cap = window.Capacitor;
  return cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform() ? cap : null;
}

export function initMobile(reload) {
  const cap = nativeApp();
  const App = cap && cap.Plugins && cap.Plugins.App;
  if (!App) return;
  document.documentElement.classList.add("native-app");

  let hiddenAt = 0;
  App.addListener("appStateChange", ({ isActive }) => {
    if (!isActive) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > RESUME_REFRESH_MS) reload();
  });

  App.addListener("backButton", () => {
    if (document.getElementById("sheet")?.classList.contains("show")) return closeSheet();
    const tab = (location.hash || "#overview").replace(/^#/, "");
    if (tab !== "overview") { location.hash = "#overview"; return; }
    App.minimizeApp();
  });
}
