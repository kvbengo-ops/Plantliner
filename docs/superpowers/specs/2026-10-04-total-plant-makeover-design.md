# Total plant makeover: design

Date: 2026-10-04. Status: awaiting user review. Extends the visualizer in [the AI plant visualizer plan](../plans/2026-10-03-ai-plant-visualizer.md) and [the unified-form decision](../plans/2026-10-03-unified-form-decision.md). It supersedes the board's "no multi-plant designer in this scope" line for this one feature.

## Goal

A second preview mode, **Total plant makeover**, inside the existing `#plant-plan-form`. The customer ticks several catalog products, sets a quantity for each, and clicks once. They get back their own room photo **re-staged**: seating and tables rearranged and the chosen plants placed so the room feels balanced, plus a written explanation of why it was laid out that way.

Agreed with the user:
- Output is a re-staged photo plus a written rationale (not plants-only, not a floor plan).
- One click. The plan is shown together with the result, with a "Try another layout" button. There is no plan-then-approve step.
- Customer-facing, in the same form, products from the shared catalog only. Same daily caps (50 total, 5 per IP).

## How it works

```
POST /api/visualizations { mode: "makeover", items, style, image, dims? }
  validate → take_slot → save room.jpg → Groq designs a layout (vision, JSON)
  → validate the plan → build the Kie prompt from the plan
  → Kie edits room.jpg with one reference photo per distinct product → store row
GET  /api/visualizations/:id   (unchanged polling) now also returns the rationale and layout notes
```

Single-plant requests (`mode` absent or `"single"`) are unchanged and keep today's deterministic prompt. Using Groq there is deferred: the single-plant path has not passed G0, and changing its prompt now would muddy that evidence.

### API contract (record in `TASK_BOARD.md` when the plan is approved)

Request, makeover mode:
`{ mode: "makeover", image: base64Jpeg, spaceType, style, items: [{ productId, quantity }], dims? }`
`placement` and `productId` are not sent. The designer decides placement.

Reply `201 { id }`; errors use `{ error }` as today. New failure: `404` when the makeover is switched off (see Flag).

`GET` adds, for makeover rows: `mode`, `rationale: string`, `layout: { furniture: string[], plants: { productId, count, placement, why }[] }`. `items` and `choices` stay. For single rows, `rationale` and `layout` are `null`.

### Item rules (`rules.ts`, constants at the top)

- Quantity per item is an integer 1–8; the total across items is 1–8 (image models stop counting reliably above that). Because every item is at least 1, this also keeps distinct products at 8 or fewer, under Kie's limit of 9 reference photos (10 images minus the room).
- Duplicate `productId`s are merged; unknown ids reject the request.

### Designer (`api/_lib/designer.ts`)

The only file that knows Groq, like `imageProvider.ts` for Kie.

