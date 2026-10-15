/*
 * CPL-2 scheduling rules engine.
 * Pure functions with no page or server code, so the same file runs in the
 * browser (window.Rules) and in Node for the tests (require("./public/rules")).
 */
(function (root, factory) {
  const R = factory();
  if (typeof module === "object" && module.exports) module.exports = R;
  else root.Rules = R;
})(typeof self !== "undefined" ? self : this, function () {
  // NGO FP silicon grades, lowest to highest silicon, and their max Si %
  const GR = ["LSQ2L", "MSQ1", "MSQ2", "MSQ3", "HSQ1", "HSQ2", "HSQ3", "HSQ5"];
  const SI = ["0.45", "0.9", "1.3", "1.55", "1.7", "2.0", "2.2", "2.6"];

  // Default rule values. Every one of these can be changed in Rules & settings.
  const DEFAULTS = {
    thinJump: 0.8,        // max thickness jump, thinner gauge (mm)
    thickJump: 1.0,       // max thickness jump, thicker gauge (mm)
    thickFrom: 4.0,       // thicker gauge starts at (mm)
    thinWidth: 180,       // max width change, thinner gauge (mm)
    thickWidth: 300,      // max width change, thicker gauge (mm)
    thickWidthWarn: 250,  // flag ("check") thicker width change above (mm), null = off
    thkMin: 1.6, thkMax: 6.0,          // range of thickness (mm)
    startThk: null, startWdt: null,    // where auto-arrange starts, null = thinnest / widest
    sameThk: true,        // same thickness coils one after another (strict)
    critThk: 4.5,         // critical TDC rule applies above this thickness (mm)
    critTdcs: "JVPST01C00, JVPFB60AJS, JVPTR14AJS, JVPTR15AJS, JVPTR13AJS",
    ageMin: 72,           // coils must be older than this (hours)
    statuses: ["TA", "TW"],
    ngoWidth: 150,        // NGO FP max width jump (mm)
    ngoThk: null,         // NGO FP max thickness jump (mm), null = not checked
    // Row = coil rolled first, column = next coil, in GR order. Y = allowed weld.
    matrix: {
      LSQ2L: "YYYYYNNN", MSQ1: "YYYYYNNN", MSQ2: "YYYYYYNN", MSQ3: "YYYYYYYN",
      HSQ1: "YYYYYYYY", HSQ2: "YYYYYYNN", HSQ3: "NNNYYNNN", HSQ5: "NNNNYNNN"
    },
    exCust: [], exGradeHR: [], exGradeNGO: [],   // excluded customers / grades
    nBreaks: true, nHeld: true, nRemarks: true, nChanges: true, nToast: true, nBrowser: false
  };

  const S = v => (v == null ? "" : String(v).trim());
  const N = v => { if (v === "" || v == null) return null; const x = parseFloat(v); return isNaN(x) ? null : x; };
  const prodKey = o => S(o.Product).toUpperCase().replace(/\s/g, "");
  const grpOf = o => { const p = prodKey(o); return p === "NGOFP" ? "NGO" : (p === "HRPO" || p === "HRSPO") ? "HR" : null; };
  const gradeOf = o => (grpOf(o) === "NGO" ? S(o["Ord Crgrade"]) : S(o.Tdc));
  const thkKey = o => (N(o.Thk) == null ? "" : N(o.Thk).toFixed(2));
  const clone = o => JSON.parse(JSON.stringify(o));

  // Fill any missing settings from DEFAULTS (keeps old saved settings working).
  function withDefaults(s) {
    const m = Object.assign(clone(DEFAULTS), s || {});
    m.matrix = Object.assign(clone(DEFAULTS.matrix), (s && s.matrix) || {});
    return m;
  }
  const critList = set => S(set.critTdcs).split(/[\s,;]+/).filter(Boolean).map(x => x.toUpperCase());

  /* ---------- Part A: data preparation (deck steps 1-14 + user filters) ---------- */
  function stages(set) {
    const nEx = set.exGradeHR.length + set.exGradeNGO.length;
    return [
      { no: "1", t: "Clean the report", d: "Delete the first column and row so the column names sit in row 1.",
        r: "header row = row containing “HR Coil No”" },
      { no: "2", t: "Filter the product", d: "Keep only the products this line schedules.", r: "Product ∈ {HRPO, HRSPO, NGO FP}",
        f: o => !!grpOf(o) },
      { no: "3–4", t: "Fresh path only", d: "Act Path and Prev Unit must both be zero.", r: "Act Path = 0 AND Prev Unit = 0",
        f: o => S(o["Act Path"]) === "0" && S(o["Prev Unit"]) === "0" },
      { no: "5–6", t: "Move to the PLAN sheet", d: "Copy into the Plan sheet and delete columns not needed for scheduling.",
        r: "keep required columns" },
      { no: "7–8", t: "Status", d: "Remove TD and TU, keep only the statuses chosen in settings.",
        r: "Status ∈ {" + set.statuses.join(", ") + "}", f: o => set.statuses.includes(S(o.Status).toUpperCase()) },
      { no: "9", t: "Drop closed orders", d: "Delete every CLOSED row from Order status.", r: "Order_status ≠ CLOSED",
        f: o => S(o.Order_status).toUpperCase() !== "CLOSED" },
      { no: "10–13", t: "Split out APL7", d: "Rows with receiving remark APL7 go to the APL7 sheet.",
        r: "Receiving Remarks = APL7 → APL7 sheet", split: true },
      { no: "Filter", t: "Thickness range", d: "Coils outside the thickness range set in Rules are left out.",
        r: set.thkMin + " mm ≤ Thk ≤ " + set.thkMax + " mm", f: o => { const t = N(o.Thk);
        return t != null && t >= set.thkMin - 1e-9 && t <= set.thkMax + 1e-9; } },
      { no: "Filter", t: "Customers", d: "Customers unticked in Rules are left out.",
        r: set.exCust.length + " customer" + (set.exCust.length === 1 ? "" : "s") + " excluded", f: o => !set.exCust.includes(S(o.Cust)) },
      { no: "Filter", t: "Grades", d: "Grades (TDC for HRPO/HRSPO, grade for NGO FP) unticked in Rules are left out.",
        r: nEx + " grade" + (nEx === 1 ? "" : "s") + " excluded",
        f: o => (grpOf(o) === "NGO" ? !set.exGradeNGO.includes(gradeOf(o)) : !set.exGradeHR.includes(gradeOf(o))) },
      { no: "14", t: "Final schedule data", d: "These coils go to the HR schedule and the NGO FP report.", r: "ready to sequence" }
    ];
  }

  // Runs every stage in order. Returns the PLAN coils, the APL7 coils and per-stage counts.
  function runPipeline(rows, set) {
    let cur = rows.slice(), apl = [];
    const steps = [];
    for (const st of stages(set)) {
      const before = cur.length; let a = 0;
      if (st.f) cur = cur.filter(st.f);
      if (st.split) {
        apl = cur.filter(o => S(o["Receiving Remarks"]) === "APL7");
        cur = cur.filter(o => S(o["Receiving Remarks"]) !== "APL7");
        a = apl.length;
      }
      steps.push({ st, before, after: cur.length, apl: a });
    }
    return {
      plan: cur, apl, steps,
      HR: cur.filter(o => grpOf(o) === "HR"),
      NGO: cur.filter(o => grpOf(o) === "NGO")
    };
  }

  // Remarks like "APL 7" or "APL" that the exact APL7 filter misses.
  function remarkVariants(plan) {
    const v = {};
    plan.forEach(o => { const r = S(o["Receiving Remarks"]); if (r && /^apl\s*7?$/i.test(r) && r !== "APL7") v[r] = (v[r] || 0) + 1; });
    return v;
  }

  /* ---------- Part B/C: rules between two coils rolled one after another ---------- */
  // Returns a list of [level, message, kind]; level is "bad" (break) or "warn" (check).
  function pairIssues(a, b, g, set) {
    const iss = [];
    const ta = N(a.Thk), tb = N(b.Thk), wa = N(a.Wdt), wb = N(b.Wdt);
    const dt = ta != null && tb != null ? Math.abs(ta - tb) : null;
    const dw = wa != null && wb != null ? Math.abs(wa - wb) : null;
    const r2 = v => Math.round(v * 100) / 100;
    if (g === "HR") {
      if (dt != null) {
        const thin = Math.min(ta, tb) < set.thickFrom;
        const lim = thin ? set.thinJump : set.thickJump;
        if (dt > lim + 1e-9) iss.push(["bad",
          "Thickness jump " + r2(dt) + " mm > " + lim + " mm (" + (thin ? "thinner" : "thicker") + " gauge)", "t"]);
        if (dw != null) {
          const wl = thin ? set.thinWidth : set.thickWidth;
          if (dw > wl) iss.push(["bad", "Width change " + dw + " mm > " + wl + " mm (" + (thin ? "thinner" : "thicker") + " gauge)", "w"]);
          else if (!thin && set.thickWidthWarn != null && dw > set.thickWidthWarn) iss.push(["warn",
            "Width change " + dw + " mm is above " + set.thickWidthWarn + " mm", "w"]);
        }
        const c = critList(set);
        if (ta > set.critThk && tb > set.critThk && c.includes(S(a.Tdc).toUpperCase()) && c.includes(S(b.Tdc).toUpperCase()))
          iss.push(["bad", "Critical TDC back to back above " + set.critThk + " mm", "c"]);
      }
    } else {
      const ga = S(a["Ord Crgrade"]), gb = S(b["Ord Crgrade"]);
      if (!set.matrix[ga] || !set.matrix[gb]) iss.push(["warn",
        "Grade " + (!set.matrix[ga] ? ga || "blank" : gb || "blank") + " is not in the welding matrix", "g"]);
      else if (set.matrix[ga][GR.indexOf(gb)] !== "Y") iss.push(["bad", ga + " → " + gb + " is not an allowed weld", "g"]);
      if (dw != null && dw > set.ngoWidth) iss.push(["bad", "Width jump " + dw + " mm > " + set.ngoWidth + " mm", "w"]);
      if (set.ngoThk != null && dt != null && dt > set.ngoThk + 1e-9) iss.push(["bad",
        "Thickness jump " + r2(dt) + " mm > " + set.ngoThk + " mm", "t"]);
    }
    return iss;
  }

  const isHeld = (o, set) => { const a = N(o["Age Hours"]); return a != null && a <= set.ageMin; };

  // Checks a whole sequence: each coil against the one before it, plus age and same-thickness rules.
  function evaluate(g, list, set) {
    const firstAt = new Map();
    return list.map((o, i) => {
      const prev = i ? list[i - 1] : null;
      const iss = [];
      if (isHeld(o, set)) iss.push(["held", "Age " + N(o["Age Hours"]) + " h, needs more than " + set.ageMin + " h"]);
      if (prev) iss.push(...pairIssues(prev, o, g, set));
      const key = thkKey(o);
      if (set.sameThk && key && prev && thkKey(prev) !== key && firstAt.has(key))
        iss.push(["bad", key + " mm coils are split. Same thickness must run one after another (first at #" + (firstAt.get(key) + 1) + ")",
          "s"]);
      if (key && !firstAt.has(key)) firstAt.set(key, i);
      const t = N(o.Thk);
      const dt = prev && t != null && N(prev.Thk) != null ? Math.abs(t - N(prev.Thk)) : null;
      const dw = prev && N(o.Wdt) != null && N(prev.Wdt) != null ? Math.abs(N(o.Wdt) - N(prev.Wdt)) : null;
      return { o, iss, dt, dw };
    });
  }

  // Score for putting coil c right after coil cur: rule breaks cost the most.
  function stepCost(cur, c, g, set, sameGradeBonus) {
    const iss = pairIssues(cur, c, g, set);
    const bad = iss.filter(x => x[0] === "bad").length;
    const dw = Math.abs((N(cur.Wdt) || 0) - (N(c.Wdt) || 0));
    const dt = Math.abs((N(cur.Thk) || 0) - (N(c.Thk) || 0));
    return bad * 1e7 + (iss.length - bad) * 1e5 + (sameGradeBonus && gradeOf(c) !== gradeOf(cur) ? 1e3 : 0) + dt * 1000 + dw;
  }
  function pickNext(cur, rem, g, set, sameGrade) {
    let bi = 0, bs = Infinity;
    rem.forEach((c, i) => { const s = stepCost(cur, c, g, set, sameGrade); if (s < bs) { bs = s; bi = i; } });
    return rem.splice(bi, 1)[0];
  }

  /*
   * Auto-arrange. Held coils (too fresh) go to the end.
   * With "same thickness together" on: one block per thickness, blocks visited from the
   * start thickness outward (nearest next thickness first); inside a block, same TDC/grade
   * stays together and width changes are kept small.
   */
  function arrange(list, g, set) {
    const ready = list.filter(o => !isHeld(o, set)), held = list.filter(o => isHeld(o, set));
    if (!ready.length) return held;
    const st = set.startThk, sw = set.startWdt;
    const byStartWidth = (a,
      b) => (sw != null ? Math.abs((N(a.Wdt) || 0) - sw) - Math.abs((N(b.Wdt) || 0) - sw) : (N(b.Wdt) || 0) - (N(a.Wdt) || 0));

    if (set.sameThk) {
      const groups = new Map();
      ready.forEach(o => { const k = thkKey(o); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); });
      let keys = [...groups.keys()].map(Number);
      const seq = [];
      let curT = st != null ? st : Math.min(...keys);
      while (keys.length) {
        keys.sort((a, b) => Math.abs(a - curT) - Math.abs(b - curT) || b - a);
        const k = keys.shift(); curT = k;
        const rem = groups.get(k.toFixed(2)).slice();
        if (!seq.length) { rem.sort(byStartWidth); seq.push(rem.shift()); }
        else seq.push(pickNext(seq[seq.length - 1], rem, g, set, false));
        while (rem.length) seq.push(pickNext(seq[seq.length - 1], rem, g, set, true));
      }
      return seq.concat(held);
    }

    const rem = ready.slice();
    rem.sort((a, b) => {
      if (st != null || sw != null) {
        const s = o => (st != null ? Math.abs((N(o.Thk) || 0) - st) * 1000 : 0) + (sw != null ? Math.abs((N(o.Wdt) || 0) - sw) : 0);
        return s(a) - s(b);
      }
      return (N(a.Thk) || 0) - (N(b.Thk) || 0) || (N(b.Wdt) || 0) - (N(a.Wdt) || 0);
    });
    const seq = [rem.shift()];
    while (rem.length) seq.push(pickNext(seq[seq.length - 1], rem, g, set, true));
    return seq.concat(held);
  }

  // Count rule breaks / checks / held coils in a sequence.
  function summary(ev) {
    let breaks = 0, checks = 0, held = 0;
    ev.forEach(e => e.iss.forEach(x => { if (x[0] === "bad") breaks++; else if (x[0] === "warn") checks++; else if (x[0] === "held") held++;
      }));
    return { breaks, checks, held };
  }

  return { GR, SI, DEFAULTS, S, N, grpOf, gradeOf, thkKey, withDefaults, stages, runPipeline, remarkVariants, pairIssues, isHeld, evaluate,
    arrange, summary };
});
