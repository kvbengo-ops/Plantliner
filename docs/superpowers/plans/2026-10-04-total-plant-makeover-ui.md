# Total Plant Makeover: Form UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the "Total plant makeover" mode to the existing preview section of the homepage form: a mode switch, a plant picker with a quantity for each plant (8 in total at most), and a "How we designed it" panel beside the before/after result.

**Architecture:** Everything stays inside `#plant-plan-form` Step 2 (`#plant-preview`), reusing the existing preview state, polling, restore-from-link, lightbox and enquiry code. The quantity rules live in one small DOM-free module with a runnable test. The whole feature sits behind a `MAKEOVER_ENABLED` constant in `index.astro` that ships as `false`.

**Tech Stack:** Astro 6 (static), TypeScript, plain CSS in `src/styles/global.css`. No new dependencies, no framework.

**Specs and plans:** Design: [`docs/superpowers/specs/2026-10-04-total-plant-makeover-design.md`](../specs/2026-10-04-total-plant-makeover-design.md). Backend plan (the API this UI calls): [`2026-10-04-total-plant-makeover.md`](2026-10-04-total-plant-makeover.md). Earlier decision this extends: [`2026-10-03-unified-form-decision.md`](2026-10-03-unified-form-decision.md).

**Who edits what:** this plan edits `src/pages/index.astro`, `src/scripts/**` and `src/styles/global.css`, which are Codex's files. Codex (or the user) runs it; the plan was written by Claude, who did not touch `src/`. The patches below were generated against the working-tree files as they were on 2026-10-04 at 18:35 and replayed against them.

## Global Constraints

- No new page and no second form: everything is inside Step 2 of `#plant-plan-form`, in `#plant-preview`. The plain enquiry path and the single-plant preview must behave exactly as before.
- `const MAKEOVER_ENABLED = false;` in `src/pages/index.astro` ships `false`. It becomes `true` only when the backend is deployed with migration `0002`, `MAKEOVER_ENABLED=1` is set in Vercel **Production**, and the makeover has passed G0 (single-plant quality gate) and G1 (makeover quality gate).
- The plant total is capped at 8 (`MAX_PLANTS`), the same number as `MAX_PLANTS` in `api/_lib/rules.ts`; `makeover.test.ts` fails if they differ.
- Everything the model wrote (`rationale`, furniture notes, per-plant `why`) is inserted with `textContent` / text nodes, never `innerHTML`.
- A single-plant request body stays exactly `{ image, spaceType, productId, style, placement }`. A makeover body is `{ image, spaceType, mode: "makeover", items: [{ productId, quantity }], style }` with no `productId` or `placement`.
- The privacy line says "Kie" only while the makeover is off, and names Groq once it is on.
- Touch targets are at least 44 px; focus rings stay visible; `prefers-reduced-motion` is respected; no horizontal scrolling at 320, 375, 390, 600, 760 and 1024 px.
- No new dependencies. Model of record for copy: plain, short, no marketing words.
- `src/pages/index.astro`, `src/scripts/plantPlan.ts` and `src/styles/global.css` also contain Codex's other uncommitted work. **Do not commit them in this plan.** Commit only the two new files in Task 1.
- Working-tree files use CRLF line endings, so every `git apply` below uses `--ignore-whitespace`.

### API contract this UI relies on

From the backend plan (Task 4); build against it even before it is deployed.

- `POST /api/visualizations` with `{ image, spaceType, mode: "makeover", items: [{ productId, quantity }], style, dims? }` returns `201 { id }`. `400 { error }` for bad input, `404` while the server flag `MAKEOVER_ENABLED` is not `1`, `429` at the daily cap, `502` when the designer or Kie cannot start.
- `GET /api/visualizations/:id` returns the existing fields plus `mode: "single" | "makeover"` (absent on old previews), `rationale: string | null` and `layout: { furniture: string[], plants: [{ productId, count, placement, why }] } | null`.
- The enquiry endpoint is unchanged: one optional `productId` and an optional `visualizationId`.

## Review Focus