- `POST https://api.groq.com/openai/v1/chat/completions`, Bearer `GROQ_API_KEY`, `response_format: { type: "json_object" }` (the system prompt must contain the word "JSON"), temperature 0.4, `max_tokens` about 700, `AbortSignal.timeout(8000)`.
- Model id is one constant, overridable by `GROQ_MODEL`. Default `meta-llama/llama-4-scout-17b-16e-instruct`. Groq retires models often, so confirm it is still listed when the key is first used.
- Input: the room photo as a **signed URL** (the same short-lived URL already made for Kie, which avoids Groq's 4 MB base64 limit and its 5-image cap), plus text built from the catalog: each product's name, height, pot width, compatible placements and quantity, the style's `prompt`, the space label and any room dimensions. Customer free text is never included.
- Output the model must produce:
  ```json
  { "rationale": "2-4 sentences, plain text, the design logic",
    "furniture": ["short move note", "..."],
    "plants": [{ "productId": "snake-plant", "count": 2, "placement": "corner", "why": "short" }] }
  ```
- `parsePlan(raw, items)` is the validator and is pure, so it is testable without network:
  - Strict shape, no extra keys. `rationale` ≤ 600 chars; each furniture note ≤ 120 chars, at most 6; each `why` ≤ 120 chars.
  - `placement` must be a catalog placement id other than `auto`. Compatibility with the plant's `placements` list is guidance given to Groq, not a hard rule.
  - Counts per `productId` must sum exactly to the requested quantity, and only requested products may appear.
  - Strings are trimmed with control characters removed; anything containing `http` or `<` is rejected.
- Any failure (HTTP, timeout, bad JSON, invalid plan) throws. The create handler refunds the slot, stores a `failed` row and returns `502 "We could not start your preview. Please try again."`, exactly as a failed Kie start does today. There is no retry and no fallback prompt; add them if G1 shows frequent designer rejections.

### Prompt (`prompt.ts: buildMakeoverPrompt`)

Fixed text plus catalog data plus the validated plan. Structure:
1. Edit the first image, a photo of a real `<room>`. Images 2 to N are reference photos: "image 2 is the Snake Plant, ...".
2. Keep unchanged: walls, windows, doors, floor, ceiling, fixed fittings, lighting, camera angle, perspective and framing.
3. You may move existing movable seating and tables as follows: the `furniture` notes. Do not add, remove or restyle any furniture. Keep doors, walkways and exits clear.
4. Place exactly these plants: one line per plan entry with count, name, placement text, and size ("about 80 cm tall, pot about 25 cm wide"); they must match their reference photos. No other plants or decorations.
5. Scale and light as in the single-plant prompt; style direction as in the single-plant prompt.
6. The result must look like an unedited photograph of the same room.

Plan text is placed inside the fixed template and never concatenated as free instructions. A test asserts the prompt stays under Kie's 5,000-character limit at the maximum item count.

### Storage (`supabase/migrations/0002_makeover.sql`)

```sql
alter table visualizations
  add column mode text not null default 'single' check (mode in ('single', 'makeover')),
  add column plan jsonb,
  add column rationale text;
```
`items` already holds `[{ productId, quantity }]`. Makeover rows store `placement = 'auto'` because the column is `not null`. `handlers.ts` `Row` gains the three fields. No SQL function changes: `finish_visualization` returns `visualizations` and picks up the new columns.

### Flag and ops

- `MAKEOVER_ENABLED=1` is required for `mode: "makeover"`; otherwise the route answers 404. Set it only in Vercel's Preview environment until G1 passes, so quality runs can use the real API and production stays closed.
- New env var `GROQ_API_KEY` (Vercel only, never in the repo). Optional `GROQ_MODEL`.
- The Groq call adds a few seconds to the create request. Keep the 8 s timeout below the project's function duration limit and set `maxDuration` in `vercel.json` if needed.
- Privacy: the room photo is now processed by two providers (Groq and Kie). Add one line to the form and to the README. Results stay behind the existing 30-day retention and share-link privacy.

## Customer UI (Codex-owned; contract only)

- Toggle in the existing "Preview a plant" section: "Place one plant" or "Total plant makeover".
- Makeover shows a checklist of catalog products, each with a − / + stepper, and a running "3 of 8" total that blocks further adds at the cap.
- The result panel shows before/after, a "How we designed it" block (`rationale` plus the `furniture` notes and per-plant `why`), the approximate-AI label, and "Try another layout". All model text is inserted with `textContent`, never `innerHTML`.
- Changing items, style, photo or space invalidates the preview, as the unified-form decision already requires. The enquiry attaches the preview by `visualizationId`; the enquiry schema does not change.
- The UI stays hidden until the product photos are approved, G0 and G1 pass, and the flag is on.

## Testing and quality gate

Unit tests in the existing `node:test` style, no network:
- `rules.test.ts`: item parsing (caps, unknown ids, merged duplicates, a total of 9 rejected).
- `designer.test.ts`: `parsePlan` accepts a good plan; rejects extra keys, over-long strings, links, unknown or `auto` placements, counts that do not sum, products not requested; the request body sent to Groq contains no customer free text (stub `fetch`).
- `prompt.test.ts`: the makeover prompt names every product with its count and size, contains the keep-unchanged and clear-walkways sentences, and stays under 5,000 characters at the maximum.

**G1: quality gate, scored by the user.** Run 10 makeovers across at least 3 different room photos using stand-in or real product photos, via the Preview deployment. 7 of 10 must pass all four checks:
1. Room structure preserved (walls, windows, doors, floor, framing).
2. Furniture moved sensibly, with none duplicated, deleted or invented.
3. Requested species and counts present and recognisable.
4. Walkways and doors clear.

Also record the designer rejection rate and Groq latency. Budget about 40 Kie credits at 4 each. The user records PASS or FAIL; the feature does not go live on FAIL.

## Ownership and sequence

- **Claude:** `api/_lib/{designer,prompt,rules,handlers}.ts` and tests, migration `0002`, README env docs, `TASK_BOARD.md` rows and contract.
- **Codex:** `src/pages/index.astro`, `src/styles/global.css`, `src/scripts/**`.
- **User:** `GROQ_API_KEY`, running migration `0002`, the Preview flag, product photos, and the G1 verdict.
- The backend can be built in parallel with the unfinished single-plant UI. The feature ships only after G0 and G1 pass.

## Known risks and notes

- Re-staging furniture in a real photo is the riskiest part: the model may invent, delete or warp furniture. G1 exists to measure exactly this. A plants-only fallback mode is the escape hatch if G1 fails.
- A sign or text in the customer's photo could try to steer Groq. Schema validation, length caps, the link and tag rejection and the fixed prompt template limit this; the worst case is an odd picture, since Kie can only edit images.
- Kie's docs mark `image_size` as deprecated in favour of `aspect_ratio`. `imageProvider.ts` still sends `image_size`. Separate small fix: check against the live API before changing, since the G0 runs worked with `image_size`.

## Out of scope

Plan-first approval, floor-plan sketches, non-plant products, Groq prompting for the single-plant mode, a designer fallback prompt, a Kie webhook, async planning status, email notifications.
