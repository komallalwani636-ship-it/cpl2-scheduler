/*
 * CPL-2 Scheduler web app.
 * Uses window.Rules (rules.js) for every scheduling decision.
 * Shared state lives on the server (/api/...), with a copy in localStorage so
 * the page still opens offline or before the server answers.
 */
const R = window.Rules;
const { S, N, GR, SI, DEFAULTS, grpOf, gradeOf } = R;
const SAMPLE_NAME = "CPL2_HR_STOCK_FOR_SCHEDULING.xls";
const KEEP = ["HR Coil No", "Thk", "Wdt", "Wgt", "Age Hours", "Status", "Cust", "Tdc", "Product", "Act Path", "Prev Unit", "Order_status",
  "Receiving Remarks", "Ord Crgrade", "Silicon %", "Routing", "Edge Condth", "Next Work Center", "Coil Saddle Loc"];
const POLL_MS = 20000;

const $ = s => document.querySelector(s);
const esc = s => S(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = v => (v == null ? "â€”" : String(Math.round(v * 100) / 100));
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
let online = false, requiresKey = false, editorKey = ls.get("cpl2.key") || "";
let versions = ls.get("cpl2.versions") || {};
let events = ls.get("cpl2.events") || [];
let seen = ls.get("cpl2.seen") || {};
let alerts = [], lastN = {}, booted = false;

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
    if (e.code === 401) toast("Enter the editor key in Rules & settings to save changes for everyone.");
    else { online = false; setSync(); }
    return false;
  }
}

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

