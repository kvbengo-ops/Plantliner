import { onRequest, type Request } from 'firebase-functions/v2/https';
import { defineString } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { createHash } from 'node:crypto';
import { parseVisualizationRequest, parseEnquiry, nextStep, type Dims } from './rules.js';
import { buildPrompt } from './prompt.js';
import { KIE_API_KEY, PROVIDER, MODEL, createTask, getTask } from './imageProvider.js';

initializeApp();
const db = getFirestore();
const bucket = getStorage().bucket();

const DAILY_CAP = 20; // hard ceiling on paid generations per UTC day; raise here and redeploy
const IP_CAP = 5; // best effort only: offices share an IP and headers can be spoofed; DAILY_CAP is the real limit
const KEEP_MS = 30 * 24 * 60 * 60_000;
const SITE_URL = defineString('SITE_URL'); // the Vercel site, e.g. https://plantliner.com; Kie downloads plant photos from here

type Visualization = {
  status: 'processing' | 'succeeded' | 'failed';
  items: { productId: string; quantity: number }[]; // an array so a future "AI Designer" can add several plants
  spaceType: string;
  style: string;
  placement: string;
  dims: Dims;
  aspect: string; // the Kie ratio sent: nearest the room photo's own shape
  provider: string;
  model: string;
  taskId: string | null;
  prompt: string;
  error: string | null;
  ipKey: string;
  createdAt: number;
  checkedAt: number;
  completedAt: number | null;
  expiresAt: Timestamp; // a Firestore TTL policy deletes the record after this
};
type Reply = [status: number, body: object];

export const api = onRequest({ secrets: [KIE_API_KEY], maxInstances: 5 }, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  let reply: Reply = [404, { error: 'Not found' }];
  try {
    const id = req.path.match(/^\/api\/visualizations\/([A-Za-z0-9]{20})$/)?.[1];
    if (req.method === 'POST' && req.path === '/api/visualizations') reply = await createVisualization(req);
    else if (req.method === 'GET' && id) reply = await getVisualization(id);
    else if (req.method === 'POST' && req.path === '/api/enquiries') reply = await createEnquiry(req);
  } catch (err) {
    logger.error(err);
    reply = [500, { error: 'Something went wrong. Please try again.' }];
  }
  res.status(reply[0]).json(reply[1]);
});

async function createVisualization(req: Request): Promise<Reply> {
  const parsed = parseVisualizationRequest(req.body);
  if (!parsed.ok) return [400, { error: parsed.error }];
  const { image, ...choices } = parsed.value;

  const day = new Date().toISOString().slice(0, 10);
  const ip = String(req.headers['fastly-client-ip'] ?? req.headers['x-forwarded-for'] ?? req.ip).split(',')[0].trim();
  const ipKey = `${day}_${createHash('sha256').update(ip + day).digest('hex').slice(0, 16)}`; // rotates daily, never stores the IP
  if (!(await takeSlot(day, ipKey))) {
    return [429, { error: "Today's preview limit has been reached. Please try again tomorrow, or request a plant plan and we'll help." }];
  }

  const ref = db.collection('visualizations').doc();
  const now = Date.now();
  const record: Visualization = {
    status: 'processing',
    items: [{ productId: choices.plant.id, quantity: 1 }],
    spaceType: choices.space.id,
    style: choices.style.id,
    placement: choices.placement.id,
    dims: choices.dims,
    aspect: choices.aspect,
    provider: PROVIDER,
    model: MODEL,
    taskId: null,
    prompt: buildPrompt(choices),
    error: null,
    ipKey,
    createdAt: now,
    checkedAt: now,
    completedAt: null,
    expiresAt: Timestamp.fromMillis(now + KEEP_MS),
  };
  try {
    const roomPath = `visualizations/${ref.id}/room.jpg`;
    await bucket.file(roomPath).save(image, { contentType: 'image/jpeg' });
    record.taskId = await createTask(record.prompt, [await signedUrl(roomPath, 30), `${SITE_URL.value().replace(/\/$/, '')}${choices.plant.image}`], choices.aspect);
  } catch (err) {
    logger.error('Could not start generation', err);
    await refundSlot(ipKey);
    await ref.set({ ...record, status: 'failed', error: String(err), completedAt: now });
    return [502, { error: 'We could not start your preview. Please try again.' }];
  }
  await ref.set(record);
  return [201, { id: ref.id }];
}

