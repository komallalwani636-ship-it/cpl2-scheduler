/*
 * CPL-2 Scheduler — Step Wizard UI with Inline Report Filters & MongoDB Atlas Sync
 * Uses window.Rules (rules.js) for all scheduling decisions.
 * Steps: 1=Upload, 2=Settings, 3=HR Schedule & Filters, 4=NGO FP & Filters, 5=Download & History
 */
const R = window.Rules;
const { S, N, GR, SI, DEFAULTS, grpOf, gradeOf } = R;
const SAMPLE_NAME = "CPL2_HR_STOCK_FOR_SCHEDULING.xls";
const KEEP = ["HR Coil No", "Thk", "Wdt", "Wgt", "Age Hours", "Status", "Cust", "Tdc", "Product", "Act Path", "Prev Unit", "Order_status",
  "Receiving Remarks", "Ord Crgrade", "Silicon %", "Routing", "Edge Condth", "Next Work Center", "Coil Saddle Loc"];
const POLL_MS = 15000;
const STEPS = [1, 2, 3, 4, 5];

const $ = s => document.querySelector(s);
const esc = s => S(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = v => (v == null ? "—" : String(Math.round(v * 100) / 100));
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};

/* ---------- state ---------- */
let set = R.withDefaults(ls.get("cpl2.settings"));
let stock = ls.get("cpl2.stock");
let orders = ls.get("cpl2.orders") || { HR: [], NGO: [] };
let rows = [], res = { plan: [], apl: [], steps: [], HR: [], NGO: [] };
const hideHeld = { HR: false, NGO: false };
let online = false, storeKind = "file", requiresKey = false, editorKey = ls.get("cpl2.key") || "";
let versions = ls.get("cpl2.versions") || {};
let events = ls.get("cpl2.events") || [];
let seen = ls.get("cpl2.seen") || {};
let alerts = [], lastN = {}, booted = false;
let currentStep = 1;

// Filter state for the report pages (Step 3 & 4)
const repState = {
  HR: { search: "", status: "ALL", onlyIssues: false, openRules: false },
  NGO: { search: "", status: "ALL", onlyIssues: false, openRules: false }
};

/* ---------- server API ---------- */
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" }, editorKey ? { "x-admin-key": editorKey } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 401) { const e = new Error("key"); e.code = 401; throw e; }
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function saveRemote(key, url, body) {
  try {
    const doc = await api("PUT", url, body);
    versions[key] = doc.updatedAt; ls.set("cpl2.versions", versions);
    online = true; setSync(); return true;
  } catch (e) {
    if (e.code === 401) toast("Enter the editor key in Settings to save changes for everyone.");
    else { online = false; setSync(); }
    return false;
  }
}

/* ---------- step navigation ---------- */
function goStep(n) {
  n = Math.max(1, Math.min(5, +n));
  currentStep = n;
  STEPS.forEach(s => {
    const p = $("#p-" + s); if (p) p.hidden = s !== n;
  });
  document.querySelectorAll(".step-btn").forEach(b => {
    const s = +b.dataset.step;
    b.removeAttribute("aria-current");
    b.classList.remove("done");
    if (s === n) b.setAttribute("aria-current", "step");
    else if (s < n) b.classList.add("done");
  });
  ls.set("cpl2.step", n);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (n === 2) renderSettings();
  if (n === 3) renderSched("HR");
  if (n === 4) renderSched("NGO");
  if (n === 5) { renderHistory(); updateDlDescriptions(); renderNotifChecks(); }
}

document.querySelectorAll(".step-btn").forEach(b => {
  b.onclick = () => goStep(+b.dataset.step);
});
document.addEventListener("click", e => {
  const g = e.target.closest("[data-goto]");
  if (g) goStep(+g.dataset.goto);
});

/* ---------- pipeline ---------- */
function run() {
  res = R.runPipeline(rows, set);
  renderPrep(); renderSched("HR"); renderSched("NGO"); buildAlerts();
}
function ordered(g) {
  const list = res[g];
  const by = new Map(list.map(o => [S(o["HR Coil No"]), o]));
  const out = [], used = new Set();
  for (const id of orders[g] || []) { const o = by.get(id); if (o && !used.has(id)) { out.push(o); used.add(id); } }
  for (const o of list) { const id = S(o["HR Coil No"]); if (!used.has(id)) { out.push(o); used.add(id); } }
  return out;
}