/* ---------- schedule tab ---------- */
function renderSched(g) {
  const root = $("#p-" + g.toLowerCase() + " .wrap");
  const full = ordered(g);
  const ev = R.evaluate(g, full, set);
  const isHeld = o => R.isHeld(o, set);
  const vis = ev.filter(e => !(hideHeld[g] && isHeld(e.o)));
  const sm = R.summary(ev);
  const ton = ev.reduce((t, e) => t + (isHeld(e.o) ? 0 : N(e.o.Wgt) || 0), 0);
  $("#c" + g).textContent = full.length;
  const isHR = g === "HR";
  const applied = isHR
    ? [`Thinner gauge (&lt; ${set.thickFrom} mm): jump â‰¤ ${set.thinJump} mm, width â‰¤ ${set.thinWidth} mm`,
      `Thicker gauge (â‰¥ ${set.thickFrom} mm): jump â‰¤ ${set.thickJump} mm, width â‰¤ ${set.thickWidth} mm`,
      `Critical TDC above ${set.critThk} mm not back to back`]
    : [`Width jump â‰¤ ${set.ngoWidth} mm`, "Silicon grade welding matrix",
      set.ngoThk != null ? `Thickness jump â‰¤ ${set.ngoThk} mm` : "Thickness jump not checked"];
  applied.push(`Age &gt; ${set.ageMin} h`);
  if (set.sameThk) applied.push("Same thickness together");
  const body = vis.map((e, i) => {
    const o = e.o;
    const bad = e.iss.some(x => x[0] === "bad"), warn = e.iss.some(x => x[0] === "warn"), h = isHeld(o);
    const cls = h ? "held" : bad ? "bad" : warn ? "warn" : "ok";
    const pill = h ? `<span class="pill info">Held</span>` : bad ? `<span class="pill bad">Break</span>` : warn ? `
      <span class="pill warn">Check</span>` : `<span class="pill ok">${i ? "OK" : "First coil"}</span>`;
    const tc = e.iss.some(x => x[2] === "t" && x[0] === "bad") ? "b" : "";
    const wc = e.iss.some(x => x[2] === "w" && x[0] === "bad") ? "b" : e.iss.some(x => x[2] === "w") ? "w" : "";
    let grpRow = "";
    const prevV = i ? vis[i - 1].o : null;
    if (set.sameThk && (!prevV || R.thkKey(prevV) !== R.thkKey(o))) {
      let n = 0, w = 0;
      for (let j = i; j < vis.length && R.thkKey(vis[j].o) === R.thkKey(o); j++) { n++; w += N(vis[j].o.Wgt) || 0; }
      grpRow = `<tr class="grp"><td colspan="15"><b>${R.thkKey(o)} mm</b><span>${n} coil${n > 1 ? "s" : ""} Â· ${f2(w)} t</span></td></tr>`;
    }
    return `${grpRow}<tr class="${cls}"><td class="n">${i + 1}</td>
      <td><span class="mv"><button data-g="${g}" data-mv="-1" data-i="${i}" aria-label="Move up">â†‘</button>
        <button data-g="${g}" data-mv="1" data-i="${i}" aria-label="Move down">â†“</button></span></td>
      <td class="mono">${esc(o["HR Coil No"])}</td>${isHR ? `<td>${esc(o.Product)}</td>` : ""}
      <td class="n">${f2(N(o.Thk))}</td><td class="n">${N(o.Wdt) ?? "â€”"}</td>
      <td class="n dv ${tc}">${e.dt == null ? "" : f2(e.dt)}</td><td class="n dv ${wc}">${e.dw == null ? "" : e.dw}</td>
      <td class="n">${f2(N(o.Wgt))}</td><td class="n">${N(o["Age Hours"]) ?? "â€”"}</td>
      <td class="mono">${esc(gradeOf(o))}</td>${isHR ? "" : `<td class="n">${f2(N(o["Silicon %"]))}</td>`}
      <td class="cust" title="${esc(o.Cust)}">${esc(o.Cust)}</td><td>${esc(o.Status)}</td>
      <td><div class="why">${pill}${e.iss.map(x => `<span>${esc(x[1])}</span>`).join("")}</div></td></tr>`;
  }).join("");
  root.innerHTML = `
   <div class="phead"><div><div class="label">${isHR ? "HRPO + HRSPO" : "NGO FP Â· separate report"}</div>
     <h2>${isHR ? "HR schedule" : "NGO FP report"}</h2>
     <p>Each coil is checked against the coil rolled before it. Use Auto-arrange to build an order that follows the rules,
       then fine-tune with the arrows. The order is saved.</p></div></div>
   <div class="tiles">
     <div class="tile"><b>${full.length - sm.held}</b><span>coils ready</span></div>
     <div class="tile"><b>${f2(ton)}</b><span>tonnes ready</span></div>
     <div class="tile ${sm.breaks ? "bad" : "ok"}"><b>${sm.breaks}</b><span>rule breaks</span></div>
     <div class="tile ${sm.checks ? "warn" : "ok"}"><b>${sm.checks}</b><span>to check</span></div>
     <div class="tile"><b>${sm.held}</b><span>held, age â‰¤ ${set.ageMin} h</span></div>
   </div>
   <div class="applied"><span class="label" style="align-self:center">Rules applied</span>${applied.map(a => `<span class="chip">${a}
     </span>`).join("")}<button class="btn" data-goto="rules" style="padding:2px 10px">Edit</button></div>
   <div class="tools">
     <button class="btn primary" data-act="arrange" data-g="${g}">Auto-arrange</button>
     <button class="btn" data-act="sheet" data-g="${g}">Sheet order</button>
     <button class="btn" data-act="thk" data-g="${g}">Sort by thickness</button>
     <button class="btn" data-act="wdt" data-g="${g}">Sort by width</button>
     <span class="sep"></span>
     <button class="btn" data-act="export" data-g="${g}">⬇ Export Excel</button>
     <label class="check"><input type="checkbox" id="hide-${g}" ${hideHeld[g] ? "checked" : ""}> Hide held coils</label>
   </div>
   <div class="tbl"><table class="seq"><thead><tr><th>#</th><th>Move</th><th>HR coil</th>
      ${isHR ? "<th>Product</th>" : ""}<th>Thk mm</th><th>Wdt mm</th>
      <th>Î” Thk</th><th>Î” Wdt</th><th>Wgt t</th><th>Age h</th>
      <th>${isHR ? "TDC" : "Grade"}</th>${isHR ? "" : "<th>Si %</th>"}
      <th>Customer</th><th>Status</th><th>Check vs previous coil</th></tr></thead>
   <tbody>${body || `<tr><td colspan="15" style="padding:18px;color:var(--muted)">
      No ${isHR ? "HRPO or HRSPO" : "NGO FP"} coils pass the current filters.
      Check the thickness range, customers and grades in Rules &amp; settings.</td></tr>`}</tbody></table></div>`;
  root._vis = vis.map(e => S(e.o["HR Coil No"]));
}

