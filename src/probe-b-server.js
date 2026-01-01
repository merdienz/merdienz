import { existsSync, readFileSync } from 'node:fs';
import { createProbeApp } from './probes/app.js';
import { assertProbeBServerConfig, loadProbeBConfig } from './probes/server-config.js';

const config = loadProbeBConfig();
try {
  assertProbeBServerConfig(config);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

let httpsOptions;
if (config.probeBTlsCert || config.probeBTlsKey) {
  if (!existsSync(config.probeBTlsCert) || !existsSync(config.probeBTlsKey)) {
    console.error('PROBE_B_TLS_CERT and PROBE_B_TLS_KEY must point at readable PEM files');
    process.exit(1);
  }
  httpsOptions = {
    cert: readFileSync(config.probeBTlsCert),
    key: readFileSync(config.probeBTlsKey),
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
  };
}

const app = await createProbeApp({ config, https: httpsOptions });
await app.listen({ port: config.port, host: config.host });
const scheme = httpsOptions ? 'https' : 'http';
console.log(`Merdienz probe B listening on ${scheme}://${config.host}:${config.port}`);

async function shutdown() {
  await app.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
