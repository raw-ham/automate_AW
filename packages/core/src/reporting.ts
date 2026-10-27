import type { RecordData } from './store';

export function mailDeliveryEnabled(): boolean {
  return process.env.EMAIL_DELIVERY_ENABLED === 'true' && process.env.EMAIL_DRY_RUN !== 'true';
}

export function buildCycleReport(cycle: RecordData, task: RecordData, employee: RecordData | null, manager: RecordData | null, events: RecordData[]) {
  const mailHistory = events.map(event => {
    const recipients = Array.isArray(event.to) ? event.to : String(event.recipient || '').split(',').map((v: string) => v.trim()).filter(Boolean);
    const targetRole = event.kind === 'LEADERSHIP_ESCALATION' ? 'leadership' : 'manager';
    const targetName = targetRole === 'manager' && manager?.name ? manager.name : recipients.join(', ') || targetRole;
    const status = event.deliveryStatus || event.status || 'QUEUED';
    const sent = status === 'SENT';
    const label = sent ? `Mailed ${targetName}` : status === 'FAILED' ? `Mail failed for ${targetName}` : status === 'LOCAL_PREVIEW' ? `Mail preview for ${targetName} — not sent` : !mailDeliveryEnabled() || status === 'SUPPRESSED' ? `Pending mail to ${targetName} — mailing disabled` : `Mail queued for ${targetName}`;
    return { eventId: event.id, kind: event.kind, targetRole, targetName, recipients, status, sent, sentAt: sent ? event.sentAt || null : null, preparedAt: event.triggeredAt || event.createdAt || null, label };
  }).sort((a, b) => String(a.preparedAt).localeCompare(String(b.preparedAt)) || String(a.eventId).localeCompare(String(b.eventId)));
  const markings = [cycle.status, cycle.status === 'COMPLETED' ? 'COMPLETION_RECORDED' : 'EMPLOYEE_ACTION_PENDING', cycle.escalationCount > 0 ? cycle.managerAcknowledgedAt ? 'MANAGER_ACKNOWLEDGED' : 'MANAGER_ACKNOWLEDGEMENT_PENDING' : 'NO_MANAGER_REVIEW_REQUIRED', ...(cycle.escalationLevel === 'LEADERSHIP' ? ['LEADERSHIP_ESCALATION'] : []), ...(cycle.completedAt ? ['SELF_REPORTED_EVIDENCE'] : []), !mailDeliveryEnabled() ? 'MAILING_DISABLED' : 'MAILING_ENABLED'];
  return {
    ...cycle,
    title: task.title,
    description: task.description,
    intervalDays: task.intervalDays,
    employeeName: employee?.name || '',
    managerName: manager?.name || '',
    evidenceLabel: 'SELF_REPORTED',
    reportRevision: cycle.reportRevision || 0,
    reportNote: cycle.reportNote || '',
    reviewStatus: cycle.reviewStatus || 'UNREVIEWED',
    customTags: cycle.customTags || [],
    reportEditedAt: cycle.reportEditedAt || null,
    reportEditedBy: cycle.reportEditedBy || null,
    markings,
    mailHistory,
    mailTags: [...new Set(mailHistory.map(m => m.label))],
    mailDeliveryEnabled: mailDeliveryEnabled(),
  };
}
