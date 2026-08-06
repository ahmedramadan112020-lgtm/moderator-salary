/**
 * backup.js
 * -----------------------------------------------------------------------
 * BackupService — restorable point-in-time copies of the live database.
 *
 * TWO DIFFERENT THINGS CALLED "BACKUP"
 * ------------------------------------
 * This is NOT the per-month backup written by Months.createBackup(). That one
 * freezes the INPUTS of one specific month into
 * `monthly_reports/{monthId}/backups/*` and exists so a closed month can
 * always explain itself. It is never restored — it is evidence.
 *
 * THIS service writes to the top-level `backups` collection and is the thing
 * you restore FROM. It copies the live master data — employees, departments,
 * advances, adjustments, settings — as it stands right now, and it is created
 * automatically before anything destructive.
 *
 * DOCUMENT SHAPE
 * --------------
 *   backups/{backupId}                 <- small MANIFEST (metadata only)
 *   backups/{backupId}/chunks/{docId}  <- the actual rows, in slices
 *
 * The manifest stays small so the Backups page can list everything in one
 * cheap read. The rows are chunked because Firestore caps a document at 1 MB
 * and a few hundred employees with Arabic names and notes plus a year of
 * advances would eventually exceed it — a backup that silently stops working
 * once the company grows is worse than no backup at all.
 *
 * THE MANIFEST IS WRITTEN LAST, AND THAT IS THE WHOLE INTEGRITY MODEL
 * ------------------------------------------------------------------
 * Chunks are written first, then the manifest with `status: 'complete'`. If
 * the browser dies halfway, what remains is orphan chunks and NO manifest —
 * so the backup does not appear in the list and can never be restored from.
 * The alternative ordering (manifest first) would leave a backup that looks
 * complete, lists confidently in the UI, and restores a fraction of the
 * data. For a payroll system that is the single worst possible failure, so
 * the ordering is load-bearing rather than stylistic.
 *
 * WHAT IS DELIBERATELY NOT BACKED UP
 * ----------------------------------
 *   * `monthly_reports` documents and their `orderBatches`. A month's raw
 *     orders can be hundreds of thousands of rows, the calculated report is
 *     reproducible from them, and closed months are already immutable and
 *     snapshotted. Copying them would multiply storage for no recoverability
 *     gain — the same reasoning months.js gives for not copying orderBatches.
 *   * `audit_logs`. Append-only by rule and never restored: restoring an
 *     audit log would mean deleting entries that record what really happened.
 *   * `settlements`. Create-only permanent financial records that the rules
 *     forbid editing or deleting, so there is nothing a restore could fix.
 *   * `users`. Auth/role data, not payroll data.
 *
 * RESTORE SAFETY  (three rules, none negotiable)
 * ---------------------------------------------
 *   1. A backup of the CURRENT state is taken first, automatically. So a
 *      restore is itself undoable by restoring the pre-restore backup.
 *   2. Rows belonging to a LOCKED month are never touched. A closed month
 *      has been paid out; rewriting its advances would change a signed-off
 *      payroll, and the Firestore rules would reject it anyway.
 *   3. Nothing is deleted. Restore ADDS what is missing and UPDATES what
 *      differs. A record created after the backup was taken is left alone,
 *      because "make the database look exactly like last Tuesday" silently
 *      destroys every legitimate entry made since.
 *
 * SCHEDULED BACKUPS  (intentionally not implemented)
 * -------------------------------------------------
 * A daily backup that only happens when somebody opens the dashboard isn't a
 * daily backup — it is a backup that stops existing during holidays, which is
 * exactly when nobody notices. This is a static site with no backend, so
 * there is no honest way to schedule work.
 *
 * `runScheduled()` below is the seam for when there is one: point a Cloud
 * Function or Cloud Scheduler job at it and daily backups start working with
 * no other change. It is exported and documented, but nothing in the app
 * calls it on a timer.
 * -----------------------------------------------------------------------
 */

'use strict';

