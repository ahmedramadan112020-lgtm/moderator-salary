/**
 * settlements.js
 * -----------------------------------------------------------------------
 * FinalSettlementService — end-of-service settlement (مخالصة نهاية الخدمة).
 *
 * WHAT A SETTLEMENT IS
 * --------------------
 * When an employee leaves mid-month, the normal monthly payroll can't pay
 * them: it pays a whole month to whoever is on the books when the month is
 * calculated. A settlement answers a different question — "what exactly do
 * we owe this person, as of their last working day, and once we pay it they
 * are off the payroll."
 *
 * THE CALCULATION
 * ---------------
 *   base salary, prorated to the last working day
 * + bonus earned in the settlement month (bonus-type departments only)
 * + manual adjustments dated in the settlement month
 * - advances taken in the settlement month
 * - debt carried over from the previous month
 * = net amount due
 *
 * Every term is read through the SAME Utils helpers the monthly payroll
 * uses. That is deliberate and load-bearing: a settlement that computed
 * "prorated salary" or "bonus" its own way would drift from the payroll it
 * is replacing, and the difference would be invisible until someone
 * reconciled two spreadsheets by hand.
 *
 * PRORATION, PRECISELY
 * --------------------
 * Utils.calculateBaseSalary() prorates from a HIRE date to the month END.
 * A settlement needs the mirror image: from the month START to a LEAVING
 * date. So proration lives here (`proratedSalaryToLastDay`) rather than
 * being forced into that function, but it uses the identical
 * amount/daysInMonth arithmetic and the identical "the boundary day counts
 * as worked" rule, so the two agree on any shared day.
 *
 * A subtlety that has to be right: if the employee was ALSO hired during
 * the settlement month, they are owed only the days between hire and
 * leaving — not the whole month up to the leaving date.
 *
 * WHY APPROVAL IS A SEPARATE STEP
 * -------------------------------
 * `calculate()` is pure: it reads, it computes, it writes nothing. The UI
 * shows the result for review, and only `approve()` touches the database.
 * That split is what makes the review screen trustworthy — the numbers on
 * it are the numbers that will be saved, and looking at them costs nothing.
 *
 * WHAT APPROVAL WRITES  (atomically)
 * ----------------------------------
 *   1. the settlement document (with its full breakdown snapshot)
 *   2. the employee: status -> 'inactive', plus lastWorkingDay/settlement refs
 *   3. two audit entries: the approval, and the deactivation
 * All FOUR writes are in ONE batch. An employee marked inactive with no
 * settlement record - or a settlement with no matching employee state - is
 * exactly the kind of inconsistency that only surfaces during an audit, and
 * an audit entry that went missing for a settlement that did commit is just
 * as bad. Firestore commits a batch entirely or not at all, so neither is
 * representable.
 *
 * An automatic backup is taken BEFORE the batch. A settlement is create-only
 * by rule (never edited, never deleted), so there is no undo for it - the
 * backup is the recovery path instead.
 *
 * DATA PRESERVED
 * --------------
 * Nothing is ever deleted. The employee document stays, their advances and
 * adjustments stay, every historical monthly report stays untouched. The
 * ONLY change is `status: 'inactive'`, which the payroll already understood
 * before this feature existed.
 * -----------------------------------------------------------------------
 */

'use strict';

