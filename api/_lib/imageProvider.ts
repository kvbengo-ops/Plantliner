// The only file that knows about Kie.ai. To change provider, rewrite this file and keep the exports.
// The key lives only in the Vercel environment variable KIE_API_KEY, never in the repo.
export const PROVIDER = 'kie';
export const MODEL = 'google/nano-banana-edit';
const BASE = 'https://api.kie.ai/api/v1/jobs';

export type ProviderTask = { state: 'pending' } | { state: 'success'; imageUrl: string } | { state: 'fail'; message: string };

async function call(path: string, init: RequestInit = {}) {
  if (!process.env.KIE_API_KEY) throw new Error('KIE_API_KEY is not set');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.KIE_API_KEY}`, 'Content-Type': 'application/json' },
  });
  const json = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: any } | null;
  if (!res.ok || json?.code !== 200) throw new Error(`Kie ${path} failed: HTTP ${res.status} ${json?.msg ?? ''}`);
  return json.data;
}

// ponytail: no automatic retry; a failed start refunds the customer's slot and they can press the button again.
export async function createTask(prompt: string, imageUrls: string[], aspect: string): Promise<string> {
  const data = await call('/createTask', {
    method: 'POST',
    // Never 'auto': G0 run 1 returned a portrait image for a landscape room. `aspect` is the room photo's own shape.
    body: JSON.stringify({ model: MODEL, input: { prompt, image_urls: imageUrls, output_format: 'png', image_size: aspect } }),
  });
  return data.taskId;
}

export async function getTask(taskId: string): Promise<ProviderTask> {
  return parseTask(await call(`/recordInfo?taskId=${encodeURIComponent(taskId)}`));
}

export function parseTask(data: { state?: string; resultJson?: string; failMsg?: string }): ProviderTask {
  if (data.state === 'fail') return { state: 'fail', message: data.failMsg || 'Provider failed' };
  if (data.state !== 'success') return { state: 'pending' };
  let urls: unknown;
  try {
    urls = JSON.parse(data.resultJson ?? '{}').resultUrls;
  } catch {
    urls = undefined;
  }
  const imageUrl = Array.isArray(urls) && typeof urls[0] === 'string' ? urls[0] : null;
  return imageUrl ? { state: 'success', imageUrl } : { state: 'fail', message: 'Provider returned no image' };
}