document.addEventListener("click", e => {
  const mv = e.target.closest("button[data-mv]");
  if (mv) {
    const g = mv.dataset.g, i = +mv.dataset.i, d = +mv.dataset.mv;
    const vis = $("#p-" + g.toLowerCase() + " .wrap")._vis; const j = i + d;
    if (j < 0 || j >= vis.length) return;
    const full = ordered(g).map(o => S(o["HR Coil No"]));
    const a = full.indexOf(vis[i]), b = full.indexOf(vis[j]);
    [full[a], full[b]] = [full[b], full[a]];
    orders[g] = full; saveOrders(g); renderSched(g); buildAlerts();
    const btn = $(`#p-${g.toLowerCase()} button[data-mv="${d}"][data-i="${j}"]`); btn && btn.focus();
    return;
  }
  const act = e.target.closest("button[data-act]");
  if (act) {
    const g = act.dataset.g; let list;
    if (act.dataset.act === "arrange") list = R.arrange(res[g], g, set);
    else if (act.dataset.act === "sheet") list = res[g].slice();
    else if (act.dataset.act === "thk") list = res[g].slice().sort((a,
      b) => (N(a.Thk) ?? 0) - (N(b.Thk) ?? 0) || (N(b.Wdt) ?? 0) - (N(a.Wdt) ?? 0));
    else list = res[g].slice().sort((a, b) => (N(b.Wdt) ?? 0) - (N(a.Wdt) ?? 0) || (N(a.Thk) ?? 0) - (N(b.Thk) ?? 0));
    orders[g] = list.map(o => S(o["HR Coil No"])); saveOrders(g); renderSched(g); buildAlerts();
    toast(act.dataset.act === "arrange" ? "Coils arranged by the rules" : "Order updated");
    return;
  }
  if (act && act.dataset.act === "export") {
    exportSheet(act.dataset.g); return;
  }
  const go = e.target.closest("[data-goto]");
  if (go) showTab(go.dataset.goto);
});
document.addEventListener("change", e => {
  const m = e.target.id && e.target.id.match(/^hide-(HR|NGO)$/);
  if (m) { hideHeld[m[1]] = e.target.checked; renderSched(m[1]); }
});

/* ---------- data prep tab ---------- */
function renderPrep() {
  const total = rows.length || 1;
  $("#funnel").innerHTML = res.steps.map(({ st, before, after, apl: a }) => {
    const drop = before - after - a; let nums;
    if (st.split) nums = `<span>${after} stay in PLAN</span><span style="color:var(--heat)">${a} â†’ APL7</span>`;
    else if (st.f) nums = `<span>${after} of ${before}</span>
      ${drop ? `<span class="drop">âˆ’${drop}</span>` : `<span class="muted">no change
      </span>`}`;
    else nums = `<span>${after} rows</span><span class="muted">${st.no === "1" ? "start" : "no rows removed"}</span>`;
    return `<div class="stage"><div class="no">${st.no === "Filter" ? "Your filter" : "Step " + st.no}</div><div>
      <h3>${st.t}</h3><p>${st.d}</p><div class="rule">${esc(st.r)}</div></div>
     <div class="meter"><div class="barx"><i style="width:${after / total * 100}%"></i></div><div class="nums">${nums}</div></div></div>`;
  }).join("");
  const v = R.remarkVariants(res.plan); const k = Object.keys(v);
  $("#aplNote").hidden = !k.length;
  if (k.length) $("#aplNote").innerHTML = k.map(x => `<b>${v[x]}</b> coil${v[x] > 1 ? "s" : ""} with remark <code>${esc(x)}
    </code>`).join(" and ") + " stayed in PLAN because the remark is not typed exactly as APL7.";
}

/* ---------- export to Excel ---------- */
function exportSheet(g) {
  if (typeof XLSX === "undefined") { toast("SheetJS not loaded. Check your connection and reload."); return; }
  const full = ordered(g);
  const ev = R.evaluate(g, full, set);
  const isHR = g === "HR";
  const rows_out = ev.map((e, i) => {
    const o = e.o;
    const sm = R.summary([e]);
    const status = R.isHeld(o, set) ? "Held" : sm.breaks ? "Rule Break" : sm.checks ? "Check" : i === 0 ? "First coil" : "OK";
    const row = {
      "#": i + 1,
      "HR Coil No": S(o["HR Coil No"]),
      "Thk mm": o.Thk,
      "Wdt mm": o.Wdt,
      "Î” Thk": e.dt ?? "",
      "Î” Wdt": e.dw ?? "",
      "Wgt t": o.Wgt,
      "Age h": o["Age Hours"],
      "Customer": S(o.Cust),
      "Status": S(o.Status),
      "Result": status,
      "Issues": e.iss.map(x => x[1]).join("; ")
    };
    if (isHR) { row["Product"] = S(o.Product); row["TDC"] = S(o.Tdc); }
    else { row["Grade"] = S(o["Ord Crgrade"]); row["Si %"] = o["Silicon %"]; }
    return row;
  });
  const ws = XLSX.utils.json_to_sheet(rows_out);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, g === "HR" ? "HR Schedule" : "NGO FP");
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  XLSX.writeFile(wb, `CPL2_${g}_Schedule_${ts}.xlsx`);
  pushEvent("ok", `Exported ${g} schedule (${rows_out.length} coils) at ${now.toLocaleTimeString()}`);
  toast(`Exported ${rows_out.length} coils to Excel`);
}

