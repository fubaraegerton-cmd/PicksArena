import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';

/**
 * Serves the Vercel functions in /api during `npm run dev`, so the admin dashboard works locally.
 * Data is stored in .data/admin.json. Set ADMIN_PASSWORD in your shell to log in.
 */
function devApi(): Plugin {
  return {
    name: 'dev-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        // Same routing as Vercel: /api/a/b -> api/a/b.ts
        if (!/^\/api\/[a-z0-9/_-]+$/i.test(url.pathname)) return next();
        const route = `${url.pathname}.ts`;
        if (!existsSync(`${process.cwd()}${route}`)) return next();
        try {
          const mod = await server.ssrLoadModule(route);
          const handler = mod[req.method ?? 'GET'];
          if (!handler) {
            res.statusCode = 405;
            return res.end('Method not allowed');
          }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const request = new Request(url, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
          });
          const response: Response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Make .env / .env.local values (e.g. SUPABASE_SECRET_KEY) visible to the dev API handlers.
  for (const [k, v] of Object.entries(loadEnv(mode, process.cwd(), ''))) process.env[k] ??= v;
  return {
  plugins: [
    react(),
    devApi(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'PicksArena',
        short_name: 'PicksArena',
        description: 'Daily fantasy pick’em. Call More or Less on player projections.',
        start_url: '/board',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f0f0f',
        theme_color: '#0f0f0f',
        categories: ['sports', 'games'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [{ name: 'My Lineups', url: '/lineups' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
};
});
