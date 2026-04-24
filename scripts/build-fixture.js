// Generates a JavaScript fixture that defines a single variable whose
// value is a right-leaning ternary chain of configurable depth. Each
// branch is a template literal. The generator writes to fixtures/ so
// the test can serve the file to the browser.
//
// Usage: node scripts/build-fixture.js <depth> [variant]
//   variant = "template" (default) | "string" | "number"
//
// variant controls whether the ternary branches are:
//   - "template":  `k0`, `v0`  — the shape that triggers the bug
//   - "string":    "k0", "v0"  — SpiderMonkey handles this fine
//   - "number":    0, 1        — also fine; included for comparison
//
// The output is a .js file whose only statement is:
//   window.result = (e === BRANCH0 ? VAL0 : e === BRANCH1 ? VAL1 : ... : undefined);
//
// Firefox's parser decides whether to choke at script-compile time
// based solely on this expression's shape and depth.

"use strict";

const fs = require("fs");
const path = require("path");

const depth = Number(process.argv[2]);
const variant = process.argv[3] || "template";
if (!Number.isInteger(depth) || depth < 1) {
  console.error("usage: node build-fixture.js <depth> [template|string|number]");
  process.exit(1);
}

function branch(i) {
  if (variant === "template") return ["`k" + i + "`", "`v" + i + "`"];
  if (variant === "string") return ['"k' + i + '"', '"v' + i + '"'];
  if (variant === "number") return [String(i), String(i + 1_000_000)];
  throw new Error("unknown variant: " + variant);
}

const parts = [];
for (let i = 0; i < depth; i++) {
  const [k, v] = branch(i);
  parts.push("e === " + k + " ? " + v);
}
const expr = parts.join(" : ") + " : undefined";

// Pre-pick the "last-branch" input so the evaluator would walk every
// level if it ever ran — but this bug shows up at parse time, so the
// function is never invoked.
const lastKey =
  variant === "template"
    ? "`k" + (depth - 1) + "`"
    : variant === "string"
      ? '"k' + (depth - 1) + '"'
      : String(depth - 1);

const src =
  "window.__depth__ = " +
  depth +
  ";\n" +
  "window.__variant__ = " +
  JSON.stringify(variant) +
  ";\n" +
  "window.result = (function(e) { return " +
  expr +
  "; })(" +
  lastKey +
  ");\n" +
  "window.__parsed__ = true;\n";

const outDir = path.resolve(__dirname, "..", "fixtures");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `ternary-${variant}-${depth}.js`);
fs.writeFileSync(outPath, src);
console.log(
  "wrote " +
    path.relative(process.cwd(), outPath) +
    " (" +
    (src.length / 1024).toFixed(1) +
    " KB, variant=" +
    variant +
    ", depth=" +
    depth +
    ")",
);
