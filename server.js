/*
 * CPL-2 Scheduler server.
 * Serves the web app from ./public and a small JSON API that keeps
 * settings, the stock file and the saved orders the same on every device.
 */
require("dotenv").config();
const express = require("express");
const path = require("path");
const { createStore } = require("./src/store");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // if set, saving needs this key

async function main() {
  const store = await createStore();
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  // Only people with the editor key can change shared data (when ADMIN_KEY is set).
  const canWrite = (req, res, next) => {
    if (!ADMIN_KEY || req.get("x-admin-key") === ADMIN_KEY) return next();
    res.status(401).json({ error: "Editor key missing or wrong" });
  };

  app.get("/api/health", (req, res) => res.json({ ok: true, store: store.kind }));

  // Everything the page needs in one call. The page polls this to pick up changes.
  app.get("/api/state", async (req, res, next) => {
    try {
      const all = await store.getAll();
      res.json({ requiresKey: !!ADMIN_KEY, state: all });
    } catch (e) { next(e); }
  });

  app.put("/api/settings", canWrite, async (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== "object") return res.status(400).json({ error: "Settings must be an object" });
      res.json(await store.put("settings", req.body));
    } catch (e) { next(e); }
  });

  app.put("/api/stock", canWrite, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!Array.isArray(b.cols) || !Array.isArray(b.rows)) return res.status(400).json({ error: "Stock needs cols and rows" });
      res.json(await store.put("stock", { name: String(b.name || "stock"), cols: b.cols, rows: b.rows }));
    } catch (e) { next(e); }
  });

  app.put("/api/plan/:group", canWrite, async (req, res, next) => {
    try {
      const g = req.params.group;
      if (g !== "HR" && g !== "NGO") return res.status(400).json({ error: "Group must be HR or NGO" });
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : [];
      res.json(await store.put("plan-" + g, { ids }));
    } catch (e) { next(e); }
  });

  app.use(express.static(path.join(__dirname, "public")));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  });

  app.listen(PORT, () => console.log(`CPL-2 Scheduler on http://localhost:${PORT} (storage: ${store.kind})`));
}

main().catch(e => { console.error("Could not start:", e.message); process.exit(1); });