/* ---------- schedule & report rendering (Step 3 & 4) ---------- */
function renderSched(g) {
  const rootId = g === "HR" ? "p-hr-content" : "p-ngo-content";
  const root = $("#" + rootId);
  if (!root) return;
  const isHR = g === "HR";
  const full = ordered(g);
  const ev = R.evaluate(g, full, set);
  const isHeld = o => R.isHeld(o, set);

  // Available statuses in this group
  const statuses = ["ALL", ...new Set(full.map(o => S(o.Status).toUpperCase()).filter(Boolean))].sort();

  // Search and filter criteria
  const q = (repState[g].search || "").trim().toLowerCase();
  const st = repState[g].status || "ALL";
  const onlyIss = repState[g].onlyIssues;

  const vis = ev.filter(e => {
    const o = e.o;
    if (hideHeld[g] && isHeld(o)) return false;
    if (st !== "ALL" && S(o.Status).toUpperCase() !== st) return false;
    if (onlyIss && !e.iss.some(x => x[0] === "bad" || x[0] === "warn")) return false;
    if (q) {
      const text = [o["HR Coil No"], o.Cust, gradeOf(o), o.Status, o.Product, o.Heat].map(S).join(" ").toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });

  const sm = R.summary(ev);
  const ton = ev.reduce((t, e) => t + (isHeld(e.o) ? 0 : N(e.o.Wgt) || 0), 0);
  const countEl = isHR ? $("#cHR") : $("#cNGO");
  if (countEl) countEl.textContent = `${vis.length} / ${full.length}`;

  const applied = isHR
    ? [`Thinner (< ${set.thickFrom} mm): jump ≤ ${set.thinJump} mm, width ≤ ${set.thinWidth} mm`,
      `Thicker (≥ ${set.thickFrom} mm): jump ≤ ${set.thickJump} mm, width ≤ ${set.thickWidth} mm`,
      `Critical TDC above ${set.critThk} mm not back to back`]
    : [`Width jump ≤ ${set.ngoWidth} mm`, "Silicon grade welding matrix",
      set.ngoThk != null ? `Thickness jump ≤ ${set.ngoThk} mm` : "Thickness jump not checked"];
  applied.push(`Age > ${set.ageMin} h`);
  if (set.sameThk) applied.push("Same thickness together");

  const body = vis.map((e, i) => {
    const o = e.o;
    const bad = e.iss.some(x => x[0] === "bad"), warn = e.iss.some(x => x[0] === "warn"), h = isHeld(o);
    const cls = h ? "held" : bad ? "bad" : warn ? "warn" : "ok";
    const pill = h ? `<span class="pill info">Held</span>` : bad ? `<span class="pill bad">Rule Break</span>` :
      warn ? `<span class="pill warn">Check</span>` : `<span class="pill ok">${i ? "OK" : "First coil"}</span>`;
    const tc = e.iss.some(x => x[2] === "t" && x[0] === "bad") ? "b" : "";
    const wc = e.iss.some(x => x[2] === "w" && x[0] === "bad") ? "b" : e.iss.some(x => x[2] === "w") ? "w" : "";
    let grpRow = "";
    const prevV = i ? vis[i - 1].o : null;
    if (set.sameThk && (!prevV || R.thkKey(prevV) !== R.thkKey(o))) {
      let n = 0, w = 0;
      for (let j = i; j < vis.length && R.thkKey(vis[j].o) === R.thkKey(o); j++) { n++; w += N(vis[j].o.Wgt) || 0; }
      grpRow = `<tr class="grp"><td colspan="15"><b>${R.thkKey(o)} mm</b><span>${n} coil${n > 1 ? "s" : ""} · ${f2(w)} t</span></td></tr>`;
    }
    return `${grpRow}<tr class="${cls}"><td class="n">${i + 1}</td>
      <td><span class="mv"><button data-g="${g}" data-mv="-1" data-i="${i}" aria-label="Move up">↑</button>
        <button data-g="${g}" data-mv="1" data-i="${i}" aria-label="Move down">↓</button></span></td>
      <td class="mono">${esc(o["HR Coil No"])}</td>${isHR ? `<td>${esc(o.Product)}</td>` : ""}
      <td class="n">${f2(N(o.Thk))}</td><td class="n">${N(o.Wdt) ?? "—"}</td>
      <td class="n dv ${tc}">${e.dt == null ? "" : f2(e.dt)}</td><td class="n dv ${wc}">${e.dw == null ? "" : e.dw}</td>
      <td class="n">${f2(N(o.Wgt))}</td><td class="n">${N(o["Age Hours"]) ?? "—"}</td>
      <td class="mono">${esc(gradeOf(o))}</td>${isHR ? "" : `<td class="n">${f2(N(o["Silicon %"]))}</td>`}
      <td class="cust" title="${esc(o.Cust)}">${esc(o.Cust)}</td><td>${esc(o.Status)}</td>
      <td><div class="why">${pill}${e.iss.map(x => `<span>${esc(x[1])}</span>`).join("")}</div></td></tr>`;
  }).join("");

  const inlineRulesHTML = repState[g].openRules ? `
    <div class="inline-rules-card" id="rules-card-${g}">
      <div class="inline-rules-hd">
        <span>⚙ Inline Rules &amp; Filter Limits for ${isHR ? "HRPO / HRSPO" : "NGO FP"}</span>
        <span style="display:flex;gap:8px;align-items:center">
          <span class="muted" style="font-size:.8rem;font-weight:normal" id="inline-saved-${g}">Saved to MongoDB Atlas ✓</span>
          <button class="btn" data-act="close-rules" data-g="${g}" style="padding:2px 8px;font-size:.76rem">✕ Close</button>
        </span>
      </div>
      <div class="fields">
        ${isHR ? `
          <div class="field"><label>Thicker gauge jump (mm)</label>
            <div class="inp"><input type="number" step="0.05" data-rk="thickJump" data-rg="${g}" value="${set.thickJump}"><span>mm</span></div>
            <small>Deck: 1 mm in 2–6 mm</small></div>
          <div class="field"><label>Thinner gauge jump (mm)</label>
            <div class="inp"><input type="number" step="0.05" data-rk="thinJump" data-rg="${g}" value="${set.thinJump}"><span>mm</span></div>
            <small>Deck: 0.5 mm below 2 mm</small></div>
          <div class="field"><label>Thicker begins at (mm)</label>
            <div class="inp"><input type="number" step="0.1" data-rk="thickFrom" data-rg="${g}" value="${set.thickFrom}"><span>mm</span></div>
            <small>Coils from this thickness up</small></div>
          <div class="field"><label>Thinner width change (mm)</label>
            <div class="inp"><input type="number" step="5" data-rk="thinWidth" data-rg="${g}" value="${set.thinWidth}"><span>mm</span></div>
            <small>Deck: 150 mm &lt; 2.0 mm</small></div>
          <div class="field"><label>Thicker width change (mm)</label>
            <div class="inp"><input type="number" step="5" data-rk="thickWidth" data-rg="${g}" value="${set.thickWidth}"><span>mm</span></div>
            <small>Deck: 250–300 mm</small></div>
          <div class="field"><label>Minimum age (hours)</label>
            <div class="inp"><input type="number" step="1" data-rk="ageMin" data-rg="${g}" value="${set.ageMin}"><span>h</span></div>
            <small>Deck: &gt; 72 h</small></div>
          <div class="field"><label>Thinnest coil (mm)</label>
            <div class="inp"><input type="number" step="0.1" data-rk="thkMin" data-rg="${g}" value="${set.thkMin}"><span>mm</span></div>
            <small>Deck: 1.6 mm</small></div>
          <div class="field"><label>Thickest coil (mm)</label>
            <div class="inp"><input type="number" step="0.1" data-rk="thkMax" data-rg="${g}" value="${set.thkMax}"><span>mm</span></div>
            <small>Deck: 6 mm</small></div>
        ` : `
          <div class="field"><label>NGO width jump (mm)</label>
            <div class="inp"><input type="number" step="5" data-rk="ngoWidth" data-rg="${g}" value="${set.ngoWidth}"><span>mm</span></div>
            <small>Max width change</small></div>
          <div class="field"><label>NGO thickness jump (mm)</label>
            <div class="inp"><input type="number" step="0.05" data-rk="ngoThk" data-rg="${g}" placeholder="—" value="${set.ngoThk ?? ""}"><span>mm</span></div>
            <small>Blank = not checked</small></div>
          <div class="field"><label>Minimum age (hours)</label>
            <div class="inp"><input type="number" step="1" data-rk="ageMin" data-rg="${g}" value="${set.ageMin}"><span>h</span></div>
            <small>Deck: &gt; 72 h</small></div>
        `}
      </div>
      ${isHR ? `
        <label class="check" style="margin-top:6px">
          <input type="checkbox" data-rk="sameThk" data-rg="${g}" ${set.sameThk ? "checked" : ""}>
          <strong>Same thickness together:</strong> Run all coils of one thickness sequentially (strict grouping)
        </label>
      ` : `
        <div style="margin-top:8px">
          <span class="label-sm" style="display:block;margin-bottom:6px">Silicon grade welding matrix (click any cell to toggle YES / NO)</span>
          <div class="scroll"><table class="mx" id="inline-mx"></table></div>
        </div>
      `}
    </div>` : "";

  root.innerHTML = `
   <div class="tiles">
     <div class="tile"><b>${full.length - sm.held}</b><span>coils ready</span></div>
     <div class="tile"><b>${f2(ton)}</b><span>tonnes ready</span></div>
     <div class="tile ${sm.breaks ? "bad" : "ok"}"><b>${sm.breaks}</b><span>rule breaks</span></div>
     <div class="tile ${sm.checks ? "warn" : "ok"}"><b>${sm.checks}</b><span>to check</span></div>
     <div class="tile"><b>${sm.held}</b><span>held (age ≤ ${set.ageMin} h)</span></div>
   </div>

   <!-- Report Filters & Inline Rules (ON SAME PAGE) -->
   <div class="rep-filter-box">
     <div class="rep-filter-row">
       <div class="rf-search">
         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
         <input type="search" placeholder="Search coil no, customer, TDC, status..." data-rf-search="${g}" value="${esc(repState[g].search)}">
       </div>
       <div class="status-pills">
         <span class="label-sm" style="margin-right:2px">Status:</span>
         ${statuses.map(s => `<button class="status-pill ${st === s ? "active" : ""}" data-rf-status="${g}" data-val="${s}">${s}</button>`).join("")}
       </div>
       <button class="btn ${repState[g].openRules ? "primary" : ""}" data-act="toggle-rules" data-g="${g}">
         ⚙ ${repState[g].openRules ? "Hide Rules & Filters ▲" : "Adjust Rules & Filters ▼"}
       </button>
     </div>
     ${inlineRulesHTML}
   </div>

   <div class="applied"><span class="label-sm">Rules applied</span>${applied.map(a => `<span class="chip">${a}</span>`).join("")}</div>

   <div class="tools">
     <button class="btn primary" data-act="arrange" data-g="${g}">⚡ Auto-arrange</button>
     <button class="btn" data-act="sheet" data-g="${g}">Sheet order</button>
     <button class="btn" data-act="thk" data-g="${g}">By thickness</button>
     <button class="btn" data-act="wdt" data-g="${g}">By width</button>
     <span class="sep"></span>
     <button class="btn" data-act="export" data-g="${g}">⬇ Export Excel</button>
     <label class="check"><input type="checkbox" id="hide-${g}" ${hideHeld[g] ? "checked" : ""}> Hide held</label>
     <label class="check"><input type="checkbox" data-rf-issues="${g}" ${onlyIss ? "checked" : ""}> Only breaks/checks</label>
     <span class="muted" style="font-size:.8rem;font-family:var(--f-mono)">Showing ${vis.length} of ${full.length}</span>
   </div>

   <div class="tbl"><table class="seq"><thead><tr><th>#</th><th>Move</th><th>HR Coil No</th>
      ${isHR ? "<th>Product</th>" : ""}<th>Thk mm</th><th>Wdt mm</th>
      <th>Δ Thk</th><th>Δ Wdt</th><th>Wgt t</th><th>Age h</th>
      <th>${isHR ? "TDC" : "Grade"}</th>${isHR ? "" : "<th>Si %</th>"}
      <th>Customer</th><th>Status</th><th>Check vs previous</th></tr></thead>
   <tbody>${body || `<tr><td colspan="15" style="padding:28px;color:var(--muted);text-align:center">
      No ${isHR ? "HRPO or HRSPO" : "NGO FP"} coils match your current search or filters. Adjust search or filters above.</td></tr>`}</tbody></table></div>`;

  root._vis = vis.map(e => S(e.o["HR Coil No"]));

  // Render silicon matrix inside inline card if open
  if (!isHR && repState[g].openRules) {
    const imx = $("#inline-mx");
    if (imx) {
      imx.innerHTML = `<thead><tr><th>First ↓ Next →</th>${GR.map((gr, i) => `<th>${gr}<br><span class="muted">${SI[i]}%</span></th>`).join("")}</tr></thead><tbody>${GR.map(r => `<tr><th>${r}</th>${[...set.matrix[r]].map((c, i) => `<td>
        <button data-mx="${r}" data-i="${i}" class="${c === "Y" ? "y" : "x"}"
          aria-label="${r} then ${GR[i]}: ${c === "Y" ? "allowed" : "not allowed"}">${c === "Y" ? "YES" : "NO"}
        </button></td>`).join("")}</tr>`).join("")}</tbody>`;
    }
  }
}

/* ---------- button & input interactions ---------- */
document.addEventListener("click", e => {
  const mv = e.target.closest("button[data-mv]");
  if (mv) {
    const g = mv.dataset.g, i = +mv.dataset.i, d = +mv.dataset.mv;
    const rootId = g === "HR" ? "p-hr-content" : "p-ngo-content";
    const vis = $("#" + rootId)._vis; const j = i + d;
    if (j < 0 || j >= vis.length) return;
    const full = ordered(g).map(o => S(o["HR Coil No"]));
    const a = full.indexOf(vis[i]), b = full.indexOf(vis[j]);
    [full[a], full[b]] = [full[b], full[a]];
    orders[g] = full; saveOrders(g); renderSched(g); buildAlerts();
    const btn = document.querySelector(`button[data-mv="${d}"][data-i="${j}"][data-g="${g}"]`);
    btn && btn.focus();
    return;
  }

  // Status pills in report filter bar
  const stBtn = e.target.closest("button[data-rf-status]");
  if (stBtn) {
    const g = stBtn.dataset.rfStatus;
    repState[g].status = stBtn.dataset.val;
    renderSched(g);
    return;
  }

  const act = e.target.closest("button[data-act]");
  if (act) {
    const g = act.dataset.g;
    if (act.dataset.act === "export") { exportSheet(g); return; }
    if (act.dataset.act === "toggle-rules") {
      repState[g].openRules = !repState[g].openRules;
      renderSched(g);
      return;
    }
    if (act.dataset.act === "close-rules") {
      repState[g].openRules = false;
      renderSched(g);
      return;
    }
    let list;
    if (act.dataset.act === "arrange") list = R.arrange(res[g], g, set);
    else if (act.dataset.act === "sheet") list = res[g].slice();
    else if (act.dataset.act === "thk") list = res[g].slice().sort((a, b) => (N(a.Thk) ?? 0) - (N(b.Thk) ?? 0) || (N(b.Wdt) ?? 0) - (N(a.Wdt) ?? 0));
    else list = res[g].slice().sort((a, b) => (N(b.Wdt) ?? 0) - (N(a.Wdt) ?? 0) || (N(a.Thk) ?? 0) - (N(b.Thk) ?? 0));
    orders[g] = list.map(o => S(o["HR Coil No"])); saveOrders(g); renderSched(g); buildAlerts();
    toast(act.dataset.act === "arrange" ? "Coils arranged by rules ✓" : "Order updated");
    return;
  }
});

// Search and issue filter changes on report pages
document.addEventListener("input", e => {
  const searchInput = e.target.closest("input[data-rf-search]");
  if (searchInput) {
    const g = searchInput.dataset.rfSearch;
    repState[g].search = searchInput.value;
    renderSched(g);
    // Keep focus
    const input = document.querySelector(`input[data-rf-search="${g}"]`);
    if (input) {
      input.focus();
      input.selectionStart = input.selectionEnd = input.value.length;
    }
    return;
  }

  // Inline rule changes from the report page
  const rkInput = e.target.closest("input[data-rk]");
  if (rkInput) {
    const k = rkInput.dataset.rk;
    const g = rkInput.dataset.rg;
    if (rkInput.type === "checkbox") {
      set[k] = rkInput.checked;
    } else {
      const v = rkInput.value.trim();
      set[k] = v === "" ? null : +v;
    }
    saveSettings();
    run();
    return;
  }
});

document.addEventListener("change", e => {
  const m = e.target.id && e.target.id.match(/^hide-(HR|NGO)$/);
  if (m) { hideHeld[m[1]] = e.target.checked; renderSched(m[1]); return; }

  const iss = e.target.closest("input[data-rf-issues]");
  if (iss) {
    const g = iss.dataset.rfIssues;
    repState[g].onlyIssues = iss.checked;
    renderSched(g);
    return;
  }
});

/* ---------- data prep (Step 1) ---------- */
function renderPrep() {
  const total = rows.length || 1;
  const funnel = $("#funnel");
  if (!funnel) return;
  funnel.innerHTML = res.steps.map(({ st, before, after, apl: a }) => {
    const drop = before - after - a; let nums;
    if (st.split) nums = `<span>${after} stay in PLAN</span><span style="color:var(--heat)">${a} → APL7</span>`;
    else if (st.f) nums = `<span>${after} of ${before}</span>${drop ? `<span class="drop">−${drop}</span>` : `<span class="muted">no change</span>`}`;
    else nums = `<span>${after} rows</span><span class="muted">${st.no === "1" ? "start" : "no rows removed"}</span>`;
    return `<div class="stage"><div class="no">${st.no === "Filter" ? "Your filter" : "Step " + st.no}</div><div>
      <h3>${st.t}</h3><p>${st.d}</p><div class="rule">${esc(st.r)}</div></div>
     <div class="meter"><div class="barx"><i style="width:${after / total * 100}%"></i></div><div class="nums">${nums}</div></div></div>`;
  }).join("");
  const v = R.remarkVariants(res.plan); const k = Object.keys(v);
  const aplNote = $("#aplNote");
  if (aplNote) {
    aplNote.hidden = !k.length;
    if (k.length) aplNote.innerHTML = k.map(x => `<b>${v[x]}</b> coil${v[x] > 1 ? "s" : ""} with remark <code>${esc(x)}</code>`).join(" and ") + " stayed in PLAN because the remark is not typed exactly as APL7.";
  }
  const srcDetail = $("#srcDetail");
  if (srcDetail) srcDetail.textContent = `${rows.length} rows loaded · ${res.HR.length} HR coils · ${res.NGO.length} NGO coils`;
}

/* ---------- settings (Step 2) ---------- */
const NUM = [
  { g: "jump", k: "thinJump", l: "Thinner gauge jump", u: "mm", st: 0.05, deck: "Deck: 0.4 mm in 1.6–2.0 mm" },
  { g: "jump", k: "thickJump", l: "Thicker gauge jump", u: "mm", st: 0.05, deck: "Deck: 1 mm in 2–6 mm" },
  { g: "jump", k: "thickFrom", l: "Thicker gauge starts at", u: "mm", st: 0.1, deck: "Coils from this thickness up use thicker limits" },
  { g: "width", k: "thinWidth", l: "Width change, thinner gauge", u: "mm", st: 5, deck: "Deck: 150 mm below 2.0 mm" },
  { g: "width", k: "thickWidth", l: "Width change, thicker gauge", u: "mm", st: 5, deck: "Deck: 250–300 mm" },
  { g: "width", k: "thickWidthWarn", l: "Flag thicker width above", u: "mm", st: 5, deck: "Shown as Check, not break. Blank = off", blank: true },
  { g: "range", k: "thkMin", l: "Thinnest coil", u: "mm", st: 0.1, deck: "Deck: 1.6 mm" },
  { g: "range", k: "thkMax", l: "Thickest coil", u: "mm", st: 0.1, deck: "Deck: 6 mm" },
  { g: "start", k: "startThk", l: "Start thickness", u: "mm", st: 0.1, deck: "Blank = start from thinnest", blank: true },
  { g: "start", k: "startWdt", l: "Start width", u: "mm", st: 5, deck: "Blank = start from widest", blank: true },
  { g: "crit", k: "critThk", l: "Critical TDC above", u: "mm", st: 0.1, deck: "Deck: 4.5 mm" },
  { g: "age", k: "ageMin", l: "Minimum age", u: "h", st: 1, deck: "Deck: above 72 h" },
  { g: "ngo", k: "ngoWidth", l: "NGO FP width jump", u: "mm", st: 5, deck: "Max width change between NGO FP coils" },
  { g: "ngo", k: "ngoThk", l: "NGO FP thickness jump", u: "mm", st: 0.05, deck: "Blank = not checked", blank: true }
];
const fieldsHTML = g => `<div class="fields">${NUM.filter(f => f.g === g).map(f => `<div class="field"><label for="s-${f.k}">${f.l}</label>
  <div class="inp">
  <input id="s-${f.k}" data-k="${f.k}" type="number" inputmode="decimal" step="${f.st}" ${f.blank ? 'placeholder="—"' : ""}
    value="${set[f.k] ?? ""}">
  <span>${f.u}</span></div><small id="h-${f.k}">${f.deck}</small></div>`).join("")}</div>`;
const card = (title, desc, inner, wide) => `<div class="card${wide ? " wide" : ""}"><header><h3>${title}</h3>${desc ? `<p>${desc}</p>` : ""}
  </header>${inner}</div>`;
const PK = {
  cust: { title: "Customer", key: "exCust", src: () => rows.filter(o => grpOf(o)), val: o => S(o.Cust) },
  gHR: { title: "HRPO / HRSPO TDC", key: "exGradeHR", src: () => rows.filter(o => grpOf(o) === "HR"), val: o => S(o.Tdc) },
  gNGO: { title: "NGO FP grade", key: "exGradeNGO", src: () => rows.filter(o => grpOf(o) === "NGO"), val: o => S(o["Ord Crgrade"]) }
};
const picker = id => `<div class="picker"><div class="bar"><span class="label-sm">${PK[id].title}</span>
  <input type="search" id="q-${id}" placeholder="Search" aria-label="Search ${PK[id].title}">
  <button class="btn" data-pk="${id}" data-all="1">Select all</button><button class="btn" data-pk="${id}" data-all="0">Clear all</button>
  <span class="muted" id="n-${id}" style="font-size:.8rem"></span></div><div class="plist" id="l-${id}"></div></div>`;

function renderSettings() {
  const statusOpts = [...new Set(["TA", "TW", "TD", "TU", "TS", "PA", ...rows.map(o => S(o.Status).toUpperCase()).filter(Boolean)])];
  const form = $("#settingsForm");
  if (!form) return;
  form.innerHTML =
    (requiresKey ? card("Editor key", "Saving changes for everyone needs the editor key set on the server.",
      `<div class="field"><label for="editorKey">Editor key</label><div class="inp">
      <input id="editorKey" type="password" autocomplete="current-password" value="${esc(editorKey)}"></div>
      <small>${editorKey ? "Key entered" : "Without key you can look, but changes stay on this device"}</small></div>`, true) : "") +
    card("Thickness jump", "Largest thickness change allowed between two HRPO/HRSPO coils.", fieldsHTML("jump")) +
    card("Width change", "Largest width change allowed between two HRPO/HRSPO coils.", fieldsHTML("width")) +
    card("Range of thickness", "Coils outside this range are left out of both schedules.", fieldsHTML("range")) +
    card("Start of thickness and width", "Auto-arrange begins with coil closest to these values.", fieldsHTML("start")) +
    card("Same thickness together",
      "All coils of one thickness run one after another.",
      `<label class="check"><input type="checkbox" id="s-sameThk" ${set.sameThk ? "checked" : ""}> Same thickness one after another (strict)
      </label>`) +
    card("Critical TDC", "Above set thickness, these TDCs must not run back to back.", fieldsHTML("crit") + `<div class="field">
      <label for="s-critTdcs">Critical TDC codes</label><textarea id="s-critTdcs" rows="2">${esc(set.critTdcs)}</textarea>
      <small>Separate codes with commas</small></div>`) +
    card("Age limit and status", "", fieldsHTML("age") + `<div class="field"><span class="label-sm">Statuses to schedule</span>
      <div class="checks" id="s-statuses">${statusOpts.map(s => `<label>
      <input type="checkbox" value="${s}" ${set.statuses.includes(s) ? "checked" : ""}> ${s}</label>`).join("")}</div>
      <small>Deck: TA and TW only</small></div>`) +
    card("NGO FP report", "Rules for separate NGO FP schedule. Click a matrix cell to switch YES / NO.",
      fieldsHTML("ngo") + `<div class="scroll"><table class="mx" id="mx"></table></div>`) +
    card("Customers", "Untick customers not required in this schedule.", picker("cust"), true) +
    card("Grades", "Untick grades not required. HRPO/HRSPO use TDC, NGO FP uses order grade.",
      picker("gHR") + picker("gNGO"), true);
  renderMatrix(); renderPickers(); markChanged();
}
function renderPickers() { for (const id in PK) renderPicker(id); }
function renderPicker(id) {
  const p = PK[id]; const cnt = {};
  p.src().forEach(o => { const v = p.val(o) || "(blank)"; cnt[v] = (cnt[v] || 0) + 1; });
  const q = S(($("#q-" + id) || {}).value).toLowerCase(); const ex = set[p.key];
  const keys = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || a.localeCompare(b));
  const nEl = $("#n-" + id); if (nEl) nEl.textContent = `${keys.filter(k => !ex.includes(k)).length} of ${keys.length} selected`;
  const lEl = $("#l-" + id);
  if (lEl) lEl.innerHTML = keys.filter(k => !q || k.toLowerCase().includes(q)).map(k => `<label class="${ex.includes(k) ? "off" : ""}">
    <input type="checkbox" data-pkv="${id}" value="${esc(k)}" ${ex.includes(k) ? "" : "checked"}><span>${esc(k)}</span>
    <em>${cnt[k]} coil${cnt[k] > 1 ? "s" : ""}</em></label>`).join("")
      || `<label><span></span><span class="muted">No match</span><span></span></label>`;
  p._keys = keys;
}
function renderMatrix() {
  const mx = $("#mx"); if (!mx) return;
  mx.innerHTML = `<thead><tr><th>First ↓ Next →</th>${GR.map((g, i) => `<th>${g}<br><span class="muted">${SI[i]}%</span></th>`).join("")}</tr></thead><tbody>${GR.map(r => `<tr><th>${r}</th>${[...set.matrix[r]].map((c, i) => `<td>
    <button data-mx="${r}" data-i="${i}" class="${c === "Y" ? "y" : "x"}"
      aria-label="${r} then ${GR[i]}: ${c === "Y" ? "allowed" : "not allowed"}">${c === "Y" ? "YES" : "NO"}
    </button></td>`).join("")}</tr>`).join("")}</tbody>`;
}
function markChanged() {
  NUM.forEach(f => {
    const el = $("#h-" + f.k); if (!el) return;
    const diff = set[f.k] !== DEFAULTS[f.k];
    el.classList.toggle("changed", diff);
    el.textContent = diff ? `Changed from deck (${DEFAULTS[f.k] ?? "blank"} ${f.u})` : f.deck;
  });
}

