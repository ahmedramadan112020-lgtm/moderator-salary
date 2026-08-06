/**
 * months.js
 * -----------------------------------------------------------------------
 * The MONTH LIFECYCLE module: Active Month, month status, closing a month
 * (snapshot + backup + audit log + lock + open the next month), and the
 * lightweight index every month-listing screen reads from.
 *
 * WHY AN ACTIVE MONTH AT ALL
 * --------------------------
 * The app used to decide "which month am I working on" from
 * `new Date()` - the DEVICE clock. That is not acceptable for payroll:
 *   * a wrong clock on one PC silently books salaries into the wrong month,
 *   * two admins in different timezones can disagree about "this month",
 *   * on the 1st of the month the app jumps forward on its own, even
 *     though the previous month usually hasn't been paid out yet.
 *
 * So the active month is a DECISION, stored once in Firestore
 * (`settings/system.activeMonthId`) and shared by every device. The device
 * clock is never consulted again - not on startup, not when closing a
 * month. The single exception is the very first initialization of a brand
 * new deployment, and even there we ask the SERVER for the time
 * (serverTimestamp written then read back) rather than trusting the
 * browser.
 *
 * MONTH STATUS
 * ------------
 *   open   - the working month. Everything can be edited.
 *   locked - closed and frozen. Read-only forever: no recalculation, no
 *            advances/adjustments, no imports, no clearing.
 *
 * Months created before this feature have no `status` field at all. They
 * read as `open`, which is exactly what they were, so NO migration is
 * needed and nothing existing changes behaviour.
 *
 * WHAT CLOSING A MONTH WRITES  (all of it, or none of it)
 * ------------------------------------------------------
 *   1. snapshot  - the frozen OUTPUT: report rows, totals, department
 *                  totals, and the bonus tables actually used.
 *   2. backup    - the frozen INPUT: employees, advances, adjustments,
 *                  departments, settings. Chunked so a big company can't
 *                  hit Firestore's 1 MB per-document limit.
 *   3. summary   - the small `monthly_summaries/{monthId}` index document
 *                  that the Months page, the Archive page and (in a later
 *                  phase) the reports read.
 *   4. audit log - an append-only record of who closed what, when.
 *   5. lock      - `status: 'locked'` on the month document.
 *   6. next month- created as `open` and made the new Active Month.
 *
 * Ordering is deliberate: everything that PRESERVES data is written before
 * anything that RESTRICTS or ADVANCES state. If the browser dies halfway,
 * the worst case is a month that has a snapshot/backup but is still open -
 * i.e. re-runnable - never a locked month whose data was never preserved.
 *
 * WHAT IS *NOT* COPIED
 * --------------------
 * The raw `orderBatches` subcollection. It can hold hundreds of thousands
 * of order rows (far beyond a 1 MB document), it is never deleted when a
 * month closes, and the snapshot already contains everything derived from
 * it. Duplicating it would multiply storage for zero recoverability gain.
 * -----------------------------------------------------------------------
 */

'use strict';

