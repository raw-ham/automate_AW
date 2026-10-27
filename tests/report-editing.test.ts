import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { LocalStore, seedLocal, runWorker, deliverOutbox, buildCycleReport } from '@allo/core';
import { editReport, ReportEditError } from '../services/automation-worker/src/edit-report';
import { createWorkerHandler } from '../services/automation-worker/src/http';
import { databaseReport } from '../services/automation-worker/src/report';

process.env.DATA_MODE = 'local';
process.env.EMAIL_DELIVERY_ENABLED = 'false';
process.env.EMAIL_DRY_RUN = 'true';
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'allo-edit-'));
  const db = new LocalStore(path.join(directory, 'data.json'));
  await seedLocal(db);
  const now = (await db.get('appConfig', 'settings'))!.testClock;
  await runWorker(db, now);
  const cycle = (await db.list('taskCycles'))[0]!;
  return { db, cycle, now, dispose: () => rm(directory, { recursive: true }) };
}

test('edits atomically update source cycle, derived report and immutable audit history', async () => {
  const { db, cycle, now, dispose } = await fixture();
  try {
    const input = { requestId: 'request-0001', expectedRevision: 0, changes: { reportNote: 'Portal evidence needs review', reviewStatus: 'NEEDS_ACTION', customTags: ['follow-up', 'follow-up'] } };
    const result = await editReport(db, cycle.id, input, 'ai-reviewer');
    assert.equal(result.revision, 1);
    assert.equal((await db.get('taskCycles', cycle.id))!.reportNote, input.changes.reportNote);
    assert.deepEqual((await db.get('reports', cycle.id))!.customTags, ['follow-up']);
    assert.equal((await db.get('taskCycles', cycle.id))!.status, cycle.status);
    const audit = (await db.list('auditLogs', [['type', '==', 'REPORT_EDITED']]))[0]!;
    assert.equal(audit.actor, 'integration:ai-reviewer');
    assert.equal(audit.changes[0].before, '');
    const replay = await editReport(db, cycle.id, input, 'ai-reviewer');
    assert.equal(replay.replayed, true);
    assert.equal((await db.list('auditLogs', [['type', '==', 'REPORT_EDITED']])).length, 1);
    await runWorker(db, now);
    assert.equal((await db.get('reports', cycle.id))!.reportNote, input.changes.reportNote);
    assert.equal((await db.get('reports', cycle.id))!.reportRevision, 1);
  } finally { await dispose(); }
});

test('concurrent/stale edits and forged lifecycle or mail facts are rejected', async () => {
  const { db, cycle, dispose } = await fixture();
  try {
    const attempt = (requestId: string) => editReport(db, cycle.id, { requestId, expectedRevision: 0, changes: { reportNote: requestId } }, 'reviewer');
    const outcomes = await Promise.allSettled([attempt('request-first'), attempt('request-second')]);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(x => x.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.status, 409);
    await assert.rejects(editReport(db, cycle.id, { requestId: 'request-forged', expectedRevision: 1, changes: { status: 'COMPLETED', mailTags: ['Mailed manager'] } }, 'reviewer'), (e: unknown) => e instanceof ReportEditError && e.status === 400);
    await assert.rejects(editReport(db, cycle.id, { requestId: 'request-first', expectedRevision: 1, changes: { reportNote: 'Reusing request ID with changed payload' } }, 'reviewer'), (e: unknown) => e instanceof ReportEditError && e.status === 409);
  } finally { await dispose(); }
});

test('mail labels distinguish suppressed preparation from actual historical sends', () => {
  const cycle = { id: 'cycle', status: 'OVERDUE', escalationCount: 1 };
  const suppressed = buildCycleReport(cycle, {}, null, { name: 'Rahul' }, [{ id: 'm1', kind: 'MANAGER_OVERDUE', recipient: 'manager@example.com', deliveryStatus: 'SUPPRESSED' }]);
  assert.match(suppressed.mailTags[0]!, /Pending mail to Rahul — mailing disabled/);
  assert.equal(suppressed.mailHistory[0]!.sent, false);
  assert.equal(suppressed.mailHistory[0]!.sentAt, null);
  const sent = buildCycleReport(cycle, {}, null, { name: 'Rahul' }, [{ id: 'm2', kind: 'MANAGER_OVERDUE', deliveryStatus: 'SENT', sentAt: '2026-10-01T10:00:00Z' }]);
  assert.equal(sent.mailTags[0], 'Mailed Rahul');
  assert.equal(sent.mailHistory[0]!.sent, true);
});

test('mail-disabled worker cannot call an email provider even for queued records', async () => {
  const { db, dispose } = await fixture();
  const previousMode = process.env.DATA_MODE;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    process.env.DATA_MODE = 'firebase';
    await db.transaction(async tx => { tx.set('notificationOutbox', 'pending', { id: 'pending', status: 'QUEUED' }); });
    globalThis.fetch = (async () => { requests++; throw new Error('No network calls should occur'); }) as typeof fetch;
    await deliverOutbox(db);
    assert.equal(requests, 0);
    assert.equal((await db.get('notificationOutbox', 'pending'))!.status, 'QUEUED');
  } finally { globalThis.fetch = originalFetch; process.env.DATA_MODE = previousMode; await dispose(); }
});

test('write token scopes, browser editor, and live changes work over HTTP', async () => {
  const { db, cycle, dispose } = await fixture();
  const server = createServer(createWorkerHandler({ db, workerToken: 'worker-secret', reportToken: 'read-secret', reportWriteToken: 'write-secret', editorId: 'test-agent', local: true, tick: async () => ({}), lastResult: () => null }));
  const controller = new AbortController();
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const payload = { requestId: 'http-edit-001', expectedRevision: 0, changes: { reportNote: 'Live edit' } };
    for (const token of ['read-secret', 'worker-secret', 'wrong']) assert.equal((await fetch(base + '/reports/' + cycle.id, { method: 'PATCH', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(payload) })).status, 401);
    assert.equal((await fetch(base + '/report-editor')).status, 200);
    const stream = await fetch(base + '/report-events?key=read-secret', { signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const readEvent = async () => {
      let buffer = '';
      const timeout = setTimeout(() => controller.abort(), 4000);
      try { while (!buffer.includes('event: report-changed')) { const chunk = await reader.read(); if (chunk.done) throw new Error('Stream closed early'); buffer += new TextDecoder().decode(chunk.value); } }
      finally { clearTimeout(timeout); }
    };
    await readEvent();
    const edit = await fetch(base + '/reports/' + cycle.id + '?key=write-secret', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(edit.status, 200);
    const result = await edit.json(); assert.equal(result.actor, 'integration:test-agent');
    await readEvent();
    const report = await (await fetch(base + '/get-report?key=read-secret')).json();
    assert.equal(report.permissions.edit, false);
    assert.equal(report.data.reports.find((r: { id: string }) => r.id === cycle.id).reportNote, 'Live edit');
    assert.equal((await (await fetch(base + '/get-report?key=write-secret')).json()).permissions.edit, true);
    assert.equal((await databaseReport(db, new URL('http://localhost/get-report'))).schemaVersion, '1.1');
    controller.abort(); await reader.cancel().catch(() => {});
  } finally {
    controller.abort();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await dispose();
  }
});
