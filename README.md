# Firefox parser: `InternalError: too much recursion` on deep ternary chains

A minimal, reproducible demonstration that **Firefox's SpiderMonkey JS
parser refuses to parse a right-leaning `?:` chain once it exceeds a
depth of roughly 4000-5000 levels**, throwing
`InternalError: too much recursion` **at script compile time** before
any JavaScript in the file has run.

The same source parses cleanly in Chromium's V8 at depths up to at
least 100 000.

This is a parser limit, not a runtime limit. The generated ternary is
never invoked; Firefox throws while compiling the `<script>` body.

Tracking issue:
[bugzilla.mozilla.org/show_bug.cgi?id=2034840](https://bugzilla.mozilla.org/show_bug.cgi?id=2034840).

---

## Why this matters

We hit this in a production React / Single-Page App whose JavaScript
minifier collapses long `if (x === K1) return V1; if (x === K2) return
V2; …` chains (each chunk-ID-to-filename case in a webpack-generated
function) into a single right-leaning ternary expression. At ~4400
entries the output sits right at Firefox's parser threshold. Chromium
loads the app normally; Firefox fails to parse the runtime bundle and
the page falls back to an error UI. The error message in the browser
console is just:

```
Uncaught InternalError: too much recursion
```

with no filename, no line number, no stack: the classic signature of
a script-compile-time parser failure.

We confirmed with the real bundle that Firefox's parser was the choke
point by loading the minified runtime as a plain `<script src=…>` in a
throwaway HTML page. The same error appeared, and `window.onerror`
reported `filename: -` and `line: 0:1`. The generated function is
never called, so this is unambiguously a parse-time failure.

This repo is the minimal repro extracted from that investigation,
with no reference to any specific application or minifier.

---

## What this repo contains

```
.
├── scripts/build-fixture.js      # generate a ternary-chain .js file of N levels
├── tests/parse-recursion.spec.js # Playwright test: assert parse pass/fail per depth
├── repro.html                    # standalone browser repro (no Playwright)
├── playwright.config.js
└── fixtures/                     # generated (gitignored), produced by build-fixture.js
```

`build-fixture.js` generates a single JavaScript file whose only code is:

```js
window.__depth__ = <N>;
window.__variant__ = "<template|string|number>";
window.result = (function (e) {
  return e === <k0> ? <v0>
       : e === <k1> ? <v1>
       : e === <k2> ? <v2>
       : …
       : undefined;
})(<kN-1>);
window.__parsed__ = true;
```

`<k*>`/`<v*>` are one of three shapes: **template literals** like
`` `k0` `` / `` `v0` ``, **double-quoted strings** like `"k0"` / `"v0"`,
or **plain numbers** like `0` / `1000000`. The test runs all three
variants to show the parse failure is purely about depth; the kind of
literal on each side does not change the threshold.

---

## Reproducing it yourself

```bash
git clone https://github.com/guru-irl/firefox-ternary-parse-recursion.git
cd firefox-ternary-parse-recursion
npm install
npm run install-browsers        # installs Chromium and Firefox via Playwright
npm test                        # run the suite
```

Playwright will:
1. Generate `fixtures/ternary-<variant>-<depth>.js` for each of the
   seven depths under test.
2. For each browser × depth × variant, open a blank page, inject the
   fixture as `<script src=…>`, and check whether parsing succeeded.
3. Assert that Firefox fails above the threshold and Chromium does not.

Expected output: **42 passed** (7 depths × 3 variants × 2 browsers).
If the suite ever reports something other than all-pass on a new
browser version, the threshold has shifted; inspect the logged
message and adjust `PASS_DEPTHS` / `FAIL_DEPTHS` in
`tests/parse-recursion.spec.js`.

### One-shot manual reproduction

If you just want to see the error without running a Playwright test:

```bash
node scripts/build-fixture.js 5000 template   # generates fixtures/ternary-template-5000.js
python3 -m http.server 8000                   # or any static server
```

Open `http://localhost:8000/repro.html?depth=5000` in Firefox; the
page shows `❌ parse / load failure` with an error object whose
`message` is `too much recursion`. Open the same URL in Chromium and
the page shows `✅ parsed and executed, window.result = "v4999"`.

Change depth via `?depth=<N>`; try `?variant=string` or
`?variant=number` to confirm the threshold is the same for any branch
literal type. Fixtures must exist for the selected depth/variant
combination, pre-generate them with:

```bash
for d in 1000 3000 5000 10000; do node scripts/build-fixture.js $d template; done
```

(Opening the fixture `.js` file directly in a browser doesn't trigger
the error: the browser just displays the source as text. The parse
error fires only when the file is loaded via a `<script src=…>` tag,
which is what `repro.html` and the Playwright suite do.)

### Fastest way to see the bug without running anything

`scripts/build-fixture.js 5000` is literally:
```js
window.result = (function (e) {
  return e === `k0` ? `v0`
       : e === `k1` ? `v1`
       : …  // 4998 more branches
       : e === `k4999` ? `v4999`
       : undefined;
})(`k4999`);
```

Paste that (fully expanded) into Firefox's DevTools console → "too
much recursion". Paste it into Chrome's DevTools console → returns
`"v4999"`.

---

## Measured threshold

| Depth | Chromium 147 | Firefox 148 |
| ---: | :---: | :---: |
| 1 000 | ✅ parses | ✅ parses |
| 2 000 | ✅ | ✅ |
| 3 000 | ✅ | ✅ |
| 4 000 | ✅ | ✅ |
| 5 000 | ✅ | ❌ `InternalError: too much recursion` |
| 10 000 | ✅ | ❌ |
| 100 000 | ✅ | ❌ |

Identical results for template-literal, double-quoted-string, and
numeric branches.

---

## What we think is happening

SpiderMonkey's ternary (`ConditionalExpression`) parser recurses
whenever it sees a `? A : B` where `B` is itself a
`ConditionalExpression`. Each nested `? :` adds one native stack frame
to the parser. At roughly 4500 frames the parser runs out of its
compile-time stack and throws `InternalError: too much recursion`
without reporting a source location (because there is no source
location yet, it hasn't produced a bytecode offset).

V8 appears to handle the same grammatical structure with an iterative
or much more shallowly-recursive parse, so the same source text
compiles without trouble.

We have not looked at the SpiderMonkey source; everything above is
inferred from the observed behaviour.

---

## Why it bites us in real code

Some JavaScript minifiers collapse long chains of `if (cond) return x;`
statements into a single `return cond1 ? x : cond2 ? y : …;`
expression as a size optimisation. In our specific case the generated
webpack runtime lists one `if-return` per async chunk in a function
called `__webpack_require__.u(chunkId)`, and the minifier in our
pipeline rewrites those hundreds or thousands of statements into one
right-leaning ternary. A few thousand chunks is enough to produce a
ternary that collapses to 4000+ levels and pushes us over Firefox's
threshold.

Because the parser error happens before any code runs, React's error
boundaries never catch it; the browser just surfaces the raw error
and the app fails to bootstrap.

---

## For the Firefox / SpiderMonkey team

Repro is as above: run `npm test` in this repo, or paste the one-shot
script into a devtools console.

What would be useful from you:
1. **Documented parser depth limit.** Knowing the exact threshold per
   expression type would let tool authors cap generated code well
   below it.
2. **Better error signal.** "Uncaught InternalError: too much
   recursion" with no filename or position, while technically correct,
   is extremely hard to diagnose, especially when the expression is
   thousands of lines inside a multi-megabyte minified bundle. A
   filename and a position (even if approximate) would make this
   discoverable through normal debugging channels.
3. **An iterative parse path for right-leaning `ConditionalExpression`
   chains.** V8's equivalent handles 100 000+ without trouble; this
   grammar is inherently right-associative but the traversal doesn't
   need to use the native stack for it.
---

## License

MIT.
