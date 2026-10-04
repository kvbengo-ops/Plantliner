// TEMPORARY: shows why `api/` misbehaves on Vercel. Reports only whether each variable is set and what KIND of Supabase key it is, never a value. Delete after use.
const modules: Record<string, () => Promise<unknown>> = {
  catalog: () => import('./_lib/catalog.js'),
  rules: () => import('./_lib/rules.js'),
  prompt: () => import('./_lib/prompt.js'),
  imageProvider: () => import('./_lib/imageProvider.js'),
  db: () => import('./_lib/db.js'),
  handlers: () => import('./_lib/handlers.js'),
};

function keyKind(key: string) {
  if (!key) return 'missing';
  if (key.startsWith('sb_secret_')) return 'secret (correct)';
  if (key.startsWith('sb_publishable_')) return 'PUBLISHABLE (wrong: cannot write)';
  try {
    return `jwt, role=${JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role}`;
  } catch {
    return 'unrecognised format';
  }
}

export async function GET() {
  const env = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'KIE_API_KEY', 'CRON_SECRET', 'GROQ_API_KEY'].map((key) => [key, Boolean(process.env[key])]));
  const imports: Record<string, string> = {};
  for (const [name, load] of Object.entries(modules)) {
    try {
      await load();
      imports[name] = 'ok';
    } catch (err) {
      imports[name] = String(err).slice(0, 300);
    }
  }
  const checks: Record<string, string> = { supabaseKey: keyKind(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '') };
  try {
    const { db } = await import('./_lib/db.js');
    // refund_slot on a key that does not exist changes nothing; it only proves the key may call server-only functions.
    checks.rpc = (await db.rpc('refund_slot', { p_ip_key: 'diag-nonexistent' })).error?.message ?? 'ok';
    checks.bucket = (await db.storage.getBucket('plantliner')).error?.message ?? 'ok';
    checks.tableRead = (await db.from('enquiries').select('id').limit(1)).error?.message ?? 'ok';
  } catch (err) {
    checks.error = String(err).slice(0, 300);
  }
  // The makeover is only allowed when the flag is exactly '1', so report its length and exactness, never its value.
  const flag = process.env.MAKEOVER_ENABLED;
  const makeoverFlag = { set: flag !== undefined, length: flag?.length ?? 0, exactlyOne: flag === '1' };
  const deployment = { commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7), branch: process.env.VERCEL_GIT_COMMIT_REF, id: process.env.VERCEL_DEPLOYMENT_ID };
  return Response.json({ vercelEnv: process.env.VERCEL_ENV, deployment, makeoverFlag, env, imports, checks });
}