const BackupService = (() => {

  /* ============================================================
   * CONSTANTS
   * ============================================================ */

  const TYPE = {
    AUTOMATIC: 'automatic',
    MANUAL: 'manual',
    SCHEDULED: 'scheduled'   // reserved: see runScheduled()
  };

  const TYPE_LABELS = {
    [TYPE.AUTOMATIC]: 'تلقائية',
    [TYPE.MANUAL]: 'يدوية',
    [TYPE.SCHEDULED]: 'مجدولة'
  };

  const STATUS = {
    COMPLETE: 'complete',
    FAILED: 'failed'
  };

  /**
   * Why a backup was taken. Stored verbatim on the manifest so the Backups
   * page can explain every row without guessing, and so "which backup do I
   * want" is answerable months later.
   */
  const TRIGGER = {
    MANUAL: 'manual_request',
    MONTH_CLOSE: 'before_month_close',
    BEFORE_RESTORE: 'before_restore',
    BEFORE_EMPLOYEE_DELETE: 'before_employee_delete',
    BEFORE_MONTH_CLEAR: 'before_month_data_clear',
    BEFORE_MONTH_RESET: 'before_month_reset',
    BEFORE_SETTLEMENT: 'before_final_settlement',
    BEFORE_DEPARTMENT_ARCHIVE: 'before_department_archive',
    BEFORE_BULK_DELETE: 'before_bulk_delete',
    SCHEDULED: 'scheduled_run'
  };

  const TRIGGER_LABELS = {
    [TRIGGER.MANUAL]: 'إنشاء يدوي',
    [TRIGGER.MONTH_CLOSE]: 'قبل إنهاء الشهر',
    [TRIGGER.BEFORE_RESTORE]: 'قبل الاسترجاع',
    [TRIGGER.BEFORE_EMPLOYEE_DELETE]: 'قبل حذف موظف',
    [TRIGGER.BEFORE_MONTH_CLEAR]: 'قبل مسح بيانات شهر',
    [TRIGGER.BEFORE_MONTH_RESET]: 'قبل إفراغ محتوى شهر',
    [TRIGGER.BEFORE_SETTLEMENT]: 'قبل اعتماد مخالصة',
    [TRIGGER.BEFORE_DEPARTMENT_ARCHIVE]: 'قبل أرشفة قسم',
    [TRIGGER.BEFORE_BULK_DELETE]: 'قبل حذف مجموعة سجلات',
    [TRIGGER.SCHEDULED]: 'نسخة مجدولة'
  };

  /**
   * Rows per chunk document. Sized by ROW COUNT rather than measured bytes,
   * matching Months.BACKUP_CHUNK: 300 employee or advance records sit
   * comfortably under 1 MB even with long Arabic names and notes, while
   * keeping the document count small.
   */
  const CHUNK_SIZE = 300;

  /**
   * The collections a backup covers, in restore order.
   *
   * Departments come before employees on purpose: an employee references a
   * departmentId, so restoring people into departments that don't exist yet
   * would briefly leave them orphaned and break the next calculation.
   *
   * `monthField` names the field that ties a row to a payroll month. Rows
   * whose month is locked are skipped on restore — that is what keeps a
   * closed payroll immutable. Collections without one are live master data,
   * not month data, and are never month-gated (the same distinction the
   * Firestore rules draw for `moderators`).
   *
   * ADDING A COLLECTION: append an entry here. Backup, compare, restore and
   * the JSON export all pick it up with no further changes.
   */
  const COLLECTION_SPECS = [
    {
      key: 'departments',
      collection: COLLECTIONS.DEPARTMENTS,
      label: 'الأقسام',
      monthField: null
    },
    {
      key: 'employees',
      collection: COLLECTIONS.EMPLOYEES,
      label: 'الموظفون',
      monthField: null
    },
    {
      key: 'advances',
      collection: COLLECTIONS.ADVANCES,
      label: 'السلف',
      monthField: 'monthId'
    },
    {
      key: 'adjustments',
      collection: COLLECTIONS.ADJUSTMENTS,
      label: 'التسويات',
      monthField: 'monthId'
    },
    {
      key: 'settings',
      collection: COLLECTIONS.SETTINGS,
      label: 'الإعدادات',
      monthField: null,
      // System bookkeeping, not user data. `system` holds the active-month
      // pointer and the backfill markers; restoring it would yank every
      // device onto an old month and could re-trigger a completed migration.
      // `adminBootstrap` is a one-time security marker the rules protect.
      excludeIds: ['system', 'adminBootstrap', 'migrations']
    },
    {
      key: 'orders', collection: 'monthly_reports/*/orderBatches', label: 'الطلبات',
      monthField: 'monthId', read: readOrderBatches,
      refFor: row => db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(row.route.monthId).collection(MONTH_SUBCOLLECTIONS.ORDER_BATCHES).doc(row.route.batchId)
    },
    {
      key: 'salary_processing', collection: COLLECTIONS.SALARY_PROCESSING, label: 'لقطات معالجة الرواتب', monthField: null
    },
    { key: 'roles', collection: COLLECTIONS.ROLES, label: 'الأدوار والصلاحيات', monthField: null },
    { key: 'users', collection: COLLECTIONS.USERS, label: 'تعيينات الأدوار للمستخدمين', monthField: null },
    {
      key: 'audit_logs', collection: COLLECTIONS.AUDIT_LOGS, label: 'سجل التدقيق', monthField: null,
      writeMode: 'createOnly'
    }
  ];

  const SCOPE_KEYS = {
    full: COLLECTION_SPECS.map(spec => spec.key),
    orders: ['orders'],
    salary_processing: ['salary_processing'],
    settings: ['settings'],
    roles: ['roles', 'users'],
    audit: ['audit_logs']
  };

  function specsForScope(scope) {
    const keys = SCOPE_KEYS[scope || 'full'] || SCOPE_KEYS.full;
    return COLLECTION_SPECS.filter(spec => keys.includes(spec.key));
  }

  function specsForManifest(manifest) {
    const keys = Array.isArray(manifest?.collectionKeys) && manifest.collectionKeys.length
      ? manifest.collectionKeys : ['departments', 'employees', 'advances', 'adjustments', 'settings'];
    return COLLECTION_SPECS.filter(spec => keys.includes(spec.key));
  }

  function specFor(key) {
    return COLLECTION_SPECS.find(s => s.key === key) || null;
  }

  async function readOrderBatches() {
    const months = await db.collection(COLLECTIONS.MONTHLY_REPORTS).get();
    const rows = [];
    for (const month of months.docs) {
      const batches = await month.ref.collection(MONTH_SUBCOLLECTIONS.ORDER_BATCHES).get();
      batches.docs.forEach(batch => rows.push({ id: `${month.id}/${batch.id}`, route: { monthId: month.id, batchId: batch.id }, data: ServiceCommon.plainClone(batch.data()) }));
    }
    return rows;
  }

  /* ============================================================
   * READING THE LIVE DATABASE
   * ============================================================ */

  /**
   * Reads one collection into plain, JSON-safe rows.
   *
   * Every document keeps its own id, because that id is the join key the
   * whole system runs on: advances reference `moderatorId`, report rows
   * reference employees, employees reference `departmentId`. A restore that
   * generated fresh ids would break every one of those links, so restore
   * always writes back to the SAME id.
   */
  async function readCollection(spec) {
    if (typeof spec.read === 'function') return spec.read();
    const snap = await db.collection(spec.collection).get();
    const exclude = new Set(spec.excludeIds || []);

    return snap.docs
      .filter(doc => !exclude.has(doc.id))
      .map(doc => ({
        id: doc.id,
        data: ServiceCommon.plainClone(doc.data())
      }));
  }

  /** Reads every backed-up collection. Returns { key: rows[] }. */
  async function readAllCollections(specs = COLLECTION_SPECS) {
    const out = {};
    // Sequential rather than parallel: a company with a long history can
    // have thousands of advances, and firing five unbounded reads at once
    // competes for the same connection while the UI is already blocked on a
    // loading overlay. Sequential is barely slower and far kinder to a weak
    // connection, which is the environment this actually runs in.
    for (const spec of specs) {
      try {
        out[spec.key] = await readCollection(spec);
      } catch (err) {
        console.error(`Backup: could not read ${spec.key}:`, err);
        throw new Error(`تعذر قراءة ${spec.label} أثناء إنشاء النسخة: ${err.message}`);
      }
    }
    return out;
  }

  /* ============================================================
   * CREATING A BACKUP
   * ============================================================ */

  /**
   * Creates a backup of the current live data.
   *
   * @param {object} options
   *        - type    : TYPE.MANUAL | TYPE.AUTOMATIC | TYPE.SCHEDULED
   *        - trigger : one of TRIGGER
   *        - name    : optional human name; auto-generated when absent
   *        - note    : optional free text
   *        - monthId : the month the triggering action concerned, if any
   * @returns {Promise<object>} the manifest as stored, plus its id
   */
  async function createBackup(options = {}) {
    const type = Object.values(TYPE).includes(options.type) ? options.type : TYPE.MANUAL;
    const trigger = options.trigger || TRIGGER.MANUAL;
    const createdDate = new Date();

    // ---- 1. Read everything ----
    const selectedSpecs = specsForScope(options.scope);
    const collections = await readAllCollections(selectedSpecs);
    const extraCollections = normalizeExtraCollections(options.extraCollections);
    extraCollections.forEach(spec => {
      collections[spec.key] = spec.rows;
    });
    const backupSpecs = selectedSpecs.concat(extraCollections);

    // ---- 2. Measure ----
    let totalDocuments = 0;
    let approxBytes = 0;
    const counts = {};

    backupSpecs.forEach(spec => {
      const rows = collections[spec.key] || [];
      counts[spec.key] = rows.length;
      totalDocuments += rows.length;
      approxBytes += ServiceCommon.estimateSize(rows);
    });

    if (totalDocuments === 0) {
      throw new Error('مفيش أي بيانات لعمل نسخة احتياطية منها');
    }

    // A readable, sortable id: `2026-08-03_14-32-07`. Two backups inside the
    // same second would collide, so a short random suffix guarantees
    // uniqueness without making the id unreadable.
    const backupId = `${ServiceCommon.timestampId(createdDate)}-${
      Math.random().toString(36).slice(2, 6)}`;

    const backupRef = db.collection(COLLECTIONS.BACKUPS).doc(backupId);
    const chunksRef = backupRef.collection(BACKUP_SUBCOLLECTIONS.CHUNKS);

    // ---- 3. Write the chunks FIRST ----
    // Deterministic chunk ids (`employees-0000`) so a retry overwrites the
    // same documents instead of duplicating them.
    let chunkCount = 0;
    const chunkIndex = [];

    for (const spec of backupSpecs) {
      const rows = collections[spec.key] || [];
      if (rows.length === 0) continue;

      const slices = ServiceCommon.chunk(rows, CHUNK_SIZE);

      for (let i = 0; i < slices.length; i++) {
        const chunkId = `${spec.key}-${String(i).padStart(4, '0')}`;
        const chunkValue = {
          collectionKey: spec.key,
          collectionName: spec.collection,
          index: i,
          count: slices[i].length,
          rows: slices[i]
        };
        await chunksRef.doc(chunkId).set(chunkValue);
        chunkIndex.push({ chunkId, collectionKey: spec.key, count: slices[i].length });
        chunkCount += 1;
      }
    }

    // ---- 4. Manifest LAST: this is what makes the backup "exist" ----
    const manifest = {
      name: options.name
        ? String(options.name).trim()
        : defaultName(type, trigger, createdDate),
      type,
      trigger,
      triggerLabel: TRIGGER_LABELS[trigger] || trigger,
      status: STATUS.COMPLETE,
      note: String(options.note || '').trim(),
      monthId: options.monthId || null,
      scope: options.scope || 'full',
      collectionKeys: backupSpecs.map(spec => spec.key),

      // ---- metadata the admin sees on the Backups page ----
      collectionCount: backupSpecs.filter(s => counts[s.key] > 0).length,
      documentCount: totalDocuments,
      approxBytes,
      counts,
      chunkCount,
      chunkSize: CHUNK_SIZE,
      chunkIndex,

      // Server time is authoritative. `createdAtLocal` records what the
      // creating device believed the time was — kept only so a wildly wrong
      // workstation clock is visible rather than silently reconciled.
      createdAt: ServiceCommon.serverTimestamp(),
      createdAtLocal: createdDate.toISOString(),
      ...ServiceCommon.actor()
    };

    await backupRef.set(manifest);

    // ---- 5. Audit ----
    // After the manifest, never before: the entry describes a backup that
    // exists, and until the manifest is written it doesn't.
    await AuditService.log(AuditService.ACTION.BACKUP_CREATED, {
      entity: 'backups',
      operation: AuditService.OPERATION.CREATE,
      documentId: backupId,
      documentLabel: manifest.name,
      monthId: manifest.monthId,
      details: {
        type,
        trigger,
        documentCount: totalDocuments,
        collectionCount: manifest.collectionCount,
        approxBytes,
        counts
      }
    });

    return { id: backupId, ...manifest };
  }

  /**
   * Adds an opt-in data section to one backup. It is used only by Month
   * Reset, whose required safety backup must include the target month's raw
   * import and calculated data before that data is removed. Normal backups
   * keep their established master-data-only scope.
   */
  function normalizeExtraCollections(extraCollections) {
    if (!Array.isArray(extraCollections)) return [];
    return extraCollections
      .filter(spec => spec && typeof spec.key === 'string' && Array.isArray(spec.rows))
      .map(spec => ({
        key: spec.key,
        collection: String(spec.collection || spec.key),
        label: String(spec.label || spec.key),
        rows: spec.rows.map(row => ServiceCommon.plainClone(row))
      }));
  }

  /**
   * Creates the mandatory system backup immediately before a Month Reset.
   * It deliberately does not catch errors: the caller must cancel the reset
   * if Firestore cannot create a complete backup. Order rows are stored
   * separately from their batch metadata so a large import remains chunked
   * well below Firestore's document-size limit.
   */
  async function createMonthResetBackup(monthId, resetSnapshot = {}) {
    if (!Utils.isValidMonthId(monthId)) {
      throw new Error('صيغة الشهر غير صحيحة لعمل نسخة Reset');
    }

    const orderBatchMeta = [];
    const orderRows = [];
    (resetSnapshot.orderBatches || []).forEach(row => {
      const data = ServiceCommon.plainClone(row.data || {});
      const orders = Array.isArray(data.orders) ? data.orders : [];
      delete data.orders;
      orderBatchMeta.push({ id: row.id, data, orderCount: orders.length });
      orders.forEach((order, index) => {
        orderRows.push({
          id: `${row.id}:${String(index).padStart(6, '0')}`,
          batchId: row.id,
          index,
          order: ServiceCommon.plainClone(order)
        });
      });
    });

    const rowsFor = rows => (rows || []).map(row => ({
      id: row.id,
      data: ServiceCommon.plainClone(row.data || {})
    }));

    const backup = await createBackup({
      type: TYPE.AUTOMATIC,
      trigger: TRIGGER.BEFORE_MONTH_RESET,
      monthId,
      scope: 'month_reset',
      name: `قبل إفراغ محتوى ${Utils.monthLabelFromId(monthId)}`,
      note: 'نسخة نظام إلزامية تشمل بيانات الشهر قبل حذف مخرجات الاستيراد والحساب',
      extraCollections: [
        { key: 'reset_month_report', collection: `monthly_reports/${monthId}`, label: 'تقرير الشهر قبل الإفراغ', rows: rowsFor(resetSnapshot.month ? [resetSnapshot.month] : []) },
        { key: 'reset_month_summary', collection: `monthly_summaries/${monthId}`, label: 'ملخص الشهر قبل الإفراغ', rows: rowsFor(resetSnapshot.summary ? [resetSnapshot.summary] : []) },
        { key: 'reset_order_batches', collection: `monthly_reports/${monthId}/orderBatches`, label: 'دفعات الطلبات قبل الإفراغ', rows: orderBatchMeta },
        { key: 'reset_orders', collection: `monthly_reports/${monthId}/orderBatches/*/orders`, label: 'طلبات الشهر قبل الإفراغ', rows: orderRows },
        { key: 'reset_snapshots', collection: `monthly_reports/${monthId}/snapshots`, label: 'لقطات الشهر قبل الإفراغ', rows: rowsFor(resetSnapshot.snapshots) },
        { key: 'reset_month_backups', collection: `monthly_reports/${monthId}/backups`, label: 'نسخ الشهر قبل الإفراغ', rows: rowsFor(resetSnapshot.monthBackups) }
      ]
    });
    return backup;
  }

  /** A descriptive default name, so unnamed backups are still identifiable. */
  function defaultName(type, trigger, date) {
    const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${
      String(date.getDate()).padStart(2, '0')} ${
      String(date.getHours()).padStart(2, '0')}:${
      String(date.getMinutes()).padStart(2, '0')}`;
    const reason = TRIGGER_LABELS[trigger] || '';
    return type === TYPE.MANUAL
      ? `نسخة يدوية — ${stamp}`
      : `نسخة تلقائية (${reason}) — ${stamp}`;
  }

  /**
   * Creates an automatic backup WITHOUT letting a backup failure block the
   * action that requested it.
   *
   * The judgement call here matters. These backups are safety nets before
   * destructive work, so the instinct is to refuse the work if the net
   * fails. But that would mean a transient Firestore hiccup makes the app
   * unusable — you couldn't delete a mistyped employee because a backup
   * wouldn't write. Worse, the caller has usually already shown a
   * confirmation dialog.
   *
   * So: the failure is logged loudly, surfaced to the caller as a null
   * result, and the caller decides. Every current caller shows a warning
   * toast and proceeds. What is NOT compromised is the audit trail — that
   * one IS atomic with the write and cannot be skipped.
   */
  async function createAutomaticBackup(trigger, options = {}) {
    try {
      return await createBackup({
        ...options,
        type: TYPE.AUTOMATIC,
        trigger
      });
    } catch (err) {
      console.error('Automatic backup failed:', err);
      try {
        Toast.show(
          'تحذير: تعذر إنشاء نسخة احتياطية تلقائية قبل العملية — ' + err.message,
          'error'
        );
      } catch (e) { /* Toast not ready */ }
      return null;
    }
  }

  /* ============================================================
   * OPERATIONAL DATA RESET
   * ============================================================ */

  /**
   * Removes only live transaction records that belong to OPEN months.
   *
   * A reset must never rewrite payroll history: locked months, settlements,
   * audit entries, reports, employees, departments and settings are all
   * intentionally outside this operation.  The normal backup already holds
   * advances and adjustments, so taking it successfully before the first
   * delete makes this destructive action recoverable through the existing
   * restore flow.
   *
   * The backup is deliberately REQUIRED here (unlike routine automatic
   * backups).  If it cannot be created, no transaction is deleted.
   */
  async function clearOpenOperations(options = {}) {
    const [monthsSnap, advancesSnap, adjustmentsSnap] = await Promise.all([
      db.collection(COLLECTIONS.MONTHLY_REPORTS).get(),
      db.collection(COLLECTIONS.ADVANCES).get(),
      db.collection(COLLECTIONS.ADJUSTMENTS).get()
    ]);

    const openMonthIds = new Set(
      monthsSnap.docs
        .filter(doc => (doc.data() || {}).status !== 'locked')
        .map(doc => doc.id)
    );

    const records = [];
    const addRecords = (snap, entity, collection) => {
      snap.docs.forEach(doc => {
        const data = doc.data() || {};
        if (!openMonthIds.has(data.monthId)) return;
        records.push({
          ref: doc.ref,
          entity,
          collection,
          id: doc.id,
          monthId: data.monthId,
          label: data.employeeName || data.moderatorName || doc.id,
          before: ServiceCommon.plainClone(data)
        });
      });
    };
    addRecords(advancesSnap, 'advances', COLLECTIONS.ADVANCES);
    addRecords(adjustmentsSnap, 'adjustments', COLLECTIONS.ADJUSTMENTS);

    if (records.length === 0) {
      return { cleared: 0, advances: 0, adjustments: 0, backup: null, openMonths: openMonthIds.size };
    }

    // Do not use createAutomaticBackup here: its best-effort contract is
    // appropriate for ordinary edits, but unsafe for a deliberate bulk reset.
    const backup = await createBackup({
      type: TYPE.AUTOMATIC,
      trigger: TRIGGER.BEFORE_MONTH_CLEAR,
      name: options.name || 'قبل تصفير بيانات التشغيل',
      note: 'نسخة إلزامية قبل حذف السلف والتسويات الخاصة بالشهور المفتوحة'
    });

    const counts = { advances: 0, adjustments: 0 };
    await ServiceCommon.commitInChunks(records, (batch, record) => {
      batch.delete(record.ref);
      AuditService.appendToBatch(batch, {
        action: AuditService.ACTION.MONTH_DATA_CLEARED,
        entity: record.entity,
        operation: AuditService.OPERATION.DELETE,
        documentId: record.id,
        documentLabel: record.label,
        monthId: record.monthId,
        before: record.before,
        details: { reset: 'open_operations', collection: record.collection, backupId: backup.id }
      });
      counts[record.entity] += 1;
      return 2; // business delete + its mandatory audit entry
    }, 400, options.onProgress);

    await AuditService.log(AuditService.ACTION.MONTH_DATA_CLEARED, {
      entity: 'operations',
      operation: AuditService.OPERATION.DELETE,
      documentLabel: 'تصفير بيانات التشغيل',
      severity: AuditService.SEVERITY.CRITICAL,
      details: {
        reset: 'open_operations',
        advances: counts.advances,
        adjustments: counts.adjustments,
        openMonths: openMonthIds.size,
        backupId: backup.id
      }
    });

    return { cleared: records.length, ...counts, backup, openMonths: openMonthIds.size };
  }

  /* ============================================================
   * LISTING & LOADING
   * ============================================================ */

  /** Normalizes a manifest for display. */
  function normalizeManifest(id, data) {
    const d = data || {};
    return {
      id,
      name: d.name || id,
      type: Object.values(TYPE).includes(d.type) ? d.type : TYPE.MANUAL,
      typeLabel: TYPE_LABELS[d.type] || TYPE_LABELS[TYPE.MANUAL],
      trigger: d.trigger || null,
      triggerLabel: d.triggerLabel || TRIGGER_LABELS[d.trigger] || '—',
      status: d.status || STATUS.COMPLETE,
      note: d.note || '',
      monthId: d.monthId || null,
      scope: d.scope || null,
      collectionKeys: Array.isArray(d.collectionKeys) ? d.collectionKeys : null,
      collectionCount: Utils.toFiniteNumber(d.collectionCount) || 0,
      documentCount: Utils.toFiniteNumber(d.documentCount) || 0,
      approxBytes: Utils.toFiniteNumber(d.approxBytes) || 0,
      counts: (d.counts && typeof d.counts === 'object') ? d.counts : {},
      chunkCount: Utils.toFiniteNumber(d.chunkCount) || 0,
      createdAt: d.createdAt || null,
      createdAtLocal: d.createdAtLocal || null,
      userId: d.userId || null,
      userEmail: d.userEmail || null
    };
  }

  /**
   * Every backup, newest first.
   *
   * Ordered by `createdAt` with no filter, so it needs no composite index.
   * Incomplete backups (chunks written but no manifest) simply aren't here —
   * they have no document to list.
   */
  async function listBackups(limit = 100) {
    try {
      const snap = await db.collection(COLLECTIONS.BACKUPS)
        .orderBy('createdAt', 'desc').limit(limit).get();
      return snap.docs.map(d => normalizeManifest(d.id, d.data()));
    } catch (err) {
      console.error('Could not list backups:', err);
      return [];
    }
  }

  /** One manifest by id, or null. */
  async function getManifest(backupId) {
    if (!backupId) return null;
    try {
      const snap = await db.collection(COLLECTIONS.BACKUPS).doc(backupId).get();
      return snap.exists ? normalizeManifest(snap.id, snap.data()) : null;
    } catch (err) {
      console.error('Could not read the backup manifest:', err);
      return null;
    }
  }

  /**
   * Loads a backup's full contents: `{ manifest, collections: {key: rows} }`.
   *
   * Verifies the chunk count against the manifest and refuses a backup that
   * is missing chunks. A partial restore is far more dangerous than a
   * refused one — it would leave half the employees updated and half not,
   * with no indication which.
   */
  async function loadBackup(backupId) {
    const manifest = await getManifest(backupId);
    if (!manifest) throw new Error('النسخة الاحتياطية مش موجودة');
    if (manifest.status !== STATUS.COMPLETE) {
      throw new Error('النسخة الاحتياطية دي غير مكتملة ومش ممكن الاسترجاع منها');
    }

    const snap = await db.collection(COLLECTIONS.BACKUPS).doc(backupId)
      .collection(BACKUP_SUBCOLLECTIONS.CHUNKS).get();

    if (snap.size !== manifest.chunkCount) {
      throw new Error(
        `النسخة الاحتياطية ناقصة: المتوقع ${manifest.chunkCount} جزء والموجود ${snap.size}. ` +
        'الاسترجاع اتوقف عشان مايحصلش استرجاع جزئي.'
      );
    }

    const collections = {};
    COLLECTION_SPECS.forEach(spec => { collections[spec.key] = []; });

    // Chunks are ordered by their index so rows land in their original order.
    const chunks = snap.docs
      .map(d => d.data() || {})
      .sort((a, b) => {
        const ka = String(a.collectionKey || '');
        const kb = String(b.collectionKey || '');
        if (ka !== kb) return ka.localeCompare(kb);
        return (Number(a.index) || 0) - (Number(b.index) || 0);
      });

    chunks.forEach(c => {
      const key = c.collectionKey;
      if (!collections[key]) collections[key] = [];
      (Array.isArray(c.rows) ? c.rows : []).forEach(row => {
        if (row && row.id) collections[key].push(row);
      });
    });

    // Cross-check the row totals too: a chunk document that exists but lost
    // its `rows` array would otherwise pass the chunk-count check above.
    const restoredTotal = Object.values(collections)
      .reduce((sum, rows) => sum + rows.length, 0);
    if (manifest.documentCount && restoredTotal !== manifest.documentCount) {
      throw new Error(
        `النسخة الاحتياطية ناقصة: المتوقع ${manifest.documentCount} سجل والموجود ${restoredTotal}.`
      );
    }

    return { manifest, collections };
  }

  /* ============================================================
   * COMPARISON  (shown before any restore)
   * ============================================================ */

  /**
   * Compares a backup against the live database, per collection.
   *
   * Returns, for every collection:
   *   toAdd      - in the backup, missing now (would be recreated)
   *   toUpdate   - in both, but the data differs (would be overwritten)
   *   unchanged  - identical
   *   newerNow   - exists now but NOT in the backup: created after it was
   *                taken, and deliberately LEFT ALONE by restore
   *   skipped    - belongs to a locked month, so untouchable
   *
   * This is what the admin approves. It is computed from the same data the
   * restore will act on, so the preview and the action can't disagree.
   */
  async function compareWithCurrent(backupId) {
    const { manifest, collections } = await loadBackup(backupId);
    const selectedSpecs = specsForManifest(manifest);
    const current = await readAllCollections(selectedSpecs);

    const report = [];
    let totals = { toAdd: 0, toUpdate: 0, unchanged: 0, newerNow: 0, skipped: 0 };

    for (const spec of selectedSpecs) {
      const backupRows = collections[spec.key] || [];
      const currentRows = current[spec.key] || [];
      const currentById = new Map(currentRows.map(r => [r.id, r]));
      const backupIds = new Set(backupRows.map(r => r.id));

      const entry = {
        key: spec.key,
        label: spec.label,
        toAdd: [], toUpdate: [], unchanged: [], newerNow: [], skipped: []
      };

      backupRows.forEach(row => {
        // Locked-month rows are untouchable, whichever side they're on.
        if (isLockedRow(spec, row.data, row) || (spec.skipRestore && spec.skipRestore(row.data))) {
          entry.skipped.push(row.id);
          return;
        }
        const live = currentById.get(row.id);
        if (!live) {
          entry.toAdd.push(row.id);
        } else if (spec.writeMode === 'createOnly') {
          entry.unchanged.push(row.id);
        } else if (ServiceCommon.stableStringify(live.data) !==
                   ServiceCommon.stableStringify(row.data)) {
          // Order-insensitive comparison: Firestore returns map keys sorted,
          // so a plain JSON.stringify would report every nested map (a bonus
          // table, a permissions map) as different on every comparison and
          // the preview would claim changes that aren't there.
          entry.toUpdate.push(row.id);
        } else {
          entry.unchanged.push(row.id);
        }
      });

      currentRows.forEach(row => {
        if (backupIds.has(row.id)) return;
        entry.newerNow.push(row.id);
      });

      totals.toAdd += entry.toAdd.length;
      totals.toUpdate += entry.toUpdate.length;
      totals.unchanged += entry.unchanged.length;
      totals.newerNow += entry.newerNow.length;
      totals.skipped += entry.skipped.length;

      report.push(entry);
    }

    return { manifest, report, totals };
  }

  /**
   * Whether a row belongs to a locked payroll month.
   *
   * Fails CLOSED: a row whose month can't be resolved from the live index is
   * treated as locked and skipped. The same reasoning as
   * app.js#onDeleteAdvance — we can't prove the month is open, and guessing
   * permissively is how a closed month gets silently edited. The Firestore
   * rules would reject it anyway, so guessing the other way would only turn
   * a skipped row into a failed batch.
   */
  function isLockedRow(spec, data) {
    if (!spec.monthField) return false;
    const monthId = spec.monthField.split('.').reduce((value, key) => value && value[key], data);
    if (!monthId || !Utils.isValidMonthId(monthId)) return true;
    return Months.isLocked(monthId);
  }

  /* ============================================================
   * RESTORE
   * ============================================================ */

  /**
   * Restores a backup over the live data.
   *
   * Order of operations, and why:
   *   1. load + verify the backup (refuse anything partial)
   *   2. take a backup of the CURRENT state, so this is itself reversible
   *   3. apply adds/updates in batched writes, departments before employees
   *   4. audit the restore
   *
   * Never deletes. Never touches a locked month. See the file header.
   *
   * @param {string} backupId
   * @param {object} options - { skipSafetyBackup: true } only for the
   *        internal pre-restore backup path, never from the UI.
   */
  async function restoreBackup(backupId, options = {}) {
    const { manifest, collections } = await loadBackup(backupId);

    // ---- Safety backup of the current state ----
    let safetyBackup = null;
    if (!options.skipSafetyBackup) {
      safetyBackup = await createBackup({
        type: TYPE.AUTOMATIC,
        trigger: TRIGGER.BEFORE_RESTORE,
        note: `نسخة تلقائية للحالة الحالية قبل الاسترجاع من "${manifest.name}"`,
        name: `قبل الاسترجاع — ${manifest.name}`
      });
      // A safety backup is mandatory: restoring without a reversible point
      // would overwrite data despite the confirmation shown in the UI.
    }

    const selectedSpecs = specsForManifest(manifest);
    const current = await readAllCollections(selectedSpecs);

    const applied = { added: 0, updated: 0, skipped: 0, unchanged: 0 };
    const perCollection = {};

    for (const spec of selectedSpecs) {
      const backupRows = collections[spec.key] || [];
      const currentById = new Map((current[spec.key] || []).map(r => [r.id, r]));

      const writes = [];
      let skipped = 0;
      let unchanged = 0;

      backupRows.forEach(row => {
        if (isLockedRow(spec, row.data, row) || (spec.skipRestore && spec.skipRestore(row.data))) { skipped += 1; return; }

        const live = currentById.get(row.id);
        if (live && (spec.writeMode === 'createOnly' || ServiceCommon.stableStringify(live.data) ===
                    ServiceCommon.stableStringify(row.data))) {
          unchanged += 1;
          return;
        }
        writes.push({ spec, row, isNew: !live });
      });

      // Batched writes: chunked at the Firestore ceiling, restoring one
      // collection at a time so departments exist before employees reference
      // them.
      await ServiceCommon.commitInChunks(writes, (batch, item) => {
        const ref = item.spec.refFor ? item.spec.refFor(item.row) : db.collection(item.spec.collection).doc(item.row.id);
        // `set` without merge, so the document ends up exactly as the backup
        // has it. A merge would leave fields that were added after the
        // backup, producing a hybrid record that matches neither state.
        // Timestamps are revived so dates come back as real Timestamps
        // rather than the numeric markers they were stored as.
        batch.set(ref, ServiceCommon.reviveClone(item.row.data));
        return 1;
      });

      const added = writes.filter(w => w.isNew).length;
      const updated = writes.length - added;

      applied.added += added;
      applied.updated += updated;
      applied.skipped += skipped;
      applied.unchanged += unchanged;

      perCollection[spec.key] = { added, updated, skipped, unchanged };
    }

    // ---- Audit ----
    // Logged after the writes: it records what actually happened, including
    // whether a safety net existed.
    await AuditService.log(AuditService.ACTION.BACKUP_RESTORED, {
      entity: 'backups',
      operation: AuditService.OPERATION.RESTORE,
      documentId: backupId,
      documentLabel: manifest.name,
      monthId: manifest.monthId,
      severity: AuditService.SEVERITY.CRITICAL,
      details: {
        restoredFrom: backupId,
        backupName: manifest.name,
        backupCreatedAt: manifest.createdAtLocal || null,
        safetyBackupId: safetyBackup ? safetyBackup.id : null,
        safetyBackupCreated: !!safetyBackup,
        ...applied,
        perCollection
      }
    });

    return { manifest, applied, perCollection, safetyBackup };
  }

  /* ============================================================
   * EXPORT
   * ============================================================ */

  /**
   * Downloads a backup as a single JSON file.
   *
   * The export is self-describing — it carries the manifest alongside the
   * rows — so a file recovered from someone's Downloads folder in a year's
   * time still says what it is, when it was taken and by whom.
   */
  async function downloadBackupJson(backupId) {
    const { manifest, collections } = await loadBackup(backupId);

    const payload = {
      __format__: 'moderator-salary-system.backup',
      __version__: 1,
      manifest: {
        ...manifest,
        // The Firestore Timestamp doesn't survive JSON meaningfully, so the
        // exported file carries an ISO string a human (and any other tool)
        // can actually read.
        createdAt: (() => {
          const d = Utils.toDateSafe(manifest.createdAt);
          return d ? d.toISOString() : manifest.createdAtLocal || null;
        })()
      },
      collections
    };

    ServiceCommon.downloadJson(
      `${ServiceCommon.safeFilename(manifest.name || backupId)}.json`,
      payload
    );

    await AuditService.log(AuditService.ACTION.BACKUP_DOWNLOADED, {
      entity: 'backups',
      operation: AuditService.OPERATION.CREATE,
      documentId: backupId,
      documentLabel: manifest.name,
      details: { documentCount: manifest.documentCount }
    });

    return true;
  }

  /* ============================================================
   * SCHEDULED BACKUPS  (seam only — nothing calls this on a timer)
   * ============================================================ */

  /**
   * The entry point a real scheduler would call.
   *
   * Deliberately NOT wired to any client-side timer. A backup that only runs
   * when a browser happens to be open is not a scheduled backup, and
   * pretending otherwise creates false confidence — which is worse than
   * knowing you have no daily backup.
   *
   * To enable genuine daily backups, deploy a Cloud Function on a schedule
   * that performs the same work server-side (Admin SDK, same collection
   * layout, `type: 'scheduled'`). This function exists so the client and the
   * scheduled job produce identical, interchangeable backups.
   */
  async function runScheduled(options = {}) {
    return createBackup({
      ...options,
      type: TYPE.SCHEDULED,
      trigger: TRIGGER.SCHEDULED,
      note: options.note || 'نسخة مجدولة تلقائية'
    });
  }

  return {
    TYPE,
    TYPE_LABELS,
    STATUS,
    TRIGGER,
    TRIGGER_LABELS,
    COLLECTION_SPECS,
    CHUNK_SIZE,
    specFor,
    // create
    createBackup,
    createAutomaticBackup,
    createMonthResetBackup,
    clearOpenOperations,
    // read
    listBackups,
    getManifest,
    loadBackup,
    normalizeManifest,
    // compare & restore
    compareWithCurrent,
    restoreBackup,
    isLockedRow,
    // export
    downloadBackupJson,
    // future
    runScheduled
  };
})();
