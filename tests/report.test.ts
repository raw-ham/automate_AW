import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { LocalStore, seedLocal } from '@allo/core';
import { databaseReport, ReportInputError } from '../services/automation-worker/src/report';
import { createWorkerHandler } from '../services/automation-worker/src/http';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'allo-report-'));
  const db = new LocalStore(path.join(directory, 'data.json'));
  await seedLocal(db);
  return { db, dispose: () => rm(directory, { recursive: true }) };
}

test('report exports allowlisted fields and never mutates database records', async () => {
  const { db, dispose } = await fixture();
  try {
    await db.transaction(async tx => {
      const user = await tx.get('users', 'manager');
      tx.set('users', 'manager', { ...user, email: 'private@example.com', passwordHash: 'PRIVATE_VALUE', accessToken: 'PRIVATE_VALUE', credentials: { key: 'PRIVATE_VALUE' } });
      tx.set('notificationOutbox', 'private', { text: 'PRIVATE_VALUE', apiKey: 'PRIVATE_VALUE' });
      tx.set('appConfig', 'secret', { apiKey: 'PRIVATE_VALUE' });
    });
    const before = await db.read();
    const report = await databaseReport(db, new URL('http://localhost/get-report'));
    const json = JSON.stringify(report);
    assert.ok(!json.includes('PRIVATE_VALUE'));
    assert.ok(!json.includes('private@example.com'));
    assert.equal(report.schemaVersion, '1.1');
    assert.equal(report.pageCounts.users, 7);
    assert.equal(report.pagination.hasMore, false);
    assert.equal(report.pagination.nextCursor, null);
    assert.deepEqual(await db.read(), before);
  } finally { await dispose(); }
});

test('pagination retrieves all records without duplicating completed collections', async () => {
  const { db, dispose } = await fixture();
  try {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const url = new URL('http://localhost/get-report?limit=1');
      if (cursor) url.searchParams.set('cursor', cursor);
      const report = await databaseReport(db, url);
      for (const [collection, rows] of Object.entries(report.data)) {
        assert.ok(rows.length <= 1);
        for (const row of rows) {
          const key = `${collection}/${row.id}`;
          assert.ok(!seen.has(key), `duplicate ${key}`);
          seen.add(key);
        }
      }
      cursor = report.pagination.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, null);
    assert.equal([...seen].filter(key => key.startsWith('users/')).length, 7);
    assert.equal([...seen].filter(key => key.startsWith('tasks/')).length, 4);
    assert.equal([...seen].filter(key => key.startsWith('taskCycles/')).length, 4);
  } finally { await dispose(); }
});

test('report rejects malformed cursors, limits and arbitrary collection requests', async () => {
  const { db, dispose } = await fixture();
  try {
    for (const query of ['limit=0', 'limit=501', 'limit=1.5', 'cursor=garbage', 'collection=appConfig']) {
      await assert.rejects(databaseReport(db, new URL(`http://localhost/get-report?${query}`)), ReportInputError);
    }
  } finally { await dispose(); }
});

test('HTTP endpoint isolates report and worker tokens, enforces GET, and prevents caching', async () => {
  const { db, dispose } = await fixture();
  let scans = 0;
  const server = createServer(createWorkerHandler({ db, workerToken: 'worker-secret', reportToken: 'report-secret', local: false, tick: async () => { scans++; return { ok: true }; }, lastResult: () => ({ private: true }) }));
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    for (const token of ['', 'wrong', 'worker-secret']) {
      const response = await fetch(base + '/get-report', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      assert.equal(response.status, 401);
    }
    assert.equal((await fetch(base + '/get-report?token=report-secret')).status, 401);
    assert.equal((await fetch(base + '/get-report?key=wrong')).status, 401);
    assert.equal((await fetch(base + '/get-report?key=worker-secret')).status, 401);
    assert.equal((await fetch(base + '/get-report?key=report-secret&key=report-secret')).status, 401);
    const queryResponse = await fetch(base + '/get-report?key=report-secret&limit=1');
    assert.equal(queryResponse.status, 200);
    assert.equal(queryResponse.headers.get('referrer-policy'), 'no-referrer');
    const queryReport = await queryResponse.json();
    assert.equal(queryReport.pageCounts.users, 1);
    assert.ok(!JSON.stringify(queryReport).includes('report-secret'));
    assert.equal((await fetch(base + '/scan?key=worker-secret', { method: 'POST' })).status, 401);
    const response = await fetch(base + '/get-report?limit=2', { headers: { Authorization: 'Bearer report-secret' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type')!, /application\/json/);
    assert.equal((await response.json()).pageCounts.users, 2);
    assert.equal((await fetch(base + '/get-report', { method: 'POST', headers: { Authorization: 'Bearer report-secret' } })).status, 405);
    assert.equal((await fetch(base + '/scan', { method: 'POST', headers: { Authorization: 'Bearer report-secret' } })).status, 401);
    assert.equal(scans, 0);
    const publicHealth = await (await fetch(base + '/health')).json();
    assert.ok(!('lastResult' in publicHealth));
    const scan = await fetch(base + '/scan', { method: 'POST', headers: { Authorization: 'Bearer worker-secret' } });
    assert.equal(scan.status, 200);
    assert.equal(scans, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await dispose();
  }
});