// Matrix toggle handler
document.addEventListener("click", e => {
  const b = e.target.closest("button[data-mx]");
  if (b) {
    const r = b.dataset.mx, i = +b.dataset.i;
    const cur = set.matrix[r]; const next = cur.slice(0, i) + (cur[i] === "Y" ? "N" : "Y") + cur.slice(i + 1);
    set.matrix = Object.assign({}, set.matrix, { [r]: next });
    renderMatrix();
    const imx = $("#inline-mx"); if (imx) renderSched("NGO");
    saveSettings(); run();
    return;
  }
  const pk = e.target.closest("button[data-pk]");
  if (pk) {
    const id = pk.dataset.pk, all = pk.dataset.all === "1", p = PK[id];
    set[p.key] = all ? [] : (p._keys || []).slice();
    renderPicker(id); saveSettings(); run();
    return;
  }
});

// Pickers search and check
document.addEventListener("input", e => {
  if (e.target.id && e.target.id.startsWith("q-")) { renderPicker(e.target.id.slice(2)); }
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.pkv) {
    const id = t.dataset.pkv, p = PK[id], ex = new Set(set[p.key]);
    if (t.checked) ex.delete(t.value); else ex.add(t.value);
    set[p.key] = [...ex];
    t.closest("label").classList.toggle("off", !t.checked);
    const keys = p._keys || []; const nEl = $("#n-" + id); if (nEl) nEl.textContent = `${keys.filter(k => !ex.has(k)).length} of ${keys.length} selected`;
    saveSettings(); run();
    return;
  }
  if (t.dataset.k) {
    const k = t.dataset.k, v = t.value.trim();
    set[k] = v === "" ? null : +v;
    markChanged(); saveSettings(); run();
    return;
  }
  if (t.id === "s-sameThk") { set.sameThk = t.checked; saveSettings(); run(); return; }
  if (t.closest("#s-statuses")) {
    set.statuses = [...document.querySelectorAll("#s-statuses input:checked")].map(i => i.value);
    saveSettings(); run(); return;
  }
  if (t.id === "s-critTdcs") { set.critTdcs = t.value; saveSettings(); run(); return; }
  if (t.id === "editorKey") {
    editorKey = t.value.trim(); ls.set("cpl2.key", editorKey);
    toast(editorKey ? "Editor key saved" : "Editor key cleared");
    pull(false);
  }
});