1. **Quantities typed or pasted out of range** (negative, decimal, `abc`, more than the cap): clamped, never sent (Task 1 unit tests; Task 3 check B).
2. **An old shared link with no `mode`:** still restores as a single-plant preview (Task 3 check E).
3. **A makeover link opened while the UI flag is off:** refused with a message and the link parameter removed, not half-restored (Task 3 check G).
4. **HTML inside the model's text:** shown as literal text (Task 3 check C).
5. **Double-clicking "Create my makeover", or changing anything after a result:** one request only; the old result is cleared (Task 3 checks C and D).

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/scripts/makeover.ts` | create | Quantity rules: cap, clamp, to and from the API's `items` |
| `src/scripts/makeover.test.ts` | create | Runnable check, including that the cap equals the server's |
| `src/pages/index.astro` | modify | Mode switch, makeover picker, design panel, ids the script needs |
| `src/scripts/plantPlan.ts` | modify | Mode state, quantity handling, makeover request, restore, design panel |
| `src/styles/global.css` | append | Styles for the new pieces, after the shared preview rules |

---

### Task 1: Quantity logic and its test

**Files:**
- Create: `src/scripts/makeover.ts`
- Create: `src/scripts/makeover.test.ts`

**Interfaces:**
- Consumes: `MAX_PLANTS` in `api/_lib/rules.ts` (backend plan Task 1) for one test only.
- Produces (used by Task 2): `MAX_PLANTS`, `type Item = { productId: string; quantity: number }`, `type Quantities = Record<string, number>`, `total(q)`, `capQuantity(wanted, others)`, `toItems(q)`, `fromItems(items): Quantities | null`, `summarise(items, nameOf)`.

If the first test below fails with `NaN !== 8`, the backend plan's Task 1 has not landed yet, so `api/_lib/rules.ts` has no `MAX_PLANTS`. Do that task first (or ask the user).

- [ ] **Step 1: Write the failing test**

<!-- create: src/scripts/makeover.test.ts -->
**Create `src/scripts/makeover.test.ts`:**

```typescript
// Run with: node --test src/scripts/makeover.test.ts   (Node 22.18+ runs TypeScript directly)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_PLANTS, capQuantity, fromItems, summarise, toItems, total } from './makeover.ts';

test('the cap matches the server, so the picker never offers what the API would refuse', () => {
  const rules = readFileSync(new URL('../../api/_lib/rules.ts', import.meta.url), 'utf8');
  assert.equal(Number(rules.match(/export const MAX_PLANTS = (\d+)/)?.[1]), MAX_PLANTS);
});

test('a plant can be raised only until the total reaches the cap', () => {
  assert.equal(capQuantity(3, 0), 3);
  assert.equal(capQuantity(5, 4), 4); // 4 already chosen elsewhere: 4 more is the most
  assert.equal(capQuantity(1, MAX_PLANTS), 0);
  assert.equal(capQuantity(99, 0), MAX_PLANTS);
});

test('unusable quantities become 0 and fractions round down', () => {
  for (const bad of [-1, NaN, Infinity, -Infinity]) assert.equal(capQuantity(bad, 0), 0, String(bad));
  assert.equal(capQuantity(2.9, 0), 2);
});

test('only plants with a quantity are sent, in the order they were chosen', () => {
  assert.deepEqual(toItems({ monstera: 1, 'snake-plant': 0, 'zz-plant': 2 }), [{ productId: 'monstera', quantity: 1 }, { productId: 'zz-plant', quantity: 2 }]);
  assert.deepEqual(toItems({}), []);
  assert.equal(total({ a: 2, b: 3 }), 5);
});

test('items from a saved preview restore the picker, and anything odd is refused', () => {
  assert.deepEqual(fromItems([{ productId: 'monstera', quantity: 2 }, { productId: 'monstera', quantity: 1 }]), { monstera: 3 });
  const odd = [undefined, [], 'monstera', [null], [{ productId: 'monstera' }], [{ productId: 'monstera', quantity: 0 }], [{ productId: 'monstera', quantity: 1.5 }], [{ productId: 'monstera', quantity: MAX_PLANTS + 1 }], [{ productId: 7, quantity: 1 }]];
  for (const bad of odd) assert.equal(fromItems(bad), null, JSON.stringify(bad));
});

