// Worker connection. API_BASE has no trailing slash.
//
// SECURITY: this file is public on GitHub Pages — anyone can read AUTH_SECRET.
// It is obfuscation only, not a real secret (see worker/README.md). Koofr
// credentials are NOT here; they live only in the Worker's env.
export const API_BASE = "https://statement-parser-api.jgjy926.workers.dev";
export const AUTH_SECRET = "thefirstever99dayscreatedashboard";

// Local LLM bridge (python llm_bridge.py). Only reachable when the dashboard
// is opened on the same PC; the Merchants tab degrades gracefully if it's down.
export const LLM_BRIDGE = "http://localhost:5057";
