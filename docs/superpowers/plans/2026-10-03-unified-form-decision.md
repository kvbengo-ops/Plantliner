# Unified plant plan and visualizer form

Decision from the user on 2026-10-03: **the existing homepage plant-plan form is the visualizer form.** This note supersedes the separate `/visualize/` page and result-to-home handoff described in Tasks 8–10 of [the original implementation plan](2026-10-03-ai-plant-visualizer.md). Keep that plan's backend validation, privacy, limits, retention, and provider details unless a later decision changes them.

## Customer flow

1. The customer opens `/#enquiry` from the existing site calls to action. The same `#plant-plan-form` remains the sole request form.
2. **Your space:** select the existing space type.
3. **Details:** keep light, size, room photo, and notes. Add a clearly optional “Preview a plant in your space” section within this step. It reads plant, style, and placement choices from `src/data/catalog.json`. Product photos and dimensions must be approved before these choices appear publicly.
4. If the customer chooses to preview, require a supported room photo and valid plant/style/placement. Re-encode the photo and call `POST /api/visualizations` once per deliberate click. Show processing, failure/retry, and the approximate before/after result **inside the form panel**. The preview is optional; the customer can continue to contact without it.
5. **Contact:** use the existing name and contact fields. Submit once to `POST /api/enquiries`, with the selected `productId` and optional `visualizationId`. A customer who skipped preview can still send an ordinary enquiry. Show success only after the API accepts it.
6. Do not ask for the photo or contact details a second time. If a preview exists, the enquiry can refer to its `visualizationId`; only upload the photo directly with an enquiry when there is no preview. The backend should validate that ID and store the association.

## State and links

- Existing page links keep `/#enquiry`; add a “Preview a plant” link to the same anchor when the feature is ready.
- A preview result is linkable as `/?visualization=<id>#enquiry`. On load, the homepage polls `GET /api/visualizations/:id`, restores the result and catalog-backed selections, and opens the details step. Anyone with this link can view the result; say so next to the share link.
- The browser cannot restore the user's original `File` object after reload. Use the signed before/after URLs returned by the API once ready. While processing, show progress from the stored record.
- Changing room photo, space, plant, style, or placement after generation invalidates the previous preview association and result. The customer must request a new preview to attach changed choices. Navigation within the form must not trigger a new paid request.
- “Start a new request” clears contact fields, preview choices, ID, result, errors, and the `visualization` URL parameter.
- Prevent duplicate preview and enquiry POSTs on rapid clicks. Keep field values on provider/network errors.

## Implementation boundary

- **Codex:** extend `src/pages/index.astro` and `src/styles/global.css`; use `src/scripts/photo.ts`. Reuse the existing three-step form and mobile layout. Do not create `src/pages/visualize.astro`.
- **Claude:** catalog and API contracts remain owned by Claude. `POST /api/visualizations` and `GET /api/visualizations/:id` still serve generation and restoration. `POST /api/enquiries` must accept an optional `visualizationId` and associate it with the saved enquiry. Coordinate any response-shape changes through `TASK_BOARD.md`.
- **Release gate:** until the catalog has approved product data/photos and generation has passed the quality/cost decision, keep the optional preview controls out of the live UI. The existing enquiry flow must continue working.

## Acceptance

- Plain enquiry works without a preview.
- A visitor can use one room photo, select one plant/style/placement, generate a result, and send an enquiry without re-entering anything.
- Double-clicking generate causes one paid generation; double-clicking send causes one enquiry.
- Reloading a processing/result link restores the status or result in the same form.
- Unsupported, corrupt, oversized, and portrait photos have the original plan's expected outcomes.
- Back/forward steps preserve valid entries; changing inputs clears stale preview state.
- At 320, 375, 390, 600, 760, and 1024 px, the form and before/after display fit without horizontal scrolling. Check a real phone before release.