const Months = (() => {

  /* ============================================================
   * CONSTANTS
   * ============================================================ */

  const STATUS = { OPEN: 'open', LOCKED: 'locked' };

  /** The document holding system-wide runtime state (the active month). */
  const SYSTEM_DOC = 'system';

  /**
   * Firestore hard-limits a document to 1 MB and a batch to 500 writes.
   * Backup chunks are sized by ROW COUNT rather than bytes: 300 employee
   * or advance records is comfortably under 1 MB even with long Arabic
   * names and notes, while keeping the number of documents small.
   */
  const BACKUP_CHUNK = 300;

  /** Audit-log action names. Stable strings - they end up stored.
   *
   * Now sourced from AuditService so there is ONE definition of each action
   * string in the codebase. The property names here are unchanged, so every
   * existing reference (`Months.ACTION.MONTH_CLOSED`, the labels in app.js)
   * keeps working exactly as before.
   */
  const ACTION = {
    MONTH_CLOSED: AuditService.ACTION.MONTH_CLOSED,
    ACTIVE_MONTH_CHANGED: AuditService.ACTION.ACTIVE_MONTH_CHANGED,
    MONTH_CREATED: AuditService.ACTION.MONTH_CREATED,
    MONTH_LOCKED: AuditService.ACTION.MONTH_LOCKED,
    MONTH_UNLOCKED: AuditService.ACTION.MONTH_UNLOCKED,
    MONTH_REOPENED: AuditService.ACTION.MONTH_REOPENED,
    MONTH_ARCHIVED: AuditService.ACTION.MONTH_ARCHIVED,
    MONTH_RESTORED: AuditService.ACTION.MONTH_RESTORED,
    MONTH_DELETED: AuditService.ACTION.MONTH_DELETED,
    MONTH_RESET: AuditService.ACTION.MONTH_RESET
  };

  // The final reset is one atomic Firestore batch: deletions plus the new
  // empty month/index documents and its audit entry. Staying below the
  // platform limit means a reset can never leave a half-cleared month.
  const MAX_RESET_DELETE_WRITES = 495;

  /* ============================================================
   * STATE
   * ============================================================ */

  const state = {
    activeMonthId: null,
    // Lightweight index of every month: [{ id, label, status, ... }]
    months: [],
    byId: new Map(),
    unsubSystem: null,
    unsubSummaries: null,
    initialized: false
  };

  const subscribers = [];

  /** Registers a callback fired whenever the month list or active month changes. */
  function onChange(fn) {
    if (typeof fn === 'function') subscribers.push(fn);
  }

  function notify() {
    subscribers.forEach(fn => {
      try { fn(state.months, state.activeMonthId); }
      catch (err) { console.error('Months subscriber failed:', err); }
    });
  }

  /**
   * Surfaces an error to the user when the Toast UI is available.
   *
   * `Toast` is a `const` declared at the bottom of app.js, so a bare
   * `typeof Toast !== 'undefined'` check is not actually safe: while the
   * binding is in its temporal dead zone, `typeof` THROWS rather than
   * returning 'undefined'. In practice everything here runs well after
   * app.js has finished loading, but the try/catch makes that a guarantee
   * instead of a coincidence - a module whose error reporter can itself
   * throw is a bad place to find out.
   */
  function reportError(message) {
    console.error(message);
    try {
      Toast.show(message, 'error');
    } catch (err) {
      /* Toast not ready - the console line above is the fallback. */
    }
  }

  /* ============================================================
   * NORMALIZATION
   * ============================================================ */

  /**
   * Coerces a month summary/report document into the shape the UI relies
   * on. The critical line is the status default: a document written before
   * this feature existed has no `status`, and it must read as OPEN.
   */
  function normalizeMonth(id, data) {
    const d = data || {};
    const totals = (d.totals && typeof d.totals === 'object') ? d.totals : null;

    // employeeCount is stored on the summary, but months backfilled from a
    // very old report document may only have it inside `totals`.
    let employeeCount = Utils.toFiniteNumber(d.employeeCount);
    if (employeeCount === null && totals) {
      employeeCount = Utils.toFiniteNumber(totals.employeeCount);
    }

    return {
      id,
      label: d.monthLabel || Utils.monthLabelFromId(id),
      // Anything that isn't explicitly 'locked' is open. Being conservative
      // in this direction is safe (an open month is editable, which is the
      // pre-existing behaviour); the opposite would silently freeze data.
      status: d.status === STATUS.LOCKED ? STATUS.LOCKED : STATUS.OPEN,
      archived: d.archived === true,
      archivedAt: d.archivedAt || null,
      archivedBy: d.archivedBy || null,
      orderCount: Utils.toFiniteNumber(d.orderCount) ??
        (totals ? Utils.toFiniteNumber(totals.ordersCount) : null),
      isEmpty: d.isEmpty === true,
      employeeCount,
      totals,
      departmentTotals: Array.isArray(d.departmentTotals) ? d.departmentTotals : [],
      calculatedAt: d.calculatedAt || null,
      closedAt: d.closedAt || null,
      closedBy: d.closedBy || null,
      createdAt: d.createdAt || null,
      updatedAt: d.updatedAt || null,
      snapshotId: d.snapshotId || null,
      backupChunks: Utils.toFiniteNumber(d.backupChunks) || 0
    };
  }

  function rebuildIndex(list) {
    // Newest month first - every screen shows months in reverse order.
    state.months = list.sort((a, b) => b.id.localeCompare(a.id));
    state.byId = new Map(state.months.map(m => [m.id, m]));
  }

  /* ============================================================
   * SERVER TIME  (never the device clock)
   * ============================================================ */

  /**
   * Asks Firestore what time it is, by writing `serverTimestamp()` into
   * `settings/system.serverTimeProbe` and reading it straight back.
   *
   * Used ONCE per deployment, to decide the very first active month. After
   * that the active month only ever moves because an admin closed a month
   * (next month = Utils.nextMonthId of the closed one) or picked one
   * explicitly - neither of which needs to know today's date.
   *
   * Returns a Date, or null if the round-trip fails (caller decides what
   * to do; we never silently substitute the device clock).
   */
  async function fetchServerDate() {
    const ref = db.collection(COLLECTIONS.SETTINGS).doc(SYSTEM_DOC);
    try {
      await ref.set(
        { serverTimeProbe: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      // `source: 'server'` matters: with offline persistence enabled a
      // plain get() can be answered from cache, where the pending
      // serverTimestamp is still null (or holds an estimate).
      const snap = await ref.get({ source: 'server' });
      return Utils.toDateSafe(snap.exists ? snap.data().serverTimeProbe : null);
    } catch (err) {
      console.error('fetchServerDate failed:', err);
      return null;
    }
  }

  /* ============================================================
   * ACTIVE MONTH
   * ============================================================ */

  /**
   * Resolves the active month for this deployment, creating it if needed.
   *
   * Resolution order:
   *   1. `settings/system.activeMonthId`, when it is a valid month id.
   *   2. The newest month that already exists (an upgrade of a deployment
   *      that has data but has never had an active month).
   *   3. The server's current month (first run of a brand-new database).
   *
   * Only step 3 involves a date at all, and it comes from the server.
   */
  async function resolveActiveMonthId() {
    const systemRef = db.collection(COLLECTIONS.SETTINGS).doc(SYSTEM_DOC);

    let stored = null;
    try {
      const snap = await systemRef.get();
      if (snap.exists) stored = snap.data().activeMonthId || null;
    } catch (err) {
      console.error('Could not read settings/system:', err);
    }

    if (Utils.isValidMonthId(stored)) {
      // The pointer is valid, but the document it names might not exist -
      // e.g. it was removed in the Firebase console. Recreating it is much
      // better than booting the app with no month selected at all.
      try {
        await ensureMonthExists(stored);
      } catch (err) {
        console.error('Could not ensure the stored active month exists:', err);
      }
      return stored;
    }

    // No active month recorded yet. Adopt the newest existing month so an
    // upgrade lands the admin exactly where they left off.
    if (state.months.length > 0) {
      const newest = state.months[0].id;
      await setActiveMonthId(newest, { silent: true, reason: 'adopted_newest_existing' });
      return newest;
    }

    // Brand-new deployment: ask the SERVER for today.
    const serverDate = await fetchServerDate();
    if (!serverDate) {
      throw new Error(
        'تعذر تحديد الشهر النشط: مفيش اتصال بالسيرفر لمعرفة التاريخ. ' +
        'راجع الاتصال بالإنترنت وحاول تفتح البرنامج تاني.'
      );
    }

    const monthId = Utils.monthIdFromDate(serverDate);
    await setActiveMonthId(monthId, { silent: true, reason: 'initialized_from_server_time' });
    return monthId;
  }

  /**
   * Points the deployment at `monthId`, creating the month document if it
   * doesn't exist yet.
   *
   * A LOCKED month can still be *selected* - the admin needs to be able to
   * open the archive and look at it. What being locked prevents is
   * WRITING, and that is enforced separately (assertEditable + the
   * Firestore rules), not by hiding the month.
   */
  async function setActiveMonthId(monthId, options = {}) {
    if (!Utils.isValidMonthId(monthId)) {
      throw new Error('صيغة الشهر غير صحيحة، استخدم مثال: 2026-09');
    }

    await ensureMonthExists(monthId);
    const target = await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId).get();
    if (target.exists && target.data().archived === true) {
      throw new Error(`شهر ${Utils.monthLabelFromId(monthId)} مؤرشف ولا يمكن جعله الشهر النشط`);
    }

    await db.collection(COLLECTIONS.SETTINGS).doc(SYSTEM_DOC).set({
      activeMonthId: monthId,
      activeMonthUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    state.activeMonthId = monthId;

    // `silent` covers the bootstrap writes: logging "the admin changed the
    // active month" when the app merely initialized itself would be noise
    // in an audit trail that exists to record real decisions.
    if (!options.silent) {
      await writeAuditLog(ACTION.ACTIVE_MONTH_CHANGED, {
        monthId,
        reason: options.reason || 'manual_selection'
      });
    }

    return monthId;
  }

  function activeMonthId() { return state.activeMonthId; }

  /* ============================================================
   * MONTH CREATION
   * ============================================================ */

  /**
   * Creates `monthId` as an OPEN month if it doesn't exist, seeding it
   * with a snapshot of the current pricing settings.
   *
   * The bonus-rules snapshot is the pre-existing behaviour from
   * app.js#createMonthIfNeeded and is preserved exactly: editing Settings
   * later must never retroactively change an existing month.
   *
   * @param {object} seed  optional { bonusRules, carryDebt, departmentBonusRules }
   *                       - defaults are read from the live Settings.
   */
  async function ensureMonthExists(monthId, seed = {}) {
    if (!Utils.isValidMonthId(monthId)) {
      throw new Error('صيغة الشهر غير صحيحة، استخدم مثال: 2026-09');
    }

    const ref = db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId);
    const snap = await ref.get();
    if (snap.exists) return false;

    const resolved = await resolveSeed(seed);

    await ref.set({
      monthLabel: Utils.monthLabelFromId(monthId),
      status: STATUS.OPEN,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      bonusRules: resolved.bonusRules,
      carryDebt: resolved.carryDebt,
      departmentBonusRules: resolved.departmentBonusRules,
      report: [],
      totals: null,
      departmentTotals: [],
      orderCount: 0,
      isEmpty: true,
      archived: false
    });

    // Mirror the new month into the index so the Months page lists it
    // immediately, even before it has ever been calculated.
    await writeSummary(monthId, {
      monthLabel: Utils.monthLabelFromId(monthId),
      status: STATUS.OPEN,
      employeeCount: 0,
      totals: null,
      departmentTotals: [],
      orderCount: 0,
      isEmpty: true,
      archived: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    return true;
  }

  /**
   * Fills in whatever the caller didn't provide from the live Settings and
   * Departments. Kept separate so `ensureMonthExists` reads cleanly and
   * app.js can pass its already-loaded settings to avoid a re-read.
   */
  async function resolveSeed(seed = {}) {
    let bonusRules = seed.bonusRules;
    let carryDebt = seed.carryDebt;

    if (!bonusRules || carryDebt === undefined) {
      try {
        const snap = await db.collection(COLLECTIONS.SETTINGS).doc('general').get();
        const data = snap.exists ? snap.data() : {};
        if (!bonusRules) {
          bonusRules = { ...Utils.DEFAULT_BONUS_RULES, ...(data.bonusRules || {}) };
        }
        if (carryDebt === undefined) {
          carryDebt = (data.carryDebt === undefined)
            ? Utils.DEFAULT_CARRY_DEBT : data.carryDebt !== false;
        }
      } catch (err) {
        console.error('Could not read settings for new month seed:', err);
      }
    }

    let departmentBonusRules = seed.departmentBonusRules;
    if (!departmentBonusRules) {
      departmentBonusRules = {};
      if (typeof Departments !== 'undefined') {
        Departments.all().forEach(d => {
          if (d.bonusRules && typeof d.bonusRules === 'object') {
            departmentBonusRules[d.id] = { ...d.bonusRules };
          }
        });
      }
    }

    return {
      bonusRules: { ...Utils.DEFAULT_BONUS_RULES, ...(bonusRules || {}) },
      carryDebt: carryDebt === undefined ? Utils.DEFAULT_CARRY_DEBT : carryDebt !== false,
      departmentBonusRules
    };
  }

  /* ============================================================
   * STATUS QUERIES
   * ============================================================ */

  function all() { return state.months; }
  function byId(id) { return id ? (state.byId.get(id) || null) : null; }
  function locked() { return state.months.filter(m => m.status === STATUS.LOCKED); }
  function open() { return state.months.filter(m => m.status === STATUS.OPEN); }
  function active() { return state.months.filter(m => !m.archived); }

  /**
   * Whether a month is locked.
   *
   * A month the index hasn't heard of is treated as NOT locked: it is
   * either brand new or still loading, and refusing to write to a month
   * merely because the listener hasn't caught up would break normal use.
   * The Firestore rules are the backstop that makes this safe - they read
   * the real document, not this cache.
   */
  function isLocked(monthId) {
    const m = byId(monthId);
    return !!m && m.status === STATUS.LOCKED;
  }

  function isArchived(monthId) {
    const m = byId(monthId);
    return !!m && m.archived === true;
  }

  function isOpen(monthId) { return !isLocked(monthId); }

  /**
   * Throws a human-readable Arabic error when `monthId` cannot be written
   * to. Every mutating flow in the app funnels through this, so there is
   * exactly one place that decides what "editable" means.
   */
  function assertEditable(monthId, actionLabel = 'التعديل') {
    if (!monthId) throw new Error('مفيش شهر محدد');
    if (isLocked(monthId)) {
      throw new Error(
        `شهر ${Utils.monthLabelFromId(monthId)} مقفول، و${actionLabel} مش مسموح فيه. ` +
        'الشهور المقفولة للعرض فقط من صفحة الأرشيف.'
      );
    }
    if (isArchived(monthId)) {
      throw new Error(`شهر ${Utils.monthLabelFromId(monthId)} مؤرشف، و${actionLabel} مش مسموح فيه.`);
    }
    return true;
  }

  /**
   * Guard for RECALCULATION specifically.
   *
   * Recalculating a month rewrites its `carriedDebt`, which is the exact
   * figure the FOLLOWING month deducts as `previousDebt`. If that next
   * month is locked it can no longer absorb the correction, so the two
   * months would permanently disagree. Blocking here is what keeps the
   * debt chain honest across a lock boundary.
   */
  function assertRecalculable(monthId) {
    assertEditable(monthId, 'الحساب');

    const nextId = Utils.nextMonthId(monthId);
    if (nextId && isLocked(nextId)) {
      throw new Error(
        `مش ممكن تعيد حساب ${Utils.monthLabelFromId(monthId)} لأن شهر ` +
        `${Utils.monthLabelFromId(nextId)} مقفول وبيعتمد على الديون المرحّلة منه. ` +
        'إعادة الحساب هتخلي الرقمين مختلفين.'
      );
    }
    return true;
  }

  /* ============================================================
   * SUMMARY INDEX  (monthly_summaries)
   * ============================================================ */

  /**
   * Upserts the month's index document. Deliberately small: status,
   * label, totals and the per-department summary - never the per-employee
   * rows, which is the whole reason this collection exists.
   */
  async function writeSummary(monthId, payload) {
    if (!Utils.isValidMonthId(monthId)) return;
    await db.collection(COLLECTIONS.MONTHLY_SUMMARIES).doc(monthId)
      .set(payload, { merge: true });
  }

  /**
   * Recomputes the index entry for a month from its report document.
   * Called after every calculation so the Months page dashboard stays in
   * step with the report without anyone having to close the month first.
   */
  async function refreshSummary(monthId, monthData) {
    if (!Utils.isValidMonthId(monthId)) return;

    let data = monthData;
    if (!data) {
      const snap = await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId).get();
      if (!snap.exists) return;
      data = snap.data() || {};
    }

    const report = Array.isArray(data.report) ? data.report : [];
    const totals = (data.totals && typeof data.totals === 'object')
      ? data.totals
      : (report.length > 0 ? Reports.computeTotals(report) : null);

    await writeSummary(monthId, {
      monthLabel: data.monthLabel || Utils.monthLabelFromId(monthId),
      status: data.status === STATUS.LOCKED ? STATUS.LOCKED : STATUS.OPEN,
      archived: data.archived === true,
      archivedAt: data.archivedAt || null,
      archivedBy: data.archivedBy || null,
      orderCount: Utils.toFiniteNumber(data.orderCount) ??
        (totals ? Utils.toFiniteNumber(totals.ordersCount) : null),
      isEmpty: data.isEmpty === true,
      employeeCount: report.length,
      totals: totals || null,
      departmentTotals: Array.isArray(data.departmentTotals) ? data.departmentTotals : [],
      calculatedAt: data.calculatedAt || null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  /* ============================================================
   * AUDIT LOG  (append-only)
   * ------------------------------------------------------------
   * These three functions are now thin wrappers over AuditService, which
   * owns the entry shape, the severity table and the queries. They are kept
   * because every existing caller in the app goes through
   * `Months.writeAuditLog(...)`, and because a month's audit trail is
   * genuinely part of the month lifecycle this module owns.
   *
   * AuditService assigns severity from the action itself (closing a month is
   * critical, creating one is informational), so callers never pass it in and
   * can't accidentally log an irreversible action as routine.
   * ============================================================ */

  /**
   * Appends an audit record for a month-lifecycle event.
   *
   * Best-effort by design: a failure to write the trail must never abort or
   * roll back the business action it describes, so this resolves even on
   * error. That asymmetry is safe HERE because these events are lifecycle
   * facts logged after they happened - the document writes that change
   * payroll data go through DataLayer, where the audit entry shares the
   * business write's batch and cannot be lost independently.
   */
  async function writeAuditLog(action, details = {}) {
    return AuditService.log(action, {
      entity: 'months',
      // The month id travels both at the top level and inside `details`,
      // which is what keeps the pre-existing `details.monthId` query (and its
      // deployed composite index) working unchanged.
      monthId: details.monthId || null,
      documentId: details.monthId || null,
      documentLabel: details.monthLabel ||
        (details.monthId ? Utils.monthLabelFromId(details.monthId) : null),
      details
    });
  }

  /** The most recent audit entries, newest first. */
  async function recentAuditLogs(limit = 50) {
    return AuditService.getRecent(limit);
  }

  /** Audit entries that mention one month, newest first. */
  async function auditLogsForMonth(monthId, limit = 20) {
    return AuditService.getForMonth(monthId, limit);
  }

  /* ============================================================
   * SNAPSHOT  (the frozen OUTPUT of a month)
   * ============================================================ */

  /**
   * Writes an immutable copy of everything the month PRODUCED: the report
   * rows, the totals, the department summary, and the bonus tables the
   * calculation actually used.
   *
   * Returns the snapshot document id.
   */
  async function createSnapshot(monthId, monthData) {
    const report = Array.isArray(monthData.report) ? monthData.report : [];
    const totals = (monthData.totals && typeof monthData.totals === 'object')
      ? monthData.totals
      : Reports.computeTotals(report);

    const ref = db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId)
      .collection(MONTH_SUBCOLLECTIONS.SNAPSHOTS).doc();

    await ref.set({
      monthId,
      monthLabel: monthData.monthLabel || Utils.monthLabelFromId(monthId),
      report,
      totals,
      departmentTotals: Array.isArray(monthData.departmentTotals)
        ? monthData.departmentTotals : [],
      // The exact pricing context this month was computed under, so the
      // snapshot is self-explanatory years later.
      bonusRules: monthData.bonusRules || null,
      departmentBonusRules: monthData.departmentBonusRules || null,
      carryDebt: monthData.carryDebt !== false,
      employeeCount: report.length,
      calculatedAt: monthData.calculatedAt || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    return ref.id;
  }

  /* ============================================================
   * BACKUP  (the frozen INPUT of a month)
   * ============================================================ */

  /**
   * Writes an immutable copy of everything the month was CALCULATED FROM:
   * the employee records, that month's advances and adjustments, the
   * department definitions and the global settings.
   *
   * Split across chunk documents (BACKUP_CHUNK rows each) because a single
   * Firestore document is capped at 1 MB - a few hundred employees with
   * notes would eventually exceed it, and a backup that silently fails to
   * write once the company grows is worse than no backup at all.
   *
   * Returns the number of chunk documents written.
   */
  async function createBackup(monthId, sources = {}) {
    const backupsRef = db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId)
      .collection(MONTH_SUBCOLLECTIONS.BACKUPS);

    const employees = Array.isArray(sources.employees) ? sources.employees : [];
    const advances = (Array.isArray(sources.advances) ? sources.advances : [])
      .filter(a => a && a.monthId === monthId);
    const adjustments = (Array.isArray(sources.adjustments) ? sources.adjustments : [])
      .filter(a => a && a.monthId === monthId);
    const departments = Array.isArray(sources.departments) ? sources.departments : [];

    let chunkIndex = 0;

    /** Writes one { kind, index, items } document per chunk of `items`. */
    async function writeChunks(kind, items) {
      if (items.length === 0) return;
      for (let i = 0; i < items.length; i += BACKUP_CHUNK) {
        await backupsRef.doc(`${kind}-${String(chunkIndex).padStart(4, '0')}`).set({
          monthId,
          kind,
          index: chunkIndex,
          items: items.slice(i, i + BACKUP_CHUNK),
          count: Math.min(BACKUP_CHUNK, items.length - i),
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        chunkIndex += 1;
      }
    }

    await writeChunks('employees', employees);
    await writeChunks('advances', advances);
    await writeChunks('adjustments', adjustments);
    await writeChunks('departments', departments);

    // Settings are a single small object - one manifest document carries
    // them plus the shape of the backup, so a restore knows what to read.
    await backupsRef.doc('manifest').set({
      monthId,
      kind: 'manifest',
      settings: sources.settings || null,
      counts: {
        employees: employees.length,
        advances: advances.length,
        adjustments: adjustments.length,
        departments: departments.length
      },
      chunkCount: chunkIndex,
      chunkSize: BACKUP_CHUNK,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    return chunkIndex + 1; // + the manifest
  }

  /* ============================================================
   * CLOSE MONTH  (the whole point of this module)
   * ============================================================ */

  /**
   * Closes `monthId` and rolls the deployment forward to the next month.
   *
   * Steps, in this order on purpose - preserve, then restrict, then
   * advance - so an interruption can only ever leave a re-runnable state:
   *
   *   1. validate (not already locked, has a calculated report)
   *   2. snapshot     (frozen output)
   *   3. backup       (frozen input)
   *   4. summary      (the index/Monthly Summary used by later reports)
   *   5. audit log
   *   6. lock         (status: 'locked')
   *   7. create the next month as open, and make it the Active Month
   *
   * @param {string} monthId
   * @param {object} sources  live data to back up:
   *                 { employees, advances, adjustments, departments, settings }
   * @returns {Promise<{monthId, nextMonthId, snapshotId, backupChunks, employeeCount}>}
   */
  async function closeMonth(monthId, sources = {}) {
    if (!Utils.isValidMonthId(monthId)) {
      throw new Error('صيغة الشهر غير صحيحة');
    }

    const monthRef = db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId);
    const snap = await monthRef.get();
    if (!snap.exists) {
      throw new Error(`شهر ${Utils.monthLabelFromId(monthId)} مش موجود`);
    }

    const monthData = snap.data() || {};

    // Re-read status from the DOCUMENT, not the cached index: two admins
    // could be closing the same month at the same moment.
    if (monthData.status === STATUS.LOCKED) {
      throw new Error(`شهر ${Utils.monthLabelFromId(monthId)} مقفول بالفعل`);
    }

    const report = Array.isArray(monthData.report) ? monthData.report : [];
    if (report.length === 0) {
      throw new Error(
        `مش ممكن تقفل ${Utils.monthLabelFromId(monthId)} قبل حساب التقرير. ` +
        'افتح "التقرير الشهري" واضغط "حساب" الأول.'
      );
    }

    // ---- 2. Snapshot: the frozen output ----
    const snapshotId = await createSnapshot(monthId, monthData);

    // ---- 3. Backup: the frozen input ----
    const backupChunks = await createBackup(monthId, sources);

    // ---- 3b. System-wide restorable backup ----
    //
    // Distinct from the per-month backup above. That one freezes THIS month's
    // inputs under the month document as evidence and is never restored; this
    // one is a point-in-time copy of the whole live database that CAN be
    // restored from the Backups page.
    //
    // Taken here - after the data is preserved, before the month is locked -
    // because it is the last moment the pre-close state exists. Best-effort:
    // `createAutomaticBackup` never throws, so a backup failure can't strand
    // a month that has already been snapshotted, and the outcome is recorded
    // on the close's own audit entry either way.
    let systemBackupId = null;
    try {
      const systemBackup = await BackupService.createAutomaticBackup(
        BackupService.TRIGGER.MONTH_CLOSE,
        {
          monthId,
          name: `قبل إنهاء ${monthData.monthLabel || Utils.monthLabelFromId(monthId)}`,
          note: 'نسخة تلقائية للبيانات الحيّة قبل قفل الشهر'
        }
      );
      systemBackupId = systemBackup ? systemBackup.id : null;
    } catch (err) {
      // Defensive: createAutomaticBackup swallows its own errors, so reaching
      // here means something unexpected. Still must not block the close.
      console.error('System backup before close failed:', err);
    }

    const totals = (monthData.totals && typeof monthData.totals === 'object')
      ? monthData.totals
      : Reports.computeTotals(report);

    // ---- 4. Monthly Summary (the index later reporting phases read) ----
    await writeSummary(monthId, {
      monthLabel: monthData.monthLabel || Utils.monthLabelFromId(monthId),
      status: STATUS.LOCKED,
      employeeCount: report.length,
      totals,
      departmentTotals: Array.isArray(monthData.departmentTotals)
        ? monthData.departmentTotals : [],
      calculatedAt: monthData.calculatedAt || null,
      closedAt: firebase.firestore.FieldValue.serverTimestamp(),
      closedBy: (typeof auth !== 'undefined' && auth.currentUser)
        ? auth.currentUser.email : null,
      snapshotId,
      backupChunks,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // ---- 5. Audit log ----
    await writeAuditLog(ACTION.MONTH_CLOSED, {
      monthId,
      monthLabel: monthData.monthLabel || Utils.monthLabelFromId(monthId),
      employeeCount: report.length,
      finalSalaryTotal: totals ? (totals.finalSalary || 0) : 0,
      carriedDebtTotal: totals ? (totals.carriedDebt || 0) : 0,
      snapshotId,
      backupChunks,
      // Whether the pre-close system backup succeeded is part of the record:
      // it answers "could this close have been recovered from?" later.
      systemBackupId,
      systemBackupCreated: !!systemBackupId,
      // Smart Approval is assessed before this close flow and never writes by
      // itself. Persist its compact outcome with the existing close audit so
      // the approval decision remains explainable without a new collection.
      smartApproval: sources.smartApproval || null
    });

    // ---- 6. Lock. Nothing above this line can be undone by it. ----
    await monthRef.set({
      status: STATUS.LOCKED,
      closedAt: firebase.firestore.FieldValue.serverTimestamp(),
      closedBy: (typeof auth !== 'undefined' && auth.currentUser)
        ? auth.currentUser.email : null,
      snapshotId,
      backupChunks
    }, { merge: true });

    // ---- 7. Next month, open, and now active ----
    // Derived from the CLOSED month, never from a clock: closing August
    // always opens September even if the calendar has moved on.
    const nextId = Utils.nextMonthId(monthId);
    if (nextId) {
      const created = await ensureMonthExists(nextId, {
        bonusRules: sources.settings ? sources.settings.bonusRules : undefined,
        carryDebt: sources.settings ? sources.settings.carryDebt : undefined
      });
      if (created) {
        await writeAuditLog(ACTION.MONTH_CREATED, {
          monthId: nextId,
          monthLabel: Utils.monthLabelFromId(nextId),
          reason: 'auto_created_on_close',
          previousMonthId: monthId
        });
      }
      await setActiveMonthId(nextId, { silent: true, reason: 'auto_advanced_on_close' });
    }

    return {
      monthId,
      nextMonthId: nextId,
      snapshotId,
      backupChunks,
      systemBackupId,
      employeeCount: report.length,
      totals
    };
  }

  /**
   * Reopens an approved month without touching its report, snapshots,
   * backups, or summary contents. The Firestore Rules permit only this
   * exact locked-to-open status transition for an administrator.
   */
  async function reopenMonth(monthId, action = ACTION.MONTH_REOPENED) {
    if (!Utils.isValidMonthId(monthId)) {
      throw new Error('صيغة الشهر غير صحيحة');
    }

    const monthRef = db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId);
    const snap = await monthRef.get();
    if (!snap.exists) {
      throw new Error(`شهر ${Utils.monthLabelFromId(monthId)} غير موجود`);
    }
    const monthData = snap.data() || {};
    const wasLocked = monthData.status === STATUS.LOCKED;

    // Legacy documents could have been indexed as locked before their own
    // `status` write was denied. Normalize the authoritative report document
    // and the archive index together so both flows use the same lifecycle
    // field. For an already-open document, no report write is necessary.
    if (wasLocked) {
      // This is deliberately the only write to a locked month document. The
      // rule for reopening rejects a request that changes any other field.
      await monthRef.update({ status: STATUS.OPEN });
    } else if (monthData.status !== STATUS.OPEN) {
      await monthRef.set({ status: STATUS.OPEN }, { merge: true });
    }

    // Keep the lightweight archive/index status in sync after the month is
    // open again. This retains the existing summary document and all of its
    // data; only its lifecycle status is refreshed from the month document.
    await refreshSummary(monthId, { ...monthData, status: STATUS.OPEN });

    const indexed = state.byId.get(monthId);
    if (indexed) indexed.status = STATUS.OPEN;
    notify();
    await writeAuditLog(action, {
      monthId,
      monthLabel: monthData.monthLabel || Utils.monthLabelFromId(monthId),
      previousStatus: wasLocked ? STATUS.LOCKED : (monthData.status || STATUS.OPEN),
      status: STATUS.OPEN
    });
    return { monthId, wasLocked };
  }

  /** Marks an open, non-active month as archived. Archived months remain
   * visible and readable but cannot receive imports or other edits. */
  async function archiveMonth(monthId) {
    if (!Utils.isValidMonthId(monthId)) throw new Error('صيغة الشهر غير صحيحة');
    if (monthId === activeMonthId()) throw new Error('لا يمكن أرشفة الشهر النشط. فعّل شهرًا آخر أولًا.');

    const monthRef = db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId);
    const summaryRef = db.collection(COLLECTIONS.MONTHLY_SUMMARIES).doc(monthId);
    await db.runTransaction(async transaction => {
      const snap = await transaction.get(monthRef);
      if (!snap.exists) throw new Error('الشهر غير موجود');
      const data = snap.data() || {};
      if (data.status === STATUS.LOCKED) throw new Error('الشهر المعتمد محفوظ بالفعل في الأرشيف ولا يحتاج أرشفة إضافية');
      if (data.archived === true) throw new Error('الشهر مؤرشف بالفعل');
      const fields = {
        archived: true,
        archivedAt: firebase.firestore.FieldValue.serverTimestamp(),
        archivedBy: auth.currentUser ? (auth.currentUser.email || null) : null
      };
      transaction.update(monthRef, fields);
      transaction.set(summaryRef, fields, { merge: true });
      AuditService.appendToBatch(transaction, {
        action: ACTION.MONTH_ARCHIVED, entity: 'months', operation: AuditService.OPERATION.UPDATE,
        documentId: monthId, documentLabel: data.monthLabel || Utils.monthLabelFromId(monthId), monthId,
        before: { archived: false }, after: { archived: true }, details: { monthId }
      });
    });
  }

  /** Restores an archived, still-open month to the normal working list. */
  async function restoreArchivedMonth(monthId) {
    if (!Utils.isValidMonthId(monthId)) throw new Error('صيغة الشهر غير صحيحة');
    const monthRef = db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId);
    const summaryRef = db.collection(COLLECTIONS.MONTHLY_SUMMARIES).doc(monthId);
    await db.runTransaction(async transaction => {
      const snap = await transaction.get(monthRef);
      if (!snap.exists) throw new Error('الشهر غير موجود');
      const data = snap.data() || {};
      if (data.status === STATUS.LOCKED) throw new Error('استخدم إعادة فتح التقرير للشهر المعتمد');
      if (data.archived !== true) throw new Error('الشهر غير مؤرشف بالفعل');
      const fields = {
        archived: false,
        archivedAt: firebase.firestore.FieldValue.delete(),
        archivedBy: firebase.firestore.FieldValue.delete()
      };
      transaction.update(monthRef, fields);
      transaction.set(summaryRef, fields, { merge: true });
      AuditService.appendToBatch(transaction, {
        action: ACTION.MONTH_RESTORED, entity: 'months', operation: AuditService.OPERATION.UPDATE,
        documentId: monthId, documentLabel: data.monthLabel || Utils.monthLabelFromId(monthId), monthId,
        before: { archived: true }, after: { archived: false }, details: { monthId }
      });
    });
  }

  /** Deletes only a genuinely empty month. The transaction re-checks the
   * parent state so an import starting concurrently causes a retry and fails
   * safely instead of deleting its month. */
  async function deleteEmptyMonth(monthId) {
    if (!Utils.isValidMonthId(monthId)) throw new Error('صيغة الشهر غير صحيحة');
    if (monthId === activeMonthId()) throw new Error('لا يمكن حذف الشهر النشط. فعّل شهرًا آخر أولًا.');
    const monthRef = db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId);
    const summaryRef = db.collection(COLLECTIONS.MONTHLY_SUMMARIES).doc(monthId);
    const firstBatch = await monthRef.collection(MONTH_SUBCOLLECTIONS.ORDER_BATCHES).limit(1).get();
    if (!firstBatch.empty) throw new Error('لا يمكن حذف شهر يحتوي على طلبات');

    await db.runTransaction(async transaction => {
      const [monthSnap, summarySnap] = await Promise.all([
        transaction.get(monthRef), transaction.get(summaryRef)
      ]);
      if (!monthSnap.exists) throw new Error('الشهر غير موجود');
      const data = monthSnap.data() || {};
      const report = Array.isArray(data.report) ? data.report : [];
      if (data.status === STATUS.LOCKED || data.archived === true) throw new Error('لا يمكن حذف شهر مقفول أو مؤرشف');
      if (data.isEmpty === false || report.length > 0 || (Utils.toFiniteNumber(data.orderCount) || 0) > 0) {
        throw new Error('لا يمكن حذف شهر يحتوي على بيانات');
      }
      transaction.delete(monthRef);
      if (summarySnap.exists) transaction.delete(summaryRef);
      AuditService.appendToBatch(transaction, {
        action: ACTION.MONTH_DELETED, entity: 'months', operation: AuditService.OPERATION.DELETE,
        documentId: monthId, documentLabel: data.monthLabel || Utils.monthLabelFromId(monthId), monthId,
        before: { status: data.status || STATUS.OPEN, orderCount: data.orderCount || 0 }, details: { monthId }
      });
    });
  }

  /* ============================================================
   * RESET MONTH
   * ============================================================ */

  function previousMonthId(monthId) {
    const [year, month] = String(monthId).split('-').map(Number);
    if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
    return month === 1
      ? `${String(year - 1).padStart(4, '0')}-12`
      : `${String(year).padStart(4, '0')}-${String(month - 1).padStart(2, '0')}`;
  }

  function snapshotRows(snap) {
    return snap.docs.map(doc => ({ id: doc.id, data: ServiceCommon.plainClone(doc.data() || {}) }));
  }

  function sameRows(left, right) {
    return ServiceCommon.stableStringify(left) === ServiceCommon.stableStringify(right);
  }

  /**
   * Reads exactly the reset scope. Manual adjustments and advances are read
   * only for the post-reset integrity check; they are never queued for
   * deletion. Previous debt remains sourced from the preceding month report
   * and is likewise only compared, never changed.
   */
  async function readMonthResetScope(monthId) {
    const monthRef = db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId);
    const summaryRef = db.collection(COLLECTIONS.MONTHLY_SUMMARIES).doc(monthId);
    const previousId = previousMonthId(monthId);
    const previousRef = previousId
      ? db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(previousId)
      : null;

    const [monthSnap, summarySnap, orderBatchesSnap, snapshotsSnap, monthBackupsSnap,
      advancesSnap, adjustmentsSnap, previousSnap] = await Promise.all([
      monthRef.get(),
      summaryRef.get(),
      monthRef.collection(MONTH_SUBCOLLECTIONS.ORDER_BATCHES).get(),
      monthRef.collection(MONTH_SUBCOLLECTIONS.SNAPSHOTS).get(),
      monthRef.collection(MONTH_SUBCOLLECTIONS.BACKUPS).get(),
      db.collection(COLLECTIONS.ADVANCES).where('monthId', '==', monthId).get(),
      db.collection(COLLECTIONS.ADJUSTMENTS).where('monthId', '==', monthId).get(),
      previousRef ? previousRef.get() : Promise.resolve(null)
    ]);

    if (!monthSnap.exists) throw new Error(`شهر ${Utils.monthLabelFromId(monthId)} غير موجود`);
    const monthData = monthSnap.data() || {};
    if (monthData.status === STATUS.LOCKED) {
      throw new Error('لا يمكن إفراغ شهر معتمد/مقفل. أعد فتحه أولًا.');
    }
    if (monthData.archived === true) {
      throw new Error('لا يمكن إفراغ شهر مؤرشف. ألغِ أرشفته أولًا.');
    }

    const orderBatches = snapshotRows(orderBatchesSnap);
    return {
      monthId,
      monthRef,
      summaryRef,
      month: {
        id: monthSnap.id,
        // Reset writes a reconstructed value, not the SDK object returned by
        // this read.  A Timestamp object from a different compat-SDK realm
        // looks timestamp-like but is rejected by the active Firestore
        // client ("Expected type 'Ju'...").  The tagged clone is revived
        // below through the active client's Timestamp constructor.
        data: ServiceCommon.plainClone(monthData)
      },
      summary: summarySnap.exists
        ? {
          id: summarySnap.id,
          data: ServiceCommon.plainClone(summarySnap.data() || {})
        }
        : null,
      orderBatches,
      snapshots: snapshotRows(snapshotsSnap),
      monthBackups: snapshotRows(monthBackupsSnap),
      manualAdvances: snapshotRows(advancesSnap),
      manualAdjustments: snapshotRows(adjustmentsSnap),
      previousDebtSource: previousSnap && previousSnap.exists
        ? {
          monthId: previousId,
          debts: Utils.carriedDebtMap((previousSnap.data() || {}).report || [])
        }
        : { monthId: previousId, debts: {} }
    };
  }

  function emptyMonthDocument(monthId, before) {
    const createdAt = before && before.createdAt
      ? ServiceCommon.reviveClone(before.createdAt)
      : firebase.firestore.FieldValue.serverTimestamp();
    return {
      monthLabel: before.monthLabel || Utils.monthLabelFromId(monthId),
      status: STATUS.OPEN,
      archived: false,
      createdAt,
      bonusRules: before.bonusRules || { ...Utils.DEFAULT_BONUS_RULES },
      carryDebt: before.carryDebt !== false,
      departmentBonusRules: before.departmentBonusRules || {},
      report: [],
      totals: null,
      departmentTotals: [],
      orderCount: 0,
      employeeCount: 0,
      isEmpty: true,
      calculatedAt: null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
  }

  function emptyMonthSummary(monthId, scope) {
    const before = (scope.month && scope.month.data) || {};
    const originalCreatedAt = (scope.summary && scope.summary.data && scope.summary.data.createdAt)
      || before.createdAt
      || firebase.firestore.FieldValue.serverTimestamp();
    return {
      monthLabel: before.monthLabel || Utils.monthLabelFromId(monthId),
      status: STATUS.OPEN,
      archived: false,
      orderCount: 0,
      employeeCount: 0,
      isEmpty: true,
      totals: null,
      departmentTotals: [],
      createdAt: ServiceCommon.reviveClone(originalCreatedAt),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
  }

  /** Reads the committed state after a reset and proves both the cleared and
   * preserved sides of its contract. */
  async function verifyMonthReset(monthId, before) {
    const monthRef = db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId);
    const summaryRef = db.collection(COLLECTIONS.MONTHLY_SUMMARIES).doc(monthId);
    const previousId = before.previousDebtSource.monthId;
    const [monthSnap, summarySnap, batchesSnap, snapshotsSnap, advancesSnap,
      adjustmentsSnap, previousSnap] = await Promise.all([
      monthRef.get(),
      summaryRef.get(),
      monthRef.collection(MONTH_SUBCOLLECTIONS.ORDER_BATCHES).get(),
      monthRef.collection(MONTH_SUBCOLLECTIONS.SNAPSHOTS).get(),
      db.collection(COLLECTIONS.ADVANCES).where('monthId', '==', monthId).get(),
      db.collection(COLLECTIONS.ADJUSTMENTS).where('monthId', '==', monthId).get(),
      previousId ? db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(previousId).get() : Promise.resolve(null)
    ]);

    const errors = [];
    const month = monthSnap.exists ? (monthSnap.data() || {}) : null;
    const summary = summarySnap.exists ? (summarySnap.data() || {}) : null;
    if (!month || !Array.isArray(month.report) || month.report.length !== 0 || month.totals !== null ||
        !Array.isArray(month.departmentTotals) || month.departmentTotals.length !== 0 ||
        month.orderCount !== 0 || month.isEmpty !== true) errors.push('monthly_report');
    if (!summary || summary.totals !== null || summary.orderCount !== 0 ||
        summary.employeeCount !== 0 || summary.isEmpty !== true) errors.push('monthly_summary');
    if (!batchesSnap.empty) errors.push('order_batches');
    if (!snapshotsSnap.empty) errors.push('snapshots');
    if (!sameRows(before.manualAdvances, snapshotRows(advancesSnap))) errors.push('advances_changed');
    if (!sameRows(before.manualAdjustments, snapshotRows(adjustmentsSnap))) errors.push('adjustments_changed');

    const previousDebts = previousSnap && previousSnap.exists
      ? Utils.carriedDebtMap((previousSnap.data() || {}).report || [])
      : {};
    if (ServiceCommon.stableStringify(before.previousDebtSource.debts) !==
        ServiceCommon.stableStringify(previousDebts)) errors.push('previous_debts_changed');

    if (errors.length) {
      throw new Error(`اكتمل الحفظ لكن فشل تحقق Reset: ${errors.join(', ')}`);
    }

    return {
      verified: true,
      orders: 0,
      orderBatches: 0,
      snapshots: 0,
      manualAdvances: before.manualAdvances.length,
      manualAdjustments: before.manualAdjustments.length,
      previousDebtSource: previousId || null
    };
  }

  /**
   * Resets only imported orders and calculated month output. The target
   * month document and its lightweight index are overwritten with fresh,
   * empty documents so the month remains selectable and immediately ready
   * for a new Excel import. Manual financial inputs are intentionally not
   * part of the write batch.
   */
  async function resetMonth(monthId) {
    if (!Utils.isValidMonthId(monthId)) throw new Error('صيغة الشهر غير صحيحة');

    const scope = await readMonthResetScope(monthId);
    const deletions = [
      ...scope.orderBatches.map(record => ({ ...record, subcollection: MONTH_SUBCOLLECTIONS.ORDER_BATCHES })),
      ...scope.snapshots.map(record => ({ ...record, subcollection: MONTH_SUBCOLLECTIONS.SNAPSHOTS })),
      ...scope.monthBackups.map(record => ({ ...record, subcollection: MONTH_SUBCOLLECTIONS.BACKUPS }))
    ];
    if (deletions.length > MAX_RESET_DELETE_WRITES) {
      throw new Error('هذا الشهر يحتوي على عدد كبير من المستندات ولا يمكن إفراغه بأمان في عملية ذرّية واحدة. لم تُحذف أي بيانات.');
    }

    // Mandatory and intentionally outside the final batch: if a network or
    // permission failure prevents the backup manifest from completing, this
    // function throws here and no month data has been changed yet.
    let backup;
    try {
      backup = await BackupService.createMonthResetBackup(monthId, scope);
    } catch (err) {
      throw new Error(`تعذر إنشاء نسخة Reset الاحتياطية: ${err.message}`);
    }

    const orderCount = scope.orderBatches.reduce((sum, batch) => {
      const orders = Array.isArray(batch.data.orders) ? batch.data.orders : [];
      return sum + orders.length;
    }, 0);
    // The web SDK transaction API accepts document references only; passing
    // a subcollection Query here throws its internal "Expected type 'Ju'"
    // error before the transaction callback runs. Re-read the query-backed
    // scope immediately before the atomic write, then keep the transaction
    // to document reads/writes only.
    const currentScope = await readMonthResetScope(monthId);
    const scopeChanged = !sameRows(
      [{ id: scope.month.id, data: scope.month.data }],
      [{ id: currentScope.month.id, data: currentScope.month.data }]
    ) ||
      !sameRows(scope.orderBatches, currentScope.orderBatches) ||
      !sameRows(scope.snapshots, currentScope.snapshots) ||
      !sameRows(scope.monthBackups, currentScope.monthBackups) ||
      !sameRows(scope.manualAdvances, currentScope.manualAdvances) ||
      !sameRows(scope.manualAdjustments, currentScope.manualAdjustments) ||
      JSON.stringify(scope.previousDebtSource) !== JSON.stringify(currentScope.previousDebtSource);
    if (scopeChanged) {
      throw new Error('تغيرت بيانات الشهر أثناء تجهيز Reset. لم تُحذف أي بيانات؛ أعد المحاولة.');
    }

    await db.runTransaction(async transaction => {
      // Re-read every deleted document inside the transaction. An import,
      // calculation or close that starts after the backup therefore makes
      // the transaction retry/fail before any delete is committed.
      const [currentMonth, currentSummary] = await Promise.all([
        transaction.get(scope.monthRef),
        transaction.get(scope.summaryRef)
      ]);
      if (!currentMonth.exists || !sameRows(
        [{ id: scope.month.id, data: scope.month.data }],
        [{ id: currentMonth.id, data: ServiceCommon.plainClone(currentMonth.data() || {}) }]
      )) {
        throw new Error('تغيرت بيانات الشهر أثناء تجهيز Reset. لم تُحذف أي بيانات؛ أعد المحاولة.');
      }
      const expectedSummary = scope.summary
        ? [{ id: scope.summary.id, data: scope.summary.data }]
        : [];
      const actualSummary = currentSummary.exists
        ? [{ id: currentSummary.id, data: ServiceCommon.plainClone(currentSummary.data() || {}) }]
        : [];
      if (!sameRows(expectedSummary, actualSummary)) {
        throw new Error('تغيرت بيانات الاستيراد أو الحساب أثناء تجهيز Reset. لم تُحذف أي بيانات؛ أعد المحاولة.');
      }

      deletions.forEach(record => {
        transaction.delete(scope.monthRef.collection(record.subcollection).doc(record.id));
      });
      const resetMonthData = emptyMonthDocument(monthId, scope.month.data);
      transaction.set(scope.monthRef, resetMonthData);
      const resetSummaryData = emptyMonthSummary(monthId, scope);
      transaction.set(scope.summaryRef, resetSummaryData);
      AuditService.appendToBatch(transaction, {
        action: ACTION.MONTH_RESET,
        entity: 'months',
        operation: AuditService.OPERATION.DELETE,
        documentId: monthId,
        documentLabel: scope.month.data.monthLabel || Utils.monthLabelFromId(monthId),
        monthId,
        before: {
          orderBatches: scope.orderBatches.length,
          snapshots: scope.snapshots.length,
          monthBackups: scope.monthBackups.length,
          orderCount
        },
        after: { orderBatches: 0, snapshots: 0, orderCount: 0, report: [] },
        details: {
          monthId,
          backupId: backup.id,
          deleted: {
            orders: orderCount,
            orderBatches: scope.orderBatches.length,
            monthlyReport: true,
            monthlySummary: true,
            snapshots: scope.snapshots.length,
            monthlyBackups: scope.monthBackups.length,
            calculatedData: true
          },
          preserved: {
            advances: scope.manualAdvances.length,
            manualAdjustments: scope.manualAdjustments.length,
            previousDebtSource: scope.previousDebtSource.monthId || null
          }
        }
      });
    });

    const verification = await verifyMonthReset(monthId, scope);
    return { monthId, backupId: backup.id, orderCount, verification };
  }

  /* ============================================================
   * ARCHIVE READS
   * ============================================================ */

  /**
   * Loads a locked month for VIEWING: the stored report rows, totals and
   * department summary, straight from the month document.
   *
   * Reads the live month document rather than the snapshot because they
   * are identical at close time - and the month document is what every
   * existing renderer in the app already understands, so the archive
   * reuses the report table verbatim instead of duplicating it.
   */
  async function loadMonthDetails(monthId) {
    if (!Utils.isValidMonthId(monthId)) return null;
    const snap = await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId).get();
    if (!snap.exists) return null;

    const data = snap.data() || {};
    return {
      id: monthId,
      label: data.monthLabel || Utils.monthLabelFromId(monthId),
      status: data.status === STATUS.LOCKED ? STATUS.LOCKED : STATUS.OPEN,
      report: Array.isArray(data.report) ? data.report : [],
      totals: (data.totals && typeof data.totals === 'object') ? data.totals : null,
      departmentTotals: Array.isArray(data.departmentTotals) ? data.departmentTotals : [],
      bonusRules: data.bonusRules || null,
      departmentBonusRules: data.departmentBonusRules || null,
      carryDebt: data.carryDebt !== false,
      calculatedAt: data.calculatedAt || null,
      closedAt: data.closedAt || null,
      closedBy: data.closedBy || null,
      snapshotId: data.snapshotId || null,
      backupChunks: Utils.toFiniteNumber(data.backupChunks) || 0
    };
  }

  /* ============================================================
   * AGGREGATES  (the Months page mini-dashboard)
   * ============================================================ */

  /**
   * Headline figures across every month in the index. Computed from the
   * SUMMARY documents, so this costs no report-sized reads at all.
   */
  function overview() {
    const acc = {
      totalMonths: state.months.length,
      lockedCount: 0,
      openCount: 0,
      calculatedCount: 0,
      activeMonthId: state.activeMonthId,
      activeMonthLabel: state.activeMonthId
        ? Utils.monthLabelFromId(state.activeMonthId) : '—',
      activeMonthStatus: state.activeMonthId
        ? (isLocked(state.activeMonthId) ? STATUS.LOCKED : STATUS.OPEN)
        : null,
      lastClosedMonthId: null,
      lastClosedMonthLabel: '—',
      totalFinalSalaries: 0,
      totalCarriedDebt: 0
    };

    state.months.forEach(m => {
      if (m.status === STATUS.LOCKED) {
        acc.lockedCount += 1;
        // months[] is sorted newest first, so the first locked month we
        // meet is the most recently closed one.
        if (!acc.lastClosedMonthId) {
          acc.lastClosedMonthId = m.id;
          acc.lastClosedMonthLabel = m.label;
        }
      } else {
        acc.openCount += 1;
      }

      if (m.totals) {
        acc.calculatedCount += 1;
        acc.totalFinalSalaries += Utils.toFiniteNumber(m.totals.finalSalary) || 0;
        acc.totalCarriedDebt += Utils.toFiniteNumber(m.totals.carriedDebt) || 0;
      }
    });

    acc.totalFinalSalaries = Utils.round2(acc.totalFinalSalaries);
    acc.totalCarriedDebt = Utils.round2(acc.totalCarriedDebt);
    return acc;
  }

  /* ============================================================
   * BOOTSTRAP
   * ============================================================ */

  /**
   * Loads the month index and the active month, then keeps both live.
   *
   * Called once, before the app renders anything month-dependent. Returns
   * the resolved active month id.
   */
  async function init() {
    if (state.initialized) return state.activeMonthId;

    // Prime the index from monthly_summaries. On a deployment upgrading to
    // this version that collection is empty, so fall back to the month
    // documents themselves and backfill the index as we go.
    let list = [];
    try {
      const snap = await db.collection(COLLECTIONS.MONTHLY_SUMMARIES).get();
      list = snap.docs.map(d => normalizeMonth(d.id, d.data()));
    } catch (err) {
      console.error('Could not read monthly_summaries:', err);
    }

    // The backfill reads every month document INCLUDING its full report
    // array, so it must run at most once per deployment. An explicit marker
    // is what guarantees that: inferring "already done" from a non-empty
    // summaries collection would silently re-run the whole expensive read
    // on every page load if the backfill ever failed halfway (rules not yet
    // deployed, connection dropped) and wrote nothing.
    if (list.length === 0 && !(await summariesBackfilled())) {
      list = await backfillSummaries();
    }

    rebuildIndex(list);

    // Listeners are attached BEFORE resolving the active month, and the
    // module is marked initialized in a `finally`.
    //
    // Resolving the active month can genuinely fail - a brand-new
    // deployment opened with no connection can't ask the server what month
    // it is. If that throw escaped before this point, the session would run
    // on with no listeners and an empty month index until the user happened
    // to reload. This way the month list still loads and still updates
    // live; only the active-month pointer is missing, which is exactly the
    // part that couldn't be determined.
    listen();

    try {
      state.activeMonthId = await resolveActiveMonthId();
    } finally {
      state.initialized = true;
      notify();
    }

    return state.activeMonthId;
  }

  /**
   * Whether the one-time summary backfill has already completed.
   *
   * On a read failure this returns TRUE (i.e. "assume done"), which is the
   * safe direction: skipping the backfill leaves the app working from the
   * month documents, while wrongly re-running it would re-read every
   * historical report on every single page load.
   */
  async function summariesBackfilled() {
    try {
      const snap = await db.collection(COLLECTIONS.SETTINGS).doc(SYSTEM_DOC).get();
      return !!(snap.exists && snap.data().summariesBackfilledAt);
    } catch (err) {
      console.error('Could not read the backfill marker:', err);
      return true;
    }
  }

  /**
   * One-time, idempotent backfill: builds a summary document for every
   * existing month of a deployment that predates this feature.
   *
   * Deliberately does NOT invent a status: absent means open, and claiming
   * a month was closed when nobody closed it would be a lie the archive
   * would then display as fact.
   *
   * The completion marker is written LAST, so a run that fails partway is
   * retried on the next startup rather than being recorded as done.
   */
  async function backfillSummaries() {
    try {
      const snap = await db.collection(COLLECTIONS.MONTHLY_REPORTS).get();
      if (snap.empty) {
        await markSummariesBackfilled(0);
        return [];
      }

      const months = [];
      // Chunked batches: Firestore caps a batch at 500 writes, and a
      // long-running deployment can easily have more months than that
      // once this runs against years of history.
      let batch = db.batch();
      let ops = 0;

      for (const doc of snap.docs) {
        const data = doc.data() || {};
        const report = Array.isArray(data.report) ? data.report : [];
        const totals = (data.totals && typeof data.totals === 'object')
          ? data.totals
          : (report.length > 0 ? Reports.computeTotals(report) : null);

        const summary = {
          monthLabel: data.monthLabel || Utils.monthLabelFromId(doc.id),
          status: data.status === STATUS.LOCKED ? STATUS.LOCKED : STATUS.OPEN,
          employeeCount: report.length,
          totals: totals || null,
          departmentTotals: Array.isArray(data.departmentTotals) ? data.departmentTotals : [],
          calculatedAt: data.calculatedAt || null,
          closedAt: data.closedAt || null,
          closedBy: data.closedBy || null,
          createdAt: data.createdAt || null,
          backfilledAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        batch.set(
          db.collection(COLLECTIONS.MONTHLY_SUMMARIES).doc(doc.id),
          summary,
          { merge: true }
        );
        ops += 1;
        if (ops === 400) { await batch.commit(); batch = db.batch(); ops = 0; }

        months.push(normalizeMonth(doc.id, summary));
      }

      if (ops > 0) await batch.commit();

      await markSummariesBackfilled(months.length);
      return months;
    } catch (err) {
      console.error('Summary backfill failed:', err);
      return [];
    }
  }

  async function markSummariesBackfilled(count) {
    try {
      await db.collection(COLLECTIONS.SETTINGS).doc(SYSTEM_DOC).set({
        summariesBackfilledAt: firebase.firestore.FieldValue.serverTimestamp(),
        summariesBackfilledCount: count
      }, { merge: true });
    } catch (err) {
      console.warn('Could not record the backfill marker:', err.message);
    }
  }

  /**
   * Live listeners on the index and on the active-month pointer, so a
   * change made in another tab (or by another admin) is reflected here.
   */
  function listen() {
    if (!state.unsubSummaries) {
      state.unsubSummaries = db.collection(COLLECTIONS.MONTHLY_SUMMARIES)
        .onSnapshot((snap) => {
          rebuildIndex(snap.docs.map(d => normalizeMonth(d.id, d.data())));
          notify();
        }, (err) => {
          console.error('Months index listener failed:', err);
          reportError('خطأ في تحميل قائمة الشهور: ' + err.message);
        });
    }

    if (!state.unsubSystem) {
      state.unsubSystem = db.collection(COLLECTIONS.SETTINGS).doc(SYSTEM_DOC)
        .onSnapshot((snap) => {
          const stored = snap.exists ? snap.data().activeMonthId : null;
          if (Utils.isValidMonthId(stored) && stored !== state.activeMonthId) {
            state.activeMonthId = stored;
            notify();
          }
        }, (err) => reportError('خطأ في متابعة الشهر النشط: ' + err.message));
    }
  }

  function stop() {
    if (state.unsubSummaries) { state.unsubSummaries(); state.unsubSummaries = null; }
    if (state.unsubSystem) { state.unsubSystem(); state.unsubSystem = null; }
  }

  return {
    STATUS,
    ACTION,
    init,
    stop,
    onChange,
    // active month
    activeMonthId,
    setActiveMonthId,
    fetchServerDate,
    // months
    all,
    byId,
    open,
    locked,
    isOpen,
    isLocked,
    isArchived,
    active,
    assertEditable,
    assertRecalculable,
    ensureMonthExists,
    overview,
    // lifecycle
    closeMonth,
    reopenMonth,
    archiveMonth,
    restoreArchivedMonth,
    deleteEmptyMonth,
    resetMonth,
    verifyMonthReset,
    createSnapshot,
    createBackup,
    loadMonthDetails,
    refreshSummary,
    // audit
    writeAuditLog,
    recentAuditLogs,
    auditLogsForMonth
  };
})();