/* ---------- settings tab ---------- */
const NUM = [
  { g: "jump", k: "thinJump", l: "Thinner gauge jump", u: "mm", st: 0.05, deck: "Deck: 0.4 mm in 1.6â€“2.0 mm" },
  { g: "jump", k: "thickJump", l: "Thicker gauge jump", u: "mm", st: 0.05, deck: "Deck: 1 mm in 2â€“6 mm" },
  { g: "jump", k: "thickFrom", l: "Thicker gauge starts at", u: "mm", st: 0.1,
    deck: "Coils from this thickness up use the thicker limits" },
  { g: "width", k: "thinWidth", l: "Width change, thinner gauge", u: "mm", st: 5, deck: "Deck: 150 mm below 2.0 mm" },
  { g: "width", k: "thickWidth", l: "Width change, thicker gauge", u: "mm", st: 5, deck: "Deck: 250â€“300 mm" },
  { g: "width", k: "thickWidthWarn", l: "Flag thicker width above", u: "mm", st: 5, deck: "Shown as Check, not a break. Blank = off",
    blank: true },
  { g: "range", k: "thkMin", l: "Thinnest coil", u: "mm", st: 0.1, deck: "Deck: 1.6 mm" },
  { g: "range", k: "thkMax", l: "Thickest coil", u: "mm", st: 0.1, deck: "Deck: 6 mm" },
  { g: "start", k: "startThk", l: "Start thickness", u: "mm", st: 0.1, deck: "Blank = start from the thinnest", blank: true },
  { g: "start", k: "startWdt", l: "Start width", u: "mm", st: 5, deck: "Blank = start from the widest", blank: true },
  { g: "crit", k: "critThk", l: "Critical TDC above", u: "mm", st: 0.1, deck: "Deck: 4.5 mm" },
  { g: "age", k: "ageMin", l: "Minimum age", u: "h", st: 1, deck: "Deck: above 72 h" },
  { g: "ngo", k: "ngoWidth", l: "NGO FP width jump", u: "mm", st: 5, deck: "Max width change between NGO FP coils" },
  { g: "ngo", k: "ngoThk", l: "NGO FP thickness jump", u: "mm", st: 0.05, deck: "Blank = not checked", blank: true }
];
const fieldsHTML = g => `<div class="fields">${NUM.filter(f => f.g === g).map(f => `<div class="field"><label for="s-${f.k}">${f.l}</label>
  <div class="inp">
  <input id="s-${f.k}" data-k="${f.k}" type="number" inputmode="decimal" step="${f.st}" ${f.blank ? 'placeholder="â€”"' : ""}
    value="${set[f.k] ?? ""}">
  <span>${f.u}</span></div><small id="h-${f.k}">${f.deck}</small></div>`).join("")}</div>`;
const card = (title, desc, inner, wide) => `<div class="card${wide ? " wide" : ""}"><header><h3>${title}</h3>${desc ? `<p>${desc}</p>` : ""}
  </header>${inner}</div>`;

