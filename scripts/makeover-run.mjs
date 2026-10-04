// Runs total-plant-makeover requests against a deployed API and saves everything needed to score them (gate G1).
// Usage: BASE_URL=https://<preview-url> [LIVE=1] node scripts/makeover-run.mjs <runs.json> [outDir]
// runs.json: [{ "name": "cafe-1", "photo": "test_img/room_photo.jpg", "spaceType": "cafe", "style": "japandi",
//               "items": [{ "productId": "snake-plant", "quantity": 2 }], "dims": { "ceilingM": 2.7 } }]
// Without LIVE=1 it only prints what it would do. Each live run spends about 4 Kie credits.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const [runsFile, outDir = 'g1-results'] = process.argv.slice(2);
const base = (process.env.BASE_URL || '').replace(/\/$/, '');
if (!runsFile || !base) {
  console.error('Usage: BASE_URL=https://<preview-url> [LIVE=1] node scripts/makeover-run.mjs <runs.json> [outDir]');
  process.exit(1);
}
const runs = JSON.parse(await readFile(runsFile, 'utf8'));
const maxRuns = Number(process.env.MAX_RUNS || 10);
if (runs.length > maxRuns) {
  console.error(`${runs.length} runs is more than MAX_RUNS (${maxRuns}). Each one costs Kie credits; raise MAX_RUNS on purpose.`);
  process.exit(1);
}
const headers = { 'Content-Type': 'application/json' };
// A Vercel Preview deployment behind Deployment Protection needs this header (Project Settings > Deployment Protection).
if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

if (process.env.LIVE !== '1') {
  console.log(`DRY RUN: ${runs.length} makeover(s) against ${base}. Each spends about 4 Kie credits. Re-run with LIVE=1 to start.`);
  for (const run of runs) console.log(`- ${run.name}: ${run.photo}, ${run.spaceType}, ${run.style}, ${JSON.stringify(run.items)}`);
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
const rows = [];
const row = (name, status, seconds) => `| ${name} | ${status} | ${seconds} |  |  |  |  |  |`;
const header = ['| Run | Status | Time | Room kept | Furniture sensible | Species and counts | Walkways clear | Notes |', '|---|---|---|---|---|---|---|---|'];
// Written after every run, so a crash or Ctrl-C keeps what has already been paid for.
const save = () => writeFile(`${outDir}/scorecard.md`, [...header, ...rows].join('\n') + '\n');
const pollMs = Number(process.env.POLL_MS || 6_000);
for (const run of runs) {
  const started = Date.now();
  const image = (await readFile(run.photo)).toString('base64');
  if (image.length > 4_400_000) { // Vercel rejects request bodies over 4.5 MB
    console.log(`${run.name}: skipped, ${run.photo} is too large; resize it to about 2048 px first`);
    rows.push(row(run.name, 'skipped: photo too large', '-'));
    await save();
    continue;
  }
  const body = { mode: 'makeover', image, spaceType: run.spaceType, style: run.style, items: run.items, dims: run.dims };
  const create = await fetch(`${base}/api/visualizations`, { method: 'POST', headers, body: JSON.stringify(body) });
  const created = await create.json().catch(() => ({}));
  if (create.status !== 201) {
    // 502 means the designer or Kie failed to start; the reason is in the visualizations.error column in Supabase.
    console.log(`${run.name}: create failed (HTTP ${create.status}) ${created.error ?? ''}`);
    rows.push(row(run.name, `create failed ${create.status}`, '-'));
    await save();
    if (create.status === 429) {
      // The limits are per visitor (5 a day) and in total (shared with real visitors if they share this database). More runs would only fail.
      console.log('Stopping: HTTP 429 means a daily limit is reached. Continue tomorrow, or ask the owner to raise the limit for this Preview.');
      break;
    }
    continue;
  }
  let result = { status: 'processing' };
  while (Date.now() - started < 11 * 60_000) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    // A dropped or garbled reply (a gateway page, say) is retried on the next turn, not fatal.
    const polled = await fetch(`${base}/api/visualizations/${created.id}`, { headers }).then((response) => response.json()).catch(() => null);
    if (!polled) continue;
    result = polled;
    if (result.status !== 'processing') break;
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const { before, after, ...record } = result; // signed links expire, so keep the images, not the links
  await writeFile(`${outDir}/${run.name}.json`, JSON.stringify({ run: { ...run, photo: undefined }, id: created.id, seconds, result: record }, null, 2));
  if (result.status === 'succeeded') {
    await writeFile(`${outDir}/${run.name}-before.jpg`, Buffer.from(await (await fetch(before)).arrayBuffer()));
    await writeFile(`${outDir}/${run.name}-after.png`, Buffer.from(await (await fetch(after)).arrayBuffer()));
  }
  console.log(`${run.name}: ${result.status} in ${seconds}s`);
  rows.push(row(run.name, result.status, `${seconds}s`));
  await save();
}
await save();
console.log(`Scorecard template: ${outDir}/scorecard.md. Pass = all four checks ticked; the gate needs 7 of 10.`);