const resetBtn = $("#resetBtn");
if (resetBtn) resetBtn.onclick = () => {
  if (!confirm("Reset all rules and limits back to the standard deck values?")) return;
  set = Object.assign({}, DEFAULTS, { matrix: Object.assign({}, DEFAULTS.matrix) });
  renderSettings(); saveSettings(); run(); toast("Rules reset to standard deck values");
};

async function saveSettings() {
  ls.set("cpl2.settings", set);
  setSave("pending");
  const ok = await saveRemote("settings", "/api/settings", set);
  setSave(ok ? "ok" : "local");
}
function setSave(s) {
  const el = $("#saveState"); if (!el) return;
  const t = { pending: "Saving…", ok: "Saved to MongoDB Atlas", local: "Saved locally" }[s];
  el.className = "sync-pill " + (s === "ok" ? "on" : s === "local" ? "local" : "");
  el.querySelector("span").textContent = t;
}

function setSync() {
  const el = $("#sync"); if (!el) return;
  const isMongo = storeKind === "mongodb";
  if (online && isMongo) {
    el.className = "sync-pill on";
    el.innerHTML = `<i></i><span>MongoDB Atlas Active</span>`;
    el.title = "Connected to MongoDB Atlas cluster0.fxhfgqv.mongodb.net (database: cpl2)";
  } else if (online) {
    el.className = "sync-pill on";
    el.innerHTML = `<i></i><span>Synced across devices</span>`;
    el.title = "Connected to server (local storage fallback)";
  } else {
    el.className = "sync-pill local";
    el.innerHTML = `<i></i><span>Saved on this device</span>`;
    el.title = "Offline or connecting...";
  }
}

