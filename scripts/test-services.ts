import { spawnSync } from 'node:child_process';
for (const suite of ['auth', 'catalog', 'lifecycle', 'payments']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', `tests/integration/${suite}.ts`], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