test('the summary reads naturally', () => {
  assert.equal(summarise([{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }], (id) => id.toUpperCase()), '2 × A, 1 × B');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test src/scripts/makeover.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./makeover.ts`. (Node 22.18 or newer runs TypeScript directly; this machine has Node 24.)
<!-- expect-cmd: fail -->

- [ ] **Step 3: Implement**

<!-- create: src/scripts/makeover.ts -->
**Create `src/scripts/makeover.ts`:**

```typescript
// Quantities for "Total plant makeover": how many of each plant, capped in total. No DOM here, so it can be tested directly.
export const MAX_PLANTS = 8; // must equal MAX_PLANTS in api/_lib/rules.ts; makeover.test.ts checks that

export type Item = { productId: string; quantity: number };
export type Quantities = Record<string, number>;

export const total = (quantities: Quantities): number => Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);

// The most one plant can be set to while the others keep their quantities. Anything unusable becomes 0.
export function capQuantity(wanted: number, others: number): number {
  const whole = Number.isFinite(wanted) ? Math.floor(wanted) : 0;
  return Math.min(Math.max(whole, 0), Math.max(MAX_PLANTS - others, 0));
}

export const toItems = (quantities: Quantities): Item[] =>
  Object.entries(quantities).filter(([, quantity]) => quantity > 0).map(([productId, quantity]) => ({ productId, quantity }));

// Reads the `items` a saved preview came back with. Returns null for anything the picker could not have produced.
export function fromItems(items: unknown): Quantities | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const quantities: Quantities = {};
  for (const entry of items) {
    const { productId, quantity } = (entry ?? {}) as Partial<Item>;
    if (typeof productId !== 'string' || typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) return null;
    quantities[productId] = (quantities[productId] ?? 0) + quantity;
  }
  return total(quantities) <= MAX_PLANTS ? quantities : null;
}

export const summarise = (items: Item[], nameOf: (productId: string) => string): string =>
  items.map(({ productId, quantity }) => `${quantity} × ${nameOf(productId)}`).join(', ');
```

- [ ] **Step 4: Run it to verify it passes**

```bash
node --test src/scripts/makeover.test.ts
```

Expected: `ℹ pass 6`, `ℹ fail 0`.
<!-- expect-cmd: ok pass 6 -->

- [ ] **Step 5: Type-check**

```bash
npm run check
```

Expected: `0 errors`, `0 warnings`, `0 hints`.
<!-- expect-cmd: ok -->

- [ ] **Step 6: Commit the two new files only**

```bash
git add src/scripts/makeover.ts src/scripts/makeover.test.ts
git commit -m "$(cat <<'EOF'
Add the makeover quantity rules and a test that pins the cap to the server's

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Markup, script wiring and styles

The three edits depend on each other (the script looks up the new ids and throws if they are missing), so apply them together and check once at the end. Nothing is committed in this task (see Global Constraints).

**Files:**
- Modify: `src/pages/index.astro`
- Modify: `src/scripts/plantPlan.ts`
- Modify: `src/styles/global.css` (append)

**Interfaces:**
- Consumes (Task 1): everything exported from `./makeover`.
- Produces: `initPlantPlan(previewEnabled: boolean, makeoverEnabled = false)`; element ids `preview-modes`, `preview-intro`, `preview-privacy`, `single-picker`, `makeover-picker`, `makeover-total`, `makeover-error`, `preview-placement-field`, `preview-generate-label`, `preview-ai-label`, `preview-design`, `preview-rationale`, `preview-moves`, `preview-spots`.

The three changes ship as files in [`2026-10-04-total-plant-makeover-ui/`](2026-10-04-total-plant-makeover-ui/) next to this plan (they are too long to paste into a shell safely). Read a patch with `git apply --stat <file>` or any editor before applying it.

**If a hunk fails to apply:** Codex has changed the same lines since this plan was written. Run `git apply --check --ignore-whitespace` per file to see which hunk, then make that change by hand: lines starting with `+` are the new text, lines starting with a space show where it goes. The change is described by the replayed result, so keep the meaning, not the exact whitespace.

- [ ] **Step 1: Check the three files are as expected**

```bash
git diff --stat -- src/pages/index.astro src/styles/global.css
git status --short src/scripts
```

Expected: both files list as modified, and `src/scripts/` as untracked (`??`). Any other state means Codex has moved on: re-read the patches against the current files before applying.

- [ ] **Step 2: The markup and the call that passes the flag**

```bash
git apply --ignore-whitespace docs/superpowers/plans/2026-10-04-total-plant-makeover-ui/index.astro.patch
```