async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    const json = await res.json();
    if (json.ok) {
      storeKind = json.store;
      online = true;
    }
  } catch {
    online = false;
  }
  setSync();
}

const ordT = {};
function saveOrders(g) {
  ls.set("cpl2.orders", orders);
  clearTimeout(ordT[g]);
  ordT[g] = setTimeout(() => saveRemote("plan-" + g, "/api/plan/" + g, { ids: orders[g] }), 800);
}
async function saveStock() {
  ls.set("cpl2.stock", stock);
  const ok = await saveRemote("stock", "/api/stock", stock);
  if (!ok) toast("File loaded on this device.");
}

/* ---------- loading stock file ---------- */
function loadAOA(aoa, name) {
  const hi = aoa.findIndex(r => r && r.some(c => S(c) === "HR Coil No"));
  if (hi < 0) { toast('No "HR Coil No" column found. Load Hrstock Report export.'); return; }
  const hdr = aoa[hi].map(S);
  const idx = KEEP.map(k => hdr.indexOf(k));
  const data = aoa.slice(hi + 1).filter(r => r && r.some(c => c != null && c !== "")).map(r => idx.map(i => {
    const v = i >= 0 ? r[i] : null; return v == null ? "" : v;
  }));
  stock = { name, cols: KEEP, rows: data };
  useStock(); saveStock(); pushEvent("ok", `Loaded file ${name} (${data.length} rows)`);
  goStep(3); // Auto-jump to the HR schedule report page
  toast(`Loaded ${data.length} coils from ${name}`);
}

