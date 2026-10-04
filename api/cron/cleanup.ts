import { BUCKET, db, must } from '../_lib/db.js';

// Runs daily (vercel.json). Deletes expired previews and their images, which is the 30-day retention.
// It also touches the database every day, so a free Supabase project is never paused for inactivity.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET; // Vercel sends this as a Bearer token on cron calls
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return Response.json({ error: 'Not found' }, { status: 404 });

  const now = Date.now();
  const expired = must(await db.from('visualizations').select('id').lt('expires_at', now).limit(200)) as { id: string }[];
  if (expired.length) {
    const ids = expired.map((row) => row.id);
    const { error } = await db.storage.from(BUCKET).remove(ids.flatMap((id) => [`visualizations/${id}/room.jpg`, `visualizations/${id}/result.png`]));
    if (error) throw new Error(error.message);
    must(await db.from('visualizations').delete().in('id', ids));
  }
  // Usage counters older than two days are no longer needed. Keys start with the UTC day, so a string compare works.
  must(await db.from('usage_counts').delete().lt('key', new Date(now - 2 * 86_400_000).toISOString().slice(0, 10)));
  return Response.json({ deleted: expired.length });
}
