import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

// ponytail: one environment. Put API_ORIGIN=https://<your-vercel-site> in .env and `npm run dev` talks to the live /api (Vercel rewrites it to Firebase).
// Without it there is no proxy, so the site still builds and runs before the API exists.
const origin = loadEnv('development', process.cwd(), '').API_ORIGIN;

export default defineConfig({
  vite: origin ? { server: { proxy: { '/api': { target: origin, changeOrigin: true } } } } : {},
});