function useStock() {
  if (!stock) return;
  const cols = stock.cols || [];
  rows = (stock.rows || []).map(r => {
    const o = {}; cols.forEach((c, i) => { o[c] = r[i]; }); return o;
  });
  const nameEl = $("#srcName"); if (nameEl) nameEl.textContent = stock.name || "HR stock";
  run(); renderSettings();
}

function readFileInput(f) {
  const r = new FileReader();
  r.onload = e => {
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
      const sh = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, raw: false });
      loadAOA(aoa, f.name);
    } catch (err) { toast("Could not read file: " + err.message); }
  };
  r.readAsArrayBuffer(f);
}

const fileInput = $("#file");
if (fileInput) fileInput.addEventListener("change", e => { if (e.target.files[0]) readFileInput(e.target.files[0]); });

const uploadZone = $("#uploadZone");
if (uploadZone) {
  uploadZone.addEventListener("dragover", e => { e.preventDefault(); uploadZone.classList.add("drag-over"); });
  uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("drag-over"));
  uploadZone.addEventListener("drop", e => {
    e.preventDefault(); uploadZone.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) readFileInput(e.dataTransfer.files[0]);
  });
}

/* ---------- export to Excel (Step 5) ---------- */
function exportSheet(g) {
  const isHR = g === "HR";
  const full = ordered(g);
  const ev = R.evaluate(g, full, set);
  const isHeld = o => R.isHeld(o, set);
  const vis = ev.filter(e => !(hideHeld[g] && isHeld(e.o)));

  if (!vis.length) { toast("No coils to export"); return; }

  const rowsOut = vis.map((e, i) => {
    const o = e.o;
    const bad = e.iss.some(x => x[0] === "bad"), warn = e.iss.some(x => x[0] === "warn"), h = isHeld(o);
    const result = h ? "HELD" : bad ? "RULE BREAK" : warn ? "CHECK" : i === 0 ? "FIRST COIL" : "OK";
    const issues = e.iss.map(x => x[1]).join("; ");

    const row = {
      "Seq #": i + 1,
      "HR Coil No": o["HR Coil No"] || "",
      "Product": isHR ? (o.Product || "") : "NGO FP",
      "Thk (mm)": N(o.Thk) ?? "",
      "Wdt (mm)": N(o.Wdt) ?? "",
      "Δ Thk": e.dt != null ? f2(e.dt) : "",
      "Δ Wdt": e.dw != null ? e.dw : "",
      "Wgt (t)": N(o.Wgt) ?? "",
      "Age (h)": N(o["Age Hours"]) ?? "",
      [isHR ? "TDC" : "Grade"]: gradeOf(o) || "",
      "Customer": o.Cust || "",
      "Status": o.Status || "",
      "Result": result,
      "Issues": issues
    };
    if (!isHR) row["Silicon %"] = N(o["Silicon %"]) ?? "";
    return row;
  });

  const ws = XLSX.utils.json_to_sheet(rowsOut);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, isHR ? "HR_Schedule" : "NGO_FP_Report");

  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const fileName = `CPL2_${isHR ? "HR_Schedule" : "NGO_FP_Report"}_${stamp}.xlsx`;

  XLSX.writeFile(wb, fileName);
  pushEvent("ok", `Exported ${isHR ? "HR Schedule" : "NGO FP Report"} (${vis.length} coils)`);
  toast(`Exported ${fileName} ✓`);
}