function renderSettings() {
  const statusOpts = [...new Set(["TA", "TW", "TD", "TU", "TS", "PA", ...rows.map(o => S(o.Status).toUpperCase()).filter(Boolean)])];
  $("#settingsForm").innerHTML =
    (requiresKey ? card("Editor key", "Saving changes for everyone needs the editor key set on the server. It is kept on this device only.",
      `<div class="field"><label for="editorKey">Editor key</label><div class="inp">
      <input id="editorKey" type="password" autocomplete="current-password" value="${esc(editorKey)}"></div>
      <small>${editorKey ? "Key entered" : "Without the key you can look, but changes stay on this device"}</small></div>`, true) : "") +
    card("Thickness jump", "Largest thickness change allowed between two HRPO/HRSPO coils in a row.", fieldsHTML("jump")) +
    card("Width change", "Largest width change allowed between two HRPO/HRSPO coils in a row.", fieldsHTML("width")) +
    card("Range of thickness", "Coils outside this range are left out of both schedules.", fieldsHTML("range")) +
    card("Start of thickness and width", "Auto-arrange begins with the coil closest to these values.", fieldsHTML("start")) +
    card("Same thickness together",
      "All coils of one thickness run one after another, with the same TDC or grade kept together inside each block. " +
      "A coil that splits a thickness block counts as a rule break.",
      `<label class="check"><input type="checkbox" id="s-sameThk" ${set.sameThk ? "checked" : ""}> Same thickness one after another (strict)
      </label>`) +
    card("Critical TDC", "Above the set thickness, these TDCs must not run back to back.", fieldsHTML("crit") + `<div class="field">
      <label for="s-critTdcs">Critical TDC codes</label><textarea id="s-critTdcs" rows="2">${esc(set.critTdcs)}</textarea>
      <small>Separate codes with commas</small></div>`) +
    card("Age limit and status", "", fieldsHTML("age") + `<div class="field"><span class="label">Statuses to schedule</span>
      <div class="checks" id="s-statuses">${statusOpts.map(s => `<label>
      <input type="checkbox" value="${s}" ${set.statuses.includes(s) ? "checked" : ""}> ${s}</label>`).join("")}</div>
      <small>Deck: TA and TW only
      </small></div>`) +
    card("NGO FP report", "Rules for the separate NGO FP schedule. Click a matrix cell to switch YES / NO. Rows are the coil rolled first.",
      fieldsHTML("ngo") + `<div class="scroll"><table class="mx" id="mx"></table></div>`) +
    card("Customers", "Untick customers who are not required in this schedule.", picker("cust"), true) +
    card("Grades", "Untick grades that are not required. HRPO/HRSPO use the TDC column, NGO FP uses the order grade.",
      picker("gHR") + picker("gNGO"), true) +
    card("Notifications",
      "Choose what appears under Notifications. Phone or desktop pop-ups appear while the page is open in a background tab.",
      `
        <div class="checks">${[
          ["nBreaks", "Rule breaks in a schedule"], ["nHeld", "Coils held for age"], ["nRemarks", "APL7 remarks typed differently"],
          ["nChanges", "Rules changed on another device"], ["nToast", "Pop-up inside the page"], ["nBrowser", "Device notifications"]
        ].map(([k, l]) => `
        <label><input type="checkbox" id="s-${k}" ${set[k] ? "checked" : ""}> ${l}</label>`).join("")}</div>`, true);
  renderMatrix(); renderPickers(); markChanged();
}
const PK = {
  cust: { title: "Customer", key: "exCust", src: () => rows.filter(o => grpOf(o)), val: o => S(o.Cust) },
  gHR: { title: "HRPO / HRSPO TDC", key: "exGradeHR", src: () => rows.filter(o => grpOf(o) === "HR"), val: o => S(o.Tdc) },
  gNGO: { title: "NGO FP grade", key: "exGradeNGO", src: () => rows.filter(o => grpOf(o) === "NGO"), val: o => S(o["Ord Crgrade"]) }
};
const picker = id => `<div class="picker"><div class="bar"><span class="label">${PK[id].title}</span>
  <input type="search" id="q-${id}" placeholder="Search" aria-label="Search ${PK[id].title}">
  <button class="btn" data-pk="${id}" data-all="1">Select all</button><button class="btn" data-pk="${id}" data-all="0">Clear all</button>
  <span class="muted" id="n-${id}" style="font-size:.8rem"></span></div><div class="plist" id="l-${id}"></div></div>`;
function renderPickers() { for (const id in PK) renderPicker(id); }
function renderPicker(id) {
  const p = PK[id]; const cnt = {};
  p.src().forEach(o => { const v = p.val(o) || "(blank)"; cnt[v] = (cnt[v] || 0) + 1; });
  const q = S(($("#q-" + id) || {}).value).toLowerCase(); const ex = set[p.key];
  const keys = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || a.localeCompare(b));
  $("#n-" + id).textContent = `${keys.filter(k => !ex.includes(k)).length} of ${keys.length} selected`;
  $("#l-" + id).innerHTML = keys.filter(k => !q || k.toLowerCase().includes(q)).map(k => `<label class="${ex.includes(k) ? "off" : ""}">
    <input type="checkbox" data-pkv="${id}" value="${esc(k)}" ${ex.includes(k) ? "" : "checked"}><span>${esc(k)}</span>
    <em>${cnt[k]} coil${cnt[k] > 1 ? "s" : ""}</em></label>`).join("")
      || `<label><span></span><span class="muted">No match</span><span></span>
    </label>`;
  p._keys = keys;
}
function renderMatrix() {
  $("#mx").innerHTML = `<thead><tr><th>First â†“ Next â†’</th>${GR.map((g, i) => `<th>${g}<br><span class="muted">${SI[i]}%</span>
    </th>`).join("")}</tr></thead><tbody>${GR.map(r => `<tr><th>${r}</th>${[...set.matrix[r]].map((c, i) => `<td>
    <button data-mx="${r}" data-i="${i}" class="${c === "Y" ? "y" : "x"}"
      aria-label="${r} then ${GR[i]}: ${c === "Y" ? "allowed" : "not allowed"}">${c === "Y" ? "YES" : "NO"}
    </button></td>`).join("")}</tr>`).join("")}</tbody>`;
}
function markChanged() { NUM.forEach(f => { const h = $("#h-" + f.k); if (h) h.classList.toggle("changed", set[f.k] !== DEFAULTS[f.k]); });
  }

