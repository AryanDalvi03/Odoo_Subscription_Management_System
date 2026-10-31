import { writeFile } from 'node:fs/promises';
const raw = process.env.API_PUBLIC_ORIGIN;
if (!raw) throw new Error('Set API_PUBLIC_ORIGIN to the deployed HTTPS backend origin');
const origin = new URL(raw);
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/')
  throw new Error('Use an HTTPS origin without a path or credentials');
await writeFile(
  'apps/web/vercel.json',
  JSON.stringify(
    {
      buildCommand: 'cd ../.. && npm run build',
      outputDirectory: 'dist',
      rewrites: [
        { source: '/api/:path*', destination: `${origin.origin}/api/:path*` },
        { source: '/((?!api/).*)', destination: '/index.html' },
      ],
      headers: [
        {
          source: '/assets/(.*)',
          headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
        },
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log('Vercel same-origin API proxy configured. Review the generated file before deploying.');