What it changes, all inside `#plant-preview`: adds the mode switch `#preview-modes` (hidden until the feature is enabled) and a privacy sentence; wraps the existing plant grid and its error in `#single-picker` and adds `#makeover-picker`, a card per catalog plant with a `− quantity +` stepper (a native number input, so the keyboard and phone number pads work); puts ids on the Placement field, the generate button label and the AI note; adds the hidden "How we designed it" card `#preview-design` inside the result; and passes a new `MAKEOVER_ENABLED = false` constant to `initPlantPlan`.

- [ ] **Step 3: The script changes**

```bash
git apply --ignore-whitespace docs/superpowers/plans/2026-10-04-total-plant-makeover-ui/plantPlan.ts.patch
```

What it changes: `initPlantPlan(previewEnabled, makeoverEnabled = false)`; a `mode` variable and `setMode`; `quantities`, `renderQuantities` and `setQuantities` (keep the "N of 8" label, each box's max, the dimmed +/− and the highlighted cards in step, using `aria-disabled` so keyboard focus is never lost); the generate handler validates and sends the makeover body in makeover mode and the original body otherwise, and shows "not available yet" on a 404; `applyVisualization` restores a makeover (mode, quantities, style, result) or an old single preview, and refuses a makeover link while the flag is off; `renderDesign` fills the design card with text nodes; any quantity, mode, style, photo or space change clears the preview; the enquiry sends no `productId` in makeover mode and carries the chosen plants in the notes and the confirmation; "Start a new request" resets the mode and quantities.

- [ ] **Step 4: The styles (appended last so they follow the shared preview rules)**

```bash
cat docs/superpowers/plans/2026-10-04-total-plant-makeover-ui/global.css.append >> src/styles/global.css
```

This adds the mode cards, the makeover plant cards with the stepper, the design card, a phone layout at 520 px and below that mirrors the existing plant cards, and a reduced-motion rule.

- [ ] **Step 5: Type-check and build**

```bash
npm run check
npm run build
```

Expected: `0 errors`, `0 warnings`, `0 hints`; then `1 page(s) built`.
<!-- expect-cmd: ok -->

At this point the page looks and behaves exactly as before, because `MAKEOVER_ENABLED` is `false`: the mode switch is hidden, the single-plant picker shows, and the only visible change is one privacy sentence under the intro.

---

### Task 3: Look at it, with a stand-in API

The real API is not deployed yet, so this task checks the whole flow in a browser against a few lines of fake `/api` responses injected into the **built** page only (nothing in `src/` changes for this). **The before and after pictures in this check are unrelated stock photos from the stand-in, not AI output.** No AI provider is called and nothing is spent.

- [ ] **Step 1: Save the stand-in (outside tracked files)**

`.astro/` is git-ignored.

```bash
mkdir -p .astro
```

<!-- create: .astro/ui-stub.js -->
**Create `.astro/ui-stub.js`:**

```javascript
(() => {
  const real = window.fetch.bind(window);
  const id = 'A'.repeat(20);
  const img = (n) => `https://www.gstatic.com/webp/gallery/${n}.jpg`;
  let polls = 0;
  const reply = (done) => location.search.includes('legacy')
    ? { status: done ? 'succeeded' : 'processing', items: [{ productId: 'monstera', quantity: 1 }], choices: { spaceType: 'office', style: 'japandi', placement: 'floor' }, before: done ? img(1) : null, after: done ? img(2) : null }
    : { status: done ? 'succeeded' : 'processing', mode: 'makeover', items: [{ productId: 'snake-plant', quantity: 2 }, { productId: 'monstera', quantity: 1 }],
        choices: { spaceType: 'cafe', style: 'japandi', placement: 'auto' },
        rationale: 'Seating moves toward the window so <b>the room opens up</b>, and the tall plants frame the entrance.',
        layout: { furniture: ['Turn the two armchairs to face the window', 'Push the long table against the left wall'], plants: [
          { productId: 'snake-plant', count: 2, placement: 'corner', why: 'Upright leaves soften the corner' },
          { productId: 'monstera', count: 1, placement: 'window', why: 'Bright light suits its big leaves' }] },
        before: done ? img(1) : null, after: done ? img(2) : null };
  window.fetch = async (url, init) => {
    const u = String(url);
    if (u === '/api/visualizations' && init && init.method === 'POST') { const b = JSON.parse(init.body); delete b.image; window.__posted = b; window.__postCount = (window.__postCount || 0) + 1; polls = 0; return new Response(JSON.stringify({ id }), { status: 201 }); }
    if (u.startsWith('/api/visualizations/')) { polls++; return new Response(JSON.stringify(reply(polls > 1)), { status: 200 }); }
    if (u === '/api/enquiries') { const b = JSON.parse(init.body); delete b.photo; window.__enquiry = b; return new Response(JSON.stringify({ id: 'B'.repeat(20) }), { status: 201 }); }
    return real(url, init);
  };
})();
```

- [ ] **Step 2: Build with the makeover switched on, and inject the stand-in**

For this check only, change `const MAKEOVER_ENABLED = false;` to `true` in `src/pages/index.astro`, then build and inject:

<!-- replay: sed -i 's/const MAKEOVER_ENABLED = false;/const MAKEOVER_ENABLED = true;/' src/pages/index.astro -->
```bash
npm run build
node -e '
const fs = require("fs");
const html = fs.readFileSync("dist/index.html", "utf8");
fs.writeFileSync("dist/index.html", html.replace(/<head[^>]*>/, (m) => m + "<script>" + fs.readFileSync(".astro/ui-stub.js", "utf8") + "</script>"));
'
grep -c "__postCount" dist/index.html
```

Expected: the build succeeds and the last command prints `1`.
<!-- expect-cmd: ok -->

Then serve it, leaving it running in its own terminal:

```bash
npx astro preview --port 4399
```

Expected: the site is served at `http://localhost:4399/`.