const form = $("#settingsForm");
form.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "editorKey") { editorKey = t.value.trim(); ls.set("cpl2.key", editorKey); return; }
  if (t.dataset.k) { const f = NUM.find(x => x.k === t.dataset.k); const v = N(t.value); if (v == null && !f.blank) return; set[f.k] = v;
    markChanged(); changed(); }
  else if (t.id === "s-critTdcs") { set.critTdcs = t.value; changed(); }
  else if (t.id && t.id.startsWith("q-")) renderPicker(t.id.slice(2));
});
form.addEventListener("change", async e => {
  const t = e.target;
  if (t.id === "editorKey") { if (editorKey) { await saveSettings(); toast("Editor key saved on this device"); } return; }
  if (t.closest("#s-statuses")) { set.statuses = [...document.querySelectorAll("#s-statuses input:checked")].map(i => i.value); changed(); }
  else if (t.dataset.pkv) {
    const p = PK[t.dataset.pkv]; const ex = new Set(set[p.key]);
    t.checked ? ex.delete(t.value) : ex.add(t.value); set[p.key] = [...ex];
    t.closest("label").classList.toggle("off", !t.checked);
    const keys = p._keys || []; $("#n-" + t.dataset.pkv).textContent = `${keys.filter(k => !ex.has(k)).length} of ${keys.length} selected`;
    changed();
  }
  else if (t.id === "s-nBrowser") {
    if (t.checked) {
      if (!("Notification" in window)) { t.checked = false; toast("This browser does not support device notifications."); return; }
      const p = await Notification.requestPermission();
      if (p !== "granted") { t.checked = false; toast("Notifications are blocked. Allow them in the browser's site settings."); return; }
    }
    set.nBrowser = t.checked; changed();
  }
  else if (t.id && t.id.startsWith("s-") && t.type === "checkbox") { set[t.id.slice(2)] = t.checked; changed(); }
});
form.addEventListener("click", e => {
  const b = e.target.closest("button[data-mx]");
  if (b) {
    const r = b.dataset.mx, i = +b.dataset.i; const a = [...set.matrix[r]];
    a[i] = a[i] === "Y" ? "N" : "Y"; set.matrix[r] = a.join("");
    renderMatrix(); changed();
    const nb = $(`button[data-mx="${r}"][data-i="${i}"]`); nb && nb.focus();
    return;
  }
  const pk = e.target.closest("button[data-pk]");
  if (pk) { const p = PK[pk.dataset.pk]; set[p.key] = pk.dataset.all === "1" ? [] : (p._keys || []).slice(); renderPicker(pk.dataset.pk);
    changed(); }
});
let resetArm = 0;
$("#resetBtn").addEventListener("click", () => {
  if (Date.now() - resetArm > 4000) {
    resetArm = Date.now(); $("#resetBtn").textContent = "Click again to reset";
    setTimeout(() => ($("#resetBtn").textContent = "Reset to default rules"), 4000); return;
  }
  resetArm = 0; $("#resetBtn").textContent = "Reset to default rules";
  set = R.withDefaults({}); renderSettings(); changed(); toast("Rules reset to defaults");
});

/* ---------- saving ---------- */
let saveT = null;
function changed() { run(); setSave("pending"); clearTimeout(saveT); saveT = setTimeout(saveSettings, 700); }
async function saveSettings() {
  ls.set("cpl2.settings", set);
  const ok = await saveRemote("settings", "/api/settings", set);
  setSave(ok ? "ok" : "local");
}
function setSave(s) {
  const el = $("#saveState");
  const t = { pending: "Savingâ€¦", ok: "All changes saved for every device", local: "Saved on this device only" }[s];
  el.className = "sync " + (s === "ok" ? "on" : s === "local" ? "local" : "");
  el.querySelector("span").textContent = t;
}
function setSync() {
  const el = $("#sync");
  el.className = "sync " + (online ? "on" : "local");
  el.querySelector("span").textContent = online ? "Synced across devices" : "Offline: saved on this device";
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
  if (!ok) toast("The file is loaded on this device. It could not be shared with other devices.");
}

