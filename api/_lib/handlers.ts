import { createHash } from 'node:crypto';
import { parseVisualizationRequest, parseMakeoverRequest, parseEnquiry, nextStep, type Dims } from './rules.js';
import { buildPrompt, buildMakeoverPrompt } from './prompt.js';
import { design, type Plan } from './designer.js';
import { PROVIDER, MODEL, createTask, getTask } from './imageProvider.js';
import { db, must, newId, save, signedUrl } from './db.js';

const DAILY_CAP = 20; // hard ceiling on paid generations per UTC day; raise here and redeploy
const IP_CAP = 5; // best effort only: offices share an IP and headers can be spoofed; DAILY_CAP is the real limit
const KEEP_MS = 30 * 24 * 60 * 60_000;
// Kie downloads plant photos from the deployment that took the request, so a preview uses its own photos.
// SITE_URL overrides it for `vercel dev`, where localhost is unreachable from Kie.
const siteUrl = (request: Request) => (process.env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');

type Row = {
  id: string;
  status: 'processing' | 'succeeded' | 'failed';
  items: { productId: string; quantity: number }[];
  space_type: string;
  style: string;
  placement: string;
  dims: Dims;
  aspect: string;
  provider: string;
  model: string;
  task_id: string | null;
  prompt: string;
  // Only makeover rows carry these, so single-plant requests still insert on a database that has not run migration 0002.
  mode?: 'single' | 'makeover';
  plan?: Plan | null;
  rationale?: string | null;
  error: string | null;
  ip_key: string;
  created_at: number;
  checked_at: number;
  completed_at: number | null;
  expires_at: number;
};
export type Reply = [status: number, body: object];

// Wraps every route: JSON in, JSON out, never cached, and a friendly 500 instead of a stack trace.
export async function respond(request: Request, handler: (body: unknown, request: Request) => Promise<Reply>): Promise<Response> {
  let reply: Reply;
  try {
    const body = request.method === 'POST' ? await request.json().catch(() => undefined) : undefined;
    reply = await handler(body, request);
  } catch (err) {
    console.error(err);
    reply = [500, { error: 'Something went wrong. Please try again.' }];
  }
  return Response.json(reply[1], { status: reply[0], headers: { 'Cache-Control': 'private, no-store' } });
}

export async function createVisualization(body: unknown, request: Request): Promise<Reply> {
  const makeover = (body as { mode?: unknown } | undefined)?.mode === 'makeover';
  // Closed in production until the makeover passes its quality gate (G1); see MAKEOVER_ENABLED in the README.
  if (makeover && process.env.MAKEOVER_ENABLED !== '1') return [404, { error: 'Not found' }];
  const parsed = makeover ? parseMakeoverRequest(body) : parseVisualizationRequest(body);
  if (!parsed.ok) return [400, { error: parsed.error }];
  const input = parsed.value;
  const items = input.mode === 'makeover' ? input.items : [{ plant: input.plant, quantity: 1 }];

  const day = new Date().toISOString().slice(0, 10);
  const ip = (request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? '').split(',')[0].trim();
  const ipKey = `${day}_${createHash('sha256').update(ip + day).digest('hex').slice(0, 16)}`; // rotates daily, never stores the IP
  if (!must(await db.rpc('take_slot', { p_day: day, p_ip_key: ipKey, p_daily: DAILY_CAP, p_ip: IP_CAP }))) {
    return [429, { error: "Today's preview limit has been reached. Please try again tomorrow, or request a plant plan and we'll help." }];
  }

  const id = newId();
  const now = Date.now();
  const row: Row = {
    id,
    status: 'processing',
    items: items.map(({ plant, quantity }) => ({ productId: plant.id, quantity })),
    space_type: input.space.id,
    style: input.style.id,
    placement: input.mode === 'single' ? input.placement.id : 'auto', // in a makeover the designer chooses
    dims: input.dims,
    aspect: input.aspect,
    provider: PROVIDER,
    model: MODEL,
    task_id: null,
    prompt: input.mode === 'single' ? buildPrompt(input) : '', // a makeover prompt needs the designer's plan, set below
    ...(input.mode === 'makeover' ? { mode: 'makeover' as const, plan: null, rationale: null } : {}),
    error: null,
    ip_key: ipKey,
    created_at: now,
    checked_at: now,
    completed_at: null,
    expires_at: now + KEEP_MS,
  };
  try {
    const roomPath = `visualizations/${id}/room.jpg`;
    await save(roomPath, input.image, 'image/jpeg');
    const roomUrl = await signedUrl(roomPath, 30);
    if (input.mode === 'makeover') {
      const plan = await design({ space: input.space, style: input.style, items, dims: input.dims, roomUrl });
      row.plan = plan;
      row.rationale = plan.rationale;
      row.prompt = buildMakeoverPrompt({ space: input.space, style: input.style, items, plan, dims: input.dims });
    }
    // Reference photos follow the room in item order; buildMakeoverPrompt numbers them the same way.
    row.task_id = await createTask(row.prompt, [roomUrl, ...items.map(({ plant }) => `${siteUrl(request)}${plant.image}`)], input.aspect);
  } catch (err) {
    console.error('Could not start generation', err);
    await db.rpc('refund_slot', { p_ip_key: ipKey });
    must(await db.from('visualizations').insert({ ...row, status: 'failed', error: String(err), completed_at: now }));
    return [502, { error: 'We could not start your preview. Please try again.' }];
  }
  must(await db.from('visualizations').insert(row));
  return [201, { id }];
}

export async function getVisualization(id: string): Promise<Reply> {
  let v = must(await db.from('visualizations').select('*').eq('id', id).maybeSingle()) as Row | null;
  if (!v) return [404, { error: 'Not found' }];

  // ponytail: poll-through instead of a Kie webhook. The browser polls us and we ask Kie at most every 5 s.
  // Add a callback endpoint that re-runs this check if customers often leave before their image is ready.
  const step = nextStep({ status: v.status, createdAt: v.created_at, checkedAt: v.checked_at }, Date.now());
  if (step === 'timeout') v = await finish(id, 'failed', 'Timed out');
  if (step === 'check') {
    const task = await getTask(v.task_id!);
    if (task.state === 'success') {
      const image = await fetch(task.imageUrl); // Kie's URL expires after ~24 h, so keep our own copy
      if (!image.ok) throw new Error(`Result download failed: HTTP ${image.status}`);
      await save(`visualizations/${id}/result.png`, Buffer.from(await image.arrayBuffer()), image.headers.get('content-type') ?? 'image/png');
      v = await finish(id, 'succeeded', null);
    } else if (task.state === 'fail') {
      v = await finish(id, 'failed', task.message, true);
    } else {
      must(await db.from('visualizations').update({ checked_at: Date.now() }).eq('id', id));
    }
  }

  const done = v.status === 'succeeded';
  return [200, {
    status: v.status,
    mode: v.mode ?? 'single',
    items: v.items,
    choices: { spaceType: v.space_type, style: v.style, placement: v.placement },
    rationale: v.rationale ?? null,
    layout: v.plan ? { furniture: v.plan.furniture, plants: v.plan.plants } : null,
    before: done ? await signedUrl(`visualizations/${id}/room.jpg`, 60) : null,
    after: done ? await signedUrl(`visualizations/${id}/result.png`, 60) : null,
  }];
}

// ponytail: no notification yet; check Supabase → Table editor → enquiries. Add an email step when volume warrants.
// No rate limit either: spam here costs storage, not money. Add Turnstile if it starts happening.
export async function createEnquiry(body: unknown): Promise<Reply> {
  const parsed = parseEnquiry(body);
  if (!parsed.ok) return [400, { error: parsed.error }];
  const { enquiry, photo } = parsed.value;
  // The unified form attaches a preview by id; keep the link only when that preview really exists.
  let visualizationId = enquiry.visualizationId;
  if (visualizationId && !must(await db.from('visualizations').select('id').eq('id', visualizationId).maybeSingle())) visualizationId = null;
  const id = newId();
  const photoPath = photo ? `enquiries/${id}/photo.jpg` : null;
  if (photo && photoPath) await save(photoPath, photo, 'image/jpeg');
  must(await db.from('enquiries').insert({
    id,
    space: enquiry.space,
    light: enquiry.light,
    size: enquiry.size,
    notes: enquiry.notes,
    name: enquiry.name,
    contact_method: enquiry.contactMethod,
    contact: enquiry.contact,
    product_id: enquiry.productId,
    visualization_id: visualizationId,
    photo_path: photoPath,
    created_at: Date.now(),
  }));
  return [201, { id }];
}

// Moves processing → final exactly once, refund included (see finish_visualization in the migration).
async function finish(id: string, status: Row['status'], error: string | null, refund = false): Promise<Row> {
  return must(await db.rpc('finish_visualization', { p_id: id, p_status: status, p_error: error, p_refund: refund })) as Row;
}
