// Run with: npm test
const test = require("node:test");
const assert = require("node:assert");
const R = require("../public/rules");
const sample = require("../public/sample-stock.json");

const rows = sample.rows.map(r => Object.fromEntries(sample.cols.map((c, i) => [c, r[i]])));
const set = R.withDefaults({});
const coil = (thk, wdt, extra = {}) =>
  Object.assign({ "HR Coil No": String(Math.random()), Thk: thk, Wdt: wdt, Product: "HRPO", "Age Hours": 100, Tdc: "X" }, extra);

test("data prep matches the deck steps on the sample file", () => {
  const res = R.runPipeline(rows, set);
  assert.strictEqual(rows.length, 270);
  assert.strictEqual(res.apl.length, 60);
  assert.strictEqual(res.plan.length, 143); // 144 after step 13, minus one 6.5 mm coil outside 1.6-6 mm
});

test("thinner gauge thickness jump limit is 0.8 mm", () => {
  assert.strictEqual(R.pairIssues(coil(2.0, 1200), coil(2.8, 1200), "HR", set).length, 0);
  const iss = R.pairIssues(coil(2.0, 1200), coil(2.9, 1200), "HR", set);
  assert.ok(iss.some(x => x[0] === "bad" && x[2] === "t"));
});

test("thicker gauge (4 mm and above) thickness jump limit is 1 mm", () => {
  assert.strictEqual(R.pairIssues(coil(4.0, 1200), coil(5.0, 1200), "HR", set).length, 0);
  assert.ok(R.pairIssues(coil(4.0, 1200), coil(5.2, 1200), "HR", set).some(x => x[2] === "t"));
});

test("thinner gauge width change limit is 180 mm", () => {
  assert.strictEqual(R.pairIssues(coil(2, 1200), coil(2, 1380), "HR", set).length, 0);
  assert.ok(R.pairIssues(coil(2, 1200), coil(2, 1390), "HR", set).some(x => x[2] === "w"));
});

test("critical TDCs above 4.5 mm cannot run back to back", () => {
  const a = coil(5, 1200, { Tdc: "JVPST01C00" }), b = coil(5, 1200, { Tdc: "JVPTR14AJS" });
  assert.ok(R.pairIssues(a, b, "HR", set).some(x => x[2] === "c"));
});

test("NGO FP uses the welding matrix and the 150 mm width jump", () => {
  const n = (g, w) => ({ Thk: 2.6, Wdt: w, Product: "NGO FP", "Ord Crgrade": g });
  assert.ok(R.pairIssues(n("LSQ2L", 1000), n("HSQ2", 1000), "NGO", set).some(x => x[2] === "g"));
  assert.strictEqual(R.pairIssues(n("HSQ2", 1000), n("LSQ2L", 1000), "NGO", set).length, 0);
  assert.ok(R.pairIssues(n("LSQ2L", 1000), n("LSQ2L", 1160), "NGO", set).some(x => x[2] === "w"));
});

test("auto-arrange keeps every thickness in one block", () => {
  const res = R.runPipeline(rows, set);
  const seq = R.arrange(res.HR, "HR", set);
  assert.strictEqual(seq.length, res.HR.length);
  const keys = seq.map(R.thkKey);
  const blocks = keys.filter((k, i) => i === 0 || k !== keys[i - 1]);
  assert.strictEqual(blocks.length, new Set(keys).size);
  const ev = R.evaluate("HR", seq, set);
  assert.ok(!ev.some(e => e.iss.some(x => x[2] === "s")), "no split thickness blocks");
});

test("changed settings change the result", () => {
  const strict = R.withDefaults({ thinWidth: 50 });
  assert.ok(R.pairIssues(coil(2, 1200), coil(2, 1260), "HR", strict).some(x => x[2] === "w"));
});