/* ---------- loading a stock file ---------- */
function loadAOA(aoa, name) {
  const hi = aoa.findIndex(r => r && r.some(c => S(c) === "HR Coil No"));
  if (hi < 0) { toast("No â€œHR Coil Noâ€ column found. Load the Hrstock Report export."); return; }
  const head = aoa[hi].map(S); const idx = KEEP.map(c => head.indexOf(c));
  const missing = KEEP.filter((c, i) => idx[i] < 0);
  const data = aoa.slice(hi + 1).filter(r => r && r.some(c => c != null && c !== "")).map(r => idx.map(i => {
    if (i < 0) return null; const v = r[i];
    return typeof v === "number" ? Math.round(v * 1000) / 1000 : v == null ? null : S(v);
  }));
  stock = { name, cols: KEEP, rows: data }; useStock(); saveStock();
  pushEvent("ok", `Loaded ${name}: ${data.length} rows` + (missing.length ? `. Missing columns: ${missing.join(", ")}` : ""));
  toast(`${data.length} rows loaded from ${name}`);
}
$("#file").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  if (typeof XLSX === "undefined") { toast("The spreadsheet reader did not load. Check the connection and reload."); return; }
  try {
    const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
    const sh = wb.Sheets[wb.SheetNames.find(n => /hrstock/i.test(n)) || wb.SheetNames[0]];
    loadAOA(XLSX.utils.sheet_to_json(sh, { header: 1, raw: true, defval: null }), f.name);
  } catch (err) { toast("That file could not be read. Use the .xls or .xlsx export of the HR stock report."); }
  e.target.value = "";
});
function useStock() {
  rows = stock.rows.map(r => { const o = {}; stock.cols.forEach((c, i) => (o[c] = r[i])); return o; });
  $("#srcName").textContent = stock.name; renderSettings(); run();
}

/* ---------- notifications ---------- */
function pushEvent(level, text) {
  events.unshift({ id: "e" + Date.now(), level, text, at: Date.now() });
  events = events.slice(0, 20); ls.set("cpl2.events", events); buildAlerts();
}
function buildAlerts() {
  const a = [];
  for (const g of ["HR", "NGO"]) {
    const ev = R.evaluate(g, ordered(g), set); const sm = R.summary(ev);
    const name = g === "HR" ? "HR schedule" : "NGO FP report";
    if (set.nBreaks && sm.breaks) a.push({ key: `br-${g}-${sm.breaks}`, level: "bad",
      text: `${sm.breaks} rule break${sm.breaks > 1 ? "s" : ""} in the ${name}.`, go: g.toLowerCase(), btn: "Open " + name });
    if (set.nHeld && sm.held) a.push({ key: `hd-${g}-${sm.held}`, level: "warn",
      text: `${sm.held} coil${sm.held > 1 ? "s" : ""} in the ${name} ${sm.held > 1 ? "are" : "is"} ${set.ageMin} h old or less and held.`,
      go: g.toLowerCase(), btn: "Open " + name });
  }
  const v = R.remarkVariants(res.plan); const n = Object.values(v).reduce((x, y) => x + y, 0);
  if (set.nRemarks && n) a.push({ key: `rm-${n}`, level: "warn",
    text: `${n} coil${n > 1 ? "s have" : " has"} receiving remark ${Object.keys(v).map(k => "â€œ" + k + "â€").join(" / ")}` +
      " instead of APL7 and stayed in PLAN.",
    go: "prep", btn: "Open data prep" });
  if (!a.length) a.push({ key: "clear", level: "ok", text: "No open alerts. Both schedules follow the current rules." });
  const ev = events.filter(e => set.nChanges || !e.text.startsWith("Rules changed")).map(e => ({ key: e.id, level: e.level, text: e.text,
    at: e.at }));
  const prev = new Set(alerts.map(x => x.key));
  alerts = a.concat(ev);
  const unseen = alerts.filter(x => !seen[x.key] && x.key !== "clear");
  $("#bellCount").hidden = !unseen.length; $("#bellCount").textContent = unseen.length;
  const kindOf = k => k.replace(/-\d+$/, ""), numOf = k => +k.split("-").pop() || 0;
  const fresh = alerts.filter(x => x.key !== "clear" && !seen[x.key] && !prev.has(x.key) &&
    (x.at || numOf(x.key) > (lastN[kindOf(x.key)] || 0)));
  lastN = {}; a.forEach(x => (lastN[kindOf(x.key)] = numOf(x.key)));
  if (booted && fresh.length) {
    if (set.nToast) toast(fresh[0].text);
    if (set.nBrowser && document.hidden && "Notification" in window && Notification.permission === "granted") {
      try { new Notification("CPL-2 Scheduler", { body: fresh[0].text, tag: kindOf(fresh[0].key) }); } catch (e) {}
    }
  }
  if (!$("#drawer").hidden) renderDrawer();
}
function renderDrawer() {
  $("#nlist").innerHTML = alerts.map(x => `<div class="nitem ${x.level}${!seen[x.key] && x.key !== "clear" ? " new" : ""}"><i></i><div>
    <p>${esc(x.text)}</p>${x.at ? `<small>${new Date(x.at).toLocaleString()}</small>` : "<small>Current</small>"}${x.go ? `<br>
    <button class="btn" data-goto="${x.go}">${x.btn}</button>` : ""}</div></div>`).join("");
}
function openDrawer() { $("#drawer").hidden = false; $("#shade").hidden = false; renderDrawer(); $("#closeDrawer").focus(); }
function closeDrawer() { alerts.forEach(x => (seen[x.key] = 1)); ls.set("cpl2.seen", seen); $("#drawer").hidden = true;
  $("#shade").hidden = true; buildAlerts(); }