function updateDlDescriptions() {
  const hrDesc = $("#hrDlDesc"), ngoDesc = $("#ngoDlDesc");
  if (hrDesc) hrDesc.textContent = `${res.HR.length} HR coils in optimal rolling sequence`;
  if (ngoDesc) ngoDesc.textContent = `${res.NGO.length} NGO FP coils with silicon welding matrix`;
}

/* ---------- history & events ---------- */
function pushEvent(level, text) {
  events.unshift({ id: "ev-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), level, text, at: Date.now() });
  if (events.length > 80) events.pop();
  ls.set("cpl2.events", events);
  renderHistory();
}
function renderHistory() {
  const list = $("#histList"); if (!list) return;
  const countEl = $("#cHist"); if (countEl) countEl.textContent = events.length;
  if (!events.length) {
    list.innerHTML = `<p style="padding:16px 20px;color:var(--muted);font-size:.86rem">No activity recorded yet.</p>`;
    return;
  }
  list.innerHTML = events.map(e => `
    <div class="hist-item">
      <span class="hist-level ${e.level}">${e.level.toUpperCase()}</span>
      <div>${esc(e.text)}</div>
      <span class="hist-time">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
  `).join("");
}
const clearHistBtn = $("#clearHistBtn");
if (clearHistBtn) clearHistBtn.onclick = () => {
  events = []; ls.set("cpl2.events", events); renderHistory(); toast("History cleared");
};

/* ---------- notifications ---------- */
function buildAlerts() {
  const prev = new Set(alerts.map(a => a.key));
  const next = [];
  const evHR = R.evaluate("HR", ordered("HR"), set);
  const smHR = R.summary(evHR);
  if (smHR.breaks) next.push({ key: "hr-bad-" + smHR.breaks, level: "bad", text: `HR schedule has ${smHR.breaks} rule break${smHR.breaks > 1 ? "s" : ""}. Click Auto-arrange.` });
  const evNGO = R.evaluate("NGO", ordered("NGO"), set);
  const smNGO = R.summary(evNGO);
  if (smNGO.breaks) next.push({ key: "ngo-bad-" + smNGO.breaks, level: "bad", text: `NGO FP schedule has ${smNGO.breaks} rule break${smNGO.breaks > 1 ? "s" : ""}. Click Auto-arrange.` });
  alerts = next;
  renderDrawer();
}
function renderDrawer() {
  const list = $("#nlist"); const bCnt = $("#bellCount");
  if (!list) return;
  const unseen = alerts.filter(x => !seen[x.key]);
  if (bCnt) { bCnt.textContent = unseen.length; bCnt.hidden = unseen.length === 0; }
  if (!alerts.length) { list.innerHTML = `<p style="padding:20px;color:var(--muted);text-align:center">All good! No alerts.</p>`; return; }
  list.innerHTML = alerts.map(a => `
    <div class="hist-item">
      <span class="hist-level ${a.level}">${a.level.toUpperCase()}</span>
      <div>${esc(a.text)}</div>
    </div>
  `).join("");
}
function renderNotifChecks() {}

const bellBtn = $("#bellBtn");
if (bellBtn) bellBtn.onclick = () => {
  $("#drawer").hidden = false; $("#shade").hidden = false;
};
const closeDrawer = () => { $("#drawer").hidden = true; $("#shade").hidden = true; };
const closeBtn = $("#closeDrawer"); if (closeBtn) closeBtn.onclick = closeDrawer;
const shadeEl = $("#shade"); if (shadeEl) shadeEl.onclick = closeDrawer;
const markReadBtn = $("#markRead");
if (markReadBtn) markReadBtn.onclick = () => {
  alerts.forEach(a => { seen[a.key] = true; });
  ls.set("cpl2.seen", seen);
  renderDrawer(); closeDrawer();
};

let toastT;
function toast(t) {
  const el = $("#toast"); if (!el) return;
  el.textContent = t; el.hidden = false; clearTimeout(toastT);
  toastT = setTimeout(() => (el.hidden = true), 3600);
}

/* ---------- sync with server ---------- */
async function pull(first) {
  await checkHealth();
  let body;
  try { body = await api("GET", "/api/state"); online = true; } catch (e) { online = false; setSync(); return; }
  const wasKey = requiresKey; requiresKey = !!body.requiresKey;
  const st = body.state || {};
  const newer = k => st[k] && st[k].updatedAt !== versions[k];
  let rerun = false;
  if (newer("settings")) {
    set = R.withDefaults(st.settings.data); ls.set("cpl2.settings", set);
    if (!first) pushEvent("warn", "Rules updated on another device.");
    rerun = true;
  } else if (first && !st.settings && ls.get("cpl2.settings") && (!requiresKey || editorKey)) {
    saveSettings();
  }
  if (newer("stock")) {
    stock = st.stock.data; ls.set("cpl2.stock", stock);
    if (!first) pushEvent("ok", `New stock file loaded on another device: ${stock.name}`);
    rerun = true;
  }
  for (const g of ["HR", "NGO"]) {
    if (newer("plan-" + g)) { orders[g] = st["plan-" + g].data.ids || []; ls.set("cpl2.orders", orders); rerun = true; }
  }
  for (const k of Object.keys(st)) versions[k] = st[k].updatedAt;
  ls.set("cpl2.versions", versions);
  if (rerun || wasKey !== requiresKey) useStock();
  setSync();
}

/* ---------- boot ---------- */
(async function boot() {
  if (!stock) {
    try { const r = await fetch("sample-stock.json"); const j = await r.json(); stock = { name: SAMPLE_NAME, cols: j.cols, rows: j.rows }; }
    catch (e) { stock = { name: "No stock loaded", cols: KEEP, rows: [] }; }
  }
  useStock();
  const savedStep = ls.get("cpl2.step") || 1;
  goStep(savedStep);
  await checkHealth();
  await pull(true);
  booted = true;
  setInterval(() => pull(false), POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pull(false); });
})();
