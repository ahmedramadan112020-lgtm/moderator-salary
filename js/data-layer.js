/**
 * data-layer.js
 * -----------------------------------------------------------------------
 * DataLayer — the single door every write goes through.
 *
 * THE PROBLEM IT SOLVES
 * ---------------------
 * Before this file, writes were scattered: app.js called
 * `db.collection(...).add()` for advances, `.update()` for employees,
 * `.delete()` for adjustments; departments.js had its own four writers.
 * Auditing that shape means remembering to log at ~15 call sites, and a
 * trail that depends on remembering is a trail with holes in it — usually
 * around the newest feature, written in a hurry.
 *
 * So writes funnel through `create` / `update` / `remove` here, and each one
 * builds ONE `WriteBatch` containing:
 *
 *      the business write   +   its audit entry
 *
 * Firestore commits a batch atomically. Both land or neither does. An action
 * that changed data without being logged is therefore not something this
 * codebase can express — it isn't forbidden by policy, it's unreachable.
 *
 * WHAT ELSE IT CENTRALIZES
 * ------------------------
 *   * MONTH LOCK. Records tied to a payroll month (advances, adjustments)
 *     are checked against `Months.assertEditable` before the batch is built,
 *     using the month of the RECORD's own date — not whichever month is on
 *     screen. One implementation, so the advance path and the adjustment
 *     path cannot drift apart.
 *   * AUTO-BACKUP. Collections marked `backupBeforeDelete` get an automatic
 *     backup before a destructive write, satisfying "before deleting any
 *     employee / any important data" without every caller remembering.
 *   * UNDO DESCRIPTORS. Every operation returns exactly what UndoService
 *     needs to reverse it, so undo support is a property of going through
 *     here rather than a feature bolted onto individual handlers.
 *
 * EXTENSIBILITY  (the stated requirement)
 * ---------------------------------------
 * Nothing here knows what an employee is. Collections are registered:
 *
 *     DataLayer.registerCollection('bonuses', {
 *       collection: 'bonuses', entity: 'bonuses',
 *       label: 'حافز', monthField: 'monthId', labelField: 'employeeName'
 *     });
 *
 * ...and immediately get audit logging with correct severity, month-lock
 * enforcement, undo and auto-backup. Adding a collection touches no existing
 * function, which is what "extensible without a big rewrite" has to mean.
 *
 * WHAT IT DOESN'T HANDLE, ON PURPOSE
 * ----------------------------------
 * Multi-document business transactions with their own invariants — closing a
 * month, approving a settlement — keep their bespoke batches in months.js
 * and settlements.js. They already write atomically and already audit; what
 * they gain from this file is `AuditService`, not a generic CRUD wrapper that
 * would obscure the ordering their correctness depends on.
 * -----------------------------------------------------------------------
 */

'use strict';

