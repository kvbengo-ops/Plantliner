import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';

export const BUCKET = 'plantliner';

// Service-role key: bypasses row level security, so it must only ever live in server-side environment variables.
export const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

export function must<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// 20 letters/digits (about 119 bits): the id is also the share link, so it has to be unguessable.
export const newId = () => Array.from(randomBytes(20), (byte) => ALPHABET[byte % ALPHABET.length]).join('');

export async function save(path: string, body: Buffer, contentType: string) {
  const { error } = await db.storage.from(BUCKET).upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`Upload failed: ${error.message}`);
}

export async function signedUrl(path: string, minutes: number) {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, minutes * 60);
  if (error) throw new Error(`Signing failed: ${error.message}`);
  return data.signedUrl;
}
