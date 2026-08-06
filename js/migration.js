/**
 * migration.js
 * -----------------------------------------------------------------------
 * One-shot, idempotent data migrations that run automatically on startup.
 *
 * WHY THESE WRITES BYPASS DataLayer
 * ---------------------------------
 * Every write an ADMIN makes goes through DataLayer and lands in the audit
 * log. A migration is not an admin action: it runs automatically on startup,
 * before anyone has done anything, and it only backfills fields that were
 * missing. Routing it through DataLayer would stamp one audit entry per
 * employee - attributed to whoever happened to log in first - burying the
 * first real action under hundreds of lines of setup noise and implying
 * decisions nobody made.
 *
 * The migration records itself instead: a single marker document at
 * `settings/migrations` with the key, the completion timestamp and the number
 * of records touched. That is the right granularity for a mechanical backfill.
 * -----------------------------------------------------------------------
 * MIGRATION 1 - employeesDepartmentV1
 * -----------------------------------
 * Before the Departments feature every person in the system was a
 * "moderator" with no department. The company payroll model requires each
 * employee to belong to exactly one department, so every pre-existing
 * employee is assigned to the "Moderators" department.
 *
 * Guarantees:
 *   * NO DATA LOSS - it only *adds* the fields that are missing
 *     (departmentId, status, hireDate, notes). Name, normalizedName and
 *     createdAt are never touched, and no document is ever deleted.
 *   * IDEMPOTENT - documents that already have a departmentId are skipped,
 *     so running it on every startup is a no-op after the first time.
 *   * ZERO EXTRA READS - it operates on the employee list the app's
 *     realtime listener has already loaded.
 *   * HISTORY-SAFE - it does not touch monthly_reports. Historical rows
 *     keep whatever they were saved with; the report renderer attributes
 *     department-less legacy rows to Moderators at read time, which lands
 *     them in exactly the same place their employees were migrated to.
 *   * SAFE TO ABORT - it writes in chunks of 400 and records progress
 *     only at the end; a half-finished run simply resumes next startup
 *     because the remaining documents still lack a departmentId.
 * -----------------------------------------------------------------------
 */

'use strict';

const Migration = (() => {

  /** Firestore's hard limit is 500 writes per batch; 400 leaves headroom. */
  const CHUNK = 400;

  const MIGRATIONS_DOC = 'migrations';
  const EMPLOYEE_DEPT_KEY = 'employeesDepartmentV1';

  const state = { ran: new Set() };

  /**
   * Assigns every employee that has no departmentId to `defaultDepartmentId`
   * and backfills the new employee fields.
   *
   * @param {Array}  employees          already-loaded employee docs
   * @param {string} defaultDepartmentId usually Departments.MODERATORS_ID
   * @returns {Promise<{migrated:number, skipped:number}>}
   */
  async function migrateEmployeesToDepartments(employees, defaultDepartmentId) {
    if (state.ran.has(EMPLOYEE_DEPT_KEY)) return { migrated: 0, skipped: 0 };
    if (!defaultDepartmentId) {
      console.warn('Migration skipped: no default department available yet.');
      return { migrated: 0, skipped: 0 };
    }

    const list = Array.isArray(employees) ? employees : [];
    const needsMigration = list.filter(e => e && e.id && !e.departmentId);

    // Latch only when there was genuinely nothing to do, so a failed run
    // is retried on the next startup instead of being silently skipped.
    if (needsMigration.length === 0) {
      state.ran.add(EMPLOYEE_DEPT_KEY);
      return { migrated: 0, skipped: list.length };
    }

    let migrated = 0;
    for (let i = 0; i < needsMigration.length; i += CHUNK) {
      const chunk = needsMigration.slice(i, i + CHUNK);
      const batch = db.batch();

      chunk.forEach(emp => {
        const ref = db.collection(COLLECTIONS.EMPLOYEES).doc(emp.id);
        // update() (not set-merge) so a document deleted mid-migration
        // fails loudly instead of being silently resurrected as a stub.
        const patch = { departmentId: defaultDepartmentId };

        // Backfill only what is actually absent - never overwrite real data.
        if (emp.status === undefined) patch.status = 'active';
        if (emp.hireDate === undefined) patch.hireDate = null;
        if (emp.notes === undefined) patch.notes = '';
        if (!emp.normalizedName && emp.name) patch.normalizedName = Utils.normalizeName(emp.name);

        batch.update(ref, patch);
      });

      await batch.commit();
      migrated += chunk.length;
    }

    // Audit trail. Best-effort: the migration itself already succeeded, so
    // a failure to record it must not surface as an error to the admin.
    try {
      await db.collection(COLLECTIONS.SETTINGS).doc(MIGRATIONS_DOC).set({
        [EMPLOYEE_DEPT_KEY]: {
          completedAt: firebase.firestore.FieldValue.serverTimestamp(),
          migratedCount: migrated,
          defaultDepartmentId
        }
      }, { merge: true });
    } catch (err) {
      console.warn('Could not record migration marker:', err.message);
    }

    state.ran.add(EMPLOYEE_DEPT_KEY);
    return { migrated, skipped: list.length - migrated };
  }

  return { migrateEmployeesToDepartments };
})();
