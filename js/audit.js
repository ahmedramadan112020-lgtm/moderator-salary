/**
 * audit.js
 * -----------------------------------------------------------------------
 * AuditService — the single, mandatory record of everything that happens.
 *
 * WHAT GETS LOGGED
 * ----------------
 * Every create, update and delete in the app, plus the lifecycle events that
 * aren't document writes at all (closing a month, restoring a backup,
 * undoing an operation, reactivating an employee). Each entry carries:
 *
 *   who      - userId + userEmail
 *   when     - `at` (server time, never the device clock)
 *   what     - action + entity + documentId + a human label
 *   where    - monthId, when the action belongs to a payroll month
 *   before   - the document's state prior to the change
 *   after    - its state afterwards
 *   changed  - just the field names that actually differ
 *   severity - info | warning | critical
 *
 * WHY LOGGING CANNOT BE SKIPPED
 * -----------------------------
 * `appendToBatch()` is the important function in this file. It adds the audit
 * entry to the SAME `WriteBatch` as the business write, so Firestore commits
 * both or neither. That is what makes the trail complete by construction
 * rather than by discipline: there is no code path through DataLayer that can
 * change a document and leave the log untouched, because it is physically the
 * same commit.
 *
 * `log()` still exists for events that have no document write to attach to
 * (a month closing, a backup being created, an export). Those are logged
 * AFTER the fact they describe, deliberately: an audit entry that claims
 * something happened before it actually committed is worse than a missing
 * one.
 *
 * SEVERITY, AND WHY IT IS ASSIGNED PER ACTION
 * -------------------------------------------
 * Severity is a property of the ACTION, not of the caller's mood, so it lives
 * in the action registry below rather than being passed in at every call
 * site. That way "deleting an employee is critical" is stated once and can
 * never be logged as `info` by a careless call. A caller may still ESCALATE
 * an individual entry (a bulk delete of 200 rows is worse than one), but it
 * cannot quietly de-escalate.
 *
 *   info     - routine, expected work: adding an advance, editing a name.
 *   warning  - reversible but consequential: deleting a record, archiving a
 *              department, undoing something, changing global settings.
 *   critical - irreversible or system-wide: closing a month, approving a
 *              final settlement, restoring a backup, deleting an employee.
 *
 * EXTENSIBILITY  (the requirement: new collections without a rewrite)
 * ------------------------------------------------------------------
 * Actions are DERIVED, not enumerated. `actionFor('employees', 'delete')`
 * returns `'employees.delete'`, and severity comes from the entity's
 * registration. So supporting a brand-new collection is one
 * `registerEntity()` call — no new constants, no switch statement to extend,
 * no change to this file at all. Unregistered entities still log correctly
 * with sensible defaults rather than throwing.
 *
 * BACKWARD COMPATIBILITY
 * ----------------------
 * The existing log already has entries shaped `{action, details, userId,
 * userEmail, at}` written by months.js and settlements.js, and the month
 * details modal queries `where('details.monthId', '==', ...)`. So every new
 * entry ALSO writes `details.monthId`, and `Months.writeAuditLog()` keeps
 * working (it now delegates here). Old entries render fine because the
 * reader treats missing severity as 'info'.
 * -----------------------------------------------------------------------
 */

'use strict';

