// TEMPORARY: shows why `api/` crashes on Vercel. Reports only whether each variable is set, never its value. Delete after use.
const modules: Record<string, () => Promise<unknown>> = {
  catalog: () => import('./_lib/catalog.js'),
  rules: () => import('./_lib/rules.js'),
  prompt: () => import('./_lib/prompt.js'),
  imageProvider: () => import('./_lib/imageProvider.js'),
  db: () => import('./_lib/db.js'),
  handlers: () => import('./_lib/handlers.js'),
};

export async function GET() {
  const env = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'KIE_API_KEY', 'CRON_SECRET'].map((key) => [key, Boolean(process.env[key])]));
  const imports: Record<string, string> = {};
  for (const [name, load] of Object.entries(modules)) {
    try {
      await load();
      imports[name] = 'ok';
    } catch (err) {
      imports[name] = String(err).slice(0, 300);
    }
  }
  return Response.json({ node: process.version, vercelEnv: process.env.VERCEL_ENV, env, imports });
}
