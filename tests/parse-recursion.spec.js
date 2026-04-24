// Confirms that Firefox's parser throws `InternalError: too much
// recursion` at SCRIPT COMPILE TIME when given a right-leaning ternary
// chain above a depth Chromium's V8 parses comfortably.
//
// Each test case:
//   1. Generates a fixture .js file containing a single ternary-chain
//      assignment (see scripts/build-fixture.js).
//   2. Serves it to the browser via page.addScriptTag({ path: … }).
//   3. Checks whether the browser parsed it (window.__parsed__) or
//      raised a parse error via window.onerror.
//
// We run three fixture variants (template-literal branches, double-
// quoted string branches, numeric branches) to show the parse failure
// depends on depth, not on what kind of literal is in each branch.

const { test, expect } = require("@playwright/test");
const { spawnSync } = require("child_process");
const path = require("path");

const BUILD = path.resolve(__dirname, "..", "scripts", "build-fixture.js");

function buildFixture(depth, variant) {
  const r = spawnSync(
    process.execPath,
    [BUILD, String(depth), variant],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error("build-fixture failed: " + r.stderr);
  }
  return path.resolve(
    __dirname,
    "..",
    "fixtures",
    `ternary-${variant}-${depth}.js`,
  );
}

// Blank page with an error listener registered before any script tag.
const errorCapturingPage = `<!doctype html>
<html><head><script>
  window.__errors__ = [];
  window.addEventListener("error", function (e) {
    window.__errors__.push({
      message: (e.error && e.error.message) || e.message || "",
      filename: e.filename || "",
      line: e.lineno || 0,
      col: e.colno || 0,
    });
  }, true);
</script></head><body></body></html>`;

async function loadFixture(page, fixturePath) {
  await page.setContent(errorCapturingPage, { waitUntil: "load" });
  let scriptTagError;
  try {
    await page.addScriptTag({ path: fixturePath });
  } catch (err) {
    scriptTagError = String((err && err.message) || err);
  }
  const result = await page.evaluate(() => ({
    parsed: Boolean(window.__parsed__),
    depth: window.__depth__ || null,
    variant: window.__variant__ || null,
    errors: window.__errors__ || [],
    result: typeof window.result === "string" ? window.result : null,
  }));
  return { ...result, scriptTagError };
}

// Depths chosen to bracket the observed Firefox threshold (4000 passes,
// 5000 fails). The high-end confirms the failure is stable, not a
// flake near the boundary.
const FAIL_DEPTHS = [5_000, 10_000, 100_000];
const PASS_DEPTHS = [1_000, 2_000, 3_000, 4_000];

for (const variant of ["template", "string", "number"]) {
  test.describe(`ternary branches: ${variant}`, () => {
    for (const depth of PASS_DEPTHS) {
      test(`depth=${depth} (expected: both engines parse)`, async ({
        page,
        browserName,
      }) => {
        const fixture = buildFixture(depth, variant);
        const r = await loadFixture(page, fixture);
        expect(
          r.parsed,
          `${browserName} should parse ${variant} ternary at depth ${depth}: errors=${JSON.stringify(r.errors)}`,
        ).toBe(true);
      });
    }
    for (const depth of FAIL_DEPTHS) {
      test(`depth=${depth} (expected: firefox fails, chromium parses)`, async ({
        page,
        browserName,
      }) => {
        const fixture = buildFixture(depth, variant);
        const r = await loadFixture(page, fixture);
        if (browserName === "firefox") {
          expect(
            r.parsed,
            `firefox should FAIL to parse ${variant} ternary at depth ${depth}`,
          ).toBe(false);
          const msg = (r.errors[0]?.message || "").toLowerCase();
          expect(
            msg.includes("recursion") || msg.includes("stack"),
            `firefox error should mention recursion/stack: ${JSON.stringify(r.errors)}`,
          ).toBe(true);
        } else if (browserName === "chromium") {
          expect(
            r.parsed,
            `chromium should parse ${variant} ternary at depth ${depth}`,
          ).toBe(true);
        }
      });
    }
  });
}
