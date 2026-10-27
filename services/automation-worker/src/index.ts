import { config } from 'dotenv';
import path from 'node:path';
import { createServer } from 'node:http';
import { getStore, isLocal, seedLocal, runWorker, clock } from '@allo/core';
import { createWorkerHandler } from './http';

config({ path: path.resolve(process.cwd(), process.cwd().endsWith('/services/automation-worker') ? '../../.env' : '.env') });
// This runtime is explicitly configured for non-delivery operation.
process.env.EMAIL_DELIVERY_ENABLED = 'false';
process.env.EMAIL_DRY_RUN = 'true';
const db = getStore();
let running = false;
let lastResult: unknown = null;
const reportOnly = process.argv.includes('--report-only');

async function tick() {
  if (reportOnly) throw new Error('Scheduled scans are disabled in report-only mode');
  if (running) return { skipped: true };
  running = true;
  try { return lastResult = await runWorker(db, await clock(db)); }
  finally { running = false; }
}

async function main() {
  if (isLocal()) await seedLocal(db);
  if (process.argv.includes('--once')) { console.log(await tick()); return; }
  const workerToken = process.env.WORKER_API_TOKEN || (isLocal() ? 'local-development-only' : '');
  const reportToken = process.env.REPORT_API_TOKEN || '';
  const reportWriteToken = process.env.REPORT_WRITE_TOKEN || '';
  if (reportWriteToken && [workerToken, reportToken].includes(reportWriteToken)) throw new Error('REPORT_WRITE_TOKEN must differ from read and worker tokens');
  if (!workerToken) throw new Error('WORKER_API_TOKEN is required');
  if (!reportToken) console.warn('REPORT_API_TOKEN is not set; /get-report will reject all requests.');
  if (reportToken && reportToken === workerToken) throw new Error('REPORT_API_TOKEN must differ from WORKER_API_TOKEN');
  const host = process.env.WORKER_HOST || '127.0.0.1';
  const port = Number(process.env.WORKER_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WORKER_PORT');
  const interval = Number(process.env.SCAN_INTERVAL_MS || (isLocal() ? 5000 : 300000));
  if (!Number.isFinite(interval) || interval < 1000) throw new Error('SCAN_INTERVAL_MS must be at least 1000');
  const server = createServer(createWorkerHandler({ db, workerToken, reportToken, reportWriteToken, editorId: process.env.REPORT_EDITOR_ID || 'external-report-editor', local: isLocal(), scansEnabled: !reportOnly, tick, lastResult: () => lastResult }));
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  console.log(`Automation server: http://${host}:${port} (${reportOnly ? 'report-only; scans disabled' : `scans every ${interval}ms`})`);
  if (reportOnly) return;
  // A scan failure must not prevent reporting and subsequent retry attempts.
  await tick().catch(error => console.error('[worker] Scan failed:', error?.code || 'unknown'));
  setInterval(() => void tick().catch(error => console.error('[worker] Scan failed:', error?.code || 'unknown')), interval);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