const AuditService = (() => {

  /* ============================================================
   * SEVERITY
   * ============================================================ */

  const SEVERITY = {
    INFO: 'info',
    WARNING: 'warning',
    CRITICAL: 'critical'
  };

  /** Ranking, so escalation can be compared numerically. */
  const SEVERITY_RANK = {
    [SEVERITY.INFO]: 1,
    [SEVERITY.WARNING]: 2,
    [SEVERITY.CRITICAL]: 3
  };

  const SEVERITY_LABELS = {
    [SEVERITY.INFO]: 'عادية',
    [SEVERITY.WARNING]: 'تحذير',
    [SEVERITY.CRITICAL]: 'حرجة'
  };

  /** Anything unrecognized reads as info — never as critical noise. */
  function normalizeSeverity(value) {
    return SEVERITY_RANK[value] ? value : SEVERITY.INFO;
  }

  /** The higher of two severities. Used for escalation, never de-escalation. */
  function maxSeverity(a, b) {
    const ra = SEVERITY_RANK[normalizeSeverity(a)];
    const rb = SEVERITY_RANK[normalizeSeverity(b)];
    return ra >= rb ? normalizeSeverity(a) : normalizeSeverity(b);
  }

  /* ============================================================
   * OPERATIONS
   * ============================================================ */

  const OPERATION = {
    CREATE: 'create',
    UPDATE: 'update',
    DELETE: 'delete',
    RESTORE: 'restore',
    UNDO: 'undo'
  };

  /** Default severity per operation, when an entity doesn't override it. */
  const DEFAULT_OPERATION_SEVERITY = {
    [OPERATION.CREATE]: SEVERITY.INFO,
    [OPERATION.UPDATE]: SEVERITY.INFO,
    [OPERATION.DELETE]: SEVERITY.WARNING,
    [OPERATION.RESTORE]: SEVERITY.CRITICAL,
    [OPERATION.UNDO]: SEVERITY.WARNING
  };

  const OPERATION_LABELS = {
    [OPERATION.CREATE]: 'إضافة',
    [OPERATION.UPDATE]: 'تعديل',
    [OPERATION.DELETE]: 'حذف',
    [OPERATION.RESTORE]: 'استرجاع',
    [OPERATION.UNDO]: 'تراجع'
  };

  /* ============================================================
   * ENTITY REGISTRY  (this is the extension point)
   * ============================================================ */

  /**
   * What the audit log knows about each kind of record.
   *
   *   label      - Arabic singular, for the rendered action text
   *   severity   - per-operation overrides; anything absent falls back to
   *                DEFAULT_OPERATION_SEVERITY
   *
   * Adding a new collection to the audit system is exactly one
   * `registerEntity()` call from anywhere — nothing in this file changes.
   */
  const entities = new Map();

  function registerEntity(key, config = {}) {
    if (!key) return;
    entities.set(key, {
      key,
      label: config.label || key,
      severity: config.severity || {}
    });
  }

  function entityConfig(key) {
    return entities.get(key) || { key, label: key || 'سجل', severity: {} };
  }

  // ---- The entities that exist today ----
  //
  // Employees are `critical` on delete because the document id is referenced
  // by every historical report row, every advance and every settlement. The
  // rows survive the delete (they store their own name snapshot), but the
  // link back to the person is gone, so it is not a routine action.
  registerEntity('employees', {
    label: 'موظف',
    severity: { [OPERATION.DELETE]: SEVERITY.CRITICAL }
  });

  // A department is only ever archived, never hard-deleted (the rules forbid
  // it), so archiving is the consequential operation here.
  registerEntity('departments', { label: 'قسم' });

  registerEntity('advances', { label: 'سلفة' });
  registerEntity('adjustments', { label: 'تسوية' });

  // Settings are global and seed every future month, so changing them is
  // never merely routine.
  registerEntity('settings', {
    label: 'إعدادات',
    severity: { [OPERATION.UPDATE]: SEVERITY.WARNING }
  });

  registerEntity('months', { label: 'شهر' });
  registerEntity('settlements', {
    label: 'مخالصة',
    severity: { [OPERATION.CREATE]: SEVERITY.CRITICAL }
  });
  registerEntity('backups', { label: 'نسخة احتياطية' });
  registerEntity('salary_processing', { label: 'معالجة الرواتب' });
  registerEntity('roles', { label: 'دور وصلاحيات' });
  registerEntity('users', { label: 'مستخدم' });
  registerEntity('data_sources', { label: 'مصدر بيانات' });

  /* ============================================================
   * ACTION NAMES  (derived, never enumerated)
   * ============================================================ */

  /**
   * The stored action string for an entity+operation pair, e.g.
   * `employees.delete`. Dotted and lowercase so it stays queryable and
   * greppable, and so a new entity needs no new constant.
   */
  function actionFor(entityKey, operation) {
    return `${entityKey || 'unknown'}.${operation || 'unknown'}`;
  }

  /**
   * Severity for an entity+operation, honouring the entity's overrides then
   * the per-operation default.
   */
  function severityFor(entityKey, operation) {
    const cfg = entityConfig(entityKey);
    return normalizeSeverity(
      cfg.severity[operation] || DEFAULT_OPERATION_SEVERITY[operation] || SEVERITY.INFO
    );
  }

  /**
   * Lifecycle actions that aren't a plain document write. Kept as explicit
   * constants because they are referenced by name from several modules, and
   * because months.js already wrote three of them before this service
   * existed — those exact strings must keep being produced so historical
   * entries and new ones read identically.
   */
  const ACTION = {
    // month lifecycle (pre-existing strings — do not rename)
    MONTH_CLOSED: 'month_closed',
    ACTIVE_MONTH_CHANGED: 'active_month_changed',
    MONTH_CREATED: 'month_created',
    MONTH_LOCKED: 'month_locked',
    MONTH_UNLOCKED: 'month_unlocked',
    MONTH_REOPENED: 'month_reopened',
    MONTH_ARCHIVED: 'month_archived',
    MONTH_RESTORED: 'month_restored',
    MONTH_DELETED: 'month_deleted',
    MONTH_RESET: 'month_reset',
    // settlement lifecycle (pre-existing strings — do not rename)
    SETTLEMENT_APPROVED: 'settlement_approved',
    EMPLOYEE_DEACTIVATED: 'employee_deactivated',
    EMPLOYEE_REACTIVATED: 'employee_reactivated',
    DEPARTMENT_ARCHIVED: 'department_archived',
    DEPARTMENT_RESTORED: 'department_restored',
    // new: backup / restore / undo
    BACKUP_CREATED: 'backup_created',
    BACKUP_RESTORED: 'backup_restored',
    BACKUP_DOWNLOADED: 'backup_downloaded',
    MONTH_DATA_CLEARED: 'month_data_cleared',
    ORDERS_IMPORTED: 'orders_imported',
    ORDERS_UPDATED: 'orders_updated',
    ORDERS_DELETED: 'orders_deleted',
    ORDERS_BATCH_UNDONE: 'orders_batch_undone',
    REPORT_CALCULATED: 'report_calculated',
    UNDO_APPLIED: 'undo_applied'
  };

  /**
   * Severity for the lifecycle actions above.
   *
   * Anything that freezes payroll, moves money permanently, or rewrites live
   * data wholesale is critical. Anything that merely changes what the app is
   * pointing at, or can be re-run harmlessly, is not.
   */
  const LIFECYCLE_SEVERITY = {
    [ACTION.MONTH_CLOSED]: SEVERITY.CRITICAL,
    [ACTION.MONTH_LOCKED]: SEVERITY.CRITICAL,
    [ACTION.MONTH_UNLOCKED]: SEVERITY.WARNING,
    [ACTION.MONTH_REOPENED]: SEVERITY.WARNING,
    [ACTION.MONTH_ARCHIVED]: SEVERITY.WARNING,
    [ACTION.MONTH_RESTORED]: SEVERITY.WARNING,
    [ACTION.MONTH_DELETED]: SEVERITY.CRITICAL,
    [ACTION.MONTH_RESET]: SEVERITY.CRITICAL,
    [ACTION.SETTLEMENT_APPROVED]: SEVERITY.CRITICAL,
    [ACTION.BACKUP_RESTORED]: SEVERITY.CRITICAL,
    [ACTION.MONTH_DATA_CLEARED]: SEVERITY.CRITICAL,
    [ACTION.EMPLOYEE_DEACTIVATED]: SEVERITY.WARNING,
    [ACTION.EMPLOYEE_REACTIVATED]: SEVERITY.WARNING,
    [ACTION.DEPARTMENT_ARCHIVED]: SEVERITY.WARNING,
    [ACTION.ACTIVE_MONTH_CHANGED]: SEVERITY.WARNING,
    [ACTION.UNDO_APPLIED]: SEVERITY.WARNING,
    [ACTION.BACKUP_CREATED]: SEVERITY.INFO,
    [ACTION.BACKUP_DOWNLOADED]: SEVERITY.INFO,
    [ACTION.MONTH_CREATED]: SEVERITY.INFO,
    [ACTION.ORDERS_IMPORTED]: SEVERITY.INFO,
    [ACTION.ORDERS_UPDATED]: SEVERITY.WARNING,
    [ACTION.ORDERS_DELETED]: SEVERITY.WARNING,
    [ACTION.ORDERS_BATCH_UNDONE]: SEVERITY.WARNING,
    [ACTION.REPORT_CALCULATED]: SEVERITY.INFO
  };

  /** Arabic labels for every action, entity-derived ones included. */
  const ACTION_LABELS = {
    [ACTION.MONTH_CLOSED]: 'إنهاء شهر',
    [ACTION.ACTIVE_MONTH_CHANGED]: 'تغيير الشهر النشط',
    [ACTION.MONTH_CREATED]: 'إنشاء شهر',
    [ACTION.MONTH_LOCKED]: 'قفل شهر',
    [ACTION.MONTH_UNLOCKED]: 'فتح قفل شهر',
    [ACTION.MONTH_REOPENED]: 'إعادة فتح شهر',
    [ACTION.MONTH_ARCHIVED]: 'أرشفة شهر',
    [ACTION.MONTH_RESTORED]: 'استعادة شهر مؤرشف',
    [ACTION.MONTH_DELETED]: 'حذف شهر فارغ',
    [ACTION.MONTH_RESET]: 'إفراغ محتوى شهر',
    [ACTION.SETTLEMENT_APPROVED]: 'اعتماد مخالصة',
    [ACTION.EMPLOYEE_DEACTIVATED]: 'إيقاف موظف',
    [ACTION.EMPLOYEE_REACTIVATED]: 'إعادة تفعيل موظف',
    [ACTION.DEPARTMENT_ARCHIVED]: 'أرشفة قسم',
    [ACTION.DEPARTMENT_RESTORED]: 'استعادة قسم',
    [ACTION.BACKUP_CREATED]: 'إنشاء نسخة احتياطية',
    [ACTION.BACKUP_RESTORED]: 'استرجاع نسخة احتياطية',
    [ACTION.BACKUP_DOWNLOADED]: 'تحميل نسخة احتياطية',
    [ACTION.MONTH_DATA_CLEARED]: 'مسح بيانات شهر',
    [ACTION.ORDERS_IMPORTED]: 'استيراد طلبات',
    [ACTION.ORDERS_UPDATED]: 'تعديل طلب',
    [ACTION.ORDERS_DELETED]: 'حذف طلب',
    [ACTION.ORDERS_BATCH_UNDONE]: 'التراجع عن استيراد دفعة',
    [ACTION.REPORT_CALCULATED]: 'حساب التقرير',
    [ACTION.UNDO_APPLIED]: 'تراجع عن عملية'
  };

  /**
   * Human label for any action string, whether it's a lifecycle constant or
   * a derived `entity.operation` pair. Unknown actions return themselves
   * rather than a placeholder, so a future action added elsewhere still
   * renders something meaningful before anyone gets round to labelling it.
   */
  function labelFor(action) {
    if (ACTION_LABELS[action]) return ACTION_LABELS[action];

    const parts = String(action || '').split('.');
    if (parts.length === 2) {
      const [entityKey, operation] = parts;
      const opLabel = OPERATION_LABELS[operation] || operation;
      return `${opLabel} ${entityConfig(entityKey).label}`;
    }
    return action || '—';
  }

  /** Severity for any action string. */
  function severityOf(action) {
    if (LIFECYCLE_SEVERITY[action]) return LIFECYCLE_SEVERITY[action];
    const parts = String(action || '').split('.');
    if (parts.length === 2) return severityFor(parts[0], parts[1]);
    return SEVERITY.INFO;
  }

  /* ============================================================
   * BUILDING AN ENTRY
   * ============================================================ */

  /**
   * Assembles the document written to `audit_logs`.
   *
   * `details.monthId` is duplicated at the top level as `monthId`. That is
   * not redundancy for its own sake: the pre-existing month-details query
   * filters on `details.monthId` (and has a deployed composite index for
   * it), while every new query wants the flat field. Writing both keeps old
   * readers working and new ones simple.
   */
  function buildEntry({
    action,
    entity = null,
    operation = null,
    documentId = null,
    documentLabel = null,
    monthId = null,
    before = undefined,
    after = undefined,
    changed = null,
    severity = null,
    details = {}
  } = {}) {
    const resolvedSeverity = severity
      ? maxSeverity(severityOf(action), severity)   // escalate only
      : severityOf(action);

    const entry = {
      action,
      entity,
      operation,
      documentId,
      documentLabel,
      monthId: monthId || null,
      severity: resolvedSeverity,
      ...ServiceCommon.actor(),
      at: ServiceCommon.serverTimestamp(),
      // `details` keeps carrying monthId for the existing month-scoped query.
      details: {
        ...ServiceCommon.plainClone(details),
        ...(monthId ? { monthId } : {})
      }
    };

    // before/after are optional and size-bounded. Absent (rather than null)
    // when the action isn't a document change, so a reader can tell "no
    // change to record" apart from "changed to nothing".
    if (before !== undefined) entry.before = ServiceCommon.boundedSnapshot(before);
    if (after !== undefined) entry.after = ServiceCommon.boundedSnapshot(after);
    if (Array.isArray(changed) && changed.length > 0) entry.changed = changed;

    return entry;
  }

  /* ============================================================
   * WRITING
   * ============================================================ */

  /**
   * Adds an audit entry to an EXISTING batch, so it commits atomically with
   * the business write beside it.
   *
   * This is the function that makes logging non-optional. Returns the entry
   * that was queued (useful for tests and for the undo descriptor), and adds
   * exactly ONE operation to the batch — callers counting toward the 500
   * limit should account for it.
   *
   * @param {firebase.firestore.WriteBatch} batch
   * @param {object} params  see buildEntry
   */
  function appendToBatch(batch, params) {
    const entry = buildEntry(params);
    const ref = db.collection(COLLECTIONS.AUDIT_LOGS).doc();
    batch.set(ref, entry);
    return { id: ref.id, entry };
  }

  /**
   * Writes a standalone audit entry, for events with no document write to
   * ride along with (a month closing, a backup, an export).
   *
   * Best-effort by design, and that is a deliberate asymmetry with
   * `appendToBatch`: the action being described has ALREADY happened by the
   * time this is called, so throwing here would report a failure for work
   * that actually succeeded, and rolling it back is impossible. The failure
   * is surfaced to the console and the boolean result.
   */
  async function log(action, params = {}) {
    try {
      const entry = buildEntry({ action, ...params });
      await db.collection(COLLECTIONS.AUDIT_LOGS).add(entry);
      return true;
    } catch (err) {
      console.error('Audit log write failed:', err);
      return false;
    }
  }

  /**
   * Convenience wrapper for a document change logged on its own — used by
   * flows that write outside DataLayer (a transaction, a bulk import) but
   * still owe the log a before/after.
   */
  async function logChange(entityKey, operation, params = {}) {
    return log(actionFor(entityKey, operation), {
      entity: entityKey,
      operation,
      ...params
    });
  }

  /* ============================================================
   * READING
   * ============================================================ */

  /** Normalizes a stored entry, defaulting severity for pre-existing rows. */
  function normalizeEntry(id, data) {
    const d = data || {};
    const details = (d.details && typeof d.details === 'object') ? d.details : {};
    return {
      id,
      action: d.action || '',
      entity: d.entity || null,
      operation: d.operation || null,
      documentId: d.documentId || null,
      documentLabel: d.documentLabel || null,
      // Older entries only ever carried the month inside `details`.
      monthId: d.monthId || details.monthId || null,
      // Entries written before severity existed are informational by
      // definition: at that time only month/settlement lifecycle events were
      // logged, so deriving from the action is more accurate than defaulting.
      severity: d.severity ? normalizeSeverity(d.severity) : severityOf(d.action),
      userId: d.userId || null,
      userEmail: d.userEmail || null,
      at: d.at || null,
      before: d.before,
      after: d.after,
      changed: Array.isArray(d.changed) ? d.changed : [],
      details
    };
  }

  /**
   * The most recent entries, newest first.
   *
   * Ordering by `at` alone needs no composite index, which is why the
   * unfiltered feed is the default view: it always works, even on a fresh
   * deployment where no indexes have been deployed yet.
   */
  async function getRecent(limit = 100) {
    try {
      const snap = await db.collection(COLLECTIONS.AUDIT_LOGS)
        .orderBy('at', 'desc').limit(limit).get();
      return snap.docs.map(d => normalizeEntry(d.id, d.data()));
    } catch (err) {
      console.error('Could not read audit logs:', err);
      return [];
    }
  }

  /**
   * Entries of one severity, newest first.
   *
   * Needs a composite index on (severity, at desc) — declared in
   * firebase/firestore.indexes.json. Falls back to filtering a recent page
   * in memory if the index isn't deployed yet, so the severity filter still
   * does something useful on a deployment that hasn't run
   * `firebase deploy --only firestore:indexes`.
   */
  async function getBySeverity(severity, limit = 100) {
    const level = normalizeSeverity(severity);
    try {
      const snap = await db.collection(COLLECTIONS.AUDIT_LOGS)
        .where('severity', '==', level)
        .orderBy('at', 'desc').limit(limit).get();
      return snap.docs.map(d => normalizeEntry(d.id, d.data()));
    } catch (err) {
      console.warn('Severity query failed, filtering in memory:', err.message);
      const recent = await getRecent(Math.max(limit * 3, 200));
      return recent.filter(e => e.severity === level).slice(0, limit);
    }
  }

  /**
   * Entries mentioning one month, newest first.
   *
   * Queries the legacy `details.monthId` path because that is the field
   * every historical entry has and the one with a deployed index. New
   * entries write both, so they are matched by this too.
   */
  async function getForMonth(monthId, limit = 50) {
    if (!monthId) return [];
    try {
      const snap = await db.collection(COLLECTIONS.AUDIT_LOGS)
        .where('details.monthId', '==', monthId)
        .orderBy('at', 'desc').limit(limit).get();
      return snap.docs.map(d => normalizeEntry(d.id, d.data()));
    } catch (err) {
      // The month details view treats its audit block as optional, so a
      // missing index degrades to "no history shown", never to an error.
      console.warn('Could not read audit logs for month:', err.message);
      return [];
    }
  }

  /** Every entry touching one document — the history of a single employee. */
  async function getForDocument(documentId, limit = 50) {
    if (!documentId) return [];
    try {
      const snap = await db.collection(COLLECTIONS.AUDIT_LOGS)
        .where('documentId', '==', documentId)
        .orderBy('at', 'desc').limit(limit).get();
      return snap.docs.map(d => normalizeEntry(d.id, d.data()));
    } catch (err) {
      console.warn('Could not read audit logs for document:', err.message);
      return [];
    }
  }

  return {
    SEVERITY,
    SEVERITY_LABELS,
    OPERATION,
    OPERATION_LABELS,
    ACTION,
    // registry / extensibility
    registerEntity,
    entityConfig,
    actionFor,
    severityFor,
    // helpers
    normalizeSeverity,
    maxSeverity,
    labelFor,
    severityOf,
    buildEntry,
    normalizeEntry,
    // writing
    appendToBatch,
    log,
    logChange,
    // reading
    getRecent,
    getBySeverity,
    getForMonth,
    getForDocument
  };
})();
