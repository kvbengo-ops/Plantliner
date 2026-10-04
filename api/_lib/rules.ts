import { catalog, byId, type Option, type Plant } from './catalog.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const CHECK_EVERY_MS = 5_000;
export const GIVE_UP_AFTER_MS = 10 * 60_000;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export type Dims = { widthM?: number; lengthM?: number; ceilingM?: number };
export type Item = { plant: Plant; quantity: number };
type Room = { image: Buffer; space: Option; style: Option; dims: Dims; aspect: string };
export type VisualizationInput = Room & { mode: 'single'; plant: Plant; placement: Option };
export type MakeoverInput = Room & { mode: 'makeover'; items: Item[] };

// Image models stop counting reliably above this. Every item is at least 1, so it also keeps distinct
// products at 8 or fewer, under Kie's limit of 9 reference photos (10 images minus the room).
export const MAX_PLANTS = 8;

const DIM_RANGES: [keyof Dims, number, number][] = [['widthM', 1, 200], ['lengthM', 1, 200], ['ceilingM', 2, 20]];

// The browser re-encodes every photo as JPEG, so anything else is a broken or hand-made request.
export function parseImage(base64: unknown): Parsed<Buffer> {
  if (typeof base64 !== 'string' || !base64) return { ok: false, error: 'Please add a photo of your space.' };
  const image = Buffer.from(base64, 'base64');
  if (image.length > MAX_IMAGE_BYTES) return { ok: false, error: 'That photo is too large. Please try a smaller one.' };
  if (image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) return { ok: false, error: 'That photo could not be read. Please try a JPG, PNG, or WebP image.' };
  return { ok: true, value: image };
}

// Kie's allowed image_size ratios. 'auto' is left out on purpose: it can follow the plant photo's shape instead of the room's.
const RATIOS: [string, number][] = [['1:1', 1], ['9:16', 9 / 16], ['16:9', 16 / 9], ['3:4', 3 / 4], ['4:3', 4 / 3], ['3:2', 3 / 2], ['2:3', 2 / 3], ['5:4', 5 / 4], ['4:5', 4 / 5], ['21:9', 21 / 9]];

export function nearestRatio(width: number, height: number): string {
  const distance = (ratio: number) => Math.abs(Math.log(ratio / (width / height)));
  return RATIOS.reduce((best, candidate) => (distance(candidate[1]) < distance(best[1]) ? candidate : best))[0];
}

// Width and height from the first Start-Of-Frame marker; null when the file has none.
export function jpegSize(image: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < image.length) {
    if (image[i] !== 0xff) return null;
    const marker = image[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: image.readUInt16BE(i + 5), width: image.readUInt16BE(i + 7) };
    }
    const length = image.readUInt16BE(i + 2);
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function parseDims(raw: unknown): Parsed<Dims> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const dims: Dims = {};
  for (const [key, min, max] of DIM_RANGES) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !(value >= min && value <= max)) {
      return { ok: false, error: 'Please check the room size: ceiling 2–20 m, width and length 1–200 m.' };
    }
    dims[key] = value;
  }
  return { ok: true, value: dims };
}

// The photo, room size and output shape: everything both modes share once space and style are resolved.
function parseRoom(input: Record<string, unknown>, space: Option, style: Option): Parsed<Room> {
  const image = parseImage(input.image);
  if (!image.ok) return image;
  const size = jpegSize(image.value);
  if (!size?.width || !size.height) return { ok: false, error: 'That photo could not be read. Please try a JPG, PNG, or WebP image.' };
  const dims = parseDims(input.dims);
  if (!dims.ok) return dims;
  return { ok: true, value: { image: image.value, space, style, dims: dims.value, aspect: nearestRatio(size.width, size.height) } };
}

