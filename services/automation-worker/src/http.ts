import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '@allo/core';
import { databaseReport, ReportInputError } from './report';
import { editReport, ReportEditError } from './edit-report';

export function validBearer(header: string | undefined, expected: string): boolean {
  const match = header?.match(/^Bearer (\S+)$/i);
  if (!expected || !match) return false;
  const actual = Buffer.from(match[1]!);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function readJson(req: IncomingMessage, maximum = 16384) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maximum) throw new ReportEditError(413, 'Request body is too large');
  }
  try { return JSON.parse(body); }
  catch { throw new ReportEditError(400, 'Request body must be valid JSON'); }
}

export function createWorkerHandler(options: {
  db: Store;
  workerToken: string;
  reportToken: string;
  reportWriteToken?: string;
  editorId?: string;
  local: boolean;
  scansEnabled?: boolean;
  tick: () => Promise<unknown>;
  lastResult: () => unknown;
}) {
  let streams = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    const send = (status: number, body: unknown) => { res.writeHead(status, headers); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const keys = url.searchParams.getAll('key');
      const auth = (token: string) => keys.length <= 1 && (validBearer(req.headers.authorization, token) || keys.length === 1 && validBearer(`Bearer ${keys[0]}`, token));
      const mayEdit = auth(options.reportWriteToken || '');
      const mayRead = mayEdit || auth(options.reportToken);
      if (url.pathname === '/health' && req.method === 'GET') {
        send(200, { ok: true, mode: options.local ? 'local' : 'firebase', scansEnabled: options.scansEnabled !== false, mailingEnabled: false, reportEditingConfigured: !!options.reportWriteToken, ...(validBearer(req.headers.authorization, options.workerToken) ? { lastResult: options.lastResult() } : {}) });
        return;
      }
      if (url.pathname === '/report-editor' && req.method === 'GET') {
        const html = await readFile(new URL('./editor.html', import.meta.url), 'utf8');
        res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
        res.end(html);
        return;
      }
      if (url.pathname === '/report-events') {
        if (!mayRead) { send(401, { error: 'A valid report token is required' }); return; }
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); send(405, { error: 'Use GET' }); return; }
        if (streams >= 16) { send(429, { error: 'Too many active report streams. Retry later.' }); return; }
        res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 3000\n\n');
        streams++;
        let closed = false;
        let debounce: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe = () => {};
        const cleanup = () => { if (closed) return; closed = true; streams--; clearTimeout(debounce); clearInterval(heartbeat); clearTimeout(lifetime); unsubscribe(); };
        const heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 15000);
        const lifetime = setTimeout(() => { cleanup(); res.end(); }, 600000);
        res.once('close', cleanup);
        try {
          unsubscribe = options.db.subscribe(['taskCycles', 'reports', 'tasks', 'users', 'escalationEvents', 'auditLogs'], () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => { if (!closed) res.write(`event: report-changed\ndata: ${JSON.stringify({ changedAt: new Date().toISOString() })}\n\n`); }, 300);
          }, () => { if (!closed) { res.write('event: sync-error\ndata: {"error":"Live database subscription unavailable"}\n\n'); cleanup(); res.end(); } });
          if (closed) unsubscribe();
        } catch { res.write('event: sync-error\ndata: {"error":"Live database subscription unavailable"}\n\n'); cleanup(); res.end(); }
        return;
      }
      const editMatch = url.pathname.match(/^\/reports\/([^/]+)$/);
      if (editMatch) {
        if (!mayEdit) { send(401, { error: 'REPORT_WRITE_TOKEN is required to edit reports' }); return; }
        if (req.method !== 'PATCH') { res.setHeader('Allow', 'PATCH'); send(405, { error: 'Use PATCH /reports/{cycleId}' }); return; }
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) { send(403, { error: 'Cross-origin edits are not allowed' }); return; }
        const body = await readJson(req);
        send(200, await editReport(options.db, decodeURIComponent(editMatch[1]!), body, options.editorId || 'external-report-editor'));
        return;
      }
      if (url.pathname === '/get-report') {
        if (!mayRead) {
          res.setHeader('WWW-Authenticate', 'Bearer');
          send(401, { error: 'A valid report token is required in the Authorization header or key query parameter' });
          return;
        }
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); send(405, { error: 'Use GET /get-report' }); return; }
        url.searchParams.delete('key');
        try { send(200, { ...await databaseReport(options.db, url), permissions: { read: true, edit: mayEdit } }); }
        catch (error) {
          if (error instanceof ReportInputError) send(400, { error: error.message });
          else { console.error('[report] Database read failed; code:', (error as { code?: unknown })?.code ?? 'unknown'); send(503, { error: 'Report database is unavailable. Retry later.' }); }
        }
        return;
      }
      if (!['/scan', '/advance'].includes(url.pathname)) { send(404, { error: 'Not found' }); return; }
      if (!validBearer(req.headers.authorization, options.workerToken)) { send(401, { error: 'Unauthorized' }); return; }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(405, { error: 'Use POST' }); return; }
      if (options.scansEnabled === false) { send(409, { error: 'Scans are disabled in report-only mode' }); return; }
      if (url.pathname === '/advance') {
        if (!options.local) { send(404, { error: 'Not found' }); return; }
        const hours = Number((await readJson(req, 1024)).hours);
        if (![1, 24, 48].includes(hours)) { send(400, { error: 'Invalid clock advance' }); return; }
        await options.db.transaction(async tx => {
          const config = await tx.get('appConfig', 'settings');
          tx.set('appConfig', 'settings', { ...config, testClock: new Date(Date.parse(config!.testClock) + hours * 3600000).toISOString() });
        });
      }
      send(200, await options.tick());
    } catch (error) {
      if (error instanceof ReportEditError) send(error.status, { error: error.message });
      else { console.error('[worker-http] Request failed; code:', (error as { code?: unknown })?.code ?? 'unknown'); send(503, { error: 'Worker request failed; retry later' }); }
    }
  };
}