$("#bellBtn").onclick = openDrawer; $("#closeDrawer").onclick = closeDrawer; $("#shade").onclick = closeDrawer;
$("#markRead").onclick = () => { alerts.forEach(x => (seen[x.key] = 1)); ls.set("cpl2.seen", seen); renderDrawer(); buildAlerts(); };
$("#nlist").addEventListener("click", e => { if (e.target.closest("[data-goto]")) closeDrawer(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer(); });
let toastT;
function toast(t) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toastT);
  toastT = setTimeout(() => (el.hidden = true), 3600); }

/* ---------- tabs ---------- */
function showTab(id) {
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === id));
  ["hr", "ngo", "rules", "prep", "history"].forEach(t => ($("#p-" + t).hidden = t !== id));
  if (id === "history") renderHistory();
  ls.set("cpl2.tab", id); history.replaceState(null, "", "#" + id); window.scrollTo({ top: 0 });
}
document.querySelectorAll("nav.tabs button").forEach(b => (b.onclick = () => showTab(b.dataset.tab)));

/* ---------- history tab ---------- */
function renderHistory() {
  const el = $("#histList");
  if (!events.length) {
    el.innerHTML = '<div class="stage"><div class="no">â€”</div><div><p style="color:var(--muted)">No events recorded yet. Load a stock file or change a rule.</p></div><div></div></div>';
    return;
  }
  el.innerHTML = events.map(e => {
    const col = e.level === "bad" ? "var(--bad)" : e.level === "warn" ? "var(--heat)" : "var(--ok)";
    const time = new Date(e.at).toLocaleString();
    return `<div class="stage">
      <div class="no" style="color:${col};font-weight:600">${e.level.toUpperCase()}</div>
      <div><p>${esc(e.text)}</p></div>
      <div class="meter"><div class="nums"><span class="muted">${time}</span></div></div>
    </div>`;
  }).join("");
  $("#cHist").textContent = events.length;
}
$("#clearHistBtn").onclick = () => {
  events = []; ls.set("cpl2.events", events); renderHistory();
  $("#cHist").textContent = "";
  toast("History cleared");
};

/* ---------- sync with the server ---------- */
// Applies anything on the server that is newer than what this device last saw.
async function pull(first) {
  let body;
  try { body = await api("GET", "/api/state"); online = true; } catch (e) { online = false; setSync(); return; }
  const wasKey = requiresKey; requiresKey = !!body.requiresKey;
  const st = body.state || {};
  const newer = k => st[k] && st[k].updatedAt !== versions[k];
  let rerun = false;
  if (newer("settings")) {
    set = R.withDefaults(st.settings.data); ls.set("cpl2.settings", set);
    if (!first) pushEvent("warn", "Rules changed on another device.");
    rerun = true;
  } else if (first && !st.settings && ls.get("cpl2.settings") && (!requiresKey || editorKey)) {
    saveSettings(); // first run against an empty server: share this device's settings
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

/* ---------- start ---------- */
(async function boot() {
  if (!stock) {
    try { const r = await fetch("sample-stock.json"); const j = await r.json(); stock = { name: SAMPLE_NAME, cols: j.cols, rows: j.rows }; }
    catch (e) { stock = { name: "No stock loaded", cols: KEEP, rows: [] }; }
  }
  useStock();
  const start = location.hash.slice(1);
  showTab(["hr", "ngo", "rules", "prep"].includes(start) ? start : ls.get("cpl2.tab") || "hr");
  setSync();
  await pull(true);
  booted = true;
  setInterval(() => pull(false), POLL_MS); // keeps polling in a background tab so device notifications can fire
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pull(false); });
})();