- [ ] **Step 3: Run the checks in a browser at `http://localhost:4399/#enquiry`**

Choose a space, press "Continue to details", and scroll to "Preview a plant in your space".

**A. Mode switch.** Expect two cards, "Place one plant" (selected) and "Total plant makeover". Selecting the second swaps the plant grid for a grid with "− 0 +" steppers, hides the Placement field, changes the button to "Create my makeover", and the privacy line now names Groq.

**B. The cap.** Press "+" until the label reads "8 of 8 plants": further presses do nothing, the "+" buttons look dimmed, and "We can design up to 8 plants at once." appears. Type `99`, `-3` or `abc` into a quantity box and leave it: each ends at the largest allowed value or `0`, never more than the total cap.

**C. The whole flow.** Paste this in the browser console (it picks a café, 2 snake plants and 1 monstera, style Japandi, attaches a generated photo and clicks the button three times quickly):

<!-- console-flow -->
```javascript
document.documentElement.style.scrollBehavior = 'auto';
const $ = (selector) => document.querySelector(selector);
$('input[name=space][value=cafe]').click();
$('[data-step="0"] [data-next]').click();
$('input[name=previewMode][value=makeover]').click();
const up = (id, times) => { for (let i = 0; i < times; i++) $(`[data-qty-plant="${id}"][data-qty-step="1"]`).click(); };
up('snake-plant', 2);
up('monstera', 1);
$('#preview-style').value = 'japandi';
const canvas = document.createElement('canvas');
canvas.width = 1200;
canvas.height = 896;
canvas.getContext('2d').fillRect(0, 0, 1200, 896);
const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
const files = new DataTransfer();
files.items.add(new File([blob], 'room.jpg', { type: 'image/jpeg' }));
$('#photo').files = files.files;
$('#photo').dispatchEvent(new Event('change', { bubbles: true }));
const generate = $('#preview-generate');
generate.click(); generate.click(); generate.click(); // a quick triple click
await new Promise((resolve) => setTimeout(resolve, 1500));
JSON.stringify({ posts: window.__postCount, body: window.__posted });
```

Expected result of the script: `{"posts":1,"body":{"spaceType":"cafe","mode":"makeover","items":[{"productId":"snake-plant","quantity":2},{"productId":"monstera","quantity":1}],"style":"japandi"}}`. One post only, and no `productId` or `placement` in the body. After about 6 seconds the result appears with the title "Your space, rearranged with 3 plants"; the note under it ends "The furniture moves are a suggestion, not a measured plan."; and a "How we designed it" card shows the rationale, two furniture moves and two plant lines. The rationale in the stand-in contains `<b>the room opens up</b>`: it must appear as literal text with the angle brackets, not as bold.

**D. Anything you change clears the result.** With a result showing, press "+" on any plant (or change the style, the photo or the space). The result and the "How we designed it" card disappear, `?visualization=` leaves the address bar, and the Create button returns. Switching to "Place one plant" and back keeps the quantities.

