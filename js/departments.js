/**
 * departments.js
 * -----------------------------------------------------------------------
 * The Departments module: the backbone that turns this app from a
 * moderators-only tool into a company-wide payroll system.
 *
 * DESIGN NOTES
 * ------------
 * 1. Departments live in their own Firestore collection and are NEVER
 *    hardcoded in the UI. The eight defaults below are only *seeded* once
 *    into Firestore (idempotently) so a fresh deployment isn't empty - the
 *    admin can rename, re-price, archive or add to them freely afterwards.
 *
 * 2. Document IDs are deterministic slugs (`dept-moderators`, ...) rather
 *    than random Firestore IDs. That is what makes seeding idempotent
 *    (re-running never duplicates) and lets the employee migration find
 *    the Moderators department reliably without a name lookup.
 *
 * 3. Departments are ARCHIVED, never deleted. Every historical report
 *    references a departmentId, so a hard delete would orphan history.
 *    `status: 'active' | 'archived'` is the only lifecycle switch.
 *
 * 4. Names are only ever resolved through this module for LIVE views.
 *    Historical monthly reports carry their own `departmentName` snapshot
 *    (see Reports.buildDepartmentTotals) so renaming or archiving a
 *    department can never rewrite the past.
 *
 * FUTURE-MODULE READINESS (designed for, deliberately NOT implemented)
 * --------------------------------------------------------------------
 * Every department document reserves these relationship fields so the
 * planned modules can be added later without a data migration:
 *   teamLeaderId       -> Team Leaders module (employee id of the lead)
 *   parentDepartmentId -> department hierarchies / sub-teams
 *   permissions        -> HR Permissions module (per-department role map)
 *   features           -> per-department toggles for Attendance / Leave /
 *                          AI Performance Analysis / Live Chat
 * They are written as null/empty today and simply carried through.
 * No pages, collections or logic exist for those modules yet.
 * -----------------------------------------------------------------------
 */

'use strict';