const FinalSettlementService = (() => {

  /* ============================================================
   * CONSTANTS
   * ============================================================ */

  const STATUS = {
    APPROVED: 'approved'
  };

  /** Audit-log action names. Stable strings — they end up stored.
   *
   * Sourced from AuditService so each action string is defined once. The
   * property names are unchanged, so existing references keep working.
   */
  const ACTION = {
    SETTLEMENT_APPROVED: AuditService.ACTION.SETTLEMENT_APPROVED,
    EMPLOYEE_DEACTIVATED: AuditService.ACTION.EMPLOYEE_DEACTIVATED,
    EMPLOYEE_REACTIVATED: AuditService.ACTION.EMPLOYEE_REACTIVATED
  };

  /* ============================================================
   * DATE HELPERS
   * ============================================================ */

  /** True for a well-formed "YYYY-MM-DD" that is also a real calendar date. */
  function isValidDate(dateStr) {
    if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
    const [y, m, d] = dateStr.split('-').map(Number);
    if (m < 1 || m > 12) return false;
    const daysInMonth = new Date(y, m, 0).getDate();
    return d >= 1 && d <= daysInMonth;
  }

  /** Number of days in the month a "YYYY-MM" id refers to. */
  function daysInMonth(monthId) {
    const [y, m] = monthId.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }

  /**
   * Base salary owed for the settlement month, prorated to the last
   * working day (inclusive).
   *
   * Mirrors Utils.calculateBaseSalary()'s arithmetic exactly — same
   * amount/daysInMonth rate, same "boundary day is a worked day" rule — but
   * counts FORWARD from the start of the month (or from the hire date, if
   * the employee also started this month) instead of backward from a hire
   * date to the month end.
   *
   * @param {number}  fixedSalaryAmount monthly salary
   * @param {string}  lastWorkingDay    "YYYY-MM-DD"
   * @param {string?} hireDate          "YYYY-MM-DD", or falsy
   * @returns {{amount:number, daysWorked:number, daysInMonth:number, startDay:number, endDay:number}}
   */
  function proratedSalaryToLastDay(fixedSalaryAmount, lastWorkingDay, hireDate) {
    const monthly = Utils.toFiniteNumber(fixedSalaryAmount) || 0;
    const monthId = String(lastWorkingDay).slice(0, 7);
    const total = daysInMonth(monthId);
    const lastDay = Number(String(lastWorkingDay).slice(8, 10));

    // If the employee was hired during this same month, they are only owed
    // from the hire day — not from the 1st.
    let startDay = 1;
    if (hireDate && isValidDate(hireDate)) {
      const hireMonthId = String(hireDate).slice(0, 7);
      if (hireMonthId === monthId) {
        startDay = Number(String(hireDate).slice(8, 10));
      } else if (hireMonthId > monthId) {
        // Hired after the month they supposedly left in: nothing is owed.
        return { amount: 0, daysWorked: 0, daysInMonth: total, startDay: 0, endDay: 0 };
      }
    }

    const endDay = Math.min(Math.max(lastDay, 1), total);
    const clampedStart = Math.min(Math.max(startDay, 1), total);
    const daysWorked = Math.max(0, endDay - clampedStart + 1);

    if (monthly <= 0 || daysWorked <= 0) {
      return { amount: 0, daysWorked, daysInMonth: total, startDay: clampedStart, endDay };
    }

    // A full month must pay exactly the monthly figure, with no rounding
    // drift from (amount/days)*days.
    const amount = (daysWorked >= total)
      ? Utils.round2(monthly)
      : Utils.round2((monthly / total) * daysWorked);

    return { amount, daysWorked, daysInMonth: total, startDay: clampedStart, endDay };
  }

  /* ============================================================
   * BONUS FOR THE SETTLEMENT MONTH
   * ============================================================ */

  /**
   * Sums the bonus an employee earned from the orders imported into the
   * settlement month.
   *
   * Reads the month's ALREADY-CALCULATED report row when there is one, and
   * only falls back to summing raw orderBatches when the month hasn't been
   * calculated yet. Preferring the stored row matters: it is the figure the
   * payroll itself would pay, computed under the month's frozen bonus-rule
   * snapshot, so the settlement can never quote a different bonus than the
   * report does.
   *
   * Fixed-salary departments never earn a bonus — same rule as the payroll.
   */
  async function bonusForMonth(employee, monthId) {
    const departmentId = (employee && employee.departmentId) || Departments.MODERATORS_ID;
    if (Departments.isFixed(departmentId)) {
      return { amount: 0, source: 'fixed_department', ordersCount: 0, totalPackages: 0 };
    }

    let monthData = {};
    try {
      const snap = await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId).get();
      monthData = snap.exists ? (snap.data() || {}) : {};
    } catch (err) {
      console.error('bonusForMonth: could not read the month:', err);
    }

    const report = Array.isArray(monthData.report) ? monthData.report : [];
    const row = report.find(r => r && r.moderatorId === employee.id);
    if (row) {
      return {
        amount: Utils.round2(Number(row.totalBonus) || 0),
        source: 'calculated_report',
        ordersCount: Number(row.ordersCount) || 0,
        totalPackages: Number(row.totalPackages) || 0
      };
    }

    // Not calculated yet — derive it from the raw orders, using the month's
    // own bonus-rule snapshot so the figure matches what the report will
    // produce when it is eventually calculated.
    const rules = Utils.resolveDepartmentBonusRules(
      departmentId,
      (monthData.departmentBonusRules && typeof monthData.departmentBonusRules === 'object')
        ? monthData.departmentBonusRules : {},
      monthData.bonusRules || null,
      Departments.bonusRulesOf(departmentId)
    );

    let amount = 0;
    let ordersCount = 0;
    let totalPackages = 0;

    try {
      const batches = await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId)
        .collection(MONTH_SUBCOLLECTIONS.ORDER_BATCHES).get();

      batches.forEach(doc => {
        const items = (doc.data() || {}).items || [];
        for (const item of items) {
          if (item.moderatorId !== employee.id) continue;
          ordersCount += 1;
          totalPackages += Number(item.packages) || 0;
          amount += Utils.calculateOrderBonus(item.packages, rules);
        }
      });
    } catch (err) {
      console.error('bonusForMonth: could not read order batches:', err);
    }

    return {
      amount: Utils.round2(amount),
      source: ordersCount > 0 ? 'raw_orders' : 'no_orders',
      ordersCount,
      totalPackages
    };
  }

  /* ============================================================
   * PREVIOUS DEBT
   * ============================================================ */

  /**
   * Debt the employee carried out of the month BEFORE the settlement
   * month. Deducted here for the same reason the payroll deducts it: it is
   * recorded data, not a policy choice.
   */
  async function previousDebtFor(employeeId, monthId) {
    const prevId = Utils.previousMonthId(monthId);
    if (!prevId) return 0;
    try {
      const snap = await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(prevId).get();
      if (!snap.exists) return 0;
      const map = Utils.carriedDebtMap(snap.data().report);
      return Utils.toFiniteNumber(map[employeeId]) || 0;
    } catch (err) {
      console.error('previousDebtFor failed:', err);
      return 0;
    }
  }

  /* ============================================================
   * CALCULATE  (pure — writes nothing)
   * ============================================================ */

  /**
   * Computes a full settlement proposal for review.
   *
   * Writes NOTHING. Everything needed to display, audit and later persist
   * the settlement is returned, including a line-by-line `breakdown` that
   * is stored verbatim on approval — so the saved record explains itself
   * without anyone having to re-run this function.
   *
   * @param {object} params
   *        - employee: the employee record (from App state)
   *        - lastWorkingDay: "YYYY-MM-DD"
   *        - advances / adjustments: the app's already-loaded arrays
   *        - note: optional free text
   * @returns {Promise<object>} the settlement proposal
   */
  async function calculate({ employee, lastWorkingDay, advances = [], adjustments = [], note = '' } = {}) {
    if (!employee || !employee.id) throw new Error('لازم تختار الموظف');
    if (!isValidDate(lastWorkingDay)) throw new Error('تاريخ آخر يوم عمل غير صحيح');

    if (employee.status === 'inactive') {
      throw new Error(`الموظف "${employee.name}" غير نشط بالفعل — التسوية اتعملت قبل كده`);
    }

    const monthId = lastWorkingDay.slice(0, 7);
    if (!Utils.isValidMonthId(monthId)) throw new Error('تاريخ آخر يوم عمل غير صحيح');

    // A settlement moves money inside its month, exactly like an advance
    // does, so it obeys the same lock. Settling into a month that has
    // already been closed and paid out would change a signed-off payroll.
    Months.assertEditable(monthId, 'تسوية المستحقات');

    if (employee.hireDate && isValidDate(employee.hireDate) &&
        employee.hireDate > lastWorkingDay) {
      throw new Error('تاريخ آخر يوم عمل مش ممكن يكون قبل تاريخ التعيين');
    }

    const departmentId = employee.departmentId || Departments.MODERATORS_ID;

    // ---- 1. Prorated base salary ----
    const salary = proratedSalaryToLastDay(
      employee.fixedSalaryAmount, lastWorkingDay, employee.hireDate
    );

    // ---- 2. Bonus for the settlement month ----
    const bonus = await bonusForMonth(employee, monthId);

    // ---- 3. Adjustments dated in the settlement month ----
    const monthAdjustments = (adjustments || []).filter(a =>
      a && a.moderatorId === employee.id && a.monthId === monthId
    );
    const totalAdjustments = Utils.round2(
      monthAdjustments.reduce((sum, a) => sum + (Number(a.amount) || 0), 0)
    );

    // ---- 4. Advances taken in the settlement month ----
    const monthAdvances = (advances || []).filter(a =>
      a && a.moderatorId === employee.id && a.monthId === monthId
    );
    const totalAdvances = Utils.round2(
      monthAdvances.reduce((sum, a) => sum + (Number(a.amount) || 0), 0)
    );

    // ---- 5. Debt carried in from the previous month ----
    const previousDebt = await previousDebtFor(employee.id, monthId);

    // ---- 6. Net ----
    // Settled with carryDebt disabled ON PURPOSE: there is no next month to
    // carry anything into. A negative result is a real outcome — the
    // employee owes the company — and must be shown, not hidden as a zero.
    const settled = Utils.settleSalary({
      salary: salary.amount,
      totalBonus: bonus.amount,
      totalAdjustments,
      totalAdvances,
      previousDebt,
      carryDebt: false
    });

    const netAmount = settled.finalSalary;

    // Human-readable line items, stored with the settlement so the saved
    // record is self-explanatory forever.
    const breakdown = [
      {
        key: 'salary',
        label: 'الراتب بالتناسب',
        detail: salary.daysWorked > 0
          ? `${salary.daysWorked} يوم من ${salary.daysInMonth} (من ${salary.startDay} إلى ${salary.endDay})`
          : 'لا توجد أيام عمل مستحقة في الشهر',
        amount: salary.amount,
        type: 'add'
      },
      {
        key: 'bonus',
        label: 'البونص',
        detail: Departments.isFixed(departmentId)
          ? 'قسم راتب ثابت — بدون بونص'
          : `${Utils.formatNumber(bonus.ordersCount)} طلب / ${Utils.formatNumber(bonus.totalPackages)} طرد`,
        amount: bonus.amount,
        type: bonus.amount < 0 ? 'deduct' : 'add'
      },
      {
        key: 'adjustments',
        label: 'تسويات يدوية',
        detail: monthAdjustments.length > 0
          ? `${monthAdjustments.length} تسوية في الشهر`
          : 'لا توجد تسويات',
        amount: totalAdjustments,
        type: totalAdjustments < 0 ? 'deduct' : 'add'
      },
      {
        key: 'advances',
        label: 'السلف',
        detail: monthAdvances.length > 0
          ? `${monthAdvances.length} سلفة في الشهر`
          : 'لا توجد سلف',
        amount: -totalAdvances,
        type: 'deduct'
      },
      {
        key: 'previousDebt',
        label: 'دين سابق',
        detail: previousDebt > 0
          ? `مرحّل من ${Utils.monthLabelFromId(Utils.previousMonthId(monthId))}`
          : 'لا يوجد دين سابق',
        amount: -previousDebt,
        type: 'deduct'
      }
    ];

    // Things the admin should see BEFORE approving. None of them block the
    // settlement — they are all legitimate situations — but each one is a
    // plausible data-entry mistake, and this is the last cheap moment to
    // catch it.
    const warnings = [];
    if (netAmount < 0) {
      warnings.push(
        `الصافي بالسالب (${Utils.formatCurrency(netAmount)}) — معناه إن الموظف ` +
        'مستحق عليه مبلغ للشركة، مش العكس. راجع السلف والدين السابق.'
      );
    }
    if ((Utils.toFiniteNumber(employee.fixedSalaryAmount) || 0) <= 0) {
      warnings.push('الموظف مالوش راتب شهري ثابت مسجّل، فالراتب بالتناسب طلع صفر.');
    }
    if (salary.daysWorked >= salary.daysInMonth) {
      warnings.push('آخر يوم عمل هو آخر الشهر، فالراتب محسوب كشهر كامل.');
    }
    if (bonus.source === 'raw_orders') {
      warnings.push(
        'تقرير الشهر ده لسه مش محسوب، والبونص اتحسب من الأوردرات مباشرة. ' +
        'لو حسبت التقرير بعد كده الرقم هيطابق.'
      );
    }

    return {
      // identity
      employeeId: employee.id,
      employeeName: employee.name,
      departmentId,
      departmentName: Departments.nameOf(departmentId),
      // inputs
      lastWorkingDay,
      monthId,
      monthLabel: Utils.monthLabelFromId(monthId),
      hireDate: employee.hireDate || null,
      fixedSalaryAmount: Utils.toFiniteNumber(employee.fixedSalaryAmount) || 0,
      note: String(note || '').trim(),
      // components
      salary: salary.amount,
      daysWorked: salary.daysWorked,
      daysInMonth: salary.daysInMonth,
      totalBonus: bonus.amount,
      bonusSource: bonus.source,
      ordersCount: bonus.ordersCount,
      totalPackages: bonus.totalPackages,
      totalAdjustments,
      totalAdvances,
      previousDebt,
      netAmount,
      // presentation + audit
      breakdown,
      warnings
    };
  }

  /* ============================================================
   * APPROVE  (the only function here that writes)
   * ============================================================ */

  /**
   * Persists a calculated settlement and takes the employee off the
   * payroll.
   *
   * The settlement document and the employee's status change go in ONE
   * batch: an employee marked inactive with no settlement record, or a
   * settlement with no matching employee state, is exactly the kind of
   * inconsistency that only surfaces during an audit.
   *
   * Re-reads the employee inside the batch's preparation to catch the case
   * where they were settled from another tab a moment ago.
   *
   * @param {object} settlement the object returned by calculate()
   * @returns {Promise<{settlementId:string}>}
   */
  async function approve(settlement) {
    if (!settlement || !settlement.employeeId) {
      throw new Error('بيانات التسوية غير مكتملة');
    }
    if (!isValidDate(settlement.lastWorkingDay)) {
      throw new Error('تاريخ آخر يوم عمل غير صحيح');
    }

    // Re-assert the lock at approval time: the month could have been closed
    // between calculating and approving.
    Months.assertEditable(settlement.monthId, 'اعتماد التسوية');

    const employeeRef = db.collection(COLLECTIONS.EMPLOYEES).doc(settlement.employeeId);
    const employeeSnap = await employeeRef.get();
    if (!employeeSnap.exists) {
      throw new Error('الموظف مش موجود — يمكن اتحذف من تاب تاني');
    }
    if ((employeeSnap.data() || {}).status === 'inactive') {
      throw new Error('الموظف بقى غير نشط بالفعل — يمكن التسوية اتعملت من تاب تاني');
    }

    const user = (typeof auth !== 'undefined' && auth.currentUser) ? auth.currentUser : null;
    const settlementRef = db.collection(COLLECTIONS.SETTLEMENTS).doc();

    // ---- 0. Automatic backup before an irreversible financial record ----
    //
    // An approved settlement is create-only by rule: it can never be edited
    // or deleted, and the employee is taken off the payroll in the same
    // batch. So this is one of the three actions with no undo, and the
    // backup is the recovery path instead.
    //
    // Taken BEFORE the batch, so it captures the employee while they are
    // still active. Best-effort - `createAutomaticBackup` never throws - so
    // a backup problem can't block a departing employee's final pay.
    const preBackup = await BackupService.createAutomaticBackup(
      BackupService.TRIGGER.BEFORE_SETTLEMENT,
      {
        monthId: settlement.monthId,
        name: `قبل مخالصة ${settlement.employeeName}`,
        note: `نسخة تلقائية قبل اعتماد مخالصة نهاية الخدمة لـ${settlement.employeeName}`
      }
    );

    // The initial read above gives a fast, friendly error in the normal
    // case. It cannot, however, protect against two administrators approving
    // from separate tabs at the same instant. A transaction re-reads the
    // employee and retries if another writer changed it, so at most one
    // settlement can commit for one active employee.
    return db.runTransaction(async (batch) => {
      const freshEmployeeSnap = await batch.get(employeeRef);
      if (!freshEmployeeSnap.exists) {
        throw new Error('الموظف غير موجود — يمكن حذفه من نافذة أخرى');
      }
      if ((freshEmployeeSnap.data() || {}).status === 'inactive') {
        throw new Error('الموظف أصبح غير نشط بالفعل — يمكن اعتماد مخالصة من نافذة أخرى');
      }

    // ---- 1. The settlement record ----
    batch.set(settlementRef, {
      employeeId: settlement.employeeId,
      employeeName: settlement.employeeName,
      // Department NAME snapshot, same principle as the monthly reports:
      // renaming the department later must not rewrite this record.
      departmentId: settlement.departmentId,
      departmentName: settlement.departmentName,
      lastWorkingDay: settlement.lastWorkingDay,
      monthId: settlement.monthId,
      monthLabel: settlement.monthLabel,
      hireDate: settlement.hireDate || null,
      fixedSalaryAmount: settlement.fixedSalaryAmount,
      salary: settlement.salary,
      daysWorked: settlement.daysWorked,
      daysInMonth: settlement.daysInMonth,
      totalBonus: settlement.totalBonus,
      ordersCount: settlement.ordersCount,
      totalPackages: settlement.totalPackages,
      totalAdjustments: settlement.totalAdjustments,
      totalAdvances: settlement.totalAdvances,
      previousDebt: settlement.previousDebt,
      netAmount: settlement.netAmount,
      // The line items exactly as reviewed, so the record explains itself.
      breakdown: settlement.breakdown || [],
      note: settlement.note || '',
      status: STATUS.APPROVED,
      approvedBy: user ? user.email : null,
      approvedByUid: user ? user.uid : null,
      approvedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // ---- 2. Take the employee off the payroll ----
    // `status: 'inactive'` is the ONLY field that changes behaviour. Nothing
    // is deleted: name, department, salary, hire date, notes and every
    // historical report row stay exactly as they are.
    batch.update(employeeRef, {
      status: 'inactive',
      lastWorkingDay: settlement.lastWorkingDay,
      settlementId: settlementRef.id,
      settledAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // ---- 3. Audit trail, IN THE SAME BATCH ----
    //
    // This used to be written after the commit, on the reasoning that an
    // audit entry must not claim something that didn't happen. Putting it
    // inside the batch satisfies that requirement more strongly: Firestore
    // commits all three writes or none, so the entry cannot describe a
    // settlement that failed AND cannot go missing for one that succeeded.
    //
    // Severity comes from the action (settlement_approved is critical) - it
    // is never passed in, so this can't be logged as routine.
    AuditService.appendToBatch(batch, {
      action: ACTION.SETTLEMENT_APPROVED,
      entity: 'settlements',
      operation: AuditService.OPERATION.CREATE,
      documentId: settlementRef.id,
      documentLabel: settlement.employeeName,
      monthId: settlement.monthId,
      details: {
        settlementId: settlementRef.id,
        employeeId: settlement.employeeId,
        employeeName: settlement.employeeName,
        monthId: settlement.monthId,
        monthLabel: settlement.monthLabel,
        lastWorkingDay: settlement.lastWorkingDay,
        netAmount: settlement.netAmount,
        reason: 'final_settlement',
        backupId: preBackup ? preBackup.id : null,
        backupTaken: !!preBackup
      }
    });

    // A settlement also deactivates the employee. Logged as its own entry so
    // the employee's own history (queried by documentId) shows why they left
    // the payroll, rather than only the settlements collection knowing.
    AuditService.appendToBatch(batch, {
      action: ACTION.EMPLOYEE_DEACTIVATED,
      entity: 'employees',
      operation: AuditService.OPERATION.UPDATE,
      documentId: settlement.employeeId,
      documentLabel: settlement.employeeName,
      monthId: settlement.monthId,
      before: { status: 'active' },
      after: { status: 'inactive', lastWorkingDay: settlement.lastWorkingDay },
      changed: ['status', 'lastWorkingDay'],
      details: {
        reason: 'final_settlement',
        settlementId: settlementRef.id,
        employeeId: settlement.employeeId
      }
    });

      return { settlementId: settlementRef.id, backupId: preBackup ? preBackup.id : null };
    });
  }

  /* ============================================================
   * REACTIVATE
   * ============================================================ */

  /**
   * Puts an inactive employee back on the payroll.
   *
   * Keeps `settlementId` and `lastWorkingDay` on the record rather than
   * clearing them: the previous settlement genuinely happened and the
   * history should say so. They are simply no longer current, and
   * `reactivatedAt` marks that.
   *
   * Affects FUTURE calculations only. Every closed month keeps its own
   * frozen report rows, so nothing historical moves.
   */
  async function reactivate(employeeId) {
    if (!employeeId) throw new Error('معرّف الموظف مفقود');

    const ref = db.collection(COLLECTIONS.EMPLOYEES).doc(employeeId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('الموظف مش موجود');

    const data = snap.data() || {};
    if (data.status !== 'inactive') {
      throw new Error('الموظف نشط بالفعل');
    }

    // Routed through DataLayer so the status change and its audit entry share
    // one atomic batch, exactly like every other employee edit. The previous
    // `lastWorkingDay` and `settlementId` are deliberately left in place: the
    // settlement genuinely happened and the history should say so, it is
    // simply no longer current, and `reactivatedAt` marks that.
    await DataLayer.update('employees', employeeId, {
      status: 'active',
      reactivatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, {
      monthId: Months.activeMonthId(),
      severity: AuditService.SEVERITY.WARNING,
      note: 'إعادة تفعيل موظف بعد مخالصة'
    });

    // A second, explicitly-named entry so the reactivation is findable by its
    // own action rather than only as a generic employee update - and so it
    // carries the settlement it supersedes.
    await AuditService.log(ACTION.EMPLOYEE_REACTIVATED, {
      entity: 'employees',
      operation: AuditService.OPERATION.UPDATE,
      documentId: employeeId,
      documentLabel: data.name || employeeId,
      monthId: Months.activeMonthId(),
      details: {
        employeeId,
        employeeName: data.name || '',
        previousLastWorkingDay: data.lastWorkingDay || null,
        previousSettlementId: data.settlementId || null,
        reason: 'manual_reactivation'
      }
    });

    return true;
  }

  /* ============================================================
   * READS
   * ============================================================ */

  /** Every approved settlement, newest first. */
  async function all(limit = 200) {
    try {
      const snap = await db.collection(COLLECTIONS.SETTLEMENTS)
        .orderBy('approvedAt', 'desc').limit(limit).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.error('Could not read settlements:', err);
      return [];
    }
  }

  /** One settlement by id, or null. */
  async function byId(settlementId) {
    if (!settlementId) return null;
    try {
      const snap = await db.collection(COLLECTIONS.SETTLEMENTS).doc(settlementId).get();
      return snap.exists ? { id: snap.id, ...snap.data() } : null;
    } catch (err) {
      console.error('Could not read the settlement:', err);
      return null;
    }
  }

  return {
    STATUS,
    ACTION,
    // pure helpers (exported for testing/reuse)
    isValidDate,
    proratedSalaryToLastDay,
    // service
    calculate,
    approve,
    reactivate,
    all,
    byId
  };
})();
