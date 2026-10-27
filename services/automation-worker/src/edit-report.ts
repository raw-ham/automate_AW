import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildCycleReport, type Store } from '@allo/core';

const schema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  expectedRevision: z.number().int().nonnegative(),
  changes: z.object({
    reportNote: z.string().trim().max(5000).optional(),
    reviewStatus: z.enum(['UNREVIEWED', 'IN_REVIEW', 'REVIEWED', 'NEEDS_ACTION']).optional(),
    customTags: z.array(z.string().trim().min(1).max(60)).max(20).transform(tags => [...new Set(tags)]).optional(),
  }).strict().refine(changes => Object.keys(changes).length > 0, 'Provide at least one editable field'),
}).strict();

export class ReportEditError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function editReport(db: Store, cycleId: string, body: unknown, editorId: string) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ReportEditError(400, parsed.error.issues.map(issue => issue.message).join('; '));
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cycleId)) throw new ReportEditError(400, 'Invalid cycle ID');
  const input = parsed.data;
  const hash = createHash('sha256').update(JSON.stringify({ cycleId, ...input })).digest('hex');
  const history = await db.list('escalationEvents', [['cycleId', '==', cycleId]]);
  const actor = `integration:${editorId}`;
  return db.transaction(async tx => {
    const [cycle, prior] = await Promise.all([tx.get('taskCycles', cycleId), tx.get('reportMutations', input.requestId)]);
    if (prior) {
      if (prior.hash !== hash) throw new ReportEditError(409, 'requestId was already used for another edit');
      return { ...prior.result, replayed: true };
    }
    if (!cycle) throw new ReportEditError(404, 'Task cycle not found');
    const [task, employee, manager] = await Promise.all([tx.get('tasks', cycle.taskId), tx.get('users', cycle.employeeUid), tx.get('users', cycle.managerUid)]);
    if (!task) throw new ReportEditError(404, 'Task master not found');
    const revision = cycle.reportRevision || 0;
    if (revision !== input.expectedRevision) throw new ReportEditError(409, `Report changed: expected revision ${input.expectedRevision}, current revision ${revision}. Reload before saving.`);
    const now = new Date().toISOString();
    const next = { ...cycle, ...input.changes, reportRevision: revision + 1, reportEditedAt: now, reportEditedBy: actor, updatedAt: now };
    const report = buildCycleReport(next, task, employee, manager, history);
    const changeId = `${cycleId}__REPORT_EDITED__${input.requestId}`;
    const changes = Object.entries(input.changes).map(([field, after]) => ({ field, before: cycle[field] ?? (field === 'customTags' ? [] : field === 'reviewStatus' ? 'UNREVIEWED' : ''), after }));
    tx.set('taskCycles', cycleId, next);
    tx.set('reports', cycleId, report);
    tx.create('auditLogs', changeId, { id: changeId, cycleId, taskId: cycle.taskId, employeeUid: cycle.employeeUid, managerUid: cycle.managerUid, type: 'REPORT_EDITED', actor, at: now, detail: `Edited ${changes.map(c => c.field).join(', ')}`, changes, revision: revision + 1 });
    const result = { ok: true, cycleId, revision: revision + 1, updatedAt: now, actor, report, replayed: false };
    tx.create('reportMutations', input.requestId, { id: input.requestId, hash, actor, createdAt: now, result });
    return result;
  });
}