const Departments = (() => {

  /* ============================================================
   * CONSTANTS
   * ============================================================ */

  const STATUS = { ACTIVE: 'active', ARCHIVED: 'archived' };

  /**
   * Every employee has a fixed monthly salary (entered manually per
   * employee, prorated by hire date - see Utils.calculateBaseSalary).
   * salaryType only controls whether BONUS is added on top of it:
   *
   * 'hourly'  - "بونص" departments (constant kept as 'hourly' for
   *             backward Firestore compatibility). Employees here also
   *             earn the automatic per-order bonus.
   * 'fixed'   - flat monthly salary only, no bonus at all
   *             (e.g. Packaging, Shipping Follow-up).
   */
  const SALARY_TYPE = { HOURLY: 'hourly', FIXED: 'fixed', COMMISSION: 'commission' };

  /** The department every pre-existing moderator is migrated into. */
  const MODERATORS_ID = 'dept-moderators';

  /** Fallback colour for departments saved without one. */
  const DEFAULT_COLOR = '#3d5afe';

  /**
   * Seed data for a brand-new deployment. `id` is the deterministic
   * document id; `order` only drives default display ordering.
   * These are DEFAULTS, not hardcoded business rules - once seeded they
   * are ordinary editable Firestore documents.
   */
  const DEFAULT_DEPARTMENTS = [
    { id: 'dept-dr-marwa-team-1',   name: 'Dr. Marwa Team 1',  color: '#3d5afe', order: 1 },
    { id: 'dept-dr-marwa-team-2',   name: 'Dr. Marwa Team 2',  color: '#06b6d4', order: 2 },
    { id: 'dept-tiktok-team-1',     name: 'TikTok Team 1',     color: '#ec4899', order: 3 },
    { id: 'dept-tiktok-team-2',     name: 'TikTok Team 2',     color: '#a855f7', order: 4 },
    { id: 'dept-shipping-followup', name: 'Shipping Follow-up', color: '#f59e0b', order: 5 },
    { id: 'dept-data-entry',        name: 'Data Entry',        color: '#14b8a6', order: 6 },
    { id: MODERATORS_ID,            name: 'Moderators',        color: '#22c55e', order: 7 },
    { id: 'dept-packaging',         name: 'Packaging',         color: '#ef4444', order: 8 }
  ];

  /* ============================================================
   * STATE
   * ============================================================ */

  const state = {
    all: [],              // every department, active + archived
    byId: new Map(),
    unsub: null,
    seeded: false
  };

  const subscribers = [];

  /** Registers a callback fired whenever the department list changes. */
  function onChange(fn) {
    if (typeof fn === 'function') subscribers.push(fn);
  }

  function notify() {
    subscribers.forEach(fn => {
      try { fn(state.all); } catch (err) { console.error('Departments subscriber failed:', err); }
    });
  }

  /* ============================================================
   * NORMALIZATION
   * ============================================================ */

  /**
   * Coerces a raw Firestore document into the shape the rest of the app
   * relies on. Every consumer reads departments through here, so a
   * document written by an older version (or hand-edited in the console)
   * can never crash a render with an undefined field.
   */
  function normalize(id, data) {
    const d = data || {};
    return {
      id,
      name: d.name || '(بدون اسم)',
      normalizedName: d.normalizedName || Utils.normalizeName(d.name || ''),
      bonusRules: (d.bonusRules && typeof d.bonusRules === 'object') ? { ...d.bonusRules } : null,
      salaryType: d.salaryType === SALARY_TYPE.FIXED ? SALARY_TYPE.FIXED : SALARY_TYPE.HOURLY,
      color: (typeof d.color === 'string' && d.color.trim()) ? d.color.trim() : DEFAULT_COLOR,
      status: d.status === STATUS.ARCHIVED ? STATUS.ARCHIVED : STATUS.ACTIVE,
      order: Utils.toFiniteNumber(d.order) || 0,
      notes: d.notes || '',
      // ---- reserved for future modules (carried through untouched) ----
      teamLeaderId: d.teamLeaderId || null,
      parentDepartmentId: d.parentDepartmentId || null,
      permissions: (d.permissions && typeof d.permissions === 'object') ? { ...d.permissions } : {},
      features: (d.features && typeof d.features === 'object') ? { ...d.features } : {}
    };
  }

  function rebuildIndex(list) {
    state.all = list;
    state.byId = new Map(list.map(d => [d.id, d]));
  }

  /** Default sort: active first, then explicit order, then name. */
  function sortDepartments(list) {
    return list.sort((a, b) => {
      if (a.status !== b.status) return a.status === STATUS.ACTIVE ? -1 : 1;
      if (a.order !== b.order) return a.order - b.order;
      return String(a.name).localeCompare(String(b.name), 'ar');
    });
  }

  /* ============================================================
   * SEEDING (idempotent)
   * ============================================================ */

  /**
   * Creates any of the eight default departments that don't exist yet.
   * Runs once per session before anything reads departments.
   *
   * Idempotent by construction: deterministic document ids + a
   * `create`-only write per missing id. An existing (possibly renamed or
   * archived) department is never touched, so this is safe to run on
   * every startup and safe to run concurrently in two browser tabs.
   *
   * WHY THIS WRITES DIRECTLY AND NOT THROUGH DataLayer
   * --------------------------------------------------
   * Every departments write an ADMIN makes goes through DataLayer and is
   * audited. Seeding is not one of those: it is system bootstrap that runs
   * automatically on a fresh deployment, before the admin has done anything.
   * Routing it through DataLayer would stamp eight "قسم أضيف" entries - each
   * attributed to whoever happened to log in first - at the top of a brand
   * new audit log, burying the first real action under setup noise and
   * implying a decision nobody made.
   *
   * The one-time seed is recoverable and self-describing anyway: the ids are
   * deterministic and the defaults are right here in DEFAULT_DEPARTMENTS.
   */
  async function seedDefaults() {
    if (state.seeded) return { created: 0 };

    const snap = await db.collection(COLLECTIONS.DEPARTMENTS).get();
    const existing = new Set(snap.docs.map(d => d.id));

    const missing = DEFAULT_DEPARTMENTS.filter(d => !existing.has(d.id));
    if (missing.length === 0) {
      state.seeded = true;
      return { created: 0 };
    }

    const batch = db.batch();
    missing.forEach(def => {
      batch.set(db.collection(COLLECTIONS.DEPARTMENTS).doc(def.id), {
        name: def.name,
        normalizedName: Utils.normalizeName(def.name),
        // null = "use the month's global bonus table". Departments only
        // override the bonus rules once an admin explicitly sets them.
        bonusRules: null,
        salaryType: SALARY_TYPE.HOURLY,
        color: def.color,
        status: STATUS.ACTIVE,
        order: def.order,
        notes: '',
        teamLeaderId: null,
        parentDepartmentId: null,
        permissions: {},
        features: {},
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();

    state.seeded = true;
    return { created: missing.length };
  }

  /* ============================================================
   * LOADING
   * ============================================================ */

  /**
   * Seeds (if needed) then loads departments once, and keeps them live
   * afterwards via a snapshot listener.
   *
   * NOTE: the list is sorted in memory rather than with `.orderBy()`.
   * A Firestore orderBy silently drops documents that are missing the
   * ordered field, which would make a hand-created department invisible.
   */
  async function init() {
    try {
      await seedDefaults();
    } catch (err) {
      console.error('Department seeding failed:', err);
      // Non-fatal: the app still works with whatever departments exist.
    }

    // Prime the cache synchronously before the app renders anything.
    const snap = await db.collection(COLLECTIONS.DEPARTMENTS).get();
    rebuildIndex(sortDepartments(snap.docs.map(d => normalize(d.id, d.data()))));

    listen();
    return state.all;
  }

  function listen() {
    if (state.unsub) return;
    state.unsub = db.collection(COLLECTIONS.DEPARTMENTS)
      .onSnapshot((snap) => {
        rebuildIndex(sortDepartments(snap.docs.map(d => normalize(d.id, d.data()))));
        notify();
      }, (err) => {
        console.error('Departments listener failed:', err);
        // `Toast` is a const at the bottom of app.js: while it is in its
        // temporal dead zone `typeof` THROWS instead of returning
        // 'undefined', so the try/catch - not a typeof check - is what
        // makes this safe.
        try {
          Toast.show('خطأ في تحميل الأقسام: ' + err.message, 'error');
        } catch (e) {
          /* Toast not ready yet - the console line above is the fallback. */
        }
      });
  }

  function stop() {
    if (state.unsub) { state.unsub(); state.unsub = null; }
  }

  /* ============================================================
   * READ HELPERS
   * ============================================================ */

  function all() { return state.all; }
  function active() { return state.all.filter(d => d.status === STATUS.ACTIVE); }
  function archived() { return state.all.filter(d => d.status === STATUS.ARCHIVED); }
  function byId(id) { return id ? (state.byId.get(id) || null) : null; }
  function exists(id) { return !!byId(id); }
  function isArchived(id) { const d = byId(id); return !!d && d.status === STATUS.ARCHIVED; }

  /** The default department for newly created employees. */
  function defaultId() {
    if (byId(MODERATORS_ID) && !isArchived(MODERATORS_ID)) return MODERATORS_ID;
    const first = active()[0];
    return first ? first.id : (state.all[0] ? state.all[0].id : null);
  }

  /**
   * Display name for a departmentId in LIVE views.
   * Historical reports must NOT use this - they read their own stored
   * `departmentName` snapshot instead.
   */
  function nameOf(id, fallback = 'بدون قسم') {
    const d = byId(id);
    return d ? d.name : fallback;
  }

  function colorOf(id) {
    const d = byId(id);
    return d ? d.color : DEFAULT_COLOR;
  }

  /** Department-level bonus overrides, or null when it inherits. */
  function bonusRulesOf(id) {
    const d = byId(id);
    return d ? d.bonusRules : null;
  }

  /** 'hourly' (default) or 'fixed'. Unknown ids are treated as hourly. */
  function salaryTypeOf(id) {
    const d = byId(id);
    return d ? d.salaryType : SALARY_TYPE.HOURLY;
  }

  /**
   * Whether a department pays a flat monthly salary with NO bonus.
   * Callers use this as the single switch that governs the bonus engine
   * and monthly calculation for every employee in it.
   */
  function isFixed(id) {
    return salaryTypeOf(id) === SALARY_TYPE.FIXED;
  }

  /* ============================================================
   * VALIDATION
   * ============================================================ */

  /**
   * Validates a department form payload.
   * Returns { ok: true, value } or { ok: false, message }.
   */
  function validate({ id, name, color, bonusRules, salaryType }) {
    const cleanName = Utils.cleanDisplayName(name);
    if (!cleanName) return { ok: false, message: 'اسم القسم مطلوب' };

    const normalizedName = Utils.normalizeName(cleanName);
    const dup = state.all.find(d => d.normalizedName === normalizedName && d.id !== id);
    if (dup) return { ok: false, message: 'يوجد قسم بنفس الاسم بالفعل' };

    const cleanSalaryType = salaryType === SALARY_TYPE.FIXED ? SALARY_TYPE.FIXED : SALARY_TYPE.HOURLY;
    const isFixedType = cleanSalaryType === SALARY_TYPE.FIXED;

    const cleanColor = (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color.trim()))
      ? color.trim() : DEFAULT_COLOR;

    return {
      ok: true,
      value: {
        name: cleanName,
        normalizedName,
        salaryType: cleanSalaryType,
        color: cleanColor,
        // A "راتب ثابت" department has no bonus at all, so its rules are
        // always stored as null regardless of what the form sent.
        bonusRules: isFixedType
          ? null
          : ((bonusRules && typeof bonusRules === 'object') ? bonusRules : null)
      }
    };
  }

  /* ============================================================
   * WRITES
   * ------------------------------------------------------------
   * All four go through DataLayer, which puts each write in one atomic batch
   * with its audit entry - so a department can't be created, renamed or
   * archived without the log recording who did it and what changed.
   * Each returns an undo descriptor the caller can hand to UndoService.
   * ============================================================ */

  async function create(payload) {
    const check = validate(payload);
    if (!check.ok) throw new Error(check.message);

    const maxOrder = state.all.reduce((m, d) => Math.max(m, d.order || 0), 0);

    const result = await DataLayer.create('departments', {
      ...check.value,
      status: STATUS.ACTIVE,
      order: maxOrder + 1,
      notes: payload.notes || '',
      teamLeaderId: null,
      parentDepartmentId: null,
      permissions: {},
      features: {},
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // The id is returned for backward compatibility - the previous version
    // resolved to `ref.id` - while `undo` is additive for newer callers.
    return { id: result.id, undo: result.undo };
  }

  /**
   * Edits a department. Renaming is always safe: historical reports keep
   * their own name snapshot, so only live views follow the new name.
   */
  async function update(id, payload) {
    if (!id) throw new Error('معرّف القسم مفقود');
    const check = validate({ ...payload, id });
    if (!check.ok) throw new Error(check.message);

    return DataLayer.update('departments', id, {
      ...check.value,
      notes: payload.notes || ''
    });
  }

  /**
   * Archives a department (soft delete). Departments are never removed
   * from Firestore because monthly reports reference them forever.
   *
   * An automatic backup is taken first: archiving is reversible in principle
   * (`restore()` below), but it is the action that hides a department from
   * every live view, so it is worth a recovery point.
   */
  async function archive(id) {
    if (!id) throw new Error('معرّف القسم مفقود');

    const dept = byId(id);
    await BackupService.createAutomaticBackup(
      BackupService.TRIGGER.BEFORE_DEPARTMENT_ARCHIVE,
      { note: `قبل أرشفة قسم: ${dept ? dept.name : id}` }
    );

    return DataLayer.update('departments', id, {
      status: STATUS.ARCHIVED,
      archivedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, {
      // Archiving removes a department from every live view, so it is not a
      // routine edit even though it is technically an update.
      severity: AuditService.SEVERITY.WARNING,
      auditAction: AuditService.ACTION.DEPARTMENT_ARCHIVED
    });
  }

  async function restore(id) {
    if (!id) throw new Error('معرّف القسم مفقود');
    return DataLayer.update('departments', id, {
      status: STATUS.ACTIVE,
      archivedAt: null
    }, {
      auditAction: AuditService.ACTION.DEPARTMENT_RESTORED
    });
  }

  return {
    STATUS,
    SALARY_TYPE,
    MODERATORS_ID,
    DEFAULT_COLOR,
    DEFAULT_DEPARTMENTS,
    init,
    seedDefaults,
    listen,
    stop,
    onChange,
    all,
    active,
    archived,
    byId,
    exists,
    isArchived,
    defaultId,
    nameOf,
    colorOf,
    bonusRulesOf,
    salaryTypeOf,
    isFixed,
    validate,
    create,
    update,
    archive,
    restore
  };
})();