async function getVisualization(id: string): Promise<Reply> {
  const ref = db.doc(`visualizations/${id}`);
  const snap = await ref.get();
  if (!snap.exists) return [404, { error: 'Not found' }];
  let v = snap.data() as Visualization;

  // ponytail: poll-through instead of a Kie webhook. The browser polls us and we ask Kie at most every 5 s.
  // Add a callback endpoint that re-runs this check if customers often leave before their image is ready.
  const step = nextStep(v, Date.now());
  if (step === 'timeout') v = await finish(ref, { status: 'failed', error: 'Timed out' });
  if (step === 'check') {
    const task = await getTask(v.taskId!);
    if (task.state === 'success') {
      const image = await fetch(task.imageUrl); // Kie's URL expires after ~24 h, so keep our own copy
      if (!image.ok) throw new Error(`Result download failed: HTTP ${image.status}`);
      await bucket.file(`visualizations/${id}/result.png`).save(Buffer.from(await image.arrayBuffer()), { contentType: image.headers.get('content-type') ?? 'image/png' });
      v = await finish(ref, { status: 'succeeded' });
    } else if (task.state === 'fail') {
      v = await finish(ref, { status: 'failed', error: task.message }, true);
    } else {
      await ref.update({ checkedAt: Date.now() });
    }
  }

  const done = v.status === 'succeeded';
  return [200, {
    status: v.status,
    items: v.items,
    choices: { spaceType: v.spaceType, style: v.style, placement: v.placement },
    before: done ? await signedUrl(`visualizations/${id}/room.jpg`, 60) : null,
    after: done ? await signedUrl(`visualizations/${id}/result.png`, 60) : null,
  }];
}

// ponytail: no notification yet; check Firestore → enquiries. Add the "Trigger Email from Firestore" extension when volume warrants.
// No rate limit either: spam here costs storage, not money. Add Turnstile if it starts happening.
async function createEnquiry(req: Request): Promise<Reply> {
  const parsed = parseEnquiry(req.body);
  if (!parsed.ok) return [400, { error: parsed.error }];
  const { enquiry, photo } = parsed.value;
  // The unified form attaches a preview by id; keep the link only when that preview really exists.
  if (enquiry.visualizationId && !(await db.doc(`visualizations/${enquiry.visualizationId}`).get()).exists) enquiry.visualizationId = null;
  const ref = db.collection('enquiries').doc();
  const photoPath = photo ? `enquiries/${ref.id}/photo.jpg` : null;
  if (photo && photoPath) await bucket.file(photoPath).save(photo, { contentType: 'image/jpeg' });
  await ref.set({ ...enquiry, photoPath, createdAt: Date.now() });
  return [201, { id: ref.id }];
}

// Flips processing → terminal exactly once. A concurrent poll that loses the race gets the winner's record,
// and the slot refund rides in the same transaction, so it can never be paid twice.
function finish(ref: DocumentReference, patch: { status: Visualization['status']; error?: string }, refund = false): Promise<Visualization> {
  return db.runTransaction(async (tx) => {
    const v = (await tx.get(ref)).data() as Visualization;
    if (v.status !== 'processing') return v;
    const update = { ...patch, completedAt: Date.now() };
    tx.update(ref, update);
    if (refund) tx.set(db.doc(`usage/${v.ipKey}`), { count: FieldValue.increment(-1) }, { merge: true });
    return { ...v, ...update };
  });
}

async function signedUrl(path: string, minutes: number) {
  const [url] = await bucket.file(path).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + minutes * 60_000 });
  return url;
}

function takeSlot(day: string, ipKey: string): Promise<boolean> {
  const total = db.doc(`usage/${day}`);
  const mine = db.doc(`usage/${ipKey}`);
  return db.runTransaction(async (tx) => {
    const [totalSnap, mineSnap] = await Promise.all([tx.get(total), tx.get(mine)]);
    if ((totalSnap.data()?.count ?? 0) >= DAILY_CAP || (mineSnap.data()?.count ?? 0) >= IP_CAP) return false;
    tx.set(total, { count: FieldValue.increment(1) }, { merge: true });
    tx.set(mine, { count: FieldValue.increment(1) }, { merge: true });
    return true;
  });
}

// Only the customer's own slot comes back; the daily total counts every attempt, because attempts may cost money.
function refundSlot(ipKey: string) {
  return db.doc(`usage/${ipKey}`).set({ count: FieldValue.increment(-1) }, { merge: true });
}