**E. Shared links.** Open `http://localhost:4399/?visualization=AAAAAAAAAAAAAAAAAAAA&fresh=1#enquiry` (the extra `fresh=1` forces a real reload): after about 6 seconds the form is on the details step in makeover mode with 2 snake plants and 1 monstera, the style, the result and the design card. Open `http://localhost:4399/?legacy=1&visualization=AAAAAAAAAAAAAAAAAAAA#enquiry`: it restores as a single-plant preview (Monstera, placement "On the floor"), with no design card and the original AI note.

**F. Phone.** At 390 px wide (browser device mode, or a 390 px frame; some browsers cannot make a window narrower than about 557 px, which does not trigger the phone layout) there is no sideways scrolling, the mode cards stack, each plant card shows its photo on the left with name, size and stepper on the right, and every button is at least 44 px tall.

**G. Finish the enquiry.** Continue to contact, enter any name and email and send. The saved request (inspect `window.__enquiry` in the console) has no `productId`, has a `visualizationId`, and its `notes` ends with "Plants chosen for the makeover: 2 × Snake Plant, 1 × Monstera"; the confirmation lists "Plants: 2 × Snake Plant, 1 × Monstera". "Start a new request" returns to "Place one plant" with every quantity at 0.

- [ ] **Step 4: Check the shipping state (flag off)**

Set `const MAKEOVER_ENABLED = true;` back to `false`, run `npm run build`, inject the stand-in again (the `node -e` command from Step 2), restart the preview, reload `http://localhost:4399/?off=1#enquiry`, and confirm: the mode switch is hidden; creating a single-plant preview posts exactly `{"spaceType":"office","productId":"monstera","style":"japandi","placement":"floor"}` after you pick those; and opening `http://localhost:4399/?visualization=AAAAAAAAAAAAAAAAAAAA&off=2#enquiry` shows "This preview could not be restored because its choices are missing." with the `visualization` parameter removed.

- [ ] **Step 5: Clean up**

Stop the preview server, then rebuild without the stand-in so no test script stays in `dist/`:

<!-- replay: sed -i 's/const MAKEOVER_ENABLED = true;/const MAKEOVER_ENABLED = false;/' src/pages/index.astro -->
```bash
npm run build
git diff --stat -- src/pages/index.astro | tail -1
grep -n "const MAKEOVER_ENABLED" src/pages/index.astro
```

Expected: the build succeeds and the last line printed is the `const MAKEOVER_ENABLED = false;` line.
<!-- expect-cmd: ok -->

---

## Handing over and going live

- [ ] **Record it on the board.** In `TASK_BOARD.md` set the M3 row to REVIEW with "form UI done behind `MAKEOVER_ENABLED = false`; checks A to G passed against a stand-in API on <date>", and note that `index.astro`, `plantPlan.ts` and `global.css` still hold uncommitted work.
- [ ] **Do not flip the flag until all of these are true:** the backend plan is merged and deployed; migration `0002` has been run in Supabase; `MAKEOVER_ENABLED=1` and `GROQ_API_KEY` are set in Vercel **Production**; the user has recorded PASS for G0 and for G1; the plant photos are the approved product photos.
- [ ] **Then:** change `const MAKEOVER_ENABLED = false;` to `true` in `src/pages/index.astro`, deploy, and with the user's go-ahead (it spends about 4 Kie credits) run one real makeover with a real room photo on the live site, from the form to the enquiry. This is the only step that proves the UI against the real API.

---

## Self-review

- **Spec coverage:** mode switch, quantity checklist with a running total capped at 8, the "How we designed it" panel (rationale, furniture notes, per-plant lines), "Try another layout" (the existing "Try another look" button, which clears and keeps the choices), the approximate-AI note, `textContent` for model text, invalidation on any change, restore from a link, the privacy line, and the enquiry carrying the preview by `visualizationId` with the chosen plants in the notes (the spec's "enquiry schema does not change" holds: only existing fields are used).
- **Spec wording differences:** the spec says "Try another layout"; the existing button reads "Try another look" and serves both modes, so its label is left alone. Say so to the user if they want it renamed for the makeover.
- **Placeholders:** none. Every edit is a full file or an exact patch; the only run-time values are the local preview port and the user's real photo at go-live.
- **Type consistency:** `Quantities`, `Item`, `capQuantity`, `fromItems`, `toItems`, `summarise`, `total` and `MAX_PLANTS` are defined once in Task 1 and imported under the same names in Task 2.