const DataLayer = (() => {

  /* ============================================================
   * COLLECTION REGISTRY
   * ============================================================ */

  /**
   * Per-collection configuration.
   *
   *   collection         - the physical Firestore collection name
   *   entity             - the AuditService entity key (severity comes from it)
   *   label              - Arabic singular, for messages
   *   labelField         - which field names the record in the log/undo toast
   *   monthField         - field tying the record to a payroll month, if any
   *   backupBeforeDelete - take an automatic backup before deleting
   *   undoable           - may be undone within the 30s window
   */
  const registry = new Map();

  function registerCollection(key, config = {}) {
    if (!key) throw new Error('registerCollection: key مطلوب');
    if (!config.collection) throw new Error(`registerCollection(${key}): collection مطلوب`);

    registry.set(key, {
      key,
      collection: config.collection,
      entity: config.entity || key,
      label: config.label || key,
      labelField: config.labelField || 'name',
      monthField: config.monthField || null,
      backupBeforeDelete: config.backupBeforeDelete === true,
      undoable: config.undoable !== false,
      permissions: config.permissions || {},
      // Action verb used in the month-lock error message, e.g.
      // "شهر أغسطس مقفول، وحذف السلف مش مسموح فيه".
      lockLabels: config.lockLabels || {}
    });

    // Keep the audit registry in step, so a newly registered collection gets
    // correct severities and Arabic labels without a second call.
    AuditService.registerEntity(config.entity || key, {
      label: config.label || key,
      severity: config.severity || {}
    });

    return registry.get(key);
  }

  function specOf(key) {
    const spec = registry.get(key);
    if (!spec) throw new Error(`DataLayer: مجموعة غير مسجلة "${key}"`);
    return spec;
  }

  function isRegistered(key) { return registry.has(key); }

  /* ============================================================
   * THE COLLECTIONS THAT EXIST TODAY
   * ============================================================ */

  registerCollection('employees', {
    collection: COLLECTIONS.EMPLOYEES,
    entity: 'employees',
    label: 'موظف',
    labelField: 'name',
    // Employee records are LIVE MASTER DATA, not month data — deliberately
    // not month-gated, matching the Firestore rules for `moderators`.
    // Renaming someone or fixing their salary must stay possible while old
    // months are closed, and it can't corrupt them: every closed month
    // stores its own frozen copy of the rows and names it used.
    monthField: null,
    // A deleted employee is referenced by every historical report row, every
    // advance and every settlement, so this is the clearest case for a
    // pre-delete backup.
    backupBeforeDelete: true,
    permissions: { create: 'employees.write', update: 'employees.write', delete: 'employees.delete' },
    severity: { [AuditService.OPERATION.DELETE]: AuditService.SEVERITY.CRITICAL }
  });

  registerCollection('departments', {
    collection: COLLECTIONS.DEPARTMENTS,
    entity: 'departments',
    label: 'قسم',
    labelField: 'name',
    monthField: null,
    // Departments are archived rather than deleted (the rules forbid a hard
    // delete outright), and archiving is an update. The backup is taken by
    // the archive flow itself via its trigger constant.
    backupBeforeDelete: true,
    permissions: { create: 'departments.write', update: 'departments.write', delete: 'departments.write' }
  });

  registerCollection('advances', {
    collection: COLLECTIONS.ADVANCES,
    entity: 'advances',
    label: 'سلفة',
    labelField: 'moderatorName',
    monthField: 'monthId',
    permissions: { create: 'transactions.write', update: 'transactions.write', delete: 'transactions.write' },
    lockLabels: { create: 'تسجيل السلف', update: 'تعديل السلف', delete: 'حذف السلف' }
  });

  registerCollection('adjustments', {
    collection: COLLECTIONS.ADJUSTMENTS,
    entity: 'adjustments',
    label: 'تسوية',
    labelField: 'moderatorName',
    monthField: 'monthId',
    permissions: { create: 'transactions.write', update: 'transactions.write', delete: 'transactions.write' },
    lockLabels: { create: 'إضافة التسويات', update: 'تعديل التسويات', delete: 'حذف التسويات' }
  });

  registerCollection('settings', {
    collection: COLLECTIONS.SETTINGS,
    entity: 'settings',
    label: 'إعدادات',
    labelField: 'companyName',
    monthField: null,
    permissions: { create: 'settings.write', update: 'settings.write', delete: 'settings.write' },
    severity: { [AuditService.OPERATION.UPDATE]: AuditService.SEVERITY.WARNING }
  });

  /* ============================================================
   * HELPERS
   * ============================================================ */

  function refFor(spec, id) {
    return id
      ? db.collection(spec.collection).doc(id)
      : db.collection(spec.collection).doc();   // pre-generated id
  }

  function requireOperation(spec, operation) {
    const permission = spec.permissions && spec.permissions[operation];
    if (permission && typeof Permissions !== 'undefined') Permissions.require(permission);
  }

  /**
   * Strips `undefined` values out of a payload before it reaches Firestore.
   *
   * Firestore REJECTS `undefined` outright with "Unsupported field value:
   * undefined" - it is not treated as "absent" the way JSON would. That is
   * easy to hit by accident: an optional form field read into an object
   * literal, a destructured property that wasn't there, `obj.maybe` on a
   * partial record. One such field fails the whole batch, taking the audit
   * entry down with it.
   *
   * A field the caller genuinely wants removed is expressed with
   * `FieldValue.delete()` (see applyUndo), not with `undefined`, so dropping
   * these is always the correct reading of the intent.
   *
   * Nested objects are cleaned too, because a map field is written whole.
   * FieldValue sentinels and Timestamps are passed through untouched - they
   * are live SDK objects and must not be structurally copied.
   */
  function stripUndefined(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;

    // Live SDK objects (sentinels, Timestamps, GeoPoints, DocumentReferences)
    // must reach Firestore intact.
    if (ServiceCommon.isFieldValueSentinel(value) ||
        ServiceCommon.isTimestamp(value) ||
        value instanceof Date) {
      return value;
    }

    if (Array.isArray(value)) {
      // Firestore has no "hole" in an array, so an undefined element becomes
      // null rather than being dropped - removing it would silently shift
      // every later index.
      return value.map(v => (v === undefined ? null : stripUndefined(v)));
    }

    const out = {};
    Object.keys(value).forEach(key => {
      const v = value[key];
      if (v === undefined) return;
      out[key] = stripUndefined(v);
    });
    return out;
  }

  /** A human label for one record, for audit entries and undo toasts. */
  function labelOf(spec, data, fallbackId) {
    if (data && spec.labelField && data[spec.labelField]) {
      return String(data[spec.labelField]);
    }
    return fallbackId || null;
  }

  /**
   * Enforces the month lock for a record that carries a month.
   *
   * Checks the month of the RECORD, not the month on screen: an advance
   * dated in July belongs to July even while August is displayed, so
   * back-dating one into a closed month must fail. Throws the Arabic message
   * from Months.assertEditable, which callers surface directly.
   */
  function assertMonthEditable(spec, data, operation) {
    if (!spec.monthField) return;

    const monthId = data ? data[spec.monthField] : null;
    if (!monthId) {
      throw new Error(`مفيش شهر محدد لـ${spec.label} — تأكد من التاريخ`);
    }
    const actionLabel = spec.lockLabels[operation] ||
      `${AuditService.OPERATION_LABELS[operation] || operation} ${spec.label}`;
    Months.assertEditable(monthId, actionLabel);
  }

  /** Reads a document, or throws the standard "not found" error. */
  async function requireDoc(spec, id) {
    const snap = await refFor(spec, id).get();
    if (!snap.exists) {
      throw new Error(`${spec.label} مش موجود — يمكن يكون اتحذف من تاب تاني`);
    }
    return { id: snap.id, data: snap.data() || {} };
  }

  /* ============================================================
   * CREATE
   * ============================================================ */

  /**
   * Creates a document and its audit entry in one atomic batch.
   *
   * The id is generated CLIENT-SIDE before the batch, which is what allows
   * the audit entry to name the document it created — `add()` only reveals
   * the id after the write, far too late to include in the same commit.
   *
   * @param {string} key      registered collection key
   * @param {object} data     the document body
   * @param {object} options  { monthId, note, severity, undoable }
   * @returns {Promise<{id, undo}>}
   */
  async function create(key, data, options = {}) {
    const spec = specOf(key);
    requireOperation(spec, 'create');
    // Cleaned immediately, so both the document write and the audit snapshot
    // taken from it are free of `undefined`.
    const payload = stripUndefined({ ...data });

    assertMonthEditable(spec, payload, AuditService.OPERATION.CREATE);

    const ref = refFor(spec, options.id || null);

    // Bookkeeping every record gets, so "when did this appear" is always
    // answerable without consulting the audit log.
    payload.createdAt = payload.createdAt || ServiceCommon.serverTimestamp();

    const batch = db.batch();
    batch.set(ref, payload);

    AuditService.appendToBatch(batch, {
      action: AuditService.actionFor(spec.entity, AuditService.OPERATION.CREATE),
      entity: spec.entity,
      operation: AuditService.OPERATION.CREATE,
      documentId: ref.id,
      documentLabel: labelOf(spec, payload, ref.id),
      monthId: options.monthId || (spec.monthField ? payload[spec.monthField] : null),
      // No `before` — the document didn't exist. `after` is the new state.
      after: payload,
      severity: options.severity || null,
      details: { note: options.note || null }
    });

    await batch.commit();

    return {
      id: ref.id,
      undo: describeUndo(spec, AuditService.OPERATION.CREATE, {
        documentId: ref.id,
        label: labelOf(spec, payload, ref.id),
        // Undoing a create means deleting it; nothing else is needed.
        before: null,
        after: ServiceCommon.plainClone(payload),
        undoable: options.undoable !== false && spec.undoable
      })
    };
  }

  /* ============================================================
   * UPDATE
   * ============================================================ */

  /**
   * Updates specific fields, logging the before/after delta.
   *
   * Reads the CURRENT state first, for three reasons: the audit entry needs a
   * real `before`, undo needs the exact prior values, and the month lock has
   * to be checked against the STORED month (an advance being edited may be
   * moving between months, and both the old and the new month must be open —
   * otherwise money could be moved out of a closed month).
   *
   * @param {string} key
   * @param {string} id
   * @param {object} changes  fields to set (merge semantics)
   */
  async function update(key, id, changes, options = {}) {
    const spec = specOf(key);
    requireOperation(spec, 'update');
    if (!id) throw new Error(`معرّف ${spec.label} مفقود`);

    const existing = await requireDoc(spec, id);
    const cleanChanges = stripUndefined({ ...changes });

    // Both sides of a month move must be editable.
    if (spec.monthField) {
      assertMonthEditable(spec, existing.data, AuditService.OPERATION.UPDATE);
      if (cleanChanges[spec.monthField] &&
          cleanChanges[spec.monthField] !== existing.data[spec.monthField]) {
        assertMonthEditable(spec, cleanChanges, AuditService.OPERATION.UPDATE);
      }
    }

    const patch = { ...cleanChanges, updatedAt: ServiceCommon.serverTimestamp() };
    const after = { ...existing.data, ...cleanChanges };

    const delta = ServiceCommon.diff(existing.data, after);

    // Nothing actually changed: skip the write AND the log. An audit trail
    // padded with no-op edits is harder to read, and re-saving an unchanged
    // form is a normal thing for a user to do.
    if (delta.changed.length === 0) {
      return { id, changed: [], undo: null, noop: true };
    }

    const batch = db.batch();
    batch.update(refFor(spec, id), patch);

    AuditService.appendToBatch(batch, {
      action: options.auditAction || AuditService.actionFor(spec.entity, AuditService.OPERATION.UPDATE),
      entity: spec.entity,
      operation: AuditService.OPERATION.UPDATE,
      documentId: id,
      documentLabel: labelOf(spec, after, id),
      monthId: options.monthId || (spec.monthField ? after[spec.monthField] : null),
      // Only the delta is stored, not two whole documents: it keeps the log
      // readable and makes "what did this edit do" answerable at a glance.
      before: delta.before,
      after: delta.after,
      changed: delta.changed,
      severity: options.severity || null,
      details: { note: options.note || null }
    });

    await batch.commit();

    return {
      id,
      changed: delta.changed,
      undo: describeUndo(spec, AuditService.OPERATION.UPDATE, {
        documentId: id,
        label: labelOf(spec, after, id),
        // Undo restores exactly the fields this edit touched — never the
        // whole document, so a concurrent edit to an unrelated field isn't
        // clobbered by the undo.
        before: delta.before,
        after: delta.after,
        undoable: options.undoable !== false && spec.undoable
      })
    };
  }

  /* ============================================================
   * DELETE
   * ============================================================ */

  /**
   * Deletes a document, logging its full prior state.
   *
   * The audit entry keeps the whole `before`, not a delta — for a delete,
   * the prior state IS the information, and it's what makes the undo able to
   * recreate the record verbatim under its ORIGINAL id, so every reference
   * to it (report rows, advances, settlements) stays valid.
   *
   * Collections flagged `backupBeforeDelete` get an automatic backup first.
   */
  async function remove(key, id, options = {}) {
    const spec = specOf(key);
    requireOperation(spec, 'delete');
    if (!id) throw new Error(`معرّف ${spec.label} مفقود`);

    const existing = await requireDoc(spec, id);
    assertMonthEditable(spec, existing.data, AuditService.OPERATION.DELETE);

    // ---- Automatic backup before destructive work ----
    let backupId = null;
    if (spec.backupBeforeDelete && options.skipBackup !== true) {
      const backup = await BackupService.createAutomaticBackup(
        options.backupTrigger || BackupService.TRIGGER.BEFORE_EMPLOYEE_DELETE,
        {
          note: `قبل حذف ${spec.label}: ${labelOf(spec, existing.data, id)}`,
          monthId: options.monthId || null
        }
      );
      backupId = backup ? backup.id : null;
    }

    const batch = db.batch();
    batch.delete(refFor(spec, id));

    AuditService.appendToBatch(batch, {
      action: AuditService.actionFor(spec.entity, AuditService.OPERATION.DELETE),
      entity: spec.entity,
      operation: AuditService.OPERATION.DELETE,
      documentId: id,
      documentLabel: labelOf(spec, existing.data, id),
      monthId: options.monthId || (spec.monthField ? existing.data[spec.monthField] : null),
      before: existing.data,
      // Explicitly null, not absent: the document is gone, and saying so
      // distinguishes a delete from an edit whose `after` wasn't recorded.
      after: null,
      severity: options.severity || null,
      details: {
        note: options.note || null,
        backupId,
        backupTaken: !!backupId
      }
    });

    await batch.commit();

    return {
      id,
      backupId,
      undo: describeUndo(spec, AuditService.OPERATION.DELETE, {
        documentId: id,
        label: labelOf(spec, existing.data, id),
        // The complete prior document, so undo recreates it exactly.
        before: ServiceCommon.plainClone(existing.data),
        after: null,
        undoable: options.undoable !== false && spec.undoable
      })
    };
  }

  /* ============================================================
   * REPLACE  (set without merge)
   * ============================================================ */

  /**
   * Writes a document wholesale, creating it if absent.
   *
   * Used for the settings documents, which are singletons with fixed ids
   * (`general`) rather than records with generated ones. Kept separate from
   * `update` because the semantics differ: this REPLACES the document, so a
   * field the caller omits is removed rather than preserved.
   */
  async function replace(key, id, data, options = {}) {
    const spec = specOf(key);
    requireOperation(spec, 'update');
    if (!id) throw new Error(`معرّف ${spec.label} مفقود`);

    const snap = await refFor(spec, id).get();
    const existed = snap.exists;
    const before = existed ? (snap.data() || {}) : null;

    const cleanData = stripUndefined({ ...data });
    const payload = { ...cleanData, updatedAt: ServiceCommon.serverTimestamp() };
    if (!existed) payload.createdAt = ServiceCommon.serverTimestamp();

    const operation = existed ? AuditService.OPERATION.UPDATE : AuditService.OPERATION.CREATE;
    const delta = existed
      ? ServiceCommon.diff(before, { ...before, ...cleanData })
      : { changed: Object.keys(cleanData), before: {}, after: ServiceCommon.plainClone(cleanData) };

    if (existed && delta.changed.length === 0) {
      return { id, changed: [], undo: null, noop: true };
    }

    const batch = db.batch();
    // merge:true so unrelated fields on a shared settings document (e.g. the
    // bonus table vs. the company name) aren't wiped by a partial save.
    batch.set(refFor(spec, id), payload, { merge: options.merge !== false });

    AuditService.appendToBatch(batch, {
      action: AuditService.actionFor(spec.entity, operation),
      entity: spec.entity,
      operation,
      documentId: id,
      documentLabel: labelOf(spec, { ...before, ...cleanData }, id),
      monthId: options.monthId || null,
      before: existed ? delta.before : undefined,
      after: delta.after,
      changed: delta.changed,
      severity: options.severity || null,
      details: { note: options.note || null }
    });

    await batch.commit();

    return {
      id,
      changed: delta.changed,
      undo: describeUndo(spec, operation, {
        documentId: id,
        label: labelOf(spec, { ...before, ...cleanData }, id),
        before: existed ? delta.before : null,
        after: delta.after,
        undoable: options.undoable !== false && spec.undoable
      })
    };
  }

  /* ============================================================
   * BULK DELETE
   * ============================================================ */

  /**
   * Deletes many documents, with ONE audit entry describing the batch.
   *
   * A per-row entry would bury the log under hundreds of near-identical
   * lines and hide the fact that a single deliberate action removed them
   * all — which is the thing an auditor actually needs to see. Severity is
   * escalated to critical because bulk deletion is not routine, and the ids
   * are recorded so the set is reconstructible from the backup.
   *
   * Chunked at the batch ceiling, so the audit entry rides in the FIRST
   * chunk — if a later chunk fails, the log still shows the attempt.
   */
  async function removeMany(key, ids, options = {}) {
    const spec = specOf(key);
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (list.length === 0) return { deleted: 0, backupId: null };

    let backupId = null;
    if (options.skipBackup !== true) {
      const backup = await BackupService.createAutomaticBackup(
        options.backupTrigger || BackupService.TRIGGER.BEFORE_BULK_DELETE,
        {
          note: options.note || `قبل حذف ${list.length} ${spec.label}`,
          monthId: options.monthId || null
        }
      );
      backupId = backup ? backup.id : null;
    }

    let auditWritten = false;
    await ServiceCommon.commitInChunks(list, (batch, id) => {
      batch.delete(refFor(spec, id));
      let ops = 1;
      if (!auditWritten) {
        AuditService.appendToBatch(batch, {
          action: AuditService.actionFor(spec.entity, AuditService.OPERATION.DELETE),
          entity: spec.entity,
          operation: AuditService.OPERATION.DELETE,
          documentId: null,
          documentLabel: `${list.length} ${spec.label}`,
          monthId: options.monthId || null,
          severity: AuditService.SEVERITY.CRITICAL,
          details: {
            bulk: true,
            count: list.length,
            // Capped so a huge deletion can't blow the 1 MB document limit;
            // the backup holds the complete set either way.
            ids: list.slice(0, 200),
            idsTruncated: list.length > 200,
            backupId,
            note: options.note || null
          }
        });
        auditWritten = true;
        ops += 1;
      }
      return ops;
    });

    return { deleted: list.length, backupId };
  }

  /* ============================================================
   * UNDO DESCRIPTORS
   * ============================================================ */

  /**
   * The reversal recipe for an operation, handed to UndoService.
   *
   * Built here rather than in UndoService because this is where the spec, the
   * ids and the before/after states already are — and because a descriptor
   * assembled anywhere else could disagree with what was actually written.
   */
  function describeUndo(spec, operation, { documentId, label, before, after, undoable }) {
    if (!undoable) return null;

    return {
      collectionKey: spec.key,
      entity: spec.entity,
      entityLabel: spec.label,
      operation,
      documentId,
      documentLabel: label,
      before,
      after,
      // Recorded so UndoService can enforce the 30s window even after a page
      // refresh, using its own clock reading rather than a stored deadline.
      at: Date.now()
    };
  }

  /**
   * Applies a reversal. Called ONLY by UndoService.
   *
   * Lives here, not there, because reversing an operation is a write like any
   * other: it must obey the month lock and it must be audited atomically.
   * Putting it anywhere else would create a second write path — the exact
   * hole this file exists to close.
   *
   * The inverse of each operation:
   *   create -> delete the document
   *   delete -> recreate it under the SAME id, so references stay valid
   *   update -> put back only the fields the edit changed
   */
  async function applyUndo(descriptor) {
    if (!descriptor || !descriptor.collectionKey) {
      throw new Error('بيانات التراجع غير مكتملة');
    }

    const spec = specOf(descriptor.collectionKey);
    const { operation, documentId } = descriptor;

    // The month lock is re-checked at undo time, never trusted from when the
    // descriptor was created: the month could have been closed in between,
    // and undoing into a closed month would edit a signed-off payroll.
    const monthData = descriptor.before || descriptor.after || {};
    if (spec.monthField) {
      assertMonthEditable(spec, monthData, AuditService.OPERATION.UNDO);
    }

    const batch = db.batch();
    const ref = refFor(spec, documentId);
    let undoneInto = null;

    if (operation === AuditService.OPERATION.CREATE) {
      // Undo of an add: verify it's still there, then remove it.
      const snap = await ref.get();
      if (!snap.exists) {
        throw new Error(`${spec.label} اتحذف بالفعل — مفيش حاجة للتراجع عنها`);
      }
      batch.delete(ref);
      undoneInto = null;

    } else if (operation === AuditService.OPERATION.DELETE) {
      // Undo of a delete: recreate under the original id.
      const snap = await ref.get();
      if (snap.exists) {
        throw new Error(`${spec.label} موجود بالفعل — يمكن اتضاف تاني من تاب تاني`);
      }
      const restored = stripUndefined(
        ServiceCommon.reviveClone(descriptor.before || {})
      );
      batch.set(ref, restored);
      undoneInto = restored;

    } else if (operation === AuditService.OPERATION.UPDATE) {
      // Undo of an edit: put back the previous values of exactly the fields
      // that changed. A field that did not exist before is REMOVED rather
      // than written as null, so the document returns to its actual prior
      // shape instead of gaining a null field it never had.
      const snap = await ref.get();
      if (!snap.exists) {
        throw new Error(`${spec.label} مش موجود — يمكن اتحذف بعد التعديل`);
      }

      const before = descriptor.before || {};
      const patch = {};
      Object.keys(before).forEach(field => {
        const value = before[field];
        patch[field] = (value === null || value === undefined)
          ? ServiceCommon.deleteField()
          : ServiceCommon.reviveClone(value);
      });
      patch.updatedAt = ServiceCommon.serverTimestamp();

      batch.update(ref, patch);
      undoneInto = before;

    } else {
      throw new Error(`نوع عملية غير مدعوم للتراجع: ${operation}`);
    }

    // The undo is itself an audited action — a warning, because it changes
    // data. Its `before`/`after` are the reverse of the original entry's, so
    // the log reads as a coherent sequence rather than a contradiction.
    AuditService.appendToBatch(batch, {
      action: AuditService.ACTION.UNDO_APPLIED,
      entity: spec.entity,
      operation: AuditService.OPERATION.UNDO,
      documentId: documentId,
      documentLabel: descriptor.documentLabel || documentId,
      monthId: spec.monthField ? monthData[spec.monthField] : null,
      before: descriptor.after === undefined ? null : descriptor.after,
      after: undoneInto,
      severity: AuditService.SEVERITY.WARNING,
      details: {
        undoneOperation: operation,
        undoneEntity: spec.entity,
        originalLabel: descriptor.documentLabel || null
      }
    });

    await batch.commit();

    return { id: documentId, operation, entityLabel: spec.label };
  }

  return {
    // registry
    registerCollection,
    isRegistered,
    specOf,
    // writes
    create,
    update,
    replace,
    remove,
    removeMany,
    // undo
    describeUndo,
    applyUndo
  };
})();