export function parseVisualizationRequest(body: unknown): Parsed<VisualizationInput> {
  const input = (body ?? {}) as Record<string, unknown>;
  const space = byId(catalog.spaceTypes, input.spaceType);
  const plant = byId(catalog.plants, input.productId);
  const style = byId(catalog.styles, input.style);
  const placement = byId(catalog.placements, input.placement);
  if (!space || !plant || !style || !placement) return { ok: false, error: 'Please choose a space, a plant, a style and a placement.' };
  const room = parseRoom(input, space, style);
  if (!room.ok) return room;
  return { ok: true, value: { ...room.value, mode: 'single', plant, placement } };
}

// Unknown ids, fractional or missing quantities and totals outside 1..MAX_PLANTS are rejected; repeated ids are merged.
export function parseItems(raw: unknown): Parsed<Item[]> {
  const error = `Please choose 1 to ${MAX_PLANTS} plants in total, with a quantity for each.`;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PLANTS) return { ok: false, error };
  const merged = new Map<string, Item>();
  for (const entry of raw) {
    const { productId, quantity } = (entry ?? {}) as Record<string, unknown>;
    const plant = byId(catalog.plants, productId);
    if (!plant || typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) return { ok: false, error };
    merged.set(plant.id, { plant, quantity: (merged.get(plant.id)?.quantity ?? 0) + quantity });
  }
  const items = [...merged.values()];
  return items.reduce((sum, item) => sum + item.quantity, 0) > MAX_PLANTS ? { ok: false, error } : { ok: true, value: items };
}

// Total plant makeover: the designer decides placement, so the request carries items and a style but no plant or placement.
export function parseMakeoverRequest(body: unknown): Parsed<MakeoverInput> {
  const input = (body ?? {}) as Record<string, unknown>;
  const space = byId(catalog.spaceTypes, input.spaceType);
  const style = byId(catalog.styles, input.style);
  if (!space || !style) return { ok: false, error: 'Please choose a space and a style.' };
  const items = parseItems(input.items);
  if (!items.ok) return items;
  const room = parseRoom(input, space, style);
  if (!room.ok) return room;
  return { ok: true, value: { ...room.value, mode: 'makeover', items: items.value } };
}

export function nextStep(v: { status: string; createdAt: number; checkedAt: number }, now: number): 'done' | 'timeout' | 'check' | 'wait' {
  if (v.status !== 'processing') return 'done';
  if (now - v.createdAt > GIVE_UP_AFTER_MS) return 'timeout';
  return now - v.checkedAt >= CHECK_EVERY_MS ? 'check' : 'wait';
}

export type Enquiry = {
  space: string;
  light: string;
  size: string;
  notes: string;
  name: string;
  contactMethod: 'Email' | 'Phone';
  contact: string;
  productId: string | null;
  visualizationId: string | null;
};

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export function parseEnquiry(body: unknown): Parsed<{ enquiry: Enquiry; photo: Buffer | null }> {
  const input = (body ?? {}) as Record<string, unknown>;
  const space = byId(catalog.spaceTypes, input.space);
  const method = input.contactMethod;
  const contactMethod = method === 'Email' || method === 'Phone' ? method : null;
  const name = text(input.name, 200);
  const contact = text(input.contact, 200);
  if (!space || !contactMethod || !name || !contact) return { ok: false, error: 'Please choose your space and tell us your name and how to reach you.' };
  let photo: Buffer | null = null;
  if (input.photo) {
    const parsed = parseImage(input.photo);
    if (!parsed.ok) return parsed;
    photo = parsed.value;
  }
  const visualizationId = typeof input.visualizationId === 'string' && /^[A-Za-z0-9]{20}$/.test(input.visualizationId) ? input.visualizationId : null;
  return {
    ok: true,
    value: {
      photo,
      enquiry: {
        space: space.id,
        light: text(input.light, 100),
        size: text(input.size, 100),
        notes: text(input.notes, 5000),
        name,
        contactMethod,
        contact,
        productId: byId(catalog.plants, input.productId)?.id ?? null,
        visualizationId,
      },
    },
  };
}
