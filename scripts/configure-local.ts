import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parse } from 'dotenv';
let current = await readFile('.env', 'utf8').catch(() => readFile('.env.example', 'utf8'));
if (!/^AUTH_SECRET=/m.test(current)) current += '\nAUTH_SECRET=\n';
if (!/^AUTH_SECRET=.+$/m.test(current))
  current = current.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${randomBytes(48).toString('hex')}`);
await writeFile('.env', current, { mode: 0o600 });
const publicVariables = Object.entries(parse(current)).filter(([name]) => name.startsWith('VITE_'));
await writeFile(
  'apps/web/.env.local',
  '# Generated public frontend configuration only.\n' +
    publicVariables.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') +
    '\n',
);
console.log(
  'Local environment ready. Secrets were generated without printing them. Existing configured values were preserved.',
);
