import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const suffix = Date.now().toString();
const database = `subscriptiq_smoke_${suffix}`;
const prefix = `sq-smoke-${suffix}`;
const api = `sq-api-${suffix}`;
const worker = `sq-worker-${suffix}`;
const env = { ...process.env, AUTH_SECRET: randomBytes(48).toString('hex') };
function docker(args: string[], required = true) {
  const result = spawnSync('docker', args, { encoding: 'utf8', env });
  if (required && result.status !== 0)
    throw new Error(result.stderr || result.stdout || 'Docker command failed');
  return result.stdout.trim();
}
try {
  const variables = [
    '--network',
    'odoo_default',
    '-e',
    'AUTH_SECRET',
    '-e',
    `QUEUE_PREFIX=${prefix}`,
    '-e',
    'NODE_ENV=production',
    '-e',
    `MONGODB_URI=mongodb://mongo:27017/${database}?replicaSet=rs0`,
    '-e',
    'REDIS_URL=redis://redis:6379',
  ];
  docker([
    'run',
    '--rm',
    '-d',
    '--name',
    worker,
    ...variables,
    'odoo-api:latest',
    'node',
    'apps/worker/dist/index.js',
  ]);
  docker(['run', '--rm', '-d', '--name', api, ...variables, 'odoo-api:latest']);
  const check =
    "let n=0;const run=async()=>{try{const r=await fetch('http://localhost:4000/api/health/ready');if(!r.ok)throw Error('Not ready');const ready=await r.json();if(Object.values(ready.data.checks).some(x=>!x))throw Error('Not ready');const spec=await(await fetch('http://localhost:4000/api/openapi.json')).json();if(Object.keys(spec.paths).length<60)throw Error('Missing API spec');if(process.getuid()===0)throw Error('Root user');console.log('PASS production container: API + worker + transactions/Redis readiness, OpenAPI and non-root runtime')}catch(e){if(++n<30)setTimeout(run,500);else{console.error(e.message);process.exit(1)}}};run()";
  console.log(docker(['exec', api, 'node', '-e', check]));
} finally {
  docker(['stop', api], false);
  docker(['stop', worker], false);
  if (!database.startsWith('subscriptiq_smoke_') || !prefix.startsWith('sq-smoke-'))
    throw new Error('Unsafe cleanup target');
  docker(
    [
      'exec',
      'odoo-mongo-1',
      'mongosh',
      '--quiet',
      `mongodb://localhost:27017/${database}?directConnection=true`,
      '--eval',
      'db.dropDatabase()',
    ],
    false,
  );
  const cleanup = `import {Queue} from 'bullmq';import {Redis} from 'ioredis';const connection=new Redis('redis://redis:6379',{maxRetriesPerRequest:1});for(const name of ['subscriptiq-operations','subscriptiq-billing','subscriptiq-email']){const q=new Queue(name,{connection,prefix:'${prefix}'});await q.obliterate({force:true});await q.close();}await connection.del('${prefix}:worker:heartbeat');connection.disconnect();`;
  docker(
    [
      'run',
      '--rm',
      '--network',
      'odoo_default',
      'odoo-api:latest',
      'node',
      '--input-type=module',
      '-e',
      cleanup,
    ],
    false,
  );
}
