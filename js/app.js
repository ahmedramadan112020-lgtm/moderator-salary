/**
 * app.js
 * -----------------------------------------------------------------------
 * Main application controller for the dashboard. Owns all in-memory
 * state, wires up Firestore listeners, orchestrates the import ->
 * calculate -> render pipeline, and handles every UI interaction that
 * isn't authentication (auth.js), charting (charts.js) or exporting
 * (reports.js).
 * -----------------------------------------------------------------------
 */

'use strict';

const App = (() => {

  /* ============================================================
   * STATE
   * ============================================================ */

  const state = {
    user: null,
    userRole: null,
    // Employees (the Firestore collection is still physically named
    // `moderators` - see COLLECTIONS in firebase.js for why).
    employees: [],         // [{id, name, normalizedName, departmentId, status, hireDate, notes}]
    // The month currently being VIEWED. This is not necessarily the Active
    // Month: the admin can open a locked month from the Archive to look at
    // it. `Months.activeMonthId()` is the single source of truth for which
    // month the deployment is actually working on.
    currentMonthId: null,
    currentReport: [],      // computed report rows for the selected month
    // Global defaults. These seed NEW months only - each month keeps its own
    // snapshot of bonusRules/carryDebt so historical reports never
    // change when these are edited later.
    settings: {
      companyName: 'اسم الشركة',
      bonusRules: { ...Utils.DEFAULT_BONUS_RULES },
      carryDebt: Utils.DEFAULT_CARRY_DEBT
    },
    // Snapshot values belonging to the currently selected month
    currentMonthBonusRules: { ...Utils.DEFAULT_BONUS_RULES },
    currentMonthCarryDebt: Utils.DEFAULT_CARRY_DEBT,
    // Per-department bonus-rules snapshot for the selected month. Once a
    // month has been calculated these freeze the rules it used, so
    // re-pricing or renaming a department later can never alter it.
    currentMonthDepartmentBonusRules: {}, // { departmentId: {..rules} }
    // departmentTotals as STORED on the month document (Option B).
    // Historical months are rendered from this array verbatim - never
    // recalculated - which is what makes them immutable.
    currentDepartmentTotals: [],
    advances: [],            // all advances (all months), filtered per-view by monthId
    adjustments: [],         // all manual adjustments (all months), filtered per-view by monthId
    // 'all' = Company View, or a departmentId for Department View.
    // Shared by the dashboard, the report table and every export.
    departmentFilter: 'all',
    sort: { key: 'name', dir: 'asc' },
    searchTerm: '',
    employeeSearchTerm: '',
    archiveSearchTerm: '',
    // Unified السلف/التسويات ledger
    ledgerSearchTerm: '',
    ledgerTypeFilter: 'all',
    ledgerEmployeeFilter: 'all',
    ledgerDepartmentFilter: 'all',
    ledgerDateFilter: '',
    transactionEditing: null,
    // Inactive-employees page
    inactiveSearchTerm: '',
    // Final settlements
    settlements: [],
    // The settlement proposal currently on the review screen. Held in
    // memory only - nothing is written until it is approved.
    pendingSettlement: null,
    showArchivedDepartments: false,
    auditLogs: [],
    // Audit log severity filter: 'all' | 'info' | 'warning' | 'critical'.
    auditSeverityFilter: 'all',
    auditSearchTerm: '',
    auditMonthFilter: 'all', auditUserFilter: 'all', auditActionFilter: 'all', auditDateFilter: '', auditResultFilter: 'all', auditLimit: 100,
    // Backups page
    backups: [],
    // The backup whose restore-confirmation modal is open, plus the
    // comparison computed for it. Held in memory only: nothing is written
    // until the admin confirms.
    pendingRestore: null,
    // Read-only Smart Approval result that authorizes the immediately
    // following existing close confirmation. It is never persisted alone.
    pendingApprovalAssessment: null,
    // The month whose read-only details modal is open, if any.
    viewingMonthId: null,
    unsubEmployees: null,
    unsubAdvances: null,
    unsubAdjustments: null
  };

  /* ============================================================
   * BOOTSTRAP
   * ============================================================ */

  async function init(user, profile = {}) {
    state.user = user;
    state.userRole = Permissions.profileRole(profile);
    Permissions.setProfile(profile);
    Permissions.applyUI();
    document.getElementById('userEmailLabel').textContent = user.email;

    bindStaticUI();
    // User administration is non-critical to payroll loading. A permissions
    // rules mismatch must never leave the whole dashboard uninitialised.
    try { await UserManagement.init(); } catch (err) { console.error('User management init failed:', err); Toast.show('تعذر تحميل قائمة المستخدمين. راجع قواعد Firestore.', 'error'); }
    resetTransactionForm();

    // Settings must be loaded BEFORE the month system starts: creating a
    // month copies its bonusRules snapshot from settings at creation time.
    await loadSettings();

    // Departments must be loaded BEFORE employees render, because every
    // employee row, the dashboard filter and the salary calculation all
    // resolve a departmentId through the Departments cache. Seeding the
    // eight defaults happens inside init() and is idempotent.
    if (Permissions.can('departments.read')) {
      try {
        await Departments.init();
      } catch (err) {
        console.error('Departments init failed:', err);
        Toast.show('تعذر تحميل الأقسام: ' + err.message, 'error');
      }
    }

    // Re-render everything that displays a department whenever the
    // department list changes (rename, archive, restore, new department).
    Departments.onChange(() => {
      renderDepartmentsTable();
      renderSettingsBonusDepartments();
      renderDepartmentOptions();
      renderImportDepartmentOptions();
      renderTransactionSelectors();
      renderEmployeesTable();
      renderDashboard();
    });

    renderDepartmentOptions();
    renderImportDepartmentOptions();
    renderDepartmentsTable();
    renderSettingsBonusDepartments();

    if (Permissions.can('employees.read')) listenEmployees();
    if (Permissions.can('transactions.read')) {
      listenAdvances();
      listenAdjustments();
    }

    // ---- ACTIVE MONTH ----
    // Months.init() resolves the active month from Firestore (never from
    // the device clock) and keeps the month index live. It must come after
    // Departments so a newly created month can snapshot their bonus rules.
    Months.onChange(onMonthsChanged);

    try {
      const activeMonthId = await Months.init();
      await selectMonth(activeMonthId);
    } catch (err) {
      console.error('Months init failed:', err);
      Toast.show('تعذر تحديد الشهر النشط: ' + err.message, 'error');
    }

    OrdersManagement.init({
      getEmployees: () => state.employees,
      getDepartments: () => Departments.all(),
      getCurrentReport: () => state.currentReport,
      onLoaded: () => renderDashboard(),
      recalculate: async (monthId) => {
        await selectMonth(monthId);
        return calculateReport();
      }
    });

    MonthManagement.init({
      create: async (monthId) => {
        const created = await Months.ensureMonthExists(monthId, {
          bonusRules: state.settings.bonusRules,
          carryDebt: state.settings.carryDebt,
          departmentBonusRules: departmentBonusRulesMap()
        });
        if (created) {
          await Months.writeAuditLog(Months.ACTION.MONTH_CREATED, {
            monthId,
            monthLabel: Utils.monthLabelFromId(monthId),
            reason: 'month_management_page'
          });
        }
        return created;
      },
      activate: async (monthId) => {
        await Months.setActiveMonthId(monthId, { reason: 'month_management_page' });
        await selectMonth(monthId);
      },
      // Closing is deliberately reused, not reimplemented: approval is the
      // only supported lock transition because it preserves snapshot+backup.
      approve: async (monthId) => {
        if (monthId !== Months.activeMonthId()) {
          await Months.setActiveMonthId(monthId, { reason: 'approve_from_month_management' });
        }
        await selectMonth(monthId);
        switchView('report');
        openSmartApproval();
      },
      unlock: async (monthId) => {
        await Months.reopenMonth(monthId, Months.ACTION.MONTH_UNLOCKED);
      },
      reopen: async (monthId) => {
        await Months.reopenMonth(monthId, Months.ACTION.MONTH_REOPENED);
        await Months.setActiveMonthId(monthId, { reason: 'reopen_from_month_management' });
        await selectMonth(monthId);
      },
      reset: async (monthId) => {
        const result = await Months.resetMonth(monthId);
        // Reset preserves the month document. Reloading it clears the
        // in-memory report immediately while retaining the live manual
        // advances/adjustments listeners that the next calculation uses.
        if (monthId === Months.activeMonthId()) await selectMonth(monthId);
        await loadDashboardStatusData();
        return result;
      }
    });
    MonthComparison.init();
    SmartApproval.init();

    loadSettlements();
    loadDashboardStatusData();

    // Re-offer an undo that was still live when the page reloaded. The 30s
    // window is measured from the original operation, so a refresh can't
    // extend it - see UndoService.restoreFromSession.
    try {
      UndoService.restoreFromSession();
    } catch (err) {
      console.error('Could not restore the pending undo:', err);
    }

    // Detach every Firestore listener when the page goes away. Not strictly
    // required (the connection dies with the tab), but leaving five live
    // snapshot listeners attached during logout means callbacks can fire
    // against a half-torn-down DOM after `Auth.logout()` navigates away.
    window.addEventListener('beforeunload', teardown);
  }

  /** Detaches every realtime listener this module owns. */
  function teardown() {
    [state.unsubEmployees, state.unsubAdvances, state.unsubAdjustments]
      .forEach(unsub => { if (typeof unsub === 'function') unsub(); });
    state.unsubEmployees = null;
    state.unsubAdvances = null;
    state.unsubAdjustments = null;

    try { Months.stop(); } catch (err) { /* module may not have initialized */ }
    try { Departments.stop(); } catch (err) { /* same */ }
  }

  /**
   * The dashboard needs only a tiny, one-time status read: one backup and a
   * short audit page. It deliberately is not a realtime listener, avoiding
   * recurring reads just to paint the status strip.
   */
  async function loadDashboardStatusData() {
    try {
      const [backups, auditLogs] = await Promise.all([
        BackupService.listBackups(1),
        AuditService.getRecent(20)
      ]);
      if (backups.length > 0) state.backups = backups;
      if (auditLogs.length > 0) state.auditLogs = auditLogs;
      renderDashboardStatus();
    } catch (err) {
      console.warn('Dashboard status data could not be loaded:', err.message);
    }
  }

  /**
   * Fired by the Months module whenever the month index or the active
   * month changes - including from another tab or another admin's device.
   */
  function onMonthsChanged() {
    updateCloseMonthButtonState();
    renderReportApprovalStatus();
    renderArchiveTable();
    renderMonthStatusUI();
    MonthComparison.refreshMonths();
  }

  function bindStaticUI() {
    // Sidebar navigation
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    document.getElementById('logoutBtn').addEventListener('click', () => Auth.logout());

    // Dark mode / sidebar preference (UI-only, Local Storage is fine here)
    const collapsed = localStorage.getItem('sidebarCollapsed') === '1';
    if (collapsed) document.body.classList.add('sidebar-collapsed');
    document.getElementById('sidebarToggle').addEventListener('click', () => {
      document.body.classList.toggle('sidebar-collapsed');
      localStorage.setItem('sidebarCollapsed', document.body.classList.contains('sidebar-collapsed') ? '1' : '0');
    });

    // Report view - approving the report intentionally reuses the existing
    // close-month workflow (snapshot, backup, summary, lock, next month).
    document.getElementById('approveReportBtn').addEventListener('click', openSmartApproval);
    document.getElementById('quickAddEmployeeBtn').addEventListener('click', () => {
      switchView('moderators');
      openEmployeeModal();
    });
    document.getElementById('quickImportOrdersBtn').addEventListener('click', () => {
      switchView('orders');
      document.querySelector('[data-orders-tab="import"]')?.click();
      document.getElementById('excelFileInput').focus();
    });
    document.getElementById('quickCalculateReportBtn').addEventListener('click', () => {
      switchView('report');
      calculateReport();
    });
    document.getElementById('quickApproveReportBtn').addEventListener('click', () => {
      switchView('report');
      openSmartApproval();
    });
    document.getElementById('quickBackupBtn').addEventListener('click', () => {
      switchView('backups');
      onCreateManualBackup();
    });

    // Backups view
    document.getElementById('createBackupBtn').addEventListener('click', onCreateManualBackup);
    document.querySelectorAll('[data-backup-scope]').forEach(btn => btn.addEventListener('click', () => onCreateManualBackup(btn.dataset.backupScope)));
    document.getElementById('refreshBackupsBtn').addEventListener('click', () => loadBackups(true));
    document.getElementById('clearOpenOperationsBtn').addEventListener('click', onClearOpenOperations);
    // Audit log view: filtering happens at the query boundary for severity,
    // then the text search narrows the loaded page without extra reads.
    document.getElementById('auditSeverityFilter').addEventListener('change', (e) => {
      state.auditSeverityFilter = e.target.value || 'all';
      loadAuditLogs();
    });
    document.getElementById('auditSearch').addEventListener('input', Utils.debounce((e) => {
      state.auditSearchTerm = e.target.value || '';
      renderAuditLogTable();
      renderAuditTimeline();
    }, 200));
    ['auditMonthFilter', 'auditUserFilter', 'auditActionFilter', 'auditDateFilter', 'auditResultFilter'].forEach(id => {
      document.getElementById(id).addEventListener('change', e => { state[id.replace('audit', 'audit').replace('Filter', 'Filter')] = e.target.value || 'all'; renderAuditLogTable(); renderAuditTimeline(); });
    });
    document.getElementById('refreshAuditBtn').addEventListener('click', () => loadAuditLogs(true));
    document.getElementById('auditLoadMoreBtn').addEventListener('click', () => { state.auditLimit += 100; loadAuditLogs(); });
    document.getElementById('auditTimeline').addEventListener('click', e => { const card = e.target.closest('[data-audit-id]'); if (card) openAuditDetails(card.dataset.auditId); });
    ['auditDetailsCloseBtn', 'auditDetailsDoneBtn'].forEach(id => document.getElementById(id).addEventListener('click', () => document.getElementById('auditDetailsModal').classList.remove('open')));
    document.getElementById('closeRestoreModal').addEventListener('click', closeRestoreModal);
    document.getElementById('cancelRestoreBtn').addEventListener('click', closeRestoreModal);
    document.getElementById('confirmRestoreBtn').addEventListener('click', onConfirmRestore);
    // Restoring overwrites live data, so the confirm button stays disabled
    // until the acknowledgement is ticked - same contract as closing a month.
    document.getElementById('restoreAck').addEventListener('change', (e) => {
      document.getElementById('confirmRestoreBtn').disabled = !e.target.checked;
    });

    // Close-month confirmation modal
    document.getElementById('closeCloseMonthModal').addEventListener('click', closeCloseMonthModal);
    document.getElementById('cancelCloseMonthBtn').addEventListener('click', closeCloseMonthModal);
    document.getElementById('confirmCloseMonthBtn').addEventListener('click', onConfirmCloseMonth);
    // The confirm button stays disabled until the acknowledgement is ticked:
    // closing a month can't be undone from the app.
    document.getElementById('closeMonthAck').addEventListener('change', (e) => {
      document.getElementById('confirmCloseMonthBtn').disabled = !e.target.checked;
    });

    // Archive view
    document.getElementById('archiveSearch').addEventListener('input', Utils.debounce((e) => {
      state.archiveSearchTerm = e.target.value;
      renderArchiveTable();
    }, 200));
    document.getElementById('closeMonthDetailsModal').addEventListener('click', closeMonthDetailsModal);
    document.getElementById('monthDetailsCloseBtn').addEventListener('click', closeMonthDetailsModal);

    // Departments view
    document.getElementById('addDepartmentBtn').addEventListener('click', () => openDepartmentModal());
    document.getElementById('departmentForm').addEventListener('submit', onSaveDepartment);
    document.getElementById('closeDepartmentModal').addEventListener('click', closeDepartmentModal);
    document.getElementById('showArchivedDepartments').addEventListener('change', (e) => {
      state.showArchivedDepartments = e.target.checked;
      renderDepartmentsTable();
    });
    // Reveal the per-department bonus grid only when the override is on,
    // so the default case stays a single checkbox.
    document.getElementById('departmentBonusToggle').addEventListener('change', (e) => {
      document.getElementById('departmentBonusGrid').classList.toggle('hidden', !e.target.checked);
      document.getElementById('departmentBonusTypeWrap').classList.toggle('hidden', !e.target.checked);
      document.getElementById('addDepartmentSalesTier').classList.toggle('hidden', !e.target.checked);
    });
    document.getElementById('departmentBonusType').addEventListener('change', renderDepartmentSalesRules);
    document.getElementById('addDepartmentSalesTier').addEventListener('click', () => { const rules = window._departmentSalesBonusRules || []; rules.push({from:0,to:0,bonus:0}); window._departmentSalesBonusRules=rules; renderDepartmentSalesRules(); });
    // Fixed-salary ("راتب ثابت") departments don't earn a bonus at all, so
    // the bonus-override section collapses when that type is chosen.
    document.getElementById('departmentSalaryTypeInput').addEventListener('change', (e) => {
      document.getElementById('departmentHourlyFieldsWrap')
        .classList.toggle('hidden', e.target.value === Departments.SALARY_TYPE.FIXED);
    });

    // Employees view
    document.getElementById('addModeratorBtn').addEventListener('click', () => openEmployeeModal());
    document.getElementById('moderatorForm').addEventListener('submit', onSaveEmployee);
    document.getElementById('closeModeratorModal').addEventListener('click', closeEmployeeModal);
    document.getElementById('moderatorSearch').addEventListener('input', Utils.debounce((e) => {
      state.employeeSearchTerm = e.target.value;
      renderEmployeesTable();
    }, 200));
    document.getElementById('employeeDeptFilter').addEventListener('change', renderEmployeesTable);

    // Import view
    document.getElementById('importTextBtn').addEventListener('click', onImportText);
    document.getElementById('excelFileInput').addEventListener('change', onImportExcel);
    document.getElementById('downloadImportTemplateBtn').addEventListener('click', onDownloadImportTemplate);
    bindExcelDropzone();

    // Import preview modal (Excel method)
    document.getElementById('closeImportPreviewModal').addEventListener('click', closeImportPreviewModal);
    document.getElementById('cancelImportPreviewBtn').addEventListener('click', closeImportPreviewModal);
    document.getElementById('confirmImportPreviewBtn').addEventListener('click', onConfirmImportPreview);
    document.getElementById('refreshImportPreviewBtn').addEventListener('click', recomputeImportPreview);
    document.getElementById('importWizardToValidation').addEventListener('click', () => showImportWizardStage(4));
    document.getElementById('importWizardToApprove').addEventListener('click', () => { if (excelImportPreview && excelImportPreview.errors.length === 0) showImportWizardStage(5); });
    document.getElementById('importWizardConfirm').addEventListener('click', onConfirmImportPreview);
    document.getElementById('refreshImportHistoryBtn').addEventListener('click', loadImportHistory);

    // Report view - toolbar.
    // Every export receives the FILTERED rows plus the active scope label,
    // so "single department" exports are department-scoped end to end.
    document.getElementById('calculateBtn').addEventListener('click', calculateReport);
    document.getElementById('exportExcelBtn').addEventListener('click', () => {
      if (!requireReport()) return;
      Reports.exportExcel(exportRows(), currentMonthLabel(), exportContext());
    });
    document.getElementById('exportPdfBtn').addEventListener('click', () => {
      if (!requireReport()) return;
      Reports.exportPDF(exportRows(), currentMonthLabel(), state.settings.companyName, exportContext());
    });
    document.getElementById('copyReportBtn').addEventListener('click', async () => {
      if (!requireReport()) return;
      await Reports.copyReport(exportRows());
      Toast.show('تم نسخ التقرير', 'success');
    });
    document.getElementById('printReportBtn').addEventListener('click', () => {
      if (!requireReport()) return;
      Reports.printReport(exportRows(), currentMonthLabel(), state.settings, exportContext());
    });
    document.getElementById('reportSearch').addEventListener('input', Utils.debounce((e) => {
      state.searchTerm = e.target.value;
      renderReportTable();
    }, 200));
    document.querySelectorAll('#reportTable th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (state.sort.key === key) {
          state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort.key = key;
          state.sort.dir = 'asc';
        }
        renderReportTable();
      });
    });

    // Moderator details modal close
    document.getElementById('closeDetailsModal').addEventListener('click', closeDetailsModal);

    // Advances view
    document.getElementById('advanceForm').addEventListener('submit', onAddAdvance);

    // Adjustments view
    document.getElementById('adjustmentForm').addEventListener('submit', onAddAdjustment);

    // Unified السلف/التسويات page: tabs + ledger filters
    document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => switchTransactionTab(btn.dataset.tab));
    });
    document.getElementById('ledgerSearch').addEventListener('input', Utils.debounce((e) => {
      state.ledgerSearchTerm = e.target.value;
      renderLedger();
    }, 200));
    document.getElementById('ledgerTypeFilter').addEventListener('change', (e) => {
      state.ledgerTypeFilter = e.target.value || 'all';
      renderLedger();
    });
    document.getElementById('ledgerEmployeeFilter').addEventListener('change', (e) => {
      state.ledgerEmployeeFilter = e.target.value || 'all';
      renderLedger();
    });
    document.getElementById('ledgerDepartmentFilter').addEventListener('change', (e) => {
      state.ledgerDepartmentFilter = e.target.value || 'all';
      renderLedger();
    });
    document.getElementById('ledgerDateFilter').addEventListener('change', (e) => {
      state.ledgerDateFilter = e.target.value || '';
      renderLedger();
    });
    document.getElementById('transactionForm').addEventListener('submit', onSaveTransaction);
    document.getElementById('transactionTypeInput').addEventListener('change', updateTransactionFormHint);
    document.getElementById('transactionCancelEditBtn').addEventListener('click', resetTransactionForm);

    // Final settlement view
    document.getElementById('settlementForm').addEventListener('submit', onCalculateSettlement);
    document.getElementById('approveSettlementBtn').addEventListener('click', onApproveSettlement);
    document.getElementById('cancelSettlementBtn').addEventListener('click', cancelSettlementReview);
    document.getElementById('closeSettlementDetailsModal')
      .addEventListener('click', closeSettlementDetailsModal);
    document.getElementById('settlementDetailsCloseBtn')
      .addEventListener('click', closeSettlementDetailsModal);

    // The inactive-employees view is optional in older dashboard markup.
    // Guard its legacy listeners so the monthly-report workflow can still
    // initialize when that retired view is not present.
    const inactiveSearch = document.getElementById('inactiveSearch');
    if (inactiveSearch) {
      inactiveSearch.addEventListener('input', Utils.debounce((e) => {
        state.inactiveSearchTerm = e.target.value;
        renderInactiveTable();
      }, 200));
    }
    const inactiveDeptFilter = document.getElementById('inactiveDeptFilter');
    if (inactiveDeptFilter) inactiveDeptFilter.addEventListener('change', renderInactiveTable);

    // Settings view
    document.getElementById('settingsForm').addEventListener('submit', onSaveSettings);
    document.getElementById('addCompanySalesTier').addEventListener('click', () => { state.settings.salesBonusRules.push({ from: 0, to: 0, bonus: 0 }); renderCompanySalesRules(); });

    bindModalDismissal();
  }

  /**
   * Backdrop-click and Escape close every non-blocking modal. The confirm
   * dialog is deliberately excluded: it owns its own Yes/No lifecycle and
   * dismissing it from here would leave its listeners attached.
   */
  function bindModalDismissal() {
    const dismissable = ['moderatorModal', 'detailsModal', 'departmentModal',
                         'monthDetailsModal', 'settlementDetailsModal'];

    dismissable.forEach(id => {
      const modal = document.getElementById(id);
      if (!modal) return;
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('open');
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      dismissable.forEach(id => {
        const modal = document.getElementById(id);
        if (modal) modal.classList.remove('open');
      });
    });
  }

  function switchView(viewName) {
    const viewPermissions = { dashboard:'dashboard.read', departments:'departments.read', moderators:'employees.read', import:'orders.import', orders:'orders.read', months:'months.read', 'month-comparison':'comparison.read', report:'reports.read', transactions:'transactions.read', settlement:'settlements.read', archive:'archive.read', backups:'backups.read', audit:'audit.read', settings:'settings.read', users:'users.manage' };
    if (!Permissions.can(viewPermissions[viewName] || 'dashboard.read')) { Toast.show('ليس لديك صلاحية فتح هذه الصفحة.', 'error'); return; }
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const view = document.getElementById(`view-${viewName}`);
    if (view) view.classList.add('active');
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    // Views that read from the month index are refreshed on entry rather
    // than kept permanently in sync, so opening them always shows current
    // data without paying for re-renders while they're hidden.
    if (viewName === 'archive') {
      renderArchiveTable();
    } else if (viewName === 'transactions') {
      renderLedger();
    } else if (viewName === 'settlement') {
      populateActiveEmployeeDatalist();
      renderSettlementsTable();
    } else if (viewName === 'backups') {
      // Loaded on entry rather than kept live: backups change only when
      // someone takes one, and a listener on them would pay for reads on
      // every page the admin visits.
      loadBackups();
    } else if (viewName === 'audit') {
      loadAuditLogs();
    } else if (viewName === 'orders') {
      OrdersManagement.open();
    } else if (viewName === 'import') {
      renderImportDepartmentOptions();
      loadImportHistory();
    } else if (viewName === 'months') {
      MonthManagement.open();
    } else if (viewName === 'month-comparison') {
      MonthComparison.open();
    }
  }

  /* ============================================================
   * FIRESTORE LISTENERS
   * ============================================================ */

  /**
   * Employees listener. The collection is physically still `moderators`
   * (see COLLECTIONS) so every existing document id keeps working.
   *
   * The first snapshot also triggers the one-time department migration:
   * any employee without a departmentId is assigned to Moderators. The
   * migration writes back into this same collection, which re-fires this
   * listener - `Migration` latches internally so that second pass is a
   * cheap no-op rather than an infinite loop.
   */
  function listenEmployees() {
    state.unsubEmployees = db.collection(COLLECTIONS.EMPLOYEES)
      .orderBy('name')
      .onSnapshot(async (snap) => {
        state.employees = snap.docs.map(d => normalizeEmployee(d.id, d.data()));

        renderEmployeesTable();
        renderDashboard();
        populateEmployeeDatalist();
        populateActiveEmployeeDatalist();
        renderTransactionSelectors();
        renderInactiveTable();

        if (Permissions.can('employees.write')) await runEmployeeMigration();
      }, (err) => Toast.show('خطأ في تحميل الموظفين: ' + err.message, 'error'));
  }

  /**
   * Coerces an employee document into a complete shape. Documents written
   * before the departments feature have no departmentId/status/hireDate -
   * they read as null here and the migration fills them in permanently.
   */
  function normalizeEmployee(id, data) {
    const d = data || {};
    return {
      id,
      name: d.name || '',
      normalizedName: d.normalizedName || Utils.normalizeName(d.name || ''),
      departmentId: d.departmentId || null,
      status: d.status === 'inactive' ? 'inactive' : 'active',
      hireDate: d.hireDate || null,
      notes: d.notes || '',
      fixedSalaryAmount: Utils.toFiniteNumber(d.fixedSalaryAmount) || 0,
      // Reference-only "hours worked per day" (e.g. 8). Never used in any
      // salary calculation - purely informational.
      dailyWorkHours: Utils.toFiniteNumber(d.dailyWorkHours),
      // ---- End-of-service fields, absent on everyone still employed ----
      // Written by FinalSettlementService.approve() alongside
      // `status: 'inactive'`. Kept after a re-activation too: the
      // settlement genuinely happened, it is simply no longer current.
      lastWorkingDay: d.lastWorkingDay || null,
      settlementId: d.settlementId || null
    };
  }

  async function runEmployeeMigration() {
    try {
      const result = await Migration.migrateEmployeesToDepartments(
        state.employees, Departments.MODERATORS_ID
      );
      if (result.migrated > 0) {
        Toast.show(`تم نقل ${result.migrated} موظف تلقائيًا إلى قسم "Moderators"`, 'success');
      }
    } catch (err) {
      console.error('Employee migration failed:', err);
      Toast.show('تعذر ترحيل الموظفين للأقسام: ' + err.message, 'error');
    }
  }

  /**
   * The department an employee belongs to for CALCULATION purposes.
   * Falls back to Moderators so an employee can never be silently dropped
   * from a report while the migration is still in flight.
   */
  function employeeDepartmentId(emp) {
    return (emp && emp.departmentId) || Departments.MODERATORS_ID;
  }

  /** Employees visible under the current global department filter. */
  function employeesInScope() {
    if (state.departmentFilter === 'all') return state.employees;
    return state.employees.filter(e => employeeDepartmentId(e) === state.departmentFilter);
  }

  async function loadSettings() {
    if (!Permissions.can('settings.read')) {
      // Dashboard/report-only roles use defaults rather than triggering an
      // expected Rules rejection for a hidden settings screen.
      populateBonusRuleInputs();
      return;
    }
    try {
      const snap = await db.collection(COLLECTIONS.SETTINGS).doc('general').get();
      if (snap.exists) {
        const data = snap.data();
        state.settings = {
          companyName: data.companyName || 'اسم الشركة',
          bonusRules: { ...Utils.DEFAULT_BONUS_RULES, ...(data.bonusRules || {}) },
          bonusType: data.bonusType || 'packages',
          salesBonusRules: Array.isArray(data.salesBonusRules) ? data.salesBonusRules : [],
          // Only an explicit `false` disables carry-over; a settings document
          // written before this feature existed keeps the default (on).
          carryDebt: (data.carryDebt === undefined) ? Utils.DEFAULT_CARRY_DEBT : data.carryDebt !== false
        };
      }
      document.getElementById('companyNameInput').value = state.settings.companyName || '';
      document.getElementById('carryDebtInput').checked = state.settings.carryDebt;
      populateBonusRuleInputs();
    } catch (err) {
      console.error(err);
    }
  }

  function populateBonusRuleInputs() {
    const r = state.settings.bonusRules;
    document.getElementById('bonusRule1').value = r['1'];
    document.getElementById('bonusRule2').value = r['2'];
    document.getElementById('bonusRule3').value = r['3'];
    document.getElementById('bonusRule4').value = r['4'];
    document.getElementById('bonusRule5').value = r['5'];
    document.getElementById('bonusRule6_9').value = r['6_9'];
    document.getElementById('bonusRule10plus').value = r['10+'];
    renderCompanySalesRules();
  }

  async function onSaveSettings(e) {
    e.preventDefault();
    const companyName = document.getElementById('companyNameInput').value.trim() || 'اسم الشركة';

    const bonusRules = {
      '1': Number(document.getElementById('bonusRule1').value) || 0,
      '2': Number(document.getElementById('bonusRule2').value) || 0,
      '3': Number(document.getElementById('bonusRule3').value) || 0,
      '4': Number(document.getElementById('bonusRule4').value) || 0,
      '5': Number(document.getElementById('bonusRule5').value) || 0,
      '6_9': Number(document.getElementById('bonusRule6_9').value) || 0,
      '10+': Number(document.getElementById('bonusRule10plus').value) || 0
    };

    const carryDebt = document.getElementById('carryDebtInput').checked;

    Loading.show('جاري حفظ الإعدادات...');
    try {
      // Settings seed every future month's bonus table and carry-debt policy,
      // so a change here is registered as WARNING severity rather than a
      // routine edit - it is the kind of change you want to find in the log
      // when a month's figures look unexpected.
      const result = await DataLayer.replace('settings', 'general', {
        companyName, bonusRules, carryDebt
      });

      state.settings.companyName = companyName;
      state.settings.bonusRules = bonusRules;
      state.settings.carryDebt = carryDebt;

      if (result.noop) {
        Toast.show('مفيش تغييرات للحفظ', 'info');
      } else {
        Toast.show('تم حفظ الإعدادات. القيم الجديدة هتتطبق على الشهور الجديدة، والشهور القديمة هتفضل بقيمها المحفوظة', 'success');
        UndoService.offer(result.undo, 'تم تعديل إعدادات الشركة');
      }
    } catch (err) {
      Toast.show('خطأ أثناء حفظ الإعدادات: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  /* ============================================================
   * MONTH MANAGEMENT
   * ------------------------------------------------------------
   * Two distinct ideas, deliberately kept apart:
   *
   *   ACTIVE MONTH  - the month the deployment is working on. Stored in
   *                   Firestore, shared by every device, changed only by
   *                   closing a month or by an explicit admin choice.
   *   SELECTED MONTH- the month currently on screen. Usually the active
   *                   one, but the admin can open a locked month from the
   *                   Archive to read it.
   *
   * `state.currentMonthId` is the SELECTED month. Anything that writes
   * must go through Months.assertEditable() first.
   * ============================================================ */

  /** { departmentId: bonusRules } for departments that override the table. */
  function departmentBonusRulesMap() {
    const map = {};
    Departments.all().forEach(d => {
      if (d.bonusRules && typeof d.bonusRules === 'object') map[d.id] = { ...d.bonusRules };
    });
    return map;
  }

  /**
   * Loads a month onto the screen.
   *
   * Unlike the old version this NEVER creates a month as a side effect of
   * viewing one: creation is now an explicit act (the "شهر جديد" button,
   * or closing a month). That is what stops a mistyped or stale month id
   * from quietly littering the database with empty months.
   */
  async function selectMonth(monthId) {
    if (!monthId) return;

    Loading.show();
    try {
      const snap = await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId).get();
      if (!snap.exists) {
        Toast.show(
          `شهر ${Utils.monthLabelFromId(monthId)} مش موجود. اضغط "شهر جديد" لإنشائه.`,
          'error'
        );
        // Fall back to the month already on screen so the UI never ends up
        // pointing at a month that isn't there.
        return;
      }

      state.currentMonthId = monthId;
      const data = snap.data() || {};

      state.currentReport = Array.isArray(data.report) ? data.report : [];

      // Stored department summaries (Option B). Rendered verbatim for
      // historical months - never recalculated - so renames, archives and
      // employees changing department cannot rewrite the past.
      state.currentDepartmentTotals = Array.isArray(data.departmentTotals)
        ? data.departmentTotals : [];

      state.currentMonthBonusRules = {
        ...Utils.DEFAULT_BONUS_RULES,
        ...(data.bonusRules || state.settings.bonusRules || {})
      };
      state.currentMonthCarryDebt = (data.carryDebt === undefined)
        ? state.settings.carryDebt : data.carryDebt !== false;

      // Department bonus-rule snapshots. Absent on months created before
      // departments existed - those simply resolve to the department's
      // live bonus table, and get stamped permanently the first time the
      // month is calculated.
      state.currentMonthDepartmentBonusRules =
        (data.departmentBonusRules && typeof data.departmentBonusRules === 'object')
          ? { ...data.departmentBonusRules } : {};

      renderMonthStatusUI();
      renderReportTable();
      renderDashboard();
      renderEmployeesTable();
      renderLedger();
      updateCloseMonthButtonState();
      renderReportApprovalStatus();
      if (typeof SalaryProcessing !== 'undefined' && SalaryProcessing.isInitialized()) {
        SalaryProcessing.load().catch(err => console.warn('Salary Processing refresh failed:', err.message));
      }
    } catch (err) {
      console.error('selectMonth failed:', err);
      Toast.show('تعذر تحميل بيانات الشهر: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  function currentMonthLabel() {
    return Utils.monthLabelFromId(state.currentMonthId);
  }

  /** True when the month on screen is locked (read-only). */
  function isViewingLockedMonth() {
    return Months.isLocked(state.currentMonthId);
  }

  /**
   * Applies the selected month's status to the whole UI: the topbar label
   * and badge, the locked banner, and every control that would write.
   *
   * Disabling the controls is a usability measure, not the security
   * boundary - Months.assertEditable() guards each handler and the
   * Firestore rules guard the database. Three layers, because a payroll
   * month that silently accepts an edit after being closed is the one bug
   * that can't be fixed after the fact.
   */
  function renderMonthStatusUI() {
    const locked = isViewingLockedMonth();
    const archived = Months.isArchived(state.currentMonthId);
    const readOnly = locked || archived;
    const monthLabel = state.currentMonthId ? currentMonthLabel() : '-';

    const labelEl = document.getElementById('currentMonthLabel');
    if (labelEl) labelEl.textContent = monthLabel;

    const badge = document.getElementById('monthStatusBadge');
    if (badge) {
      const isActive = state.currentMonthId === Months.activeMonthId();
      if (locked) {
        badge.textContent = '🔒 مقفول';
        badge.className = 'badge badge-locked';
      } else if (archived) {
        badge.textContent = '🗄️ مؤرشف';
        badge.className = 'badge badge-archived';
      } else if (isActive) {
        badge.textContent = '● الشهر النشط';
        badge.className = 'badge badge-current';
      } else {
        badge.textContent = 'مفتوح';
        badge.className = 'badge badge-open';
      }
    }

    const banner = document.getElementById('lockedMonthBanner');
    if (banner) {
      banner.classList.toggle('hidden', !readOnly);
      const bannerMonth = document.getElementById('lockedBannerMonth');
      if (bannerMonth) bannerMonth.textContent = monthLabel;
    }

    // Every control that mutates the selected month.
    const writeControls = [
      'calculateBtn',
      'importTextBtn', 'excelFileInput',
      'transactionEmployeeInput', 'transactionTypeInput', 'transactionAmountInput',
      'transactionDateInput', 'transactionNoteInput',
      'advanceModeratorInput', 'advanceAmountInput', 'advanceDateInput', 'advanceNoteInput',
      'adjustmentModeratorInput', 'adjustmentAmountInput', 'adjustmentDateInput',
      'adjustmentReasonInput'
    ];
    writeControls.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = readOnly;
    });

    // Submit buttons live inside their forms, so they're addressed by form.
    ['transactionForm', 'advanceForm', 'adjustmentForm'].forEach(formId => {
      const form = document.getElementById(formId);
      if (!form) return;
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = readOnly;
    });

    const textArea = document.getElementById('importTextArea');
    if (textArea) textArea.disabled = readOnly;

    // The settlement form is NOT tied to the month on screen: a settlement
    // is validated against the month of its own "last working day" (see
    // FinalSettlementService.calculate), exactly like an advance. So it stays
    // enabled while a locked month is merely being viewed, and the service
    // rejects it if the target month turns out to be closed.
  }

  /**
   * Updates the report-approval action. Approval is only available after a
   * report has been calculated; the actual close lifecycle remains in
   * Months.closeMonth() and is not reimplemented here.
   */
  function updateCloseMonthButtonState() {
    const monthId = state.currentMonthId;
    const month = monthId ? Months.byId(monthId) : null;
    const approveBtn = document.getElementById('approveReportBtn');
    if (!approveBtn) return;

    const approved = !!month && month.status === Months.STATUS.LOCKED;
    // An approved report is reopened only from the Archive, never approved
    // again from the report screen.
    approveBtn.hidden = approved;
    if (approved) return;

    const canApprove = !!month && monthId === Months.activeMonthId() &&
      month.status !== Months.STATUS.LOCKED &&
      !month.archived &&
      !!month.totals;
    approveBtn.disabled = !canApprove;
    approveBtn.title = canApprove
      ? 'اعتماد التقرير وقفل الشهر النشط'
      : (month && monthId !== Months.activeMonthId()
          ? 'لا يمكن اعتماد إلا التقرير الخاص بالشهر النشط'
          : 'لا يمكن اعتماد التقرير قبل حساب تقرير الشهر النشط');
  }

  /** Renders the approval state of the report currently shown on screen.
   * A locked month is the immutable, approved report produced by the
   * existing close-month lifecycle; every open month remains unapproved. */
  function renderReportApprovalStatus() {
    const badge = document.getElementById('reportApprovalBadge');
    const notice = document.getElementById('reportApprovalNotice');
    if (!badge || !notice) return;

    const month = state.currentMonthId ? Months.byId(state.currentMonthId) : null;
    const approved = !!month && month.status === Months.STATUS.LOCKED;
    const calculated = !!month && !!month.totals;

    badge.textContent = approved ? 'معتمد' : 'غير معتمد';
    badge.className = `badge ${approved ? 'badge-active' : 'badge-locked'}`;

    if (approved) {
      notice.innerHTML = '<strong>التقرير معتمد.</strong> تم حفظ النسخة النهائية وقفل الشهر، وهو متاح الآن للعرض فقط في الأرشيف.';
    } else if (!calculated) {
      notice.innerHTML = '<strong>لا يمكن اعتماد التقرير الآن.</strong> احسب التقرير الشهري أولًا، ثم راجع النتائج واضغط «اعتماد التقرير».';
    } else {
      notice.innerHTML = '<strong>التقرير غير معتمد.</strong> راجع النتائج، ثم اضغط «اعتماد التقرير» لحفظ النسخة النهائية وقفل الشهر.';
    }
  }

  /* ============================================================
   * CLOSE MONTH  (زر إنهاء الشهر)
   * ============================================================ */

  /** Runs the read-only Smart Approval review before the existing irreversible
   * confirmation. The report is re-read from Firestore so the assessment is
   * always based on the persisted state rather than a stale visible table. */
  async function openSmartApproval() {
    Permissions.require('reports.approve');
    const monthId = Months.activeMonthId();
    state.pendingApprovalAssessment = null;
    let details = null;
    try {
      details = monthId ? await Months.loadMonthDetails(monthId) : null;
    } catch (err) {
      console.warn('Could not read report for Smart Approval:', err);
    }
    const indexed = monthId ? Months.byId(monthId) : null;
    await SmartApproval.open({
      monthId,
      month: { ...(indexed || {}), ...(details || {}) },
      report: details ? details.report : [],
      totals: details ? details.totals : null,
      departments: Departments.all()
    }, assessment => {
      // Critical findings never expose this callback from SmartApproval.
      state.pendingApprovalAssessment = assessment;
      openCloseMonthModal();
    });
  }

  /**
   * Opens the close-month confirmation, pre-filled with what is about to
   * be frozen plus any warnings worth seeing BEFORE the irreversible step
   * (e.g. an employee still carrying debt forward).
   */
  function openCloseMonthModal() {
    const monthId = Months.activeMonthId();
    if (!monthId) {
      Toast.show('مفيش شهر نشط محدد', 'error');
      return;
    }

    const month = Months.byId(monthId);
    if (month && month.status === Months.STATUS.LOCKED) {
      Toast.show(`شهر ${Utils.monthLabelFromId(monthId)} مقفول بالفعل`, 'error');
      return;
    }
    if (month && month.archived) {
      Toast.show(`شهر ${Utils.monthLabelFromId(monthId)} مؤرشف. ألغِ الأرشفة قبل الاعتماد.`, 'error');
      return;
    }

    // The report must be calculated: closing an uncalculated month would
    // snapshot nothing and lock the month out of ever being calculated.
    const isSelected = state.currentMonthId === monthId;
    const report = isSelected ? state.currentReport : [];
    const hasStoredReport = !!(month && month.totals);

    if (!hasStoredReport && report.length === 0) {
      Toast.show(
        'لازم تحسب تقرير الشهر الأول. افتح "التقرير الشهري" واضغط "حساب".',
        'error'
      );
      return;
    }

    const totals = (month && month.totals)
      ? month.totals
      : Reports.computeTotals(report);
    const employeeCount = (month && month.employeeCount !== null && month.employeeCount !== undefined)
      ? month.employeeCount
      : report.length;

    document.getElementById('closeMonthLabel').textContent = Utils.monthLabelFromId(monthId);

    document.getElementById('closeMonthSummary').innerHTML = `
      <div class="cs-item">
        <div class="cs-value">${Utils.formatNumber(employeeCount)}</div>
        <div class="cs-label">عدد الموظفين</div>
      </div>
      <div class="cs-item">
        <div class="cs-value">${Utils.formatCurrency(totals.finalSalary || 0)}</div>
        <div class="cs-label">صافي الرواتب</div>
      </div>
      <div class="cs-item">
        <div class="cs-value">${Utils.formatCurrency(totals.totalAdvances || 0)}</div>
        <div class="cs-label">إجمالي السلف</div>
      </div>
      <div class="cs-item">
        <div class="cs-value">${Utils.formatCurrency(totals.carriedDebt || 0)}</div>
        <div class="cs-label">ديون مرحّلة</div>
      </div>
      <div class="cs-item">
        <div class="cs-value">${Utils.monthLabelFromId(Utils.nextMonthId(monthId))}</div>
        <div class="cs-label">الشهر التالي</div>
      </div>`;

    // Non-blocking warnings: things the admin should notice, but which are
    // legitimate reasons to close anyway.
    const warnings = [];
    if ((totals.carriedDebt || 0) > 0) {
      warnings.push(
        `فيه ديون مرحّلة بقيمة ${Utils.formatCurrency(totals.carriedDebt)} ` +
        `هتتخصم أوتوماتيك من ${Utils.monthLabelFromId(Utils.nextMonthId(monthId))}.`
      );
    }
    if (isSelected && state.currentReport.length === 0 && hasStoredReport) {
      warnings.push('التقرير المعروض حاليًا فاضي، وهيتم استخدام آخر تقرير محفوظ للشهر.');
    }
    const prevId = Utils.previousMonthId(monthId);
    if (prevId && Months.byId(prevId) && !Months.isLocked(prevId)) {
      warnings.push(
        `شهر ${Utils.monthLabelFromId(prevId)} لسه مفتوح. ` +
        'الأفضل تقفل الشهور بالترتيب عشان الديون المرحّلة تفضل مضبوطة.'
      );
    }

    const warnBox = document.getElementById('closeMonthWarnings');
    if (warnings.length > 0) {
      warnBox.style.display = 'block';
      warnBox.innerHTML = `
        <div class="error-box-title">تنبيهات قبل الإنهاء:</div>
        <ul>${warnings.map(w => `<li>${Utils.escapeHtml(w)}</li>`).join('')}</ul>`;
    } else {
      warnBox.style.display = 'none';
      warnBox.innerHTML = '';
    }

    // Reset the acknowledgement every time, so a previous tick can never
    // carry over into a new confirmation.
    document.getElementById('closeMonthAck').checked = false;
    document.getElementById('confirmCloseMonthBtn').disabled = true;
    document.getElementById('closeMonthModal').classList.add('open');
  }

  function closeCloseMonthModal() {
    document.getElementById('closeMonthModal').classList.remove('open');
  }

  /**
   * Executes the close. All the heavy lifting lives in Months.closeMonth();
   * this function's job is the UI contract around it.
   */
  async function onConfirmCloseMonth() {
    Permissions.require('reports.approve');
    const monthId = Months.activeMonthId();
    if (!monthId) return;

    const assessment = state.pendingApprovalAssessment;
    if (!assessment || assessment.monthId !== monthId || assessment.critical.length) {
      closeCloseMonthModal();
      Toast.show('لازم يكتمل فحص Smart Approval بدون أخطاء مانعة قبل الاعتماد.', 'error');
      openSmartApproval();
      return;
    }

    if (!document.getElementById('closeMonthAck').checked) {
      Toast.show('لازم تأكد إنك موافق على قفل الشهر', 'error');
      return;
    }

    closeCloseMonthModal();
    Loading.show('جاري إنهاء الشهر... من فضلك ما تقفلش الصفحة');

    try {
      const result = await Months.closeMonth(monthId, {
        employees: state.employees,
        advances: state.advances,
        adjustments: state.adjustments,
        departments: Departments.all(),
        settings: state.settings,
        smartApproval: {
          score: assessment.score,
          warningsCount: assessment.warnings.length,
          criticalCount: assessment.critical.length,
          checksCount: assessment.totalChecks
        }
      });

      Toast.show(
        `تم اعتماد تقرير ${Utils.monthLabelFromId(monthId)} بنجاح: Snapshot و Backup و Monthly Summary اتحفظوا، ` +
        `والشهر اتقفل. الشهر النشط الآن: ${Utils.monthLabelFromId(result.nextMonthId)}`,
        'success'
      );

      // Prepare the newly opened month in the background so the app is
      // ready to work on it, then land the admin on the Archive - where
      // the month they just closed now appears.
      if (result.nextMonthId) {
        await selectMonth(result.nextMonthId);
      } else {
        await selectMonth(monthId);
      }

      onMonthsChanged();
      switchView('archive');
      document.getElementById('pageTitle').textContent = 'الأرشيف';
    } catch (err) {
      console.error('closeMonth failed:', err);
      Toast.show('خطأ أثناء إنهاء الشهر: ' + err.message, 'error');
    } finally {
      state.pendingApprovalAssessment = null;
      Loading.hide();
    }
  }

  /* ============================================================
   * ARCHIVE VIEW  (الأرشيف - عرض فقط)
   * ============================================================ */

  function renderArchiveTable() {
    const tbody = document.getElementById('archiveTableBody');
    if (!tbody) return;

    let rows = Months.locked();

    const term = (state.archiveSearchTerm || '').trim();
    if (term) {
      const needle = Utils.normalizeName(term);
      rows = rows.filter(m =>
        Utils.normalizeName(m.label).includes(needle) || m.id.includes(term)
      );
    }

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-state">${
        Months.locked().length === 0
          ? 'لا توجد شهور مقفولة بعد. استخدم "إنهاء الشهر" في صفحة إدارة الشهور.'
          : 'لا يوجد شهر مطابق للبحث'
      }</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(m => {
      const t = m.totals || {};
      return `
      <tr>
        <td>${Utils.escapeHtml(m.label)}</td>
        <td>${m.employeeCount === null ? '—' : Utils.formatNumber(m.employeeCount)}</td>
        <td>${Utils.formatCurrency(t.salary || 0)}</td>
        <td class="${(t.totalBonus || 0) < 0 ? 'text-danger' : 'text-success'}">${
          Utils.formatCurrency(t.totalBonus || 0)}</td>
        <td class="text-danger">${Utils.formatCurrency(t.totalAdvances || 0)}</td>
        <td class="${(t.carriedDebt || 0) > 0 ? 'text-danger' : ''}">${
          Utils.formatCurrency(t.carriedDebt || 0)}</td>
        <td>${m.closedBy ? Utils.escapeHtml(m.closedBy) : '—'}</td>
        <td>${Utils.formatDateTime(m.closedAt)}</td>
        <td class="actions-cell">
          <button class="btn-icon" data-action="details" data-id="${m.id}" title="عرض التفاصيل">👁️</button>
          ${state.userRole === 'admin' ? `<button class="btn btn-danger-outline" data-action="reopen" data-id="${m.id}">إلغاء اعتماد التقرير</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-action="details"]').forEach(btn => {
      btn.addEventListener('click', () => openMonthDetailsModal(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="reopen"]').forEach(btn => {
      btn.addEventListener('click', () => confirmReopenApprovedMonth(btn.dataset.id));
    });
  }

  function confirmReopenApprovedMonth(monthId) {
    const month = Months.byId(monthId);
    if (!month || month.status !== Months.STATUS.LOCKED || state.userRole !== 'admin') return;

    Confirm.show(
      `هل أنت متأكد من إلغاء اعتماد تقرير ${month.label}؟ سيصبح الشهر قابلاً للتعديل مرة أخرى، ولن يتم حذف أي Snapshot أو Backup أو Monthly Summary.`,
      () => reopenApprovedMonth(monthId)
    );
  }

  async function reopenApprovedMonth(monthId) {
    if (state.userRole !== 'admin') {
      Toast.show('غير مصرح لك بإلغاء اعتماد التقرير', 'error');
      return;
    }

    Loading.show('جاري إلغاء اعتماد التقرير وإعادة فتح الشهر...');
    try {
      await Months.reopenMonth(monthId);
      await Months.setActiveMonthId(monthId, { reason: 'report_reopened' });
      await selectMonth(monthId);
      onMonthsChanged();
      switchView('report');
      document.getElementById('pageTitle').textContent = 'التقرير الشهري';
      Toast.show('تم إلغاء اعتماد التقرير. الشهر مفتوح الآن ويمكن تعديله وإعادة حسابه.', 'success');
    } catch (err) {
      console.error('reopenApprovedMonth failed:', err);
      Toast.show('تعذر إلغاء اعتماد التقرير: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  /**
   * Read-only detail view of a closed month.
   *
   * Renders entirely from the month's OWN stored data - including each
   * row's department NAME snapshot - so it shows the month exactly as it
   * was calculated, never today's departments or today's employees. There
   * is no edit path in or out of this modal.
   */
  async function openMonthDetailsModal(monthId) {
    if (!monthId) return;

    Loading.show('جاري تحميل تفاصيل الشهر...');
    try {
      const details = await Months.loadMonthDetails(monthId);
      if (!details) {
        Toast.show('تعذر تحميل تفاصيل الشهر', 'error');
        return;
      }

      state.viewingMonthId = monthId;
      document.getElementById('monthDetailsTitle').textContent =
        `تفاصيل شهر ${details.label}`;

      const totals = details.totals || Reports.computeTotals(details.report);

      document.getElementById('monthDetailsStats').innerHTML = [
        ['عدد الموظفين', Utils.formatNumber(details.report.length)],
        ['إجمالي الرواتب', Utils.formatCurrency(totals.salary || 0)],
        ['إجمالي البونص', Utils.formatCurrency(totals.totalBonus || 0)],
        ['تسويات يدوية', Utils.formatCurrency(totals.totalAdjustments || 0)],
        ['إجمالي السلف', Utils.formatCurrency(totals.totalAdvances || 0)],
        ['دين سابق', Utils.formatCurrency(totals.previousDebt || 0)],
        ['صافي الرواتب', Utils.formatCurrency(totals.finalSalary || 0)],
        ['مرحّل للشهر القادم', Utils.formatCurrency(totals.carriedDebt || 0)],
        ['إجمالي الطلبات', Utils.formatNumber(totals.ordersCount || 0)],
        ['إجمالي الطرود', Utils.formatNumber(totals.totalPackages || 0)],
        ['إجمالي المبيعات', Utils.formatCurrency(totals.totalSales || 0)],
        ['تاريخ الإنهاء', Utils.formatDateTime(details.closedAt)]
      ].map(([label, value]) => `
        <div class="details-stat">
          <div class="v">${value}</div>
          <div class="l">${label}</div>
        </div>`).join('');

      // Department summary, from the month's frozen array.
      const deptBody = document.getElementById('monthDetailsDeptBody');
      const deptRows = Array.isArray(details.departmentTotals) ? details.departmentTotals : [];
      deptBody.innerHTML = deptRows.length === 0
        ? `<tr><td colspan="6" class="empty-state">لا يوجد ملخص أقسام محفوظ لهذا الشهر</td></tr>`
        : deptRows.map(d => `
          <tr>
            <td>${Utils.escapeHtml(d.departmentName || '—')}</td>
            <td>${Utils.formatNumber(d.employeeCount || 0)}</td>
            <td>${Utils.formatCurrency(d.totalSalary || 0)}</td>
            <td class="${(d.totalBonus || 0) < 0 ? 'text-danger' : 'text-success'}">${
              Utils.formatCurrency(d.totalBonus || 0)}</td>
            <td class="text-danger">${Utils.formatCurrency(d.totalAdvances || 0)}</td>
            <td class="text-strong">${Utils.formatCurrency(d.finalSalary || 0)}</td>
          </tr>`).join('');

      // Employee rows, each reading its own stored department name.
      const reportBody = document.getElementById('monthDetailsReportBody');
      reportBody.innerHTML = details.report.length === 0
        ? `<tr><td colspan="9" class="empty-state">لا يوجد تقرير محفوظ لهذا الشهر</td></tr>`
        : details.report.map(r => {
            const prevDebt = Utils.rowPreviousDebt(r);
            const carried = Utils.rowCarriedDebt(r);
            return `
            <tr>
              <td>${Utils.escapeHtml(r.name || '—')}</td>
              <td>${Utils.escapeHtml(Utils.rowDepartmentName(r, '—'))}</td>
              <td>${Utils.formatCurrency(Utils.rowSalary(r))}</td>
              <td class="${(r.totalBonus || 0) < 0 ? 'text-danger' : 'text-success'}">${
                Utils.formatCurrency(r.totalBonus || 0)}</td>
              <td class="${(r.totalAdjustments || 0) < 0 ? 'text-danger' : 'text-success'}">${
                Utils.formatCurrency(r.totalAdjustments || 0)}</td>
              <td class="text-danger">${Utils.formatCurrency(r.totalAdvances || 0)}</td>
              <td class="${prevDebt > 0 ? 'text-danger' : ''}">${Utils.formatCurrency(prevDebt)}</td>
              <td class="text-strong">${Utils.formatCurrency(r.finalSalary || 0)}</td>
              <td class="${carried > 0 ? 'text-danger text-strong' : ''}">${
                Utils.formatCurrency(carried)}</td>
            </tr>`;
          }).join('');

      // Per-month audit trail. Optional: it needs a composite index, and
      // its absence must not block viewing the month.
      const auditEl = document.getElementById('monthDetailsAudit');
      auditEl.innerHTML = '<div class="dist-row"><span class="dist-label">جاري التحميل...</span></div>';
      document.getElementById('monthDetailsModal').classList.add('open');

      const logs = await Months.auditLogsForMonth(monthId, 50);
      auditEl.innerHTML = logs.length === 0
        ? '<div class="dist-row"><span class="dist-label">لا يوجد سجل عمليات لهذا الشهر</span></div>'
        : logs.map(l => `
          <div class="dist-row">
            <span class="dist-label">
              ${severityBadge(l.severity)}
              <span class="audit-action ${auditActionClass(l.action, l.severity)}">${
                Utils.escapeHtml(auditActionLabel(l.action))}</span>
              ${l.documentLabel ? Utils.escapeHtml(l.documentLabel) + ' — ' : ''}
              ${l.userEmail ? Utils.escapeHtml(l.userEmail) : ''}
            </span>
            <span class="dist-value">${Utils.formatDateTime(l.at)}</span>
          </div>`).join('');
    } catch (err) {
      console.error('openMonthDetailsModal failed:', err);
      Toast.show('تعذر تحميل تفاصيل الشهر: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  function closeMonthDetailsModal() {
    document.getElementById('monthDetailsModal').classList.remove('open');
    state.viewingMonthId = null;
  }

  /* ============================================================
   * AUDIT LOG VIEW
   * ------------------------------------------------------------
   * Labels and severities come from AuditService, so a newly registered
   * collection renders correctly here with no change to this file.
   * ============================================================ */

  function auditActionLabel(action) {
    return AuditService.labelFor(action);
  }

  /**
   * CSS class for an action chip.
   *
   * Driven by SEVERITY rather than by a per-action map: that way every future
   * action is coloured correctly the moment it is registered, instead of
   * silently falling through to an unstyled chip.
   */
  function auditActionClass(action, storedSeverity = null) {
    // A bulk operation may intentionally escalate its stored severity above
    // the action's default. The chip must reflect the actual audit entry,
    // not merely the default assigned to that action type.
    const severity = storedSeverity
      ? AuditService.normalizeSeverity(storedSeverity)
      : AuditService.severityOf(action);
    return `audit-sev-${severity}`;
  }

  /** The severity badge shown in its own column. */
  function severityBadge(severity) {
    const level = AuditService.normalizeSeverity(severity);
    const icons = {
      [AuditService.SEVERITY.INFO]: 'ℹ️',
      [AuditService.SEVERITY.WARNING]: '⚠️',
      [AuditService.SEVERITY.CRITICAL]: '🔴'
    };
    return `<span class="sev-badge sev-${level}">${icons[level]} ${
      AuditService.SEVERITY_LABELS[level]}</span>`;
  }

  async function loadAuditLogs(showToast = false) {
    try {
      state.auditLogs = state.auditSeverityFilter === 'all'
        ? await AuditService.getRecent(state.auditLimit)
        : await AuditService.getBySeverity(state.auditSeverityFilter, state.auditLimit);
      renderAuditLogTable();
      renderAuditTimeline();
      renderDashboardStatus();
      if (showToast) Toast.show('تم تحديث سجل العمليات', 'success');
    } catch (err) {
      console.error('loadAuditLogs failed:', err);
    }
  }

  /**
   * Human summary of one entry's payload.
   *
   * Prefers the explicit `changed` field list when present - "اتغير: الراتب,
   * القسم" tells the admin more than any total would - and falls back to the
   * numeric details for lifecycle events that have no before/after.
   */
  function auditDetailText(entry) {
    const d = entry.details || {};
    const extras = [];

    if (Array.isArray(entry.changed) && entry.changed.length > 0) {
      extras.push(`اتغير: ${entry.changed.map(fieldLabel).join('، ')}`);
    }
    if (d.employeeCount !== undefined) extras.push(`${Utils.formatNumber(d.employeeCount)} موظف`);
    if (d.orderCount !== undefined) extras.push(`${Utils.formatNumber(d.orderCount)} طلب`);
    if (d.newEmployeeCount) extras.push(`+${Utils.formatNumber(d.newEmployeeCount)} موظف جديد`);
    if (d.finalSalaryTotal !== undefined) extras.push(Utils.formatCurrency(d.finalSalaryTotal));
    if (d.netAmount !== undefined) extras.push(Utils.formatCurrency(d.netAmount));
    if (d.documentCount !== undefined) extras.push(`${Utils.formatNumber(d.documentCount)} سجل`);
    if (d.added !== undefined || d.updated !== undefined) {
      extras.push(`أضيف ${Utils.formatNumber(d.added || 0)} / حُدّث ${Utils.formatNumber(d.updated || 0)}`);
    }
    if (d.backupTaken) extras.push('📦 نسخة احتياطية');
    if (d.count !== undefined && d.bulk) extras.push(`${Utils.formatNumber(d.count)} سجل`);
    if (d.reason) extras.push(auditReasonLabel(d.reason));
    if (d.note) extras.push(String(d.note));

    return extras.length ? extras.join(' • ') : '—';
  }

  /** Arabic labels for the field names that appear in `changed`. */
  function fieldLabel(field) {
    const map = {
      name: 'الاسم', departmentId: 'القسم', status: 'الحالة',
      hireDate: 'تاريخ التعيين', notes: 'ملاحظات',
      fixedSalaryAmount: 'الراتب الثابت', dailyWorkHours: 'ساعات العمل',
      amount: 'المبلغ', date: 'التاريخ', note: 'ملاحظة', reason: 'السبب',
      monthId: 'الشهر', moderatorName: 'الموظف',
      companyName: 'اسم الشركة', bonusRules: 'جدول البونص', carryDebt: 'ترحيل الديون',
      color: 'اللون', salaryType: 'نوع الراتب', order: 'الترتيب',
      lastWorkingDay: 'آخر يوم عمل', settlementId: 'المخالصة'
    };
    return map[field] || field;
  }

  function renderAuditLogTable() {
    const tbody = document.getElementById('auditLogTableBody');
    if (!tbody) return;

    const query = Utils.normalizeName(state.auditSearchTerm || '');
    const logs = query ? state.auditLogs.filter(entry => {
      const haystack = [
        auditActionLabel(entry.action), entry.entity, entry.operation,
        entry.documentLabel, entry.documentId, entry.userEmail, entry.monthId,
        auditDetailText(entry)
      ].map(value => Utils.normalizeName(String(value || ''))).join(' ');
      return haystack.includes(query);
    }) : state.auditLogs;

    const count = document.getElementById('auditLogCount');
    if (count) count.textContent = `${Utils.formatNumber(logs.length)} من ${Utils.formatNumber(state.auditLogs.length)}`;

    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${
        query
          ? 'لا توجد نتائج مطابقة للبحث'
          : state.auditSeverityFilter === 'all'
          ? 'لا توجد عمليات مسجلة بعد'
          : 'لا توجد عمليات بهذه الدرجة'
      }</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map(l => {
      const monthCell = l.monthId
        ? Utils.escapeHtml(Utils.monthLabelFromId(l.monthId))
        : ((l.details && l.details.monthLabel)
            ? Utils.escapeHtml(l.details.monthLabel) : '—');

      return `
      <tr class="audit-row audit-row-${l.severity}">
        <td>${severityBadge(l.severity)}</td>
        <td><span class="audit-action ${auditActionClass(l.action, l.severity)}">${
          Utils.escapeHtml(auditActionLabel(l.action))}</span></td>
        <td>${l.documentLabel ? Utils.escapeHtml(l.documentLabel) : '—'}</td>
        <td>${monthCell}</td>
        <td>${l.userEmail ? Utils.escapeHtml(l.userEmail) : '—'}</td>
        <td>${Utils.formatDateTime(l.at)}</td>
        <td class="audit-detail">${Utils.escapeHtml(auditDetailText(l))}</td>
      </tr>`;
    }).join('');
  }

  function renderAuditTimeline() {
    const timeline = document.getElementById('auditTimeline');
    if (!timeline) return;
    const query = Utils.normalizeName(state.auditSearchTerm || '');
    const logs = state.auditLogs.filter(l => {
      const text = [auditActionLabel(l.action), l.userEmail, l.monthId, l.documentLabel, auditDetailText(l)].map(x => Utils.normalizeName(String(x || ''))).join(' ');
      const entryDate = Utils.toDateSafe(l.at); const dateValue = entryDate ? entryDate.toISOString().slice(0, 10) : '';
      return (!query || text.includes(query)) && (state.auditMonthFilter === 'all' || l.monthId === state.auditMonthFilter) && (state.auditUserFilter === 'all' || l.userEmail === state.auditUserFilter) && (state.auditActionFilter === 'all' || l.action === state.auditActionFilter) && (!state.auditDateFilter || dateValue === state.auditDateFilter) && (state.auditResultFilter === 'all' || (state.auditResultFilter === 'errors' ? l.severity === AuditService.SEVERITY.CRITICAL : l.severity !== AuditService.SEVERITY.CRITICAL));
    });
    const optionize = (id, values, label, selected) => { const el = document.getElementById(id); if (!el) return; el.innerHTML = `<option value="all">${label}</option>${[...values].filter(Boolean).sort().map(v => `<option value="${Utils.escapeHtml(v)}">${Utils.escapeHtml(v)}</option>`).join('')}`; el.value = selected; };
    optionize('auditMonthFilter', new Set(state.auditLogs.map(l => l.monthId)), 'كل الشهور', state.auditMonthFilter);
    optionize('auditUserFilter', new Set(state.auditLogs.map(l => l.userEmail)), 'كل المستخدمين', state.auditUserFilter);
    optionize('auditActionFilter', new Set(state.auditLogs.map(l => l.action)), 'كل العمليات', state.auditActionFilter);
    document.getElementById('auditTimelineStats').innerHTML = [['إجمالي العمليات', logs.length], ['الاعتمادات', logs.filter(l => l.action === AuditService.ACTION.MONTH_CLOSED).length], ['الاستيراد', logs.filter(l => String(l.action).includes('import')).length], ['الحذف', logs.filter(l => l.operation === AuditService.OPERATION.DELETE).length], ['Backup', logs.filter(l => String(l.action).includes('backup')).length], ['آخر عملية', logs[0] ? auditActionLabel(logs[0].action) : '—']].map(x => `<div><span>${x[0]}</span><strong>${Utils.escapeHtml(String(x[1]))}</strong></div>`).join('');
    if (!logs.length) { timeline.innerHTML = '<div class="empty-state">لا توجد عمليات مطابقة.</div>'; return; }
    const icon = l => l.action === AuditService.ACTION.MONTH_CLOSED ? '✅' : String(l.action).includes('import') ? '🟠' : String(l.action).includes('backup') ? '📦' : l.operation === AuditService.OPERATION.DELETE ? '🗑️' : l.operation === AuditService.OPERATION.UPDATE ? '🔵' : l.operation === AuditService.OPERATION.CREATE ? '🟢' : '📋';
    timeline.innerHTML = logs.map(l => `<article class="audit-timeline-card audit-${l.severity}" data-audit-id="${Utils.escapeHtml(l.id)}"><div class="audit-timeline-icon">${icon(l)}</div><div><div class="audit-timeline-head"><strong>${Utils.escapeHtml(auditActionLabel(l.action))}</strong>${severityBadge(l.severity)}</div><p>${Utils.escapeHtml(auditDetailText(l))}</p><div class="audit-timeline-meta"><span>👤 ${Utils.escapeHtml(l.userEmail || '—')}</span><span>🗓️ ${Utils.escapeHtml(l.monthId ? Utils.monthLabelFromId(l.monthId) : '—')}</span><span>${Utils.formatDateTime(l.at)}</span></div></div></article>`).join('');
  }

  function openAuditDetails(id) { const l = state.auditLogs.find(x => x.id === id); if (!l) return; const d = l.details || {}; const approval = d.smartApproval ? `<p><strong>Approval Score:</strong> ${d.smartApproval.score}% · Warnings: ${d.smartApproval.warningsCount} · Checks: ${d.smartApproval.checksCount}</p>` : ''; const changes = l.changed && l.changed.length ? `<ul>${l.changed.map(k => `<li>${Utils.escapeHtml(fieldLabel(k))}: ${Utils.escapeHtml(String((l.before || {})[k] ?? '—'))} ← ${Utils.escapeHtml(String((l.after || {})[k] ?? '—'))}</li>`).join('')}</ul>` : ''; document.getElementById('auditDetailsBody').innerHTML = `<p><strong>${Utils.escapeHtml(auditActionLabel(l.action))}</strong> — ${Utils.escapeHtml(l.userEmail || '—')}</p><p>${Utils.formatDateTime(l.at)}</p><p>${Utils.escapeHtml(auditDetailText(l))}</p>${approval}${changes}<pre class="audit-details-json">${Utils.escapeHtml(JSON.stringify(d, null, 2))}</pre>`; document.getElementById('auditDetailsModal').classList.add('open'); }

  function auditReasonLabel(reason) {
    const map = {
      manual_selection: 'اختيار يدوي',
      manual_creation: 'إنشاء يدوي',
      auto_created_on_close: 'إنشاء تلقائي عند الإنهاء',
      auto_advanced_on_close: 'انتقال تلقائي عند الإنهاء',
      adopted_newest_existing: 'تهيئة من أحدث شهر',
      initialized_from_server_time: 'تهيئة من وقت السيرفر',
      final_settlement: 'مخالصة نهاية الخدمة',
      manual_reactivation: 'إعادة تفعيل يدوية'
    };
    // Backup triggers share this label space, so a reason that is really a
    // trigger still renders in Arabic instead of falling through as a raw
    // snake_case string.
    return map[reason] || BackupService.TRIGGER_LABELS[reason] || reason;
  }

  /* ============================================================
   * BACKUPS VIEW  (النسخ الاحتياطية)
   * ------------------------------------------------------------
   * Two things happen on this page: taking a manual backup, and restoring
   * from an existing one. Restoring is deliberately a three-step flow -
   * compare, confirm, apply - because it is the only action in the app that
   * overwrites live data wholesale.
   * ============================================================ */

  async function loadBackups(showToast = false) {
    try {
      state.backups = await BackupService.listBackups(100);
      renderBackupsView();
      renderDashboardStatus();
      if (showToast) Toast.show('تم تحديث قائمة النسخ الاحتياطية', 'success');
    } catch (err) {
      console.error('loadBackups failed:', err);
      Toast.show('تعذر تحميل النسخ الاحتياطية: ' + err.message, 'error');
    }
  }

  function renderBackupsView() {
    renderBackupsSummary();
    renderBackupsTable();
  }

  function renderBackupsSummary() {
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    const list = state.backups;
    const manual = list.filter(b => b.type === BackupService.TYPE.MANUAL).length;
    const automatic = list.filter(b => b.type === BackupService.TYPE.AUTOMATIC).length;
    const totalBytes = list.reduce((sum, b) => sum + (b.approxBytes || 0), 0);

    set('cardBackupsTotal', Utils.formatNumber(list.length));
    set('cardBackupsManual', Utils.formatNumber(manual));
    set('cardBackupsAuto', Utils.formatNumber(automatic));
    set('cardBackupsSize', Utils.formatBytes(totalBytes));

    const latest = list[0];
    set('latestBackupLabel', latest
      ? `${latest.name} — ${Utils.formatDateTime(latest.createdAt)}`
      : '—');
  }

  function backupTypeBadge(type) {
    const cls = type === BackupService.TYPE.MANUAL
      ? 'bk-manual'
      : (type === BackupService.TYPE.SCHEDULED ? 'bk-scheduled' : 'bk-auto');
    const icon = type === BackupService.TYPE.MANUAL
      ? '👤' : (type === BackupService.TYPE.SCHEDULED ? '⏰' : '🤖');
    return `<span class="bk-badge ${cls}">${icon} ${
      BackupService.TYPE_LABELS[type] || type}</span>`;
  }

  function renderBackupsTable() {
    const tbody = document.getElementById('backupsTableBody');
    if (!tbody) return;

    if (state.backups.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">
        لا توجد نسخ احتياطية بعد. اضغط "إنشاء نسخة احتياطية الآن" لعمل أول نسخة.
      </td></tr>`;
      return;
    }

    tbody.innerHTML = state.backups.map(b => `
      <tr>
        <td>
          <div class="bk-name">${Utils.escapeHtml(b.name)}</div>
          ${b.note ? `<div class="bk-note">${Utils.escapeHtml(b.note)}</div>` : ''}
        </td>
        <td>${backupTypeBadge(b.type)}</td>
        <td>${Utils.escapeHtml(b.triggerLabel || '—')}</td>
        <td>${Utils.formatNumber(b.collectionCount)}</td>
        <td>${Utils.formatNumber(b.documentCount)}</td>
        <td>${Utils.formatBytes(b.approxBytes)}</td>
        <td>
          <div>${Utils.formatDateTime(b.createdAt)}</div>
          <div class="bk-note">${b.userEmail ? Utils.escapeHtml(b.userEmail) : '—'}</div>
        </td>
        <td class="actions-cell">
          <button class="btn-icon" data-action="restore" data-id="${Utils.escapeHtml(b.id)}"
                  title="استرجاع من هذه النسخة">♻️</button>
          <button class="btn-icon" data-action="download" data-id="${Utils.escapeHtml(b.id)}"
                  title="تحميل JSON">⬇️</button>
        </td>
      </tr>`).join('');

    tbody.querySelectorAll('[data-action="restore"]').forEach(btn => {
      btn.addEventListener('click', () => openRestoreModal(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="download"]').forEach(btn => {
      btn.addEventListener('click', () => onDownloadBackup(btn.dataset.id));
    });
  }

  /** Manual backup, from the button on the Backups page. */
  async function onCreateManualBackup(scope = 'full') {
    Permissions.require('backups.create');
    const scopeLabel = ({ full:'كاملة', orders:'الطلبات فقط', salary_processing:'معالجة الرواتب فقط', settings:'الإعدادات فقط', roles:'الأدوار والصلاحيات فقط', audit:'سجل التدقيق فقط' })[scope] || 'كاملة';
    const rawName = prompt(
      'اسم النسخة الاحتياطية (اختياري — اتركه فاضي للاسم التلقائي):',
      `نسخة ${scopeLabel}`
    );
    // `null` means the admin pressed Cancel; an empty string means they
    // accepted the auto-generated name. Those are different intentions.
    if (rawName === null) return;

    Loading.show('جاري إنشاء نسخة احتياطية...');
    try {
      const backup = await BackupService.createBackup({
        type: BackupService.TYPE.MANUAL,
        trigger: BackupService.TRIGGER.MANUAL,
        scope,
        name: rawName.trim() || undefined,
        note: 'نسخة يدوية من صفحة النسخ الاحتياطية'
      });

      Toast.show(
        `تم إنشاء النسخة: ${Utils.formatNumber(backup.documentCount)} سجل ` +
        `من ${Utils.formatNumber(backup.collectionCount)} مجموعة ` +
        `(${Utils.formatBytes(backup.approxBytes)} تقريبًا)`,
        'success'
      );

      await loadBackups();
      loadAuditLogs();
    } catch (err) {
      console.error('Manual backup failed:', err);
      Toast.show('تعذر إنشاء النسخة الاحتياطية: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  /** Starts the deliberately narrow, recoverable operational-data reset. */
  function onClearOpenOperations() {
    if (state.userRole !== 'admin') {
      Toast.show('تصفير بيانات التشغيل متاح للمسؤول فقط.', 'error');
      return;
    }
    Confirm.show(
      'سيتم حذف السلف والتسويات الخاصة بالشهور المفتوحة فقط بعد إنشاء نسخة احتياطية إلزامية. ' +
      'لن يتم حذف الموظفين أو الأقسام أو الإعدادات أو بيانات الأشهر المقفلة أو التسويات النهائية أو سجل التدقيق. هل تريد المتابعة؟',
      executeClearOpenOperations
    );
  }

  async function executeClearOpenOperations() {
    Loading.show('جاري إنشاء نسخة احتياطية إلزامية قبل التصفير...');
    Loading.setProgress(0);
    try {
      const result = await BackupService.clearOpenOperations({
        onProgress: (done, total) => {
          Loading.setLabel(`جاري تصفير بيانات التشغيل (${done}/${total})...`);
          Loading.setProgress(total ? (done / total) * 100 : 100);
        }
      });
      if (result.cleared === 0) {
        Toast.show('لا توجد سلف أو تسويات قابلة للتصفير في الشهور المفتوحة.', 'info');
        return;
      }
      Toast.show(
        `تم تصفير ${Utils.formatNumber(result.cleared)} عملية ` +
        `(${Utils.formatNumber(result.advances)} سلفة و${Utils.formatNumber(result.adjustments)} تسوية). ` +
        'النسخة الاحتياطية متاحة في صفحة النسخ.',
        'success'
      );
      // Advance/adjustment listeners refresh their respective live state
      // after the committed deletes; only these one-time reads need a nudge.
      await Promise.all([loadBackups(), loadAuditLogs()]);
    } catch (err) {
      console.error('Operational reset failed:', err);
      Toast.show('لم يتم تصفير البيانات: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  async function onDownloadBackup(backupId) {
    Loading.show('جاري تحضير الملف...');
    try {
      await BackupService.downloadBackupJson(backupId);
      Toast.show('تم تحميل ملف النسخة الاحتياطية', 'success');
    } catch (err) {
      Toast.show('تعذر تحميل النسخة: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  /* ============================================================
   * RESTORE FLOW  (compare -> confirm -> apply)
   * ============================================================ */

  /**
   * Step 1: compare the backup against the live data and show the result.
   *
   * Nothing is written here. The comparison is computed from the same data
   * the restore will act on, so what the admin approves is exactly what will
   * happen - the same two-phase design the settlement screen uses.
   */
  async function openRestoreModal(backupId) {
    Loading.show('جاري مقارنة النسخة بالبيانات الحالية...');
    try {
      const comparison = await BackupService.compareWithCurrent(backupId);
      state.pendingRestore = comparison;

      const { manifest, report, totals } = comparison;

      document.getElementById('restoreBackupName').textContent = manifest.name;
      document.getElementById('restoreBackupMeta').textContent = [
        `أُنشئت: ${Utils.formatDateTime(manifest.createdAt)}`,
        manifest.userEmail ? `بواسطة: ${manifest.userEmail}` : null,
        `${Utils.formatNumber(manifest.documentCount)} سجل`,
        `${Utils.formatBytes(manifest.approxBytes)} تقريبًا`,
        manifest.triggerLabel
      ].filter(Boolean).join(' • ');

      document.getElementById('restoreSummary').innerHTML = `
        <div class="cs-item">
          <div class="cs-value text-success">${Utils.formatNumber(totals.toAdd)}</div>
          <div class="cs-label">سجل هيترجع (مش موجود حاليًا)</div>
        </div>
        <div class="cs-item">
          <div class="cs-value text-warning">${Utils.formatNumber(totals.toUpdate)}</div>
          <div class="cs-label">سجل هيتم تعديله للنسخة</div>
        </div>
        <div class="cs-item">
          <div class="cs-value">${Utils.formatNumber(totals.unchanged)}</div>
          <div class="cs-label">سجل زي ما هو</div>
        </div>
        <div class="cs-item">
          <div class="cs-value">${Utils.formatNumber(totals.newerNow)}</div>
          <div class="cs-label">سجل أحدث من النسخة (هيتم تركه)</div>
        </div>
        <div class="cs-item">
          <div class="cs-value">${Utils.formatNumber(totals.skipped)}</div>
          <div class="cs-label">🔒 سجل في شهر مقفول (مش هيتغير)</div>
        </div>`;

      document.getElementById('restoreCompareBody').innerHTML = report.map(r => `
        <tr>
          <td>${Utils.escapeHtml(r.label)}</td>
          <td class="${r.toAdd.length ? 'text-success' : ''}">${Utils.formatNumber(r.toAdd.length)}</td>
          <td class="${r.toUpdate.length ? 'text-warning' : ''}">${Utils.formatNumber(r.toUpdate.length)}</td>
          <td>${Utils.formatNumber(r.unchanged.length)}</td>
          <td>${Utils.formatNumber(r.newerNow.length)}</td>
          <td>${r.skipped.length ? `🔒 ${Utils.formatNumber(r.skipped.length)}` : '—'}</td>
        </tr>`).join('');

      // Warnings the admin should read BEFORE confirming. None of them block
      // the restore - each is a legitimate situation - but each is also a
      // plausible misunderstanding of what restore does.
      const warnings = [];
      if (totals.toAdd === 0 && totals.toUpdate === 0) {
        warnings.push('البيانات الحالية مطابقة للنسخة — الاسترجاع مش هيغيّر أي حاجة.');
      }
      if (totals.newerNow > 0) {
        warnings.push(
          `فيه ${totals.newerNow} سجل اتضافوا بعد تاريخ النسخة. الاسترجاع ` +
          '<strong>مش بيحذف</strong> أي حاجة، فالسجلات دي هتفضل موجودة زي ما هي.'
        );
      }
      if (totals.skipped > 0) {
        warnings.push(
          `فيه ${totals.skipped} سجل في شهور مقفولة، ومش هيتم لمسهم خالص — ` +
          'الشهر المقفول بيانات مدفوعة ومش مسموح تعديلها.'
        );
      }
      warnings.push(
        'هيتم أخذ <strong>نسخة احتياطية تلقائية للحالة الحالية</strong> قبل الاسترجاع، ' +
        'فلو حصل أي مشكلة تقدر ترجع للحالة اللي قبل الاسترجاع.'
      );

      const warnBox = document.getElementById('restoreWarnings');
      warnBox.style.display = 'block';
      warnBox.innerHTML = `
        <div class="error-box-title">قبل الاسترجاع:</div>
        <ul>${warnings.map(w => `<li>${w}</li>`).join('')}</ul>`;

      // Reset the acknowledgement every time, so a previous tick can never
      // carry over into a new confirmation.
      document.getElementById('restoreAck').checked = false;
      document.getElementById('confirmRestoreBtn').disabled = true;
      document.getElementById('restoreModal').classList.add('open');
    } catch (err) {
      console.error('Restore comparison failed:', err);
      Toast.show('تعذر مقارنة النسخة: ' + err.message, 'error');
      state.pendingRestore = null;
    } finally {
      Loading.hide();
    }
  }

  function closeRestoreModal() {
    document.getElementById('restoreModal').classList.remove('open');
    state.pendingRestore = null;
  }

  /** Step 2/3: apply the restore, after the acknowledgement is ticked. */
  async function onConfirmRestore() {
    Permissions.require('backups.restore');
    Permissions.require('backups.create');
    const pending = state.pendingRestore;
    if (!pending) {
      Toast.show('مفيش نسخة محددة للاسترجاع', 'error');
      return;
    }
    if (!document.getElementById('restoreAck').checked) {
      Toast.show('لازم تأكد إنك موافق على الاسترجاع', 'error');
      return;
    }

    const backupId = pending.manifest.id;
    const sensitiveKeys = ['roles', 'users', 'salary_processing'];
    if ((pending.manifest.collectionKeys || []).some(key => sensitiveKeys.includes(key))) {
      Permissions.require('roles.manage');
    }
    const backupName = pending.manifest.name;
    closeRestoreModal();

    Loading.show('جاري أخذ نسخة احتياطية للحالة الحالية ثم الاسترجاع...');
    try {
      const result = await BackupService.restoreBackup(backupId);
      const a = result.applied;

      Toast.show(
        `تم الاسترجاع من "${backupName}": ` +
        `${Utils.formatNumber(a.added)} سجل رجع، ` +
        `${Utils.formatNumber(a.updated)} سجل اتحدّث` +
        (a.skipped ? `، ${Utils.formatNumber(a.skipped)} اتجاهلوا (شهور مقفولة)` : ''),
        'success'
      );

      if (!result.safetyBackup) {
        Toast.show(
          'تنبيه: تعذر أخذ نسخة احتياطية للحالة السابقة قبل الاسترجاع',
          'error'
        );
      }

      // The employees/advances/adjustments listeners re-render themselves, but
      // departments and the month index are loaded explicitly.
      await loadSettings();
      await loadBackups();
      loadAuditLogs();
      renderDashboard();
      renderEmployeesTable();
      renderLedger();
    } catch (err) {
      console.error('Restore failed:', err);
      Toast.show('تعذر الاسترجاع: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  /* ============================================================
   * DEPARTMENTS (الأقسام)
   * ------------------------------------------------------------
   * Departments are dynamic Firestore documents - nothing in the UI
   * hardcodes a department name. They are archived, never deleted,
   * because historical reports reference them forever.
   * ============================================================ */

  /** Human label for the active scope, used in headings and exports. */
  function currentScopeLabel() {
    if (state.departmentFilter === 'all') return 'كل الأقسام';
    return Departments.nameOf(state.departmentFilter);
  }

  function renderScopeLabels() {
    const label = currentScopeLabel();
    ['dashboardScopeLabel', 'reportScopeLabel'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = label;
    });
  }

  /** Fills every <select> that picks a department (employee form, filters). */
  function renderDepartmentOptions() {
    const activeDepts = Departments.active();

    const empSelect = document.getElementById('employeeDepartmentInput');
    if (empSelect) {
      const keep = empSelect.value;
      empSelect.innerHTML = activeDepts
        .map(d => `<option value="${Utils.escapeHtml(d.id)}">${Utils.escapeHtml(d.name)}</option>`)
        .join('');
      if (keep && activeDepts.some(d => d.id === keep)) empSelect.value = keep;
    }

    const empFilter = document.getElementById('employeeDeptFilter');
    if (empFilter) {
      const keep = empFilter.value;
      empFilter.innerHTML = `<option value="all">كل الأقسام</option>` +
        Departments.all().map(d => `<option value="${Utils.escapeHtml(d.id)}">${
          Utils.escapeHtml(d.name)}${d.status === Departments.STATUS.ARCHIVED ? ' (مؤرشف)' : ''
        }</option>`).join('');
      empFilter.value = (keep && (keep === 'all' || Departments.exists(keep))) ? keep : 'all';
    }

    // The inactive-employees page has its own department filter, built from
    // the full department list (including archived ones, since a former
    // employee may well have belonged to a department that has since been
    // retired).
    const inactiveFilter = document.getElementById('inactiveDeptFilter');
    if (inactiveFilter) {
      const keep = inactiveFilter.value;
      inactiveFilter.innerHTML = `<option value="all">كل الأقسام</option>` +
        Departments.all().map(d => `<option value="${Utils.escapeHtml(d.id)}">${
          Utils.escapeHtml(d.name)}${d.status === Departments.STATUS.ARCHIVED ? ' (مؤرشف)' : ''
        }</option>`).join('');
      inactiveFilter.value = (keep && (keep === 'all' || Departments.exists(keep))) ? keep : 'all';
    }
  }

  function renderImportDepartmentOptions() {
    const select = document.getElementById('importDepartmentSelect');
    if (!select) return;
    const selected = select.value || 'auto';
    select.innerHTML = '<option value="auto">تحديد تلقائي حسب القسم المعروض</option>' + Departments.active().map(d => `<option value="${Utils.escapeHtml(d.id)}">${Utils.escapeHtml(d.name)}</option>`).join('');
    select.value = [...select.options].some(o => o.value === selected) ? selected : 'auto';
  }

  async function loadImportHistory() {
    const body = document.getElementById('importHistoryBody');
    if (!body || !state.currentMonthId) return;
    body.innerHTML = '<tr><td colspan="8" class="empty-cell">جاري تحميل سجل الاستيراد…</td></tr>';
    try {
      const snap = await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(state.currentMonthId).collection(MONTH_SUBCOLLECTIONS.ORDER_BATCHES).orderBy('importedAt', 'desc').get();
      body.innerHTML = snap.docs.map(doc => { const b = doc.data() || {}; return `<tr><td>${Utils.escapeHtml(b.fileName || 'استيراد')}</td><td>${Utils.escapeHtml(b.importedBy || '—')}</td><td>${Utils.formatDateTime(b.importedAt)}</td><td>${Utils.formatNumber(b.count || 0)}</td><td>${Utils.formatNumber((b.autoCreatedEmployeeIds || []).length)}</td><td>${Utils.escapeHtml(b.importDepartmentName || 'تلقائي')}</td><td>${Utils.formatNumber(b.errorCount || 0)}</td><td><span class="badge badge-success">تم الاستيراد</span></td></tr>`; }).join('') || '<tr><td colspan="8" class="empty-cell">لا توجد عمليات استيراد لهذا الشهر.</td></tr>';
    } catch (err) { console.error('Import history load failed:', err); body.innerHTML = '<tr><td colspan="8" class="empty-cell">تعذر تحميل سجل الاستيراد.</td></tr>'; }
  }

  /** Live employee headcount per department (active employees only). */
  function employeeCountByDepartment(departmentId) {
    return state.employees.filter(e =>
      employeeDepartmentId(e) === departmentId && e.status !== 'inactive'
    ).length;
  }

  function renderDepartmentsTable() {
    const tbody = document.getElementById('departmentsTableBody');
    if (!tbody) return;

    const rows = state.showArchivedDepartments
      ? Departments.all()
      : Departments.active();

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${
        Departments.all().length === 0
          ? 'لا توجد أقسام بعد. اضغط "إضافة قسم" للبدء.'
          : 'لا توجد أقسام مؤرشفة'
      }</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(d => {
      const isArchived = d.status === Departments.STATUS.ARCHIVED;
      const count = employeeCountByDepartment(d.id);
      const isFixedDept = d.salaryType === Departments.SALARY_TYPE.FIXED;
      const salaryTypeLabel = isFixedDept
        ? '<span class="badge badge-info">راتب ثابت (بدون بونص)</span>'
        : '<span class="badge badge-active">بونص</span>';
      const overrides = isFixedDept
        ? '<span class="text-muted-inline">لا يوجد بونص</span>'
        : (d.bonusRules
            ? '<span class="badge badge-info">مخصص</span>'
            : '<span class="text-muted-inline">افتراضي</span>');

      return `
      <tr class="${isArchived ? 'row-archived' : ''}">
        <td>
          <span class="dept-chip">
            <span class="dept-dot" style="background:${Utils.escapeHtml(d.color)}"></span>
            ${Utils.escapeHtml(d.name)}
          </span>
        </td>
        <td>${salaryTypeLabel}</td>
        <td>${overrides}</td>
        <td>${Utils.formatNumber(count)}</td>
        <td>${isArchived
          ? '<span class="badge badge-archived">مؤرشف</span>'
          : '<span class="badge badge-active">نشط</span>'}</td>
        <td class="actions-cell">
          <button class="btn-icon" data-action="edit" data-id="${d.id}" title="تعديل">✏️</button>
          ${isArchived
            ? `<button class="btn-icon" data-action="restore" data-id="${d.id}" title="استعادة">♻️</button>`
            : `<button class="btn-icon btn-danger" data-action="archive" data-id="${d.id}" title="أرشفة">📦</button>`}
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', () => openDepartmentModal(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="archive"]').forEach(btn => {
      btn.addEventListener('click', () => onArchiveDepartment(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="restore"]').forEach(btn => {
      btn.addEventListener('click', () => onRestoreDepartment(btn.dataset.id));
    });
  }

  function renderSettingsBonusDepartments() {
    const wrap = document.getElementById('settingsBonusDepartments');
    if (!wrap) return;
    wrap.innerHTML = Departments.active().map(d => `<div class="settings-department-row"><div><strong>${Utils.escapeHtml(d.name)}</strong><span class="badge ${d.bonusRules ? 'badge-active' : 'badge-archived'}">${d.bonusRules ? 'جدول خاص' : 'الجدول الافتراضي'}</span></div><button type="button" class="btn btn-sm" data-settings-dept-bonus="${Utils.escapeHtml(d.id)}">إدارة</button></div>`).join('') || '<div class="empty-cell">لا توجد أقسام نشطة.</div>';
    wrap.querySelectorAll('[data-settings-dept-bonus]').forEach(btn => btn.addEventListener('click', () => openDepartmentModal(btn.dataset.settingsDeptBonus)));
  }

  function openDepartmentModal(id = null) {
    const modal = document.getElementById('departmentModal');
    const form = document.getElementById('departmentForm');
    form.reset();
    document.getElementById('departmentIdInput').value = id || '';

    const bonusToggle = document.getElementById('departmentBonusToggle');
    const bonusGrid = document.getElementById('departmentBonusGrid');
    const salaryTypeSelect = document.getElementById('departmentSalaryTypeInput');

    if (id) {
      const dept = Departments.byId(id);
      if (!dept) return;
      document.getElementById('departmentModalTitle').textContent = 'تعديل قسم';
      document.getElementById('departmentNameInput').value = dept.name;
      document.getElementById('departmentColorInput').value = dept.color;
      document.getElementById('departmentNotesInput').value = dept.notes || '';
      salaryTypeSelect.value = dept.salaryType || Departments.SALARY_TYPE.HOURLY;

      bonusToggle.checked = dept.useBonusOverride === true || !!dept.bonusRules;
      document.getElementById('departmentBonusType').value = dept.bonusType || (dept.salaryType === Departments.SALARY_TYPE.COMMISSION ? 'sales' : 'packages');
      window._departmentSalesBonusRules = Array.isArray(dept.salesBonusRules) ? dept.salesBonusRules.slice() : [];
      fillDepartmentBonusInputs(dept.bonusRules || state.settings.bonusRules);
    } else {
      document.getElementById('departmentModalTitle').textContent = 'إضافة قسم';
      document.getElementById('departmentColorInput').value = Departments.DEFAULT_COLOR;
      salaryTypeSelect.value = Departments.SALARY_TYPE.HOURLY;
      bonusToggle.checked = false;
      document.getElementById('departmentBonusType').value = 'packages'; window._departmentSalesBonusRules = [];
      fillDepartmentBonusInputs(state.settings.bonusRules);
    }

    bonusGrid.classList.toggle('hidden', !bonusToggle.checked);
    document.getElementById('departmentBonusTypeWrap').classList.toggle('hidden', !bonusToggle.checked);
    document.getElementById('addDepartmentSalesTier').classList.toggle('hidden', !bonusToggle.checked);
    renderDepartmentSalesRules();
    document.getElementById('departmentHourlyFieldsWrap')
      .classList.toggle('hidden', salaryTypeSelect.value === Departments.SALARY_TYPE.FIXED);
    modal.classList.add('open');
  }

  function fillDepartmentBonusInputs(rules) {
    const r = Object.assign({}, Utils.DEFAULT_BONUS_RULES, rules || {});
    const map = {
      deptBonus1: '1', deptBonus2: '2', deptBonus3: '3', deptBonus4: '4',
      deptBonus5: '5', deptBonus6_9: '6_9', deptBonus10plus: '10+'
    };
    Object.entries(map).forEach(([elId, key]) => {
      const el = document.getElementById(elId);
      if (el) el.value = r[key];
    });
  }

  function readDepartmentBonusInputs() {
    return {
      '1': Number(document.getElementById('deptBonus1').value) || 0,
      '2': Number(document.getElementById('deptBonus2').value) || 0,
      '3': Number(document.getElementById('deptBonus3').value) || 0,
      '4': Number(document.getElementById('deptBonus4').value) || 0,
      '5': Number(document.getElementById('deptBonus5').value) || 0,
      '6_9': Number(document.getElementById('deptBonus6_9').value) || 0,
      '10+': Number(document.getElementById('deptBonus10plus').value) || 0
    };
  }

  function closeDepartmentModal() {
    document.getElementById('departmentModal').classList.remove('open');
  }

  async function onSaveDepartment(e) {
    e.preventDefault();
    const id = document.getElementById('departmentIdInput').value;
    const useCustomBonus = document.getElementById('departmentBonusToggle').checked;

    const payload = {
      name: document.getElementById('departmentNameInput').value,
      color: document.getElementById('departmentColorInput').value,
      notes: document.getElementById('departmentNotesInput').value.trim(),
      salaryType: document.getElementById('departmentSalaryTypeInput').value,
      bonusRules: useCustomBonus ? readDepartmentBonusInputs() : null,
      useBonusOverride: useCustomBonus,
      bonusType: useCustomBonus ? document.getElementById('departmentBonusType').value : null,
      salesBonusRules: useCustomBonus ? (window._departmentSalesBonusRules || []) : []
    };

    Loading.show();
    try {
      if (id) {
        await Departments.update(id, payload);
        Toast.show('تم تحديث القسم. التقارير القديمة مش هتتأثر', 'success');
      } else {
        await Departments.create(payload);
        Toast.show('تم إضافة القسم', 'success');
      }
      closeDepartmentModal();
    } catch (err) {
      Toast.show('خطأ: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  function renderDepartmentSalesRules() {
    const wrap=document.getElementById('departmentSalesBonusRules'); if(!wrap)return;
    const sales=document.getElementById('departmentBonusType').value==='sales';
    document.getElementById('departmentBonusGrid').classList.toggle('hidden', !document.getElementById('departmentBonusToggle').checked || sales);
    wrap.classList.toggle('hidden', !sales);
    wrap.innerHTML=(window._departmentSalesBonusRules||[]).map((r,i)=>`<div class="sales-tier"><input data-dsf="${i}" value="${r.from}"><input data-dst="${i}" value="${r.to}"><input data-dsb="${i}" value="${r.bonus}"><button type="button" data-dsd="${i}">حذف</button></div>`).join('');
    wrap.querySelectorAll('input').forEach(el=>el.oninput=()=>{const i=Number(el.dataset.dsf??el.dataset.dst??el.dataset.dsb);const key=el.dataset.dsf?'from':el.dataset.dst?'to':'bonus';window._departmentSalesBonusRules[i][key]=Number(el.value)||0;});
    wrap.querySelectorAll('[data-dsd]').forEach(b=>b.onclick=()=>{window._departmentSalesBonusRules.splice(Number(b.dataset.dsd),1);renderDepartmentSalesRules();});
  }

  /**
   * Archiving is blocked while the department still has active employees:
   * an employee must always belong to exactly one LIVE department, and
   * silently orphaning them would break the next salary calculation.
   */
  function onArchiveDepartment(id) {
    const dept = Departments.byId(id);
    if (!dept) return;

    const count = employeeCountByDepartment(id);
    if (count > 0) {
      Toast.show(
        `مش هينفع تأرشف "${dept.name}" وفيه ${count} موظف نشط. انقلهم لقسم تاني الأول`,
        'error'
      );
      return;
    }

    if (Departments.active().length <= 1) {
      Toast.show('لازم يفضل قسم نشط واحد على الأقل', 'error');
      return;
    }

    Confirm.show(
      `هل تريد أرشفة قسم "${dept.name}"؟ القسم مش هيتحذف نهائيًا، وهيفضل ظاهر في كل التقارير القديمة زي ما هو.`,
      async () => {
        Loading.show();
        try {
          await Departments.archive(id);
          Toast.show('تم أرشفة القسم', 'success');
        } catch (err) {
          Toast.show('خطأ: ' + err.message, 'error');
        } finally {
          Loading.hide();
        }
      }
    );
  }

  function onRestoreDepartment(id) {
    const dept = Departments.byId(id);
    if (!dept) return;
    Loading.show();
    Departments.restore(id)
      .then(() => Toast.show('تم استعادة القسم', 'success'))
      .catch(err => Toast.show('خطأ: ' + err.message, 'error'))
      .finally(() => Loading.hide());
  }

  /* ============================================================
   * EMPLOYEE CRUD (الموظفون)
   * ============================================================ */

  function populateEmployeeDatalist() {
    const list = document.getElementById('moderatorDatalist');
    if (!list) return;
    list.innerHTML = state.employees
      .map(m => `<option value="${Utils.escapeHtml(m.name)}">`).join('');
  }

  /** Small coloured chip showing an employee's department. */
  function departmentChip(departmentId) {
    const dept = Departments.byId(departmentId);
    if (!dept) return '<span class="text-muted-inline">بدون قسم</span>';
    return `<span class="dept-chip">
      <span class="dept-dot" style="background:${Utils.escapeHtml(dept.color)}"></span>
      ${Utils.escapeHtml(dept.name)}${dept.status === Departments.STATUS.ARCHIVED ? ' (مؤرشف)' : ''}
    </span>`;
  }

  function renderEmployeesTable() {
    const tbody = document.getElementById('moderatorsTableBody');
    if (!tbody) return;

    const term = Utils.normalizeName(state.employeeSearchTerm);
    const deptFilterEl = document.getElementById('employeeDeptFilter');
    const deptFilter = deptFilterEl ? deptFilterEl.value : 'all';

    const rows = state.employees.filter(m => {
      if (term && !(m.normalizedName || '').includes(term)) return false;
      if (deptFilter !== 'all' && employeeDepartmentId(m) !== deptFilter) return false;
      return true;
    });

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">${
        state.employees.length === 0
          ? 'لا يوجد موظفون بعد. اضغط "إضافة موظف" للبدء.'
          : 'لا يوجد موظف مطابق'
      }</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(m => {
      const deptId = employeeDepartmentId(m);
      const fixedSalaryCell = `<input type="number" class="fixed-salary-inline-input" min="0" step="0.01"
             data-id="${m.id}" value="${m.fixedSalaryAmount || ''}" placeholder="0">`;

      return `
      <tr>
        <td>${Utils.escapeHtml(m.name)}</td>
        <td>${departmentChip(deptId)}</td>
        <td>${fixedSalaryCell}</td>
        <td>${Utils.formatHours(m.dailyWorkHours)}</td>
        <td>${m.status === 'inactive'
          ? '<span class="badge badge-archived">غير نشط</span>'
          : '<span class="badge badge-active">نشط</span>'}</td>
        <td>${m.hireDate ? Utils.escapeHtml(m.hireDate) : '—'}</td>
        <td class="cell-notes" title="${Utils.escapeHtml(m.notes || '')}">${
          m.notes ? Utils.escapeHtml(m.notes) : '—'}</td>
        <td class="actions-cell">
          <button class="btn-icon" data-action="edit" data-id="${m.id}" title="تعديل">✏️</button>
          <button class="btn-icon btn-danger" data-action="delete" data-id="${m.id}" title="حذف">🗑️</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', () => openEmployeeModal(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', () => onDeleteEmployee(btn.dataset.id));
    });
    tbody.querySelectorAll('.fixed-salary-inline-input').forEach(input => {
      input.addEventListener('change', onInlineFixedSalaryChange);
    });
  }

  /**
   * Saves a fixed-salary edit made directly from the Employees table,
   * without opening the full edit modal. Mirrors the validation used in
   * onSaveEmployee so a bad value can never reach Firestore from here.
   */
  async function onInlineFixedSalaryChange(e) {
    const input = e.target;
    const id = input.dataset.id;
    const emp = state.employees.find(m => m.id === id);
    if (!emp) return;

    const n = Utils.toFiniteNumber(input.value);
    if (n === null || n < 0) {
      Toast.show('الراتب الشهري الثابت غير صالح', 'error');
      input.value = emp.fixedSalaryAmount || '';
      return;
    }

    const fixedSalaryAmount = Utils.round2(n);
    input.classList.remove('saved', 'save-error');
    input.disabled = true;
    try {
      // Routed through DataLayer like every other write, so a salary changed
      // straight from the table is audited identically to one changed in the
      // modal - the quick path is exactly as traceable as the slow one.
      const result = await DataLayer.update('employees', id, { fixedSalaryAmount });

      input.classList.add('saved');
      setTimeout(() => input.classList.remove('saved'), 2000);

      if (result.noop) {
        Toast.show('الراتب زي ما هو - مفيش تغيير', 'info');
      } else {
        Toast.show(`تم تحديث راتب ${emp.name}`, 'success');
        UndoService.offer(
          result.undo,
          `تم تعديل راتب "${emp.name}" إلى ${Utils.formatCurrency(fixedSalaryAmount)}`
        );
      }
    } catch (err) {
      input.classList.add('save-error');
      Toast.show('خطأ أثناء الحفظ: ' + err.message, 'error');
      // Put the previous value back, so the cell never shows a figure that
      // was rejected by the database.
      input.value = emp.fixedSalaryAmount || '';
    } finally {
      input.disabled = false;
    }
  }

  function openEmployeeModal(id = null) {
    const modal = document.getElementById('moderatorModal');
    const form = document.getElementById('moderatorForm');
    form.reset();
    document.getElementById('moderatorIdInput').value = id || '';

    renderDepartmentOptions();
    const deptSelect = document.getElementById('employeeDepartmentInput');

    if (id) {
      const emp = state.employees.find(m => m.id === id);
      if (!emp) return;
      document.getElementById('moderatorModalTitle').textContent = 'تعديل موظف';
      document.getElementById('moderatorNameInput').value = emp.name;
      document.getElementById('employeeStatusInput').value = emp.status || 'active';
      document.getElementById('employeeHireDateInput').value = emp.hireDate || '';
      document.getElementById('employeeNotesInput').value = emp.notes || '';
      document.getElementById('employeeFixedSalaryInput').value =
        emp.fixedSalaryAmount ? emp.fixedSalaryAmount : '';
      document.getElementById('employeeDailyHoursInput').value =
        (emp.dailyWorkHours === null || emp.dailyWorkHours === undefined) ? '' : emp.dailyWorkHours;

      const deptId = employeeDepartmentId(emp);
      // An employee sitting in an archived department keeps showing it -
      // the option is injected so saving doesn't silently move them.
      if (deptId && !Array.from(deptSelect.options).some(o => o.value === deptId)) {
        const dept = Departments.byId(deptId);
        const opt = document.createElement('option');
        opt.value = deptId;
        opt.textContent = dept ? `${dept.name} (مؤرشف)` : deptId;
        deptSelect.appendChild(opt);
      }
      deptSelect.value = deptId;
    } else {
      document.getElementById('moderatorModalTitle').textContent = 'إضافة موظف';
      document.getElementById('employeeStatusInput').value = 'active';
      // Default to the department currently being viewed, which is almost
      // always the one the admin is adding into.
      const preferred = (state.departmentFilter !== 'all' &&
                         !Departments.isArchived(state.departmentFilter))
        ? state.departmentFilter : Departments.defaultId();
      if (preferred) deptSelect.value = preferred;
    }
    modal.classList.add('open');
  }

  function closeEmployeeModal() {
    document.getElementById('moderatorModal').classList.remove('open');
  }

  async function onSaveEmployee(e) {
    Permissions.require(document.getElementById('moderatorIdInput').value ? 'employees.write' : 'employees.write');
    e.preventDefault();
    const id = document.getElementById('moderatorIdInput').value;
    const rawName = document.getElementById('moderatorNameInput').value;
    const name = Utils.cleanDisplayName(rawName);
    const departmentId = document.getElementById('employeeDepartmentInput').value;
    const status = document.getElementById('employeeStatusInput').value === 'inactive'
      ? 'inactive' : 'active';
    const hireDate = document.getElementById('employeeHireDateInput').value || null;
    const notes = document.getElementById('employeeNotesInput').value.trim();

    if (!name) { Toast.show('اسم الموظف مطلوب', 'error'); return; }
    if (!departmentId) { Toast.show('لازم تختار القسم', 'error'); return; }
    if (!Departments.exists(departmentId)) { Toast.show('القسم المختار غير موجود', 'error'); return; }

    // Every employee (regardless of department) has a fixed monthly
    // salary, entered manually by the admin here.
    const rawFixed = document.getElementById('employeeFixedSalaryInput').value;
    const fixedN = Utils.toFiniteNumber(rawFixed);
    if (fixedN === null || fixedN < 0) {
      Toast.show('الراتب الشهري الثابت غير صالح', 'error');
      return;
    }
    const fixedSalaryAmount = Utils.round2(fixedN);

    // Reference-only "hours worked per day" - optional, never used in any
    // salary calculation.
    const rawDailyHours = document.getElementById('employeeDailyHoursInput').value;
    let dailyWorkHours = null;
    if (rawDailyHours !== '') {
      const h = Utils.toFiniteNumber(rawDailyHours);
      if (h === null || h < 0) {
        Toast.show('عدد ساعات العمل غير صالح', 'error');
        return;
      }
      dailyWorkHours = h;
    }

    const normalizedName = Utils.normalizeName(name);

    // Prevent duplicate employees (same normalized name, different doc)
    const dup = state.employees.find(m => m.normalizedName === normalizedName && m.id !== id);
    if (dup) { Toast.show('يوجد موظف بنفس الاسم بالفعل', 'error'); return; }

    Loading.show();
    try {
      if (id) {
        // Note: changing an employee's department affects FUTURE
        // calculations only. Historical reports keep the department they
        // were calculated under, snapshot name included.
        const result = await DataLayer.update('employees', id, {
          name, normalizedName, departmentId, status, hireDate, notes,
          fixedSalaryAmount, dailyWorkHours
        });

        if (result.noop) {
          Toast.show('مفيش تغييرات للحفظ', 'info');
        } else {
          Toast.show('تم تحديث بيانات الموظف', 'success');
          UndoService.offer(result.undo, `تم تعديل بيانات "${name}"`);
        }
      } else {
        const result = await DataLayer.create('employees', {
          name, normalizedName, departmentId, status, hireDate, notes,
          fixedSalaryAmount, dailyWorkHours
        });
        Toast.show('تم إضافة الموظف', 'success');
        UndoService.offer(result.undo, `تم إضافة الموظف "${name}"`);
      }
      closeEmployeeModal();
    } catch (err) {
      Toast.show('خطأ: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  /**
   * Deletes an employee.
   *
   * DataLayer takes an automatic backup first (employees are registered with
   * `backupBeforeDelete`), logs the full prior document as `before` at
   * CRITICAL severity, and returns an undo descriptor that recreates the
   * person under their ORIGINAL id - which is what keeps every historical
   * report row, advance and settlement still pointing at them.
   */
  function onDeleteEmployee(id) {
    const emp = state.employees.find(m => m.id === id);
    if (!emp) return;
    Confirm.show(
      `هل تريد حذف الموظف "${emp.name}"؟ لن يتم حذف بيانات الشهور السابقة، ` +
      'وهيتم أخذ نسخة احتياطية تلقائية قبل الحذف.',
      async () => {
        Loading.show('جاري أخذ نسخة احتياطية والحذف...');
        try {
          const result = await DataLayer.remove('employees', id, {
            backupTrigger: BackupService.TRIGGER.BEFORE_EMPLOYEE_DELETE
          });
          Toast.show('تم حذف الموظف', 'success');
          UndoService.offer(result.undo, `تم حذف الموظف "${emp.name}"`);
        } catch (err) {
          Toast.show('خطأ: ' + err.message, 'error');
        } finally {
          Loading.hide();
        }
      }
    );
  }

  /* ============================================================
   * BONUS RULES RESOLUTION
   * ------------------------------------------------------------
   * Bonus is only earned by employees in "بونص" departments (i.e. any
   * department where Departments.isFixed() is false). Fixed-salary
   * departments never earn a bonus at all.
   * ============================================================ */

  /** Bonus rules for one employee in the CURRENT month. */
  function bonusRulesForEmployee(emp) {
    const deptId = employeeDepartmentId(emp);
    return Utils.resolveDepartmentBonusRules(
      deptId,
      state.currentMonthDepartmentBonusRules,
      state.currentMonthBonusRules,
      Departments.bonusRulesOf(deptId)
    );
  }


  /* ============================================================
   * ADVANCES (السلف) - moderator loans/advances deducted from that
   * month's final salary
   * ============================================================ */

  function listenAdvances() {
    state.unsubAdvances = db.collection(COLLECTIONS.ADVANCES)
      .orderBy('date', 'desc')
      .onSnapshot((snap) => {
        state.advances = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderLedger();
        renderDashboard();
      }, (err) => Toast.show('خطأ في تحميل السلف: ' + err.message, 'error'));
  }

  async function onAddAdvance(e) {
    e.preventDefault();
    const rawName = document.getElementById('advanceModeratorInput').value;
    const amount = Number(document.getElementById('advanceAmountInput').value);
    const date = document.getElementById('advanceDateInput').value;
    const note = document.getElementById('advanceNoteInput').value.trim();

    const emp = Utils.findBestModeratorMatch(rawName, state.employees);
    if (!emp) { Toast.show('لم يتم العثور على موظف بهذا الاسم، تأكد من إضافته أولاً في صفحة الموظفين', 'error'); return; }
    if (!Number.isFinite(amount) || amount <= 0) { Toast.show('مبلغ السلفة غير صالح', 'error'); return; }
    if (!date) { Toast.show('الرجاء اختيار تاريخ الصرف', 'error'); return; }

    const monthId = date.slice(0, 7); // "YYYY-MM-DD" -> "YYYY-MM"

    // The advance belongs to the month of its own DATE, which may differ
    // from the month on screen - so the lock check is against that month,
    // not the selected one. Back-dating an advance into a closed month
    // would silently change a payroll that has already been signed off.
    //
    // DataLayer re-runs this same assertion from the record's monthField
    // before it writes; checking here too keeps the error immediate and
    // avoids showing a loading overlay for a write that can't succeed.
    try {
      Months.assertEditable(monthId, 'تسجيل السلف');
    } catch (err) {
      Toast.show(err.message, 'error');
      return;
    }

    Loading.show();
    try {
      const result = await DataLayer.create('advances', {
        // moderatorId is kept as the field name: every historical advance
        // already uses it and the report joins on it.
        moderatorId: emp.id,
        moderatorName: emp.name,
        // Denormalized for future per-department advance reporting. The
        // salary calculation never reads it - it always resolves the
        // department from the employee record - so an employee moving
        // department can't corrupt an existing advance.
        departmentId: employeeDepartmentId(emp),
        amount, date, note, monthId
      });
      document.getElementById('advanceForm').reset();
      Toast.show('تم تسجيل السلفة', 'success');
      UndoService.offer(
        result.undo,
        `تم تسجيل سلفة ${Utils.formatCurrency(amount)} لـ"${emp.name}"`
      );
    } catch (err) {
      Toast.show('خطأ: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  function onDeleteAdvance(id) {
    const advance = state.advances.find(a => a.id === id);
    // Deleting an advance rewrites the month it belongs to, so a closed
    // month's advances are as immutable as its report. Fail CLOSED when the
    // record isn't in local state: we can't prove its month is open, and
    // guessing in the permissive direction is how a locked month gets
    // silently edited.
    if (!advance) {
      Toast.show('تعذر التحقق من شهر السلفة، حدّث الصفحة وحاول تاني', 'error');
      return;
    }
    try {
      Months.assertEditable(advance.monthId, 'حذف السلف');
    } catch (err) {
      Toast.show(err.message, 'error');
      return;
    }

    Confirm.show('هل تريد حذف هذه السلفة؟', async () => {
      Loading.show();
      try {
        const result = await DataLayer.remove('advances', id);
        Toast.show('تم حذف السلفة', 'success');
        UndoService.offer(
          result.undo,
          `تم حذف سلفة ${Utils.formatCurrency(advance.amount || 0)} لـ"${advance.moderatorName || ''}"`
        );
      } catch (err) {
        Toast.show('خطأ: ' + err.message, 'error');
      } finally {
        Loading.hide();
      }
    });
  }

  /* ============================================================
   * UNIFIED LEDGER  (السلف والتسويات)
   * ------------------------------------------------------------
   * Advances and adjustments are separate collections with separate forms,
   * but they answer one question for the admin: "what moved this month's
   * pay?". So the table below the tabs merges them into a single
   * chronological ledger with an explicit type column, rather than making
   * anyone reconcile two lists by eye.
   *
   * The sign convention is normalized on the way in: an advance is always a
   * deduction, an adjustment keeps its own sign. That makes the "التأثير"
   * column and the footer total meaningful across both types.
   * ============================================================ */

  const TX_TYPE = { ADVANCE: 'advance', ADJUSTMENT: 'adjustment' };

  function renderTransactionSelectors() {
    const employeeSelect = document.getElementById('transactionEmployeeInput');
    const employeeFilter = document.getElementById('ledgerEmployeeFilter');
    const departmentFilter = document.getElementById('ledgerDepartmentFilter');
    const employees = [...state.employees].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'));

    if (employeeSelect) {
      const keep = employeeSelect.value;
      employeeSelect.innerHTML = '<option value="">اختر الموظف</option>' + employees
        .map(e => `<option value="${Utils.escapeHtml(e.id)}">${Utils.escapeHtml(e.name)}</option>`).join('');
      employeeSelect.value = employees.some(e => e.id === keep) ? keep : '';
    }
    if (employeeFilter) {
      employeeFilter.innerHTML = '<option value="all">كل الموظفين</option>' + employees
        .map(e => `<option value="${Utils.escapeHtml(e.id)}">${Utils.escapeHtml(e.name)}</option>`).join('');
      state.ledgerEmployeeFilter = employees.some(e => e.id === state.ledgerEmployeeFilter)
        ? state.ledgerEmployeeFilter : 'all';
      employeeFilter.value = state.ledgerEmployeeFilter;
    }
    if (departmentFilter) {
      const departments = Departments.all();
      departmentFilter.innerHTML = '<option value="all">كل الأقسام</option>' + departments
        .map(d => `<option value="${Utils.escapeHtml(d.id)}">${Utils.escapeHtml(d.name)}</option>`).join('');
      state.ledgerDepartmentFilter = departments.some(d => d.id === state.ledgerDepartmentFilter)
        ? state.ledgerDepartmentFilter : 'all';
      departmentFilter.value = state.ledgerDepartmentFilter;
    }
  }

  function updateTransactionFormHint() {
    const type = document.getElementById('transactionTypeInput').value;
    const amount = document.getElementById('transactionAmountInput');
    const hint = document.getElementById('transactionFormHint');
    const isAdvance = type === TX_TYPE.ADVANCE;
    amount.min = isAdvance ? '0.01' : '';
    amount.placeholder = isAdvance ? 'مثال: 1000' : 'موجب للإضافة أو سالب للخصم، مثال: -200';
    if (hint) hint.textContent = isAdvance
      ? 'السلفة تُسجل بمبلغ موجب وتُخصم من المستحقات في شهر تاريخها.'
      : 'التسوية تقبل مبلغًا موجبًا للإضافة أو سالبًا للخصم، وتدخل في شهر تاريخها.';
  }

  function resetTransactionForm() {
    state.transactionEditing = null;
    const form = document.getElementById('transactionForm');
    if (form) form.reset();
    const date = document.getElementById('transactionDateInput');
    if (date) date.value = new Date().toISOString().slice(0, 10);
    const save = document.getElementById('transactionSaveBtn');
    const cancel = document.getElementById('transactionCancelEditBtn');
    if (save) save.textContent = '💾 حفظ العملية';
    if (cancel) cancel.classList.add('hidden');
    updateTransactionFormHint();
  }

  function transactionRecord(type, id) {
    const list = type === TX_TYPE.ADVANCE ? state.advances : state.adjustments;
    return list.find(item => item.id === id) || null;
  }

  function transactionDepartmentId(record) {
    if (record.departmentId) return record.departmentId;
    const employee = state.employees.find(emp => emp.id === record.moderatorId);
    return employee ? employeeDepartmentId(employee) : '';
  }

  function beginTransactionEdit(type, id) {
    const record = transactionRecord(type, id);
    if (!record) { Toast.show('تعذر العثور على العملية. حدّث الصفحة وحاول مرة أخرى.', 'error'); return; }
    try { Months.assertEditable(record.monthId, 'تعديل العملية'); } catch (err) { Toast.show(err.message, 'error'); return; }

    state.transactionEditing = { type, id };
    renderTransactionSelectors();
    document.getElementById('transactionEmployeeInput').value = record.moderatorId || '';
    document.getElementById('transactionTypeInput').value = type;
    document.getElementById('transactionAmountInput').value = record.amount || '';
    document.getElementById('transactionDateInput').value = record.date || '';
    document.getElementById('transactionNoteInput').value = type === TX_TYPE.ADVANCE ? (record.note || '') : (record.reason || '');
    document.getElementById('transactionSaveBtn').textContent = '💾 حفظ التعديل';
    document.getElementById('transactionCancelEditBtn').classList.remove('hidden');
    updateTransactionFormHint();
    document.getElementById('transactionForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function onSaveTransaction(e) {
    Permissions.require('transactions.write');
    e.preventDefault();
    const employeeId = document.getElementById('transactionEmployeeInput').value;
    const type = document.getElementById('transactionTypeInput').value;
    const amount = Number(document.getElementById('transactionAmountInput').value);
    const date = document.getElementById('transactionDateInput').value;
    const note = document.getElementById('transactionNoteInput').value.trim();
    const employee = state.employees.find(emp => emp.id === employeeId);

    if (!employee) { Toast.show('الرجاء اختيار موظف صالح.', 'error'); return; }
    if (!date) { Toast.show('الرجاء اختيار تاريخ العملية.', 'error'); return; }
    if (!Number.isFinite(amount) || (type === TX_TYPE.ADVANCE ? amount <= 0 : amount === 0)) {
      Toast.show(type === TX_TYPE.ADVANCE ? 'مبلغ السلفة يجب أن يكون أكبر من صفر.' : 'مبلغ التسوية غير صالح.', 'error');
      return;
    }
    const monthId = date.slice(0, 7);
    try { Months.assertEditable(monthId, state.transactionEditing ? 'تعديل العملية' : 'حفظ العملية'); }
    catch (err) { Toast.show(err.message, 'error'); return; }

    const editing = state.transactionEditing;
    if (editing && editing.type !== type) {
      Toast.show('لا يمكن تغيير نوع العملية أثناء التعديل. احذف العملية وأنشئ النوع الصحيح.', 'error');
      return;
    }
    const key = type === TX_TYPE.ADVANCE ? 'advances' : 'adjustments';
    const payload = {
      moderatorId: employee.id,
      moderatorName: employee.name,
      departmentId: employeeDepartmentId(employee),
      amount, date, monthId,
      ...(type === TX_TYPE.ADVANCE ? { note } : { reason: note })
    };

    Loading.show();
    try {
      if (editing) {
        await DataLayer.update(key, editing.id, payload);
        Toast.show('تم حفظ تعديل العملية.', 'success');
      } else {
        // Pending/approved is a workflow label only in Part 1. Payroll keeps
        // reading the same advance/adjustment values and formulas as before.
        await DataLayer.create(key, { ...payload, status: 'pending' });
        Toast.show('تم حفظ العملية وبانتظار الاعتماد.', 'success');
      }
      resetTransactionForm();
    } catch (err) {
      Toast.show('خطأ: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  function approveTransaction(type, id) {
    // All data writes are enforced again by Firestore Rules. This client-side
    // guard avoids turning a missing/non-admin profile into the opaque
    // "Missing or insufficient permissions" error at the approval button.
    if (state.userRole !== 'admin') {
      Toast.show('اعتماد العمليات متاح للمسؤول فقط. راجع صلاحيات حسابك.', 'error');
      return;
    }
    const record = transactionRecord(type, id);
    if (!record) { Toast.show('تعذر العثور على العملية.', 'error'); return; }
    try { Months.assertEditable(record.monthId, 'اعتماد العملية'); } catch (err) { Toast.show(err.message, 'error'); return; }
    Confirm.show('هل تريد اعتماد هذه العملية؟', async () => {
      Loading.show();
      try {
        await DataLayer.update(type === TX_TYPE.ADVANCE ? 'advances' : 'adjustments', id, { status: 'approved' });
        Toast.show('تم اعتماد العملية.', 'success');
      } catch (err) {
        Toast.show('خطأ: ' + err.message, 'error');
      } finally {
        Loading.hide();
      }
    });
  }

  function switchTransactionTab(tab) {
    const isAdvances = tab !== TX_TYPE.ADJUSTMENT;

    document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
      const active = btn.dataset.tab === (isAdvances ? 'advances' : 'adjustments');
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    document.getElementById('tabPanelAdvances').classList.toggle('active', isAdvances);
    document.getElementById('tabPanelAdjustments').classList.toggle('active', !isAdvances);
  }

  /**
   * Both collections for the selected month, merged into one shape.
   *
   * `effect` is the signed impact on net salary: advances are inherently
   * deductions so their positive stored amount becomes negative here, while
   * an adjustment already carries its own sign.
   */
  function ledgerRows() {
    const monthId = state.currentMonthId;

    const advances = state.advances
      .filter(a => a.monthId === monthId)
      .map(a => ({
        id: a.id,
        type: TX_TYPE.ADVANCE,
        employeeName: a.moderatorName || '',
        employeeId: a.moderatorId || '',
        departmentId: transactionDepartmentId(a),
        amount: Number(a.amount) || 0,
        effect: -(Number(a.amount) || 0),
        date: a.date || '',
        detail: a.note || '',
        monthId: a.monthId,
        status: a.status || 'approved'
      }));

    const adjustments = state.adjustments
      .filter(a => a.monthId === monthId)
      .map(a => ({
        id: a.id,
        type: TX_TYPE.ADJUSTMENT,
        employeeName: a.moderatorName || '',
        employeeId: a.moderatorId || '',
        departmentId: transactionDepartmentId(a),
        amount: Number(a.amount) || 0,
        effect: Number(a.amount) || 0,
        date: a.date || '',
        detail: a.reason || '',
        monthId: a.monthId,
        status: a.status || 'approved'
      }));

    let rows = advances.concat(adjustments);

    if (state.ledgerTypeFilter !== 'all') {
      rows = rows.filter(r => r.type === state.ledgerTypeFilter);
    }

    if (state.ledgerEmployeeFilter !== 'all') {
      rows = rows.filter(r => r.employeeId === state.ledgerEmployeeFilter);
    }
    if (state.ledgerDepartmentFilter !== 'all') {
      rows = rows.filter(r => r.departmentId === state.ledgerDepartmentFilter);
    }
    if (state.ledgerDateFilter) {
      rows = rows.filter(r => r.date === state.ledgerDateFilter);
    }

    if (state.ledgerSearchTerm) {
      const term = Utils.normalizeName(state.ledgerSearchTerm);
      rows = rows.filter(r => Utils.normalizeName(r.employeeName).includes(term));
    }

    // Newest first, then by employee name so same-day entries group together.
    rows.sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return String(a.employeeName).localeCompare(String(b.employeeName), 'ar');
    });

    return rows;
  }

  function renderLedger() {
    const label = document.getElementById('transactionsMonthLabel');
    if (label) label.textContent = currentMonthLabel() || '-';

    const tbody = document.getElementById('ledgerTableBody');
    if (!tbody) return;

    const rows = ledgerRows();
    const locked = isViewingLockedMonth();

    renderLedgerSummary();

    if (rows.length === 0) {
      const nothingAtAll = state.advances.filter(a => a.monthId === state.currentMonthId).length === 0 &&
                           state.adjustments.filter(a => a.monthId === state.currentMonthId).length === 0;
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${
        nothingAtAll
          ? 'لا توجد سلف أو تسويات مسجلة لهذا الشهر'
          : 'لا توجد عملية مطابقة للبحث أو الفلتر'
      }</td></tr>`;
      const tfoot = document.getElementById('ledgerTableFoot');
      if (tfoot) tfoot.innerHTML = '';
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const isAdvance = r.type === TX_TYPE.ADVANCE;
      const chipClass = isAdvance
        ? 'type-advance'
        : (r.amount < 0 ? 'type-adjustment-minus' : 'type-adjustment-plus');
      const chipLabel = isAdvance
        ? '💵 سلفة'
        : (r.amount < 0 ? '🔧 تسوية (خصم)' : '🔧 تسوية (إضافة)');

      return `
      <tr>
        <td>${Utils.escapeHtml(r.employeeName)}</td>
        <td><span class="type-chip ${chipClass}">${chipLabel}</span></td>
        <td>${Utils.formatCurrency(r.amount)}</td>
        <td>${Utils.escapeHtml(r.date)}</td>
        <td><span class="badge ${r.status === 'approved' ? 'badge-active' : 'badge-locked'}">${
          r.status === 'approved' ? 'معتمدة' : 'بانتظار الاعتماد'}</span></td>
        <td>${r.detail ? Utils.escapeHtml(r.detail) : '—'}</td>
        <td class="actions-cell">${locked
          ? '<span class="text-muted-inline">🔒</span>'
          : `${r.status !== 'approved' ? `<button class="btn-icon" data-action="approve" data-id="${Utils.escapeHtml(r.id)}" data-type="${r.type}" title="اعتماد">✅</button>` : ''}
             <button class="btn-icon" data-action="edit" data-id="${Utils.escapeHtml(r.id)}" data-type="${r.type}" title="تعديل">✏️</button>
             <button class="btn-icon btn-danger" data-action="delete" data-id="${Utils.escapeHtml(r.id)}" data-type="${r.type}" title="حذف">🗑️</button>`}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.btn-icon[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'approve') {
          approveTransaction(btn.dataset.type, btn.dataset.id);
        } else if (btn.dataset.action === 'edit') {
          beginTransactionEdit(btn.dataset.type, btn.dataset.id);
        } else if (btn.dataset.type === TX_TYPE.ADVANCE) {
          onDeleteAdvance(btn.dataset.id);
        } else {
          onDeleteAdjustment(btn.dataset.id);
        }
      });
    });

    const totalEffect = Utils.round2(rows.reduce((sum, r) => sum + r.effect, 0));
    const tfoot = document.getElementById('ledgerTableFoot');
    if (tfoot) {
      tfoot.innerHTML = `
        <tr>
          <td>الإجمالي</td>
          <td>${Utils.formatNumber(rows.length)} عملية</td>
          <td>—</td>
          <td class="${totalEffect < 0 ? 'text-danger' : 'text-success'}">${
            (totalEffect > 0 ? '+' : '') + Utils.formatCurrency(totalEffect)}</td>
          <td colspan="3">—</td>
        </tr>`;
    }
  }

  /**
   * Header totals for the month as a WHOLE - deliberately not affected by
   * the search box or the type filter, so the figures stay comparable with
   * the monthly report no matter how the table below is filtered.
   */
  function renderLedgerSummary() {
    const monthId = state.currentMonthId;

    const advancesTotal = Utils.round2(state.advances
      .filter(a => a.monthId === monthId)
      .reduce((sum, a) => sum + (Number(a.amount) || 0), 0));

    const adjustmentsTotal = Utils.round2(state.adjustments
      .filter(a => a.monthId === monthId)
      .reduce((sum, a) => sum + (Number(a.amount) || 0), 0));

    const net = Utils.round2(adjustmentsTotal - advancesTotal);

    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    set('ledgerAdvancesTotal', Utils.formatCurrency(advancesTotal));
    set('ledgerAdjustmentsTotal', Utils.formatCurrency(adjustmentsTotal));
    set('ledgerNetTotal', (net > 0 ? '+' : '') + Utils.formatCurrency(net));
  }

  /* ============================================================
   * MANUAL ADJUSTMENTS (تسويات يدوية) - free-form +/- amounts added
   * to that month's final salary (e.g. shift coverage)
   * ============================================================ */

  function listenAdjustments() {
    state.unsubAdjustments = db.collection(COLLECTIONS.ADJUSTMENTS)
      .orderBy('date', 'desc')
      .onSnapshot((snap) => {
        state.adjustments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderLedger();
        renderDashboard();
      }, (err) => Toast.show('خطأ في تحميل التسويات: ' + err.message, 'error'));
  }

  async function onAddAdjustment(e) {
    e.preventDefault();
    const rawName = document.getElementById('adjustmentModeratorInput').value;
    const amount = Number(document.getElementById('adjustmentAmountInput').value);
    const date = document.getElementById('adjustmentDateInput').value;
    const reason = document.getElementById('adjustmentReasonInput').value.trim();

    const emp = Utils.findBestModeratorMatch(rawName, state.employees);
    if (!emp) { Toast.show('لم يتم العثور على موظف بهذا الاسم، تأكد من إضافته أولاً في صفحة الموظفين', 'error'); return; }
    if (!Number.isFinite(amount) || amount === 0) { Toast.show('المبلغ غير صالح', 'error'); return; }
    if (!date) { Toast.show('الرجاء اختيار التاريخ', 'error'); return; }

    const monthId = date.slice(0, 7);

    // Same rule as advances: the adjustment lands in the month of its own
    // date, and that month must be open.
    try {
      Months.assertEditable(monthId, 'إضافة التسويات');
    } catch (err) {
      Toast.show(err.message, 'error');
      return;
    }

    Loading.show();
    try {
      const result = await DataLayer.create('adjustments', {
        moderatorId: emp.id,
        moderatorName: emp.name,
        departmentId: employeeDepartmentId(emp),
        amount, date, reason, monthId
      });
      document.getElementById('adjustmentForm').reset();
      Toast.show('تم إضافة التسوية', 'success');
      UndoService.offer(
        result.undo,
        `تم إضافة تسوية ${Utils.formatCurrency(amount)} لـ"${emp.name}"`
      );
    } catch (err) {
      Toast.show('خطأ: ' + err.message, 'error');
    } finally {
      Loading.hide();
    }
  }

  function onDeleteAdjustment(id) {
    const adjustment = state.adjustments.find(a => a.id === id);
    // Same fail-closed rule as advances: no local record means we can't
    // prove the month is open.
    if (!adjustment) {
      Toast.show('تعذر التحقق من شهر التسوية، حدّث الصفحة وحاول تاني', 'error');
      return;
    }
    try {
      Months.assertEditable(adjustment.monthId, 'حذف التسويات');
    } catch (err) {
      Toast.show(err.message, 'error');
      return;
    }

    Confirm.show('هل تريد حذف هذه التسوية؟', async () => {
      Loading.show();
      try {
        const result = await DataLayer.remove('adjustments', id);
        Toast.show('تم حذف التسوية', 'success');
        UndoService.offer(
          result.undo,
          `تم حذف تسوية ${Utils.formatCurrency(adjustment.amount || 0)} لـ"${
            adjustment.moderatorName || ''}"`
        );
      } catch (err) {
        Toast.show('خطأ: ' + err.message, 'error');
      } finally {
        Loading.hide();
      }
    });
  }

  /* ============================================================
   * FINAL SETTLEMENT VIEW  (تسوية مستحقات الموظف)
   * ------------------------------------------------------------
   * Two-phase by design: "احسب المستحقات" computes and DISPLAYS a proposal
   * without writing anything, and only "اعتماد التسوية" persists it. So the
   * admin can calculate as many times as they like, with any date, at zero
   * risk - and the numbers they approve are exactly the numbers they read.
   * ============================================================ */

  /** Datalist of ACTIVE employees only - you can't settle someone twice. */
  function populateActiveEmployeeDatalist() {
    const list = document.getElementById('activeEmployeeDatalist');
    if (!list) return;
    list.innerHTML = state.employees
      .filter(e => e.status !== 'inactive')
      .map(e => `<option value="${Utils.escapeHtml(e.name)}">`).join('');
  }

  async function onCalculateSettlement(e) {
    e.preventDefault();

    const rawName = document.getElementById('settlementEmployeeInput').value;
    const lastWorkingDay = document.getElementById('settlementLastDayInput').value;
    const note = document.getElementById('settlementNoteInput').value.trim();

    // Match against ACTIVE employees only, so a name that belongs to an
    // already-settled person can't be fuzzy-matched back into a new
    // settlement.
    const activeEmployees = state.employees.filter(emp => emp.status !== 'inactive');
    const employee = Utils.findBestModeratorMatch(rawName, activeEmployees);

    if (!employee) {
      Toast.show(
        'لم يتم العثور على موظف نشط بهذا الاسم. تأكد من الاسم، أو راجع صفحة "غير النشطين".',
        'error'
      );
      return;
    }
    if (!lastWorkingDay) {
      Toast.show('الرجاء اختيار تاريخ آخر يوم عمل', 'error');
      return;
    }

    Loading.show('جاري حساب المستحقات...');
    try {
      const settlement = await FinalSettlementService.calculate({
        employee,
        lastWorkingDay,
        advances: state.advances,
        adjustments: state.adjustments,
        note
      });

      state.pendingSettlement = settlement;
      renderSettlementReview(settlement);
      Toast.show('تم حساب المستحقات — راجع الأرقام ثم اعتمد التسوية', 'success');
    } catch (err) {
      console.error('Settlement calculation failed:', err);
      Toast.show(err.message, 'error');
      cancelSettlementReview();
    } finally {
      Loading.hide();
    }
  }

  function renderSettlementReview(s) {
    const panel = document.getElementById('settlementReviewPanel');
    if (!panel) return;

    document.getElementById('settlementHead').innerHTML = [
      ['الموظف', Utils.escapeHtml(s.employeeName)],
      ['القسم', Utils.escapeHtml(s.departmentName)],
      ['آخر يوم عمل', Utils.escapeHtml(s.lastWorkingDay)],
      ['شهر التسوية', Utils.escapeHtml(s.monthLabel)],
      ['الراتب الشهري الثابت', Utils.formatCurrency(s.fixedSalaryAmount)],
      ['أيام العمل المستحقة', `${Utils.formatNumber(s.daysWorked)} من ${Utils.formatNumber(s.daysInMonth)}`]
    ].map(([label, value]) => `
      <div class="sh-item">
        <div class="sh-label">${label}</div>
        <div class="sh-value">${value}</div>
      </div>`).join('');

    document.getElementById('settlementBreakdownBody').innerHTML =
      (s.breakdown || []).map(line => `
        <tr class="${line.type === 'deduct' ? 'row-deduct' : 'row-add'}">
          <td>${Utils.escapeHtml(line.label)}</td>
          <td class="text-muted-inline">${Utils.escapeHtml(line.detail || '—')}</td>
          <td>${(line.amount > 0 ? '+' : '') + Utils.formatCurrency(line.amount)}</td>
        </tr>`).join('');

    document.getElementById('settlementBreakdownFoot').innerHTML = `
      <tr>
        <td>صافي المستحق</td>
        <td>${s.netAmount < 0 ? 'مستحق على الموظف للشركة' : 'مستحق للموظف'}</td>
        <td class="${s.netAmount < 0 ? 'text-danger' : 'text-strong'}">${
          Utils.formatCurrency(s.netAmount)}</td>
      </tr>`;

    const warnBox = document.getElementById('settlementWarnings');
    if (s.warnings && s.warnings.length > 0) {
      warnBox.style.display = 'block';
      warnBox.innerHTML = `
        <div class="error-box-title">تنبيهات قبل الاعتماد:</div>
        <ul>${s.warnings.map(w => `<li>${Utils.escapeHtml(w)}</li>`).join('')}</ul>`;
    } else {
      warnBox.style.display = 'none';
      warnBox.innerHTML = '';
    }

    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function cancelSettlementReview() {
    state.pendingSettlement = null;
    const panel = document.getElementById('settlementReviewPanel');
    if (panel) panel.classList.add('hidden');
  }

  function onApproveSettlement() {
    const s = state.pendingSettlement;
    if (!s) {
      Toast.show('مفيش تسوية محسوبة للاعتماد', 'error');
      return;
    }

    Confirm.show(
      `اعتماد تسوية "${s.employeeName}" بمبلغ ${Utils.formatCurrency(s.netAmount)}؟\n\n` +
      'بعد الاعتماد: حالة الموظف هتبقى غير نشط، ومش هيظهر في حساب رواتب الشهور الجديدة. ' +
      'كل بياناته وتقاريره القديمة هتتحفظ بالكامل ومش هيتحذف أي حاجة.',
      async () => {
        Loading.show('جاري اعتماد التسوية...');
        try {
          const result = await FinalSettlementService.approve(s);

          Toast.show(
            `تم اعتماد تسوية ${s.employeeName} بنجاح. الموظف بقى غير نشط وبياناته محفوظة.`,
            'success'
          );

          cancelSettlementReview();
          document.getElementById('settlementForm').reset();

          await loadSettlements();
          loadAuditLogs();
          renderInactiveTable();
          // The employees listener fires on the status change and re-renders
          // the tables and datalists on its own.

          console.info('Settlement approved:', result.settlementId);
        } catch (err) {
          console.error('Settlement approval failed:', err);
          Toast.show('خطأ أثناء اعتماد التسوية: ' + err.message, 'error');
        } finally {
          Loading.hide();
        }
      }
    );
  }

  async function loadSettlements() {
    try {
      state.settlements = await FinalSettlementService.all();
      renderSettlementsTable();
      renderInactiveTable();
    } catch (err) {
      console.error('loadSettlements failed:', err);
    }
  }

  function renderSettlementsTable() {
    const tbody = document.getElementById('settlementsTableBody');
    if (!tbody) return;

    if (state.settlements.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">لا توجد تسويات معتمدة بعد</td></tr>`;
      return;
    }

    tbody.innerHTML = state.settlements.map(s => `
      <tr>
        <td>${Utils.escapeHtml(s.employeeName || '—')}</td>
        <td>${Utils.escapeHtml(s.departmentName || '—')}</td>
        <td>${Utils.escapeHtml(s.lastWorkingDay || '—')}</td>
        <td>${Utils.escapeHtml(s.monthLabel || Utils.monthLabelFromId(s.monthId))}</td>
        <td class="${(s.netAmount || 0) < 0 ? 'text-danger' : 'text-strong'}">${
          Utils.formatCurrency(s.netAmount || 0)}</td>
        <td>${Utils.formatDateTime(s.approvedAt)}</td>
        <td>${s.approvedBy ? Utils.escapeHtml(s.approvedBy) : '—'}</td>
        <td class="actions-cell">
          <button class="btn-icon" data-id="${Utils.escapeHtml(s.id)}" title="عرض التفاصيل">👁️</button>
        </td>
      </tr>`).join('');

    tbody.querySelectorAll('.btn-icon').forEach(btn => {
      btn.addEventListener('click', () => openSettlementDetailsModal(btn.dataset.id));
    });
  }

  /** Read-only view of an approved settlement, from its stored breakdown. */
  function openSettlementDetailsModal(settlementId) {
    const s = state.settlements.find(x => x.id === settlementId);
    if (!s) {
      Toast.show('تعذر العثور على التسوية', 'error');
      return;
    }

    document.getElementById('settlementDetailsTitle').textContent =
      `تسوية ${s.employeeName || ''}`;

    document.getElementById('settlementDetailsStats').innerHTML = [
      ['القسم', Utils.escapeHtml(s.departmentName || '—')],
      ['آخر يوم عمل', Utils.escapeHtml(s.lastWorkingDay || '—')],
      ['شهر التسوية', Utils.escapeHtml(s.monthLabel || '—')],
      ['تاريخ التعيين', s.hireDate ? Utils.escapeHtml(s.hireDate) : '—'],
      ['الراتب الشهري', Utils.formatCurrency(s.fixedSalaryAmount || 0)],
      ['أيام العمل', `${Utils.formatNumber(s.daysWorked || 0)} / ${Utils.formatNumber(s.daysInMonth || 0)}`],
      ['صافي المستحق', Utils.formatCurrency(s.netAmount || 0)],
      ['تاريخ الاعتماد', Utils.formatDateTime(s.approvedAt)],
      ['بواسطة', s.approvedBy ? Utils.escapeHtml(s.approvedBy) : '—']
    ].map(([label, value]) => `
      <div class="details-stat">
        <div class="v">${value}</div>
        <div class="l">${label}</div>
      </div>`).join('');

    // Renders the breakdown SNAPSHOT stored at approval time, so this always
    // shows how the figure was actually reached - never a recalculation.
    const breakdown = Array.isArray(s.breakdown) ? s.breakdown : [];
    document.getElementById('settlementDetailsBreakdown').innerHTML =
      breakdown.length === 0
        ? `<tr><td colspan="3" class="empty-state">لا يوجد تفصيل محفوظ لهذه التسوية</td></tr>`
        : breakdown.map(line => `
            <tr class="${line.type === 'deduct' ? 'row-deduct' : 'row-add'}">
              <td>${Utils.escapeHtml(line.label || '—')}</td>
              <td class="text-muted-inline">${Utils.escapeHtml(line.detail || '—')}</td>
              <td>${((line.amount || 0) > 0 ? '+' : '') + Utils.formatCurrency(line.amount || 0)}</td>
            </tr>`).join('') + `
          <tr class="row-subtotal">
            <td>صافي المستحق</td>
            <td>${s.note ? Utils.escapeHtml(s.note) : '—'}</td>
            <td>${Utils.formatCurrency(s.netAmount || 0)}</td>
          </tr>`;

    document.getElementById('settlementDetailsModal').classList.add('open');
  }

  function closeSettlementDetailsModal() {
    document.getElementById('settlementDetailsModal').classList.remove('open');
  }

  /* ============================================================
   * INACTIVE EMPLOYEES VIEW  (الموظفون غير النشطين)
   * ============================================================ */

  function renderInactiveTable() {
    const tbody = document.getElementById('inactiveTableBody');
    if (!tbody) return;

    const term = Utils.normalizeName(state.inactiveSearchTerm);
    const deptFilterEl = document.getElementById('inactiveDeptFilter');
    const deptFilter = deptFilterEl ? deptFilterEl.value : 'all';

    const rows = state.employees.filter(emp => {
      if (emp.status !== 'inactive') return false;
      if (term && !(emp.normalizedName || '').includes(term)) return false;
      if (deptFilter !== 'all' && employeeDepartmentId(emp) !== deptFilter) return false;
      return true;
    });

    const totalInactive = state.employees.filter(e => e.status === 'inactive').length;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${
        totalInactive === 0
          ? 'كل الموظفين نشطين حاليًا — مفيش موظف غير نشط.'
          : 'لا يوجد موظف مطابق للبحث'
      }</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(emp => {
      // The settlement is matched by the employee's own settlementId when it
      // has one, and by employeeId otherwise - so a person deactivated
      // manually before this feature existed still shows correctly.
      const settlement = emp.settlementId
        ? state.settlements.find(s => s.id === emp.settlementId)
        : state.settlements.find(s => s.employeeId === emp.id);

      const settlementCell = settlement
        ? `<span class="badge badge-settled">✅ تسوية معتمدة</span>`
        : `<span class="badge badge-unsettled">بدون تسوية</span>`;

      return `
      <tr class="row-archived">
        <td>${Utils.escapeHtml(emp.name)}</td>
        <td>${departmentChip(employeeDepartmentId(emp))}</td>
        <td>${Utils.formatCurrency(emp.fixedSalaryAmount || 0)}</td>
        <td>${emp.hireDate ? Utils.escapeHtml(emp.hireDate) : '—'}</td>
        <td>${emp.lastWorkingDay ? Utils.escapeHtml(emp.lastWorkingDay) : '—'}</td>
        <td>${settlementCell}</td>
        <td class="actions-cell">
          ${settlement
            ? `<button class="btn-icon" data-action="view-settlement"
                       data-id="${Utils.escapeHtml(settlement.id)}" title="عرض التسوية">👁️</button>`
            : ''}
          <button class="btn-icon" data-action="reactivate" data-id="${emp.id}"
                  title="إعادة التفعيل">♻️</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-action="view-settlement"]').forEach(btn => {
      btn.addEventListener('click', () => openSettlementDetailsModal(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="reactivate"]').forEach(btn => {
      btn.addEventListener('click', () => onReactivateEmployee(btn.dataset.id));
    });
  }

  function onReactivateEmployee(employeeId) {
    const emp = state.employees.find(e => e.id === employeeId);
    if (!emp) return;

    Confirm.show(
      `إعادة تفعيل "${emp.name}"؟ هيرجع يظهر في حساب الرواتب من الشهر النشط ` +
      `(${Utils.monthLabelFromId(Months.activeMonthId())}) وبعده. ` +
      'الشهور المقفولة مش هتتأثر خالص.',
      async () => {
        Loading.show('جاري إعادة التفعيل...');
        try {
          await FinalSettlementService.reactivate(employeeId);
          Toast.show(`تم إعادة تفعيل ${emp.name}`, 'success');
          loadAuditLogs();
          // The employees listener re-renders the tables on its own.
        } catch (err) {
          Toast.show('خطأ: ' + err.message, 'error');
        } finally {
          Loading.hide();
        }
      }
    );
  }

  /* ============================================================
   * IMPORT PIPELINE (Method 1: text area / Method 2: Excel)
   * ============================================================ */

  async function onImportText() {
    const text = document.getElementById('importTextArea').value;
    const { orders, errors } = Utils.parseOrdersText(text);
    await processImportedOrders(orders, errors);
  }

  /**
   * Downloads a blank Excel template matching exactly what the Excel import
   * (Method 2) expects: a header row plus a couple of example rows. Smart
   * Column Mapping means the header text doesn't have to match this
   * verbatim to work later, but a template that already matches removes
   * any guesswork for the person filling it in.
   */
  function onDownloadImportTemplate() {
    const wsData = [
      ['اسم المشرف', 'عدد الطرود', 'السعر'],
      ['Hind', 4, 550],
      ['ريم', 4, 550],
      ['Haba', 7, 750]
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'الطلبات');
    XLSX.writeFile(wb, 'نموذج-استيراد-الطلبات.xlsx');
  }

  /* ---- Excel import: transient state for the preview modal ----
   * Not part of `state` (Firestore-backed dashboard state) on purpose -
   * this is throwaway UI state for a single file, cleared the moment the
   * modal closes. */
  let excelImportPreview = null;

  const IMPORT_FIELD_LABELS = { name: 'اسم المشرف', packages: 'عدد الطرود', price: 'السعر' };
  const IMPORT_MAPPING_CONFIDENCE_DISPLAY_THRESHOLD = 0.55;

  /** Wires drag & drop onto the Excel dropzone. Purely an input mechanism:
   *  a dropped file is handed to the *same* <input type="file"> element and
   *  a native 'change' event is dispatched on it, so onImportExcel() runs
   *  completely unchanged whether the file arrived via click or via drop. */
  function bindExcelDropzone() {
    const zone = document.getElementById('excelDropzone');
    const input = document.getElementById('excelFileInput');
    if (!zone || !input) return;

    const isSupportedExcelFile = (file) => {
      const name = (file && file.name || '').toLowerCase();
      return name.endsWith('.xlsx') || name.endsWith('.xls');
    };

    let dragCounter = 0; // handles dragenter/dragleave firing on child elements too

    zone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter += 1;
      zone.classList.add('dropzone-active');
    });

    zone.addEventListener('dragover', (e) => {
      // Required so the browser allows a drop here instead of opening the file.
      e.preventDefault();
    });

    zone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) zone.classList.remove('dropzone-active');
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      zone.classList.remove('dropzone-active');

      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      const file = files[0];

      if (!isSupportedExcelFile(file)) {
        Toast.show('صيغة الملف غير مدعومة — الرجاء إفلات ملف Excel بصيغة xlsx أو xls فقط', 'error');
        return;
      }

      // Hand the dropped file to the actual <input>, then fire its normal
      // 'change' event so onImportExcel(e) runs exactly as if the user had
      // picked this file from the dialog. Its internal logic is untouched.
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function onImportExcel(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!state.currentMonthId) {
      Toast.show('الرجاء اختيار الشهر أولاً', 'error');
      e.target.value = '';
      return;
    }
    try {
      Months.assertEditable(state.currentMonthId, 'الاستيراد');
    } catch (err) {
      Toast.show(err.message, 'error');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    Loading.show('جاري قراءة ملف Excel...');
    Loading.setProgress(0);
    reader.onprogress = (progressEvent) => {
      if (progressEvent.lengthComputable && progressEvent.total > 0) {
        Loading.setProgress((progressEvent.loaded / progressEvent.total) * 25);
      }
    };
    reader.onload = (evt) => {
      Loading.setLabel('جاري تحليل بيانات الملف...');
      Loading.setProgress(25);

      // Yield once so the reading stage can be painted before SheetJS starts
      // its synchronous workbook analysis.
      setTimeout(() => {
        try {
          const buffer = evt.target.result;
          const analysis = Utils.analyzeExcelFile(buffer);
          Loading.setProgress(75);

          if (analysis.parseError) {
            Toast.show(analysis.parseError, 'error');
            e.target.value = '';
            return;
          }

          const savedMapping = Utils.loadLastImportColumnMapping();
          const usedSavedMapping = savedMapping && Utils.importHeadersMatch(analysis.headers, savedMapping.headers);
          if (usedSavedMapping) {
            analysis.mapping = { ...savedMapping.mapping };
            analysis.confidence = { name: 1, packages: 1, price: 1 };
            const remapped = Utils.applyManualMapping(analysis.rawDataRows, analysis.mapping, analysis.lineNumberOffset);
            analysis.orders = remapped.orders;
            analysis.errors = remapped.errors;
          }

          excelImportPreview = {
            fileName: file.name,
            headers: analysis.headers,
            rawDataRows: analysis.rawDataRows,
            lineNumberOffset: analysis.lineNumberOffset,
            mapping: { ...analysis.mapping },
            confidence: { ...analysis.confidence },
            orders: analysis.orders,
            errors: analysis.errors,
            usedSavedMapping
          };
          Loading.setProgress(100);
          openImportPreviewModal();
          if (usedSavedMapping) {
            Toast.show('تم استخدام آخر إعداد محفوظ لمطابقة الأعمدة.', 'success');
          }
          e.target.value = ''; // reset input so the same file can be re-imported later
        } catch (err) {
          Toast.show('تعذر تحليل ملف Excel: ' + err.message, 'error');
          e.target.value = '';
        } finally {
          Loading.hide();
        }
      }, 0);
    };
    reader.onerror = () => {
      Loading.hide();
      Toast.show('تعذر قراءة الملف', 'error');
      e.target.value = '';
    };
    reader.readAsArrayBuffer(file);
  }

  function openImportPreviewModal() {
    renderImportWizard();
    showImportWizardStage(3);
    return;
    renderImportMappingFields();
    renderImportPreviewSummary();
    document.getElementById('importPreviewModal').classList.add('open');
  }

  function showImportWizardStage(stage) {
    document.querySelectorAll('[data-import-stage]').forEach(el => el.classList.toggle('active', Number(el.dataset.importStage) === Number(stage)));
    document.querySelectorAll('[data-import-step]').forEach(el => el.classList.toggle('active', Number(el.dataset.importStep) === Number(stage)));
    if (Number(stage) === 7) loadImportHistory();
  }
  function renderImportWizard() {
    const st = excelImportPreview; if (!st) return;
    document.getElementById('importWizardPreview').innerHTML = `<div class="close-summary"><strong>معاينة الملف: ${Utils.escapeHtml(st.fileName)}</strong><p>إجمالي الصفوف: ${Utils.formatNumber(st.orders.length + st.errors.length)} · الطلبات الصالحة: ${Utils.formatNumber(st.orders.length)} · الأخطاء: ${Utils.formatNumber(st.errors.length)}</p><ol>${st.orders.slice(0,5).map(o => `<li>${Utils.escapeHtml(o.name)} — ${Utils.formatNumber(o.packages)} عبوة — ${Utils.formatCurrency(o.price)}</li>`).join('')}</ol></div>`;
    document.getElementById('importWizardValidation').innerHTML = st.errors.length ? `<div class="error-box"><strong>تعذر الاعتماد: ${st.errors.length} خطأ.</strong><ul>${st.errors.slice(0,20).map(formatImportError).map(x=>`<li>${x}</li>`).join('')}</ul></div>` : '<div class="hint-box">نجح التحقق: جميع الصفوف صالحة وجاهزة للاعتماد.</div>';
    document.getElementById('importWizardToApprove').disabled = st.errors.length > 0;
  }

  function closeImportPreviewModal() {
    document.getElementById('importPreviewModal').classList.remove('open');
    excelImportPreview = null;
  }

  /** Renders the three column-mapping <select>s, pre-filled with the
   *  auto-detected column (or blank if nothing confident was found). */
  function renderImportMappingFields() {
    const wrap = document.getElementById('importMappingFields');
    const { headers, mapping, confidence } = excelImportPreview;

    wrap.innerHTML = Object.keys(IMPORT_FIELD_LABELS).map(field => {
      const selected = mapping[field];
      const conf = confidence[field] || 0;
      let badgeClass = 'badge-archived';
      let badgeText = 'اختر العمود';
      if (selected !== null && selected !== undefined) {
        if (conf >= IMPORT_MAPPING_CONFIDENCE_DISPLAY_THRESHOLD) {
          badgeClass = 'badge-active';
          badgeText = 'تلقائي';
        } else {
          badgeClass = 'badge-locked';
          badgeText = 'راجع الاختيار';
        }
      }
      const options = ['<option value="">-- اختر عمود --</option>']
        .concat(headers.map((h, idx) =>
          `<option value="${idx}" ${idx === selected ? 'selected' : ''}>${Utils.escapeHtml(h)}</option>`
        )).join('');
      return `
        <div class="field import-mapping-row">
          <label>${IMPORT_FIELD_LABELS[field]} <span class="badge ${badgeClass}">${badgeText}</span></label>
          <select data-mapping-field="${field}">${options}</select>
        </div>`;
    }).join('');

    wrap.querySelectorAll('select[data-mapping-field]').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const field = e.target.getAttribute('data-mapping-field');
        const val = e.target.value;
        excelImportPreview.mapping[field] = val === '' ? null : Number(val);
        // A manual pick is fully trusted - no more "needs review" badge.
        excelImportPreview.confidence[field] = 1;
        renderImportMappingFields();
      });
    });
  }

  /** Re-validates the file's rows against whatever mapping is currently
   *  selected (auto or hand-picked) and refreshes the summary. */
  function recomputeImportPreview() {
    const st = excelImportPreview;
    if (!st) return;
    const { name, packages, price } = st.mapping;
    if (name === null || packages === null || price === null) {
      Toast.show('اختر عمودًا لكل حقل (الاسم، عدد الطرود، السعر) قبل تحديث المعاينة', 'error');
      return;
    }
    const { orders, errors } = Utils.applyManualMapping(st.rawDataRows, st.mapping, st.lineNumberOffset);
    st.orders = orders;
    st.errors = errors;
    renderImportPreviewSummary();
    Toast.show('تم تحديث المعاينة', 'success');
  }

  function renderImportPreviewSummary() {
    const st = excelImportPreview;
    document.getElementById('importPreviewFileName').textContent = st.fileName;
    document.getElementById('importPreviewMonth').textContent = currentMonthLabel();

    // Informational only: these are the valid rows whose names are not in
    // the current employee list. The import behavior remains unchanged.
    const unmatchedNames = [];
    const seen = new Set();
    st.orders.forEach(o => {
      const match = Utils.findBestModeratorMatch(o.name, state.employees);
      if (!match) {
        const key = Utils.normalizeName(o.name);
        if (!seen.has(key)) { seen.add(key); unmatchedNames.push(o.name); }
      }
    });

    const validCount = st.orders.length;
    const skippedCount = st.errors.length;
    const newEmployeeCount = unmatchedNames.length;
    const recognizedCols = Object.values(st.mapping).filter(v => v !== null && v !== undefined).length;
    document.getElementById('importPreviewQuickSummary').innerHTML = `
      <strong>ملخص سريع:</strong> سيتم استيراد <strong>${Utils.formatNumber(validCount)}</strong> طلب صحيح،
      وتجاهل <strong>${Utils.formatNumber(skippedCount)}</strong> صف،
      وإنشاء <strong>${Utils.formatNumber(newEmployeeCount)}</strong> موظف جديد تلقائيًا عند التأكيد.
    `;
    document.getElementById('importPreviewSummary').innerHTML = `
      <div class="cs-item"><div class="cs-value">${Utils.formatNumber(validCount)}</div><div class="cs-label">طلبات صحيحة</div></div>
      <div class="cs-item"><div class="cs-value">${Utils.formatNumber(skippedCount)}</div><div class="cs-label">طلبات سيتم تجاهلها</div></div>
      <div class="cs-item"><div class="cs-value">${Utils.formatNumber(newEmployeeCount)}</div><div class="cs-label">موظفون جدد</div></div>
      <div class="cs-item"><div class="cs-value">${recognizedCols}/3</div><div class="cs-label">عمود تم التعرف عليه</div></div>
    `;

    const errBox = document.getElementById('importPreviewErrors');
    if (st.errors.length) {
      errBox.classList.remove('hidden');
      errBox.innerHTML = `
        <div class="error-box-title">${st.errors.length} صف هيتم تجاهله عند الاستيراد - المشاكل:</div>
        <ul>${st.errors.map(er => `<li><strong>سبب التجاهل:</strong> ${formatImportError(er)}</li>`).join('')}</ul>`;
    } else {
      errBox.classList.add('hidden');
      errBox.innerHTML = '';
    }

    // Informational only (not blocking): names with no confident match in
    // the current employee list, which the existing import pipeline
    // auto-creates as new employees - surfaced here so nothing is a surprise.
    const newBox = document.getElementById('importNewEmployeesBox');
    if (unmatchedNames.length) {
      newBox.classList.remove('hidden');
      const shownNames = unmatchedNames.slice(0, 30);
      newBox.innerHTML = `👤 <strong>${unmatchedNames.length}</strong> اسم مش موجود حاليًا في قائمة الموظفين، وهيتم إنشاء موظف جديد له تلقائيًا عند التأكيد:
        <div style="margin-top:6px">${shownNames.map(n => Utils.escapeHtml(n)).join('، ')}${unmatchedNames.length > shownNames.length ? ' ...' : ''}</div>`;
    } else {
      newBox.classList.add('hidden');
      newBox.innerHTML = '';
    }

    document.getElementById('confirmImportPreviewBtn').disabled = st.orders.length === 0 || st.errors.length > 0;
  }

  async function onConfirmImportPreview() {
    Permissions.require('orders.import');
    const st = excelImportPreview;
    if (!st) return;
    const orders = st.orders;
    const errors = st.errors;
    closeImportPreviewModal();
    const imported = await processImportedOrders(orders, errors);
    if (imported) {
      Utils.saveLastImportColumnMapping(st.headers, st.mapping);
      document.getElementById('importWizardSuccess').textContent = `تم استيراد ${Utils.formatNumber(orders.length)} طلب بنجاح.`;
      showImportWizardStage(6);
    }
  }

  function showImportErrors(errors) {
    const box = document.getElementById('importErrors');
    if (!errors || errors.length === 0) {
      box.innerHTML = '';
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="error-box-title">تم العثور على ${errors.length} خطأ - تم تجاهل هذه الأسطر والمتابعة بالباقي:</div>
      <ul>${errors.map(er => `<li>${formatImportError(er)}</li>`).join('')}</ul>`;
  }

  function formatImportError(error) {
    const row = `الصف ${error.lineNumber}`;
    const column = error.column ? ` — عمود ${Utils.escapeHtml(error.column)}` : '';
    return `${row}${column}: ${Utils.escapeHtml(error.message)}`;
  }

  async function orderImportId(rows) {
    const canonicalRows = rows.map(row => JSON.stringify([
      Utils.normalizeName(row.name || row.moderatorName || ''),
      Number(row.packages),
      Number(row.price)
    ])).sort().join('\n');
    const bytes = new TextEncoder().encode(canonicalRows);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return 'sha256:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function importAlreadyExists(batchesRef, importId) {
    const knownImport = await batchesRef.where('importId', '==', importId).limit(1).get();
    if (!knownImport.empty) return true;

    // Imports written before importId was introduced are compared by their
    // stored order content so a legacy batch cannot be duplicated once.
    const legacyBatches = await batchesRef.get();
    for (const batch of legacyBatches.docs) {
      const items = batch.data().items;
      if (Array.isArray(items) && await orderImportId(items) === importId) return true;
    }
    return false;
  }

  /**
   * Core import pipeline shared by both text and Excel import methods:
   *  1. Validate a month is selected
   *  2. Fuzzy-match every order's employee name against known employees,
   *     auto-creating employee records for genuinely new names so nothing
   *     is silently dropped (their hours start at 0 until entered)
   *  3. Persist the orders into the current month's `orderBatches`
   *     subcollection in chunks of 500 (Firestore batched-write limit),
   *     which keeps 100k+ order imports fast and cheap
   *
   * Auto-created employees land in the department currently being viewed
   * (or Moderators in Company View), so an import into a department view
   * doesn't scatter new people across the company.
   */
  async function processImportedOrders(orders, errors, options = {}) {
    showImportErrors(errors);

    if (orders.length === 0) {
      Toast.show(errors.length ? 'لا توجد طلبات صالحة للاستيراد' : 'لا توجد بيانات للاستيراد', 'error');
      return;
    }
    if (!state.currentMonthId) {
      Toast.show('الرجاء اختيار الشهر أولاً', 'error');
      return;
    }

    // Orders are imported into the SELECTED month, so that month must be open.
    try {
      Months.assertEditable(state.currentMonthId, 'الاستيراد');
    } catch (err) {
      console.error('Excel import rejected before order write', {
        monthId: state.currentMonthId,
        message: err.message
      });
      Toast.show(err.message, 'error');
      return;
    }

    const selectedImportDepartment = options.departmentId || document.getElementById('importDepartmentSelect')?.value || 'auto';
    const importDepartmentId = (selectedImportDepartment !== 'auto' && !Departments.isArchived(selectedImportDepartment))
      ? selectedImportDepartment
      : ((state.departmentFilter !== 'all' &&
                                !Departments.isArchived(state.departmentFilter))
      ? state.departmentFilter
      : Departments.defaultId());

    if (!importDepartmentId) {
      Toast.show('لا يوجد قسم نشط لإضافة الموظفين الجدد فيه', 'error');
      return;
    }

    let sourceDuplicates = Number(options.skippedSimilar || 0);

    Loading.show('جاري معالجة الطلبات...');
    Loading.setProgress(0);
    try {
      // Work on a local mutable copy of employees so newly-created ones
      // within this same import batch are matched too (avoids duplicate
      // employee creation for the same new name appearing multiple times).
      const workingEmployees = state.employees.map(m => ({ ...m }));
      const newEmployees = []; // to be written to Firestore
      const preparedOrders = [];

      for (const order of orders) {
        let match = Utils.findBestModeratorMatch(order.name, workingEmployees);

        if (!match) {
          const normalizedName = Utils.normalizeName(order.name);
          match = {
            id: null, // resolved after Firestore write
            tempKey: normalizedName,
            name: order.name,
            normalizedName,
            departmentId: importDepartmentId
          };
          workingEmployees.push(match);
          newEmployees.push(match);
        }

        preparedOrders.push({
          employeeRef: match, // resolved to moderatorId below
          packages: order.packages,
          price: order.price,
          orderDate: order.orderDate || '', externalOrderNumber: order.externalOrderNumber || '',
          customerName: order.customerName || '', customerPhone: order.customerPhone || '',
          notes: order.notes || '', fullAddress: order.fullAddress || '', productName: order.productName || '',
          waybillNumber: order.waybillNumber || '', governorate: order.governorate || '',
          shipmentStatus: order.shipmentStatus || 'لم يتم التحديث'
        });
      }

      // Check the canonical content fingerprint before creating employees or
      // persisting any order batch. Every chunk of a new import carries the
      // same id, while legacy batches are compared by their stored items.
      const importId = await orderImportId(orders);
      const batchesRef = db.collection(COLLECTIONS.MONTHLY_REPORTS)
        .doc(state.currentMonthId)
        .collection(MONTH_SUBCOLLECTIONS.ORDER_BATCHES);
      if (!options.sourceId && await importAlreadyExists(batchesRef, importId)) {
        Toast.show('تم استيراد هذا الملف مسبقًا', 'error');
        return false;
      }

      // Create any brand-new employees first (so we have real IDs).
      //
      // Each one carries its own audit entry in the SAME batch as its
      // document, exactly like an employee added by hand - an import is not
      // allowed to be the one path that creates payroll records silently.
      //
      // Chunked through the shared committer because both the employee write
      // and its audit entry count against Firestore's 500-op batch ceiling:
      // a single import of 300+ new names would otherwise exceed it and fail
      // wholesale.
      // Rough progress unit: one "unit" per new employee plus one per order,
      // split roughly 30/70 between the two phases below so the bar moves
      // steadily even when one phase is much bigger than the other.
      const totalOrders = preparedOrders.length;
      const employeePhaseWeight = newEmployees.length > 0 ? 30 : 0;
      const orderPhaseWeight = 100 - employeePhaseWeight;

      if (newEmployees.length > 0) {
        newEmployees.forEach(ne => {
          // The id is generated up front so the audit entry can name the
          // document it creates.
          ne.id = db.collection(COLLECTIONS.EMPLOYEES).doc().id;
        });

        Loading.setLabel(`جاري إنشاء الموظفين الجدد... 0/${newEmployees.length}`);
        await ServiceCommon.commitInChunks(newEmployees, (batch, ne) => {
          const ref = db.collection(COLLECTIONS.EMPLOYEES).doc(ne.id);
          const payload = {
            name: ne.name,
            normalizedName: ne.normalizedName,
            departmentId: importDepartmentId,
            status: 'active',
            hireDate: null,
            notes: '',
            // Auto-created employees start with no salary until the admin
            // enters one - unchanged from the previous behaviour.
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          };
          batch.set(ref, payload);

          AuditService.appendToBatch(batch, {
            action: AuditService.actionFor('employees', AuditService.OPERATION.CREATE),
            entity: 'employees',
            operation: AuditService.OPERATION.CREATE,
            documentId: ne.id,
            documentLabel: ne.name,
            monthId: state.currentMonthId,
            after: payload,
            details: {
              reason: 'auto_created_on_import',
              importDepartmentId,
              importDepartmentName: Departments.nameOf(importDepartmentId)
            }
          });

          // Two operations per item: the document and its audit entry.
          return 2;
        }, undefined, (employeesDone, employeesTotal) => {
          Loading.setLabel(`جاري إنشاء الموظفين الجدد... ${employeesDone}/${employeesTotal}`);
          Loading.setProgress((employeesDone / employeesTotal) * employeePhaseWeight);
        });
      }

      // Build final order records with resolved moderatorId.
      // `moderatorId` keeps its name: every historical order batch uses it.
      const finalOrders = preparedOrders.map(o => ({
        orderId: db.collection(COLLECTIONS.MONTHLY_REPORTS).doc().id,
        moderatorId: o.employeeRef.id,
        moderatorName: o.employeeRef.name,
        departmentId: o.employeeRef.departmentId || importDepartmentId,
        departmentName: Departments.nameOf(o.employeeRef.departmentId || importDepartmentId),
        packages: o.packages,
        price: o.price,
        saleValue: o.price,
        orderDate: o.orderDate, externalOrderNumber: o.externalOrderNumber,
        customerName: o.customerName, customerPhone: o.customerPhone, notes: o.notes,
        fullAddress: o.fullAddress, productName: o.productName,
        waybillNumber: o.waybillNumber, governorate: o.governorate,
        shipmentStatus: o.shipmentStatus
      }));

      // Write orders in chunks of 500 inside the month's orderBatches subcollection
      const CHUNK = 500;
      for (let i = 0; i < finalOrders.length; i += CHUNK) {
        const chunkItems = finalOrders.slice(i, i + CHUNK);
        const batchRef = batchesRef.doc();
        const autoCreatedEmployeeIds = Array.from(new Set(chunkItems
          .map(item => item.moderatorId)
          .filter(id => newEmployees.some(employee => employee.id === id))));
        const write = db.batch();
        write.set(batchRef, {
          importId,
          fileName: excelImportPreview?.fileName || 'استيراد',
          errorCount: Array.isArray(errors) ? errors.length : 0,
          importDepartmentId,
          importDepartmentName: Departments.nameOf(importDepartmentId),
          items: chunkItems,
          count: chunkItems.length,
          monthId: state.currentMonthId,
          importedAt: firebase.firestore.FieldValue.serverTimestamp(),
          importedBy: auth.currentUser ? (auth.currentUser.email || null) : null,
          autoCreatedEmployeeIds,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        // Keep the lightweight month index accurate even before the report
        // is calculated, and make an imported month ineligible for the
        // “delete empty month” action in the same atomic write as its batch.
        const monthRef = db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(state.currentMonthId);
        const summaryRef = db.collection(COLLECTIONS.MONTHLY_SUMMARIES).doc(state.currentMonthId);
        const countUpdate = {
          isEmpty: false,
          orderCount: firebase.firestore.FieldValue.increment(chunkItems.length),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        write.set(monthRef, countUpdate, { merge: true });
        write.set(summaryRef, countUpdate, { merge: true });
        await write.commit();
        const ordersDone = Math.min(i + chunkItems.length, totalOrders);
        Loading.setLabel(`جاري حفظ الطلبات... ${ordersDone}/${totalOrders}`);
        Loading.setProgress(employeePhaseWeight + (totalOrders ? (ordersDone / totalOrders) * orderPhaseWeight : orderPhaseWeight));
      }

      // ONE audit entry for the whole import, not one per order: a hundred
      // thousand entries would bury the log and hide the single fact that
      // matters - who imported how much into which month.
      //
      // Auto-created employees ARE named individually (capped), because an
      // import quietly creating payroll records is exactly the kind of side
      // effect that needs to be reviewable afterwards.
      await AuditService.log(AuditService.ACTION.ORDERS_IMPORTED, {
        entity: 'months',
        operation: AuditService.OPERATION.CREATE,
        documentId: state.currentMonthId,
        documentLabel: currentMonthLabel(),
        monthId: state.currentMonthId,
        // Auto-creating employees is a side effect worth flagging above
        // routine, so an import that added people reads as a warning.
        severity: newEmployees.length > 0
          ? AuditService.SEVERITY.WARNING : AuditService.SEVERITY.INFO,
        details: {
          monthId: state.currentMonthId,
          monthLabel: currentMonthLabel(),
          orderCount: finalOrders.length,
          skippedLines: (errors || []).length,
          newEmployeeCount: newEmployees.length,
          newEmployeeNames: newEmployees.slice(0, 50).map(e => e.name),
          newEmployeeNamesTruncated: newEmployees.length > 50,
          importDepartmentId,
          importDepartmentName: Departments.nameOf(importDepartmentId)
        }
      });

      document.getElementById('importTextArea').value = '';
      Loading.setProgress(100);

      const skippedCount = (errors || []).length;
      let successMsg = `تم استيراد ${finalOrders.length} طلب بنجاح`;
      if (skippedCount > 0) {
        successMsg += ` — تم تجاهل ${skippedCount} صف به مشاكل (التفاصيل تحت مربع الاستيراد)`;
      }
      if (newEmployees.length) {
        successMsg += ` — تمت إضافة ${newEmployees.length} موظف جديد تلقائيًا في قسم "${Departments.nameOf(importDepartmentId)}"`;
      }
      Toast.show(successMsg, 'success', {
        label: 'استيراد ملف آخر',
        onClick: () => document.getElementById('excelFileInput').click()
      });
      loadAuditLogs();
      return options.sourceId ? { imported: finalOrders.length, duplicates: sourceDuplicates, errors: (errors || []).length } : true;
    } catch (err) {
      Toast.show('خطأ أثناء الاستيراد: ' + err.message, 'error');
      return false;
    } finally {
      Loading.hide();
    }
  }

  /* ============================================================
   * CALCULATE REPORT
   * ============================================================ */

  /**
   * Reads the debt each moderator carried out of the PREVIOUS calendar
   * month, which becomes this month's `previousDebt`. Costs exactly one
   * Firestore document read, and returns an empty map when there is no
   * previous month, it was never calculated, or nothing was carried.
   */
  async function loadPreviousDebts(monthId) {
    const prevId = Utils.previousMonthId(monthId);
    if (!prevId) return {};
    try {
      const snap = await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(prevId).get();
      if (!snap.exists) return {};
      return Utils.carriedDebtMap(snap.data().report);
    } catch (err) {
      console.error('loadPreviousDebts failed:', err);
      return {};
    }
  }

  /**
   * After recalculating month N, month N+1's `previousDebt` may no longer
   * match what N now carries. We do NOT silently rewrite N+1 (that would
   * cascade edits through months the admin already signed off on) - we warn
   * so they can re-press "حساب" on the affected month deliberately.
   *
   * A LOCKED next month never reaches here: Months.assertRecalculable()
   * refuses the recalculation up front, because a locked month can no
   * longer be corrected at all.
   */
  async function warnIfNextMonthStale(monthId) {
    const nextId = Utils.nextMonthId(monthId);
    if (!nextId) return;
    try {
      const snap = await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(nextId).get();
      const nextReport = snap.exists ? snap.data().report : null;
      if (Array.isArray(nextReport) && nextReport.length > 0) {
        Toast.show(
          `تنبيه: شهر ${Utils.monthLabelFromId(nextId)} متحسب قبل كده. لو الديون المرحّلة اتغيرت، افتحه واضغط "حساب" تاني عشان يتحدث`,
          'info'
        );
      }
    } catch (err) {
      console.error('warnIfNextMonthStale failed:', err);
    }
  }

  async function calculateReport() {
    Permissions.require('reports.calculate');
    if (!state.currentMonthId) {
      Toast.show('الرجاء اختيار الشهر أولاً', 'error');
      return false;
    }

    // Two separate guards, for two separate reasons:
    //   * the month itself must be open (assertEditable), and
    //   * the FOLLOWING month must not be locked, because recalculating
    //     rewrites the carriedDebt that the next month already deducted
    //     as previousDebt - and a locked month can no longer absorb the
    //     correction. Both live in Months.assertRecalculable().
    try {
      Months.assertRecalculable(state.currentMonthId);
    } catch (err) {
      Toast.show(err.message, 'error');
      return false;
    }

    Loading.show('جاري حساب التقرير...');
    try {
      const [batchesSnap, previousDebts] = await Promise.all([
        db.collection(COLLECTIONS.MONTHLY_REPORTS)
          .doc(state.currentMonthId).collection(MONTH_SUBCOLLECTIONS.ORDER_BATCHES).get(),
        loadPreviousDebts(state.currentMonthId)
      ]);

      // Single-pass aggregation across every order in the month - O(n).
      // Bonus is computed per EMPLOYEE'S DEPARTMENT table, because a
      // department may override the company-wide bonus rules.
      const carryDebt = state.currentMonthCarryDebt;

      // EMPLOYEES ON THE PAYROLL FOR THIS MONTH.
      //
      // An inactive employee has left the company and has already been paid
      // through a final settlement (مخالصة نهاية الخدمة), so paying them a
      // monthly salary on top would be a double payment.
      //
      // The exclusion is applied HERE, at calculation time, and nowhere
      // else - which means it only ever affects months calculated from now
      // on. Every already-calculated month keeps its own frozen `report`
      // rows, so settling someone today can never retroactively remove them
      // from a month they genuinely worked.
      const payrollEmployees = state.employees.filter(emp => emp.status !== 'inactive');
      const excludedCount = state.employees.length - payrollEmployees.length;

      // Resolve each employee's bonus table ONCE up front, and capture it
      // as this month's permanent snapshot. Everything below reads from
      // this map, so one employee is never billed under two different
      // rule tables within the same calculation.
      const rulesByEmployee = new Map();
      const departmentRulesSnapshot = { ...state.currentMonthDepartmentBonusRules };

      payrollEmployees.forEach(emp => {
        const deptId = employeeDepartmentId(emp);
        // Fixed-salary departments never earn a bonus, so there is nothing
        // to resolve or snapshot here.
        if (Departments.isFixed(deptId)) return;

        const rules = bonusRulesForEmployee(emp);
        const dept = Departments.byId(deptId) || {};
        rulesByEmployee.set(emp.id, {
          bonusType: dept.salaryType === Departments.SALARY_TYPE.COMMISSION ? 'sales' : (dept.bonusType || 'packages'),
          bonusRules: rules,
          salesBonusRules: Array.isArray(dept.salesBonusRules) ? dept.salesBonusRules : []
        });

        // Stamp the department's bonus rules onto the month permanently.
        // From now on this month reproduces identical figures even if the
        // department's rules are edited, renamed or archived later.
        const liveRules = Departments.bonusRulesOf(deptId);
        if (departmentRulesSnapshot[deptId] === undefined && liveRules) {
          departmentRulesSnapshot[deptId] = { ...liveRules };
        }
      });

      const statsByEmployee = new Map();
      const globalRules = { bonusType: state.settings.bonusType || 'packages', bonusRules: state.currentMonthBonusRules || Utils.DEFAULT_BONUS_RULES, salesBonusRules: Array.isArray(state.settings.salesBonusRules) ? state.settings.salesBonusRules : [] };

      batchesSnap.forEach(doc => {
        const items = doc.data().items || [];
        for (const item of items) {
          let s = statsByEmployee.get(item.moderatorId);
          if (!s) {
            s = { ordersCount: 0, totalPackages: 0, totalSales: 0, totalBonus: 0,
                  distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0, '9': 0, '10+': 0 } };
            statsByEmployee.set(item.moderatorId, s);
          }
          s.ordersCount += 1;
          s.totalPackages += item.packages;
          s.totalSales += item.price;
          // Orders belonging to a since-deleted employee still contribute
          // to the company total under the global rules.
          const rules = rulesByEmployee.get(item.moderatorId) || globalRules;
          s.totalBonus += Utils.calculateBonus({ packages: item.packages, saleValue: item.saleValue || item.price, config: rules });
          const bucket = Utils.packageBucket(item.packages);
          if (s.distribution[bucket] !== undefined) s.distribution[bucket] += 1;
        }
      });

      // Sum this month's advances and manual adjustments per employee
      const advancesByEmployee = new Map();
      state.advances.filter(a => a.monthId === state.currentMonthId).forEach(a => {
        advancesByEmployee.set(a.moderatorId, (advancesByEmployee.get(a.moderatorId) || 0) + Number(a.amount || 0));
      });
      const adjustmentsByEmployee = new Map();
      state.adjustments.filter(a => a.monthId === state.currentMonthId).forEach(a => {
        adjustmentsByEmployee.set(a.moderatorId, (adjustmentsByEmployee.get(a.moderatorId) || 0) + Number(a.amount || 0));
      });

      // Build the full report including employees with zero orders this month
      const report = payrollEmployees.map(emp => {
        const s = statsByEmployee.get(emp.id) || {
          ordersCount: 0, totalPackages: 0, totalSales: 0, totalBonus: 0,
          distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0, '9': 0, '10+': 0 }
        };
        const totalAdvances = advancesByEmployee.get(emp.id) || 0;
        const totalAdjustments = adjustmentsByEmployee.get(emp.id) || 0;

        const departmentId = employeeDepartmentId(emp);
        const isFixedDept = Departments.isFixed(departmentId);

        // Every employee's base salary is their own fixed monthly amount,
        // prorated by hire date if they joined during this exact month.
        const salary = Utils.calculateBaseSalary(
          emp.fixedSalaryAmount, emp.hireDate, state.currentMonthId
        );

        // Bonus-type ("بونص") departments earn the automatic per-order
        // bonus on top; fixed-salary departments never do, regardless of
        // whether any orders happen to be imported for them.
        const totalBonusRaw = isFixedDept ? 0 : s.totalBonus;

        // Debt carried out of the previous month, deducted here. Anything
        // this month still cannot cover rolls forward as `carriedDebt`.
        const previousDebt = Utils.toFiniteNumber(previousDebts[emp.id]) || 0;
        const { finalSalary, carriedDebt } = Utils.settleSalary({
          salary,
          totalBonus: totalBonusRaw,
          totalAdjustments,
          totalAdvances,
          previousDebt,
      carryDebt
      , salesBonusRules: state.settings.salesBonusRules || []
        });

        return {
          moderatorId: emp.id,
          name: emp.name,
          departmentId,
          // NAME SNAPSHOT. This is the whole point of Option B: the row
          // stores the department's name AS IT IS RIGHT NOW. Renaming the
          // department tomorrow leaves this report showing the old name.
          departmentName: Departments.nameOf(departmentId),
          salaryType: isFixedDept ? Departments.SALARY_TYPE.FIXED : Departments.SALARY_TYPE.HOURLY,
          // Reference-only snapshot of the employee's own "hours/day" field.
          // Never used in any salary math.
          dailyWorkHours: emp.dailyWorkHours,
          salary,
          ordersCount: s.ordersCount,
          totalPackages: s.totalPackages,
          totalSales: s.totalSales,
          totalBonus: Utils.round2(totalBonusRaw),
          totalAdjustments: Utils.round2(totalAdjustments),
          totalAdvances: Utils.round2(totalAdvances),
          previousDebt,
          carriedDebt,
          finalSalary,
          distribution: s.distribution
        };
      });

      state.currentReport = report;

      const totals = Reports.computeTotals(report);
      // Option B: department summaries are computed once at calculation
      // time and STORED on the month document. Every later read - the
      // dashboard, the report view, exports - uses this frozen array.
      const departmentTotals = Reports.buildDepartmentTotals(report);
      state.currentDepartmentTotals = departmentTotals;
      state.currentMonthDepartmentBonusRules = departmentRulesSnapshot;

      await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(state.currentMonthId).set({
        report,
        totals,
        departmentTotals,
        monthLabel: currentMonthLabel(),
        // Persist the snapshot used for this calculation, so every later
        // recalculation reproduces identical numbers.
        bonusRules: { ...globalRules },
        departmentBonusRules: departmentRulesSnapshot,
        carryDebt,
        calculatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Keep the lightweight month index in step with the report, so the
      // Months page dashboard is accurate without waiting for a close.
      // Best-effort: the calculation itself has already been saved, so a
      // failed index write must not surface as a calculation failure.
      try {
        await Months.refreshSummary(state.currentMonthId, {
          monthLabel: currentMonthLabel(),
          status: Months.isLocked(state.currentMonthId)
            ? Months.STATUS.LOCKED : Months.STATUS.OPEN,
          report,
          totals,
          departmentTotals
        });
      } catch (err) {
        console.error('Could not refresh month summary:', err);
      }

      renderReportTable();
      renderDashboard();
      updateCloseMonthButtonState();
      renderReportApprovalStatus();

      // Auditing the calculation records the FIGURES, not the rows: the
      // report itself is stored on the month document, so duplicating it
      // here would double the storage for no extra information. What the log
      // adds is who ran it, when, and what the headline totals came out as -
      // which is what makes "these numbers changed" traceable.
      await AuditService.log(AuditService.ACTION.REPORT_CALCULATED, {
        entity: 'months',
        operation: AuditService.OPERATION.UPDATE,
        documentId: state.currentMonthId,
        documentLabel: currentMonthLabel(),
        monthId: state.currentMonthId,
        details: {
          monthId: state.currentMonthId,
          monthLabel: currentMonthLabel(),
          employeeCount: report.length,
          excludedInactive: excludedCount,
          finalSalaryTotal: totals ? (totals.finalSalary || 0) : 0,
          totalBonus: totals ? (totals.totalBonus || 0) : 0,
          totalAdvances: totals ? (totals.totalAdvances || 0) : 0,
          carriedDebtTotal: totals ? (totals.carriedDebt || 0) : 0,
          indebtedEmployees: report.filter(r => r.carriedDebt > 0).length
        }
      });

      const indebted = report.filter(r => r.carriedDebt > 0).length;
      const notes = [];
      if (indebted > 0) notes.push(`${indebted} موظف عليهم دين مرحّل للشهر القادم`);
      if (excludedCount > 0) {
        notes.push(`تم استثناء ${excludedCount} موظف غير نشط (تمت تسوية مستحقاتهم)`);
      }
      Toast.show(
        notes.length > 0
          ? `تم حساب التقرير بنجاح. ${notes.join(' • ')}`
          : 'تم حساب التقرير بنجاح',
        'success'
      );

      await warnIfNextMonthStale(state.currentMonthId);
      return true;
    } catch (err) {
      console.error('Report calculation failed:', err);
      Toast.show('حدث خطأ أثناء حساب التقرير: ' + err.message, 'error');
      return false;
    } finally {
      Loading.hide();
    }
  }

  function renderCompanySalesRules() {
    const wrap = document.getElementById('companySalesBonusRules'); if (!wrap) return;
    wrap.classList.remove('hidden');
    wrap.innerHTML = (state.settings.salesBonusRules || []).map((r,i) => `<div class="sales-tier"><input type="number" aria-label="من قيمة" placeholder="من قيمة" data-sales-from="${i}" value="${r.from}"><input type="number" aria-label="إلى قيمة" placeholder="إلى قيمة" data-sales-to="${i}" value="${r.to}"><input type="number" aria-label="العمولة" placeholder="العمولة" data-sales-bonus="${i}" value="${r.bonus}"><button type="button" data-sales-delete="${i}">حذف</button></div>`).join('');
    wrap.querySelectorAll('input').forEach(el=>el.addEventListener('input',()=>{const i=Number(el.dataset.salesFrom??el.dataset.salesTo??el.dataset.salesBonus);const key=el.dataset.salesFrom?'from':el.dataset.salesTo?'to':'bonus';state.settings.salesBonusRules[i][key]=Number(el.value)||0;}));
    wrap.querySelectorAll('[data-sales-delete]').forEach(el=>el.addEventListener('click',()=>{state.settings.salesBonusRules.splice(Number(el.dataset.salesDelete),1);renderCompanySalesRules();}));
  }

  function requireReport() {
    if (!state.currentReport || state.currentReport.length === 0) {
      Toast.show('لا يوجد تقرير محسوب لهذا الشهر بعد', 'error');
      return false;
    }
    return true;
  }

  /* ============================================================
   * DEPARTMENT SCOPING (Company View <-> Department View)
   * ------------------------------------------------------------
   * One filter drives the dashboard, the report table and every export,
   * so what you see is always exactly what you export.
   * ============================================================ */

  /**
   * The report rows inside the active department scope.
   *
   * Legacy rows (calculated before departments existed) carry no
   * departmentId - they are attributed to Moderators, which is precisely
   * the department their employees were migrated into, so a historical
   * month filtered by "Moderators" shows the same people it always did.
   */
  function scopedReport() {
    if (state.departmentFilter === 'all') return state.currentReport;
    return state.currentReport.filter(r =>
      Utils.rowDepartmentId(r, Departments.MODERATORS_ID) === state.departmentFilter
    );
  }

  /** Rows handed to the exporters: department scope, search and sort applied. */
  function exportRows() {
    return getFilteredSortedReport();
  }

  /**
   * Extra context every exporter needs to label itself correctly:
   * which department (if any) the export is scoped to, and the stored
   * department summaries for the company-wide breakdown block.
   */
  function exportContext() {
    return {
      scopeLabel: currentScopeLabel(),
      isCompanyView: state.departmentFilter === 'all',
      departmentTotals: displayDepartmentTotals()
    };
  }

  /**
   * The department summaries to display for the current month.
   *
   * Reads the STORED `departmentTotals` array whenever the month has one
   * (Option B) - it is never recalculated, so historical months keep
   * their original employee counts, totals and department NAME snapshots
   * even after departments are renamed, archived or employees move.
   *
   * The only time totals are derived on the fly is for a month that was
   * calculated before this feature shipped and therefore has no stored
   * array. Those are derived from the frozen report rows (not from live
   * employees), so they are equally stable.
   */
  function displayDepartmentTotals() {
    if (Array.isArray(state.currentDepartmentTotals) && state.currentDepartmentTotals.length > 0) {
      return state.currentDepartmentTotals;
    }
    if (!state.currentReport || state.currentReport.length === 0) return [];
    return Reports.buildDepartmentTotals(state.currentReport, {
      fallbackDepartmentId: Departments.MODERATORS_ID,
      fallbackDepartmentName: Departments.nameOf(Departments.MODERATORS_ID, 'Moderators')
    });
  }

  /* ============================================================
   * RENDERING - DASHBOARD
   * ============================================================ */

  /** Cards + charts + the department breakdown table, all filter-aware. */
  function renderDashboard() {
    const rows = scopedReport();
    const totals = Reports.computeTotals(rows);
    const departmentTotals = displayDepartmentTotals();
    const canReadReports = typeof Permissions === 'undefined' || Permissions.can('reports.read');
    renderScopeLabels();
    renderDashboardCards(rows, totals);
    renderDashboardStatus();
    renderDashboardHighlights(rows, departmentTotals);
    renderDepartmentBreakdown(departmentTotals);
    // Charts are a visual extra, not core data. A drawing failure (e.g. the
    // Chart.js CDN script failing to load) must never break "Calculate" or
    // any other flow that renders the dashboard afterwards.
    try {
      if (typeof Charts !== 'undefined') {
        Charts.renderAllCharts(canReadReports ? rows : [], {
          departmentTotals: canReadReports ? departmentTotals : [],
          isCompanyView: state.departmentFilter === 'all',
          colorOf: (id) => Departments.colorOf(id)
        });
      }
    } catch (err) {
      console.error('تعذر رسم الرسومات البيانية:', err);
    }
    if (typeof DashboardWidgets !== 'undefined') {
      const dashboardOrders = typeof OrdersManagement === 'undefined' ? [] : OrdersManagement.getAll().filter(order =>
        order.monthId === state.currentMonthId &&
        (state.departmentFilter === 'all' || order.departmentId === state.departmentFilter)
      );
      DashboardWidgets.refresh({ orders: dashboardOrders, auditLogs: state.auditLogs });
    }
  }

  function renderDashboardCards(rows, totals) {
    const canRead = permission => typeof Permissions === 'undefined' || Permissions.can(permission);
    const set = (id, value, permission) => {
      const element = document.getElementById(id);
      if (element) element.textContent = canRead(permission) ? value : '—';
    };

    // Headcount follows the filter: Company View counts everyone, a
    // department view counts only that department's employees.
    const headcount = state.departmentFilter === 'all'
      ? state.employees.length
      : employeesInScope().length;

    set('cardTotalModerators', Utils.formatNumber(headcount), 'employees.read');
    const activeEmployees = state.departmentFilter === 'all'
      ? state.employees.filter(emp => emp.status !== 'inactive').length
      : employeesInScope().filter(emp => emp.status !== 'inactive').length;
    const activeCard = document.getElementById('cardActiveEmployees');
    if (activeCard) activeCard.textContent = canRead('employees.read') ? Utils.formatNumber(activeEmployees) : '—';
    set('cardTotalHours', Utils.formatHours(totals.workedHours), 'reports.read');
    set('cardTotalOrders', Utils.formatNumber(totals.ordersCount), 'reports.read');
    set('cardTotalPackages', Utils.formatNumber(totals.totalPackages), 'reports.read');
    set('cardTotalSales', Utils.formatCurrency(totals.totalSales), 'reports.read');
    const salariesCard = document.getElementById('cardTotalSalaries');
    if (salariesCard) salariesCard.textContent = canRead('reports.read') ? Utils.formatCurrency(totals.salary) : '—';
    set('cardTotalBonus', Utils.formatCurrency(totals.totalBonus), 'reports.read');
    set('cardTotalAdvances', Utils.formatCurrency(totals.totalAdvances), 'transactions.read');
    const inDashboardScope = (record) => {
      if (record.monthId !== state.currentMonthId) return false;
      return state.departmentFilter === 'all' ||
        transactionDepartmentId(record) === state.departmentFilter;
    };
    const monthAdvances = state.advances.filter(inDashboardScope);
    const monthAdjustments = state.adjustments.filter(inDashboardScope);
    const rawAdjustmentsTotal = Utils.round2(monthAdjustments
      .reduce((sum, record) => sum + (Number(record.amount) || 0), 0));
    const adjustmentCard = document.getElementById('cardTotalAdjustments');
    const transactionCountCard = document.getElementById('cardTransactionCount');
    if (adjustmentCard) adjustmentCard.textContent = canRead('transactions.read') ? Utils.formatCurrency(rawAdjustmentsTotal) : '—';
    if (transactionCountCard) transactionCountCard.textContent = canRead('transactions.read') ? Utils.formatNumber(monthAdvances.length + monthAdjustments.length) : '—';
    set('cardTotalCarriedDebt', Utils.formatCurrency(totals.carriedDebt), 'reports.read');
    set('cardTotalFinalSalaries', Utils.formatCurrency(totals.finalSalary), 'reports.read');

    const deptCard = document.getElementById('cardTotalDepartments');
    if (deptCard) {
      const departments = state.departmentFilter === 'all'
        ? Departments.active()
        : Departments.active().filter(department => department.id === state.departmentFilter);
      deptCard.textContent = canRead('departments.read') ? Utils.formatNumber(departments.length) : '—';
    }
  }

  function renderDashboardStatus() {
    const month = state.currentMonthId ? Months.byId(state.currentMonthId) : null;
    const hasReport = state.currentReport.length > 0 || !!(month && month.totals);
    const pendingTransactions = state.advances.concat(state.adjustments)
      .filter(record => record.monthId === state.currentMonthId && record.status === 'pending' &&
        (state.departmentFilter === 'all' || transactionDepartmentId(record) === state.departmentFilter)).length;
    const latestBackup = state.backups[0] || null;
    const latestImport = state.auditLogs.find(log => log.action === AuditService.ACTION.ORDERS_IMPORTED);
    const set = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    };

    set('dashboardStatusMonth', state.currentMonthId ? currentMonthLabel() : '—');
    set('dashboardStatusReport', month && month.status === Months.STATUS.LOCKED
      ? 'معتمد' : (hasReport ? 'غير معتمد' : 'غير محسوب'));
    set('dashboardStatusBackup', (typeof Permissions === 'undefined' || Permissions.can('backups.read'))
      ? (latestBackup ? Utils.formatDateTime(latestBackup.createdAt) : 'لم يتم التحميل') : 'غير متاح');
    set('dashboardStatusPending', (typeof Permissions === 'undefined' || Permissions.can('transactions.read'))
      ? Utils.formatNumber(pendingTransactions) : 'غير متاح');
    set('dashboardStatusImport', (typeof Permissions === 'undefined' || Permissions.can('audit.read'))
      ? (latestImport ? Utils.formatDateTime(latestImport.at || latestImport.createdAt) : 'لا توجد بيانات محملة') : 'غير متاح');
  }

  function renderDashboardHighlights(rows, departmentTotals) {
    const employeeBox = document.getElementById('dashboardEmployeeHighlights');
    const departmentBox = document.getElementById('dashboardDepartmentHighlights');
    if (!employeeBox || !departmentBox) return;

    const maxBy = (items, field) => items.reduce((best, item) =>
      !best || (Number(item[field]) || 0) > (Number(best[field]) || 0) ? item : best, null);
    const insight = (label, name, value) => `
      <div class="dashboard-insight">
        <div><span class="dashboard-insight-label">${Utils.escapeHtml(label)}</span><span class="dashboard-insight-name">${Utils.escapeHtml(name || '—')}</span></div>
        <span class="dashboard-insight-value">${Utils.escapeHtml(value)}</span>
      </div>`;

    const canReadReports = typeof Permissions === 'undefined' || Permissions.can('reports.read');
    if (!canReadReports) {
      employeeBox.innerHTML = '<div class="empty-state">لا تملك صلاحية عرض بيانات التقرير.</div>';
      departmentBox.innerHTML = '<div class="empty-state">لا تملك صلاحية عرض بيانات التقرير.</div>';
      return;
    }
    if (!rows || rows.length === 0) {
      employeeBox.innerHTML = '<div class="empty-state">احسب التقرير لعرض مؤشرات الموظفين.</div>';
    } else {
      const topBonus = maxBy(rows, 'totalBonus');
      const topSales = maxBy(rows, 'totalSales');
      const topOrders = maxBy(rows, 'ordersCount');
      const topPackages = maxBy(rows, 'totalPackages');
      employeeBox.innerHTML = [
        insight('أعلى بونص', topBonus.name, Utils.formatCurrency(topBonus.totalBonus || 0)),
        insight('أعلى مبيعات', topSales.name, Utils.formatCurrency(topSales.totalSales || 0)),
        insight('أكثر طلبات', topOrders.name, Utils.formatNumber(topOrders.ordersCount || 0)),
        insight('أفضل أداء (طرود)', topPackages.name, Utils.formatNumber(topPackages.totalPackages || 0))
      ].join('');
    }

    let departments = Array.isArray(departmentTotals) ? departmentTotals : [];
    if (state.departmentFilter !== 'all') {
      departments = departments.filter(d => d.departmentId === state.departmentFilter);
    }
    if (!departments.length) {
      departmentBox.innerHTML = '<div class="empty-state">لا توجد بيانات أقسام محسوبة لهذا الشهر.</div>';
      return;
    }
    const topDepartment = maxBy(departments, 'finalSalary');
    const productiveDepartment = maxBy(departments, 'totalSales');
    const costlyDepartment = maxBy(departments, 'totalAdvances');
    const salaryDepartment = maxBy(departments, 'totalSalary');
    departmentBox.innerHTML = [
      insight('أعلى قسم صافيًا', topDepartment.departmentName, Utils.formatCurrency(topDepartment.finalSalary || 0)),
      insight('الأكثر إنتاجًا', productiveDepartment.departmentName, Utils.formatCurrency(productiveDepartment.totalSales || 0)),
      insight('أعلى خصومات/سلف', costlyDepartment.departmentName, Utils.formatCurrency(costlyDepartment.totalAdvances || 0)),
      insight('أعلى رواتب أساسية', salaryDepartment.departmentName, Utils.formatCurrency(salaryDepartment.totalSalary || 0))
    ].join('');
  }

  /**
   * The per-department summary table on the dashboard, rendered straight
   * from the month's stored departmentTotals. Only shown in Company View -
   * in a single-department view it would just restate the cards.
   */
  function renderDepartmentBreakdown(departmentTotals) {
    const panel = document.getElementById('departmentBreakdownPanel');
    const tbody = document.getElementById('departmentBreakdownBody');
    if (!panel || !tbody) return;

    const isCompanyView = state.departmentFilter === 'all';
    panel.classList.toggle('hidden', !isCompanyView);
    if (!isCompanyView) return;

    const rows = Array.isArray(departmentTotals) ? departmentTotals : displayDepartmentTotals();
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">لا توجد بيانات محسوبة لهذا الشهر بعد - اضغط "حساب" في التقرير الشهري</td></tr>`;
      return;
    }

    const grand = rows.reduce((acc, d) => {
      acc.employeeCount += d.employeeCount || 0;
      acc.totalSalary += d.totalSalary || 0;
      acc.totalBonus += d.totalBonus || 0;
      acc.totalAdjustments += d.totalAdjustments || 0;
      acc.totalAdvances += d.totalAdvances || 0;
      acc.previousDebt += d.previousDebt || 0;
      acc.carriedDebt += d.carriedDebt || 0;
      acc.finalSalary += d.finalSalary || 0;
      return acc;
    }, { employeeCount: 0, totalSalary: 0, totalBonus: 0, totalAdjustments: 0,
         totalAdvances: 0, previousDebt: 0, carriedDebt: 0, finalSalary: 0 });

    tbody.innerHTML = rows.map(d => {
      // The NAME comes from the stored snapshot, never the live list.
      const archived = Departments.isArchived(d.departmentId);
      return `
      <tr>
        <td>
          <span class="dept-chip">
            <span class="dept-dot" style="background:${Utils.escapeHtml(Departments.colorOf(d.departmentId))}"></span>
            ${Utils.escapeHtml(d.departmentName)}${archived ? ' <span class="badge badge-archived">مؤرشف</span>' : ''}
          </span>
        </td>
        <td>${Utils.formatNumber(d.employeeCount)}</td>
        <td>${Utils.formatCurrency(d.totalSalary)}</td>
        <td class="${(d.totalBonus || 0) < 0 ? 'text-danger' : 'text-success'}">${Utils.formatCurrency(d.totalBonus)}</td>
        <td class="${(d.totalAdjustments || 0) < 0 ? 'text-danger' : 'text-success'}">${Utils.formatCurrency(d.totalAdjustments || 0)}</td>
        <td class="text-danger">${Utils.formatCurrency(Utils.round2((d.totalAdvances || 0) + (d.previousDebt || 0)))}</td>
        <td class="${(d.carriedDebt || 0) > 0 ? 'text-danger' : ''}">${Utils.formatCurrency(d.carriedDebt || 0)}</td>
        <td class="text-strong">${Utils.formatCurrency(d.finalSalary)}</td>
      </tr>`;
    }).join('') + `
      <tr class="row-total">
        <td>الإجمالي</td>
        <td>${Utils.formatNumber(grand.employeeCount)}</td>
        <td>${Utils.formatCurrency(Utils.round2(grand.totalSalary))}</td>
        <td>${Utils.formatCurrency(Utils.round2(grand.totalBonus))}</td>
        <td>${Utils.formatCurrency(Utils.round2(grand.totalAdjustments))}</td>
        <td class="text-danger">${Utils.formatCurrency(Utils.round2(grand.totalAdvances + grand.previousDebt))}</td>
        <td>${Utils.formatCurrency(Utils.round2(grand.carriedDebt))}</td>
        <td class="text-strong">${Utils.formatCurrency(Utils.round2(grand.finalSalary))}</td>
      </tr>`;
  }

  /* ============================================================
   * RENDERING - REPORT TABLE (search + sort)
   * ============================================================ */

  function getFilteredSortedReport() {
    // Department scope first, then the text search, then sorting.
    let rows = [...scopedReport()];

    if (state.searchTerm) {
      const term = Utils.normalizeName(state.searchTerm);
      rows = rows.filter(r => Utils.normalizeName(r.name).includes(term));
    }

    const { key, dir } = state.sort;

    // Read through the legacy-aware accessors so sorting works identically
    // on new rows and on rows saved before the hourly-salary system.
    const valueOf = (row) => {
      if (key === 'salary') return Utils.rowSalary(row);
      if (key === 'previousDebt') return Utils.rowPreviousDebt(row);
      if (key === 'carriedDebt') return Utils.rowCarriedDebt(row);
      if (key === 'departmentName') {
        return Utils.rowDepartmentName(
          row, Departments.nameOf(Utils.rowDepartmentId(row, Departments.MODERATORS_ID))
        );
      }
      if (key === 'workedHours') {
        const h = Utils.rowDailyHours(row);
        return h === null ? -1 : h;   // legacy rows sort below any real value
      }
      const v = row[key];
      return (v === undefined || v === null) ? 0 : v;
    };

    rows.sort((a, b) => {
      let av = valueOf(a), bv = valueOf(b);
      if (typeof av === 'string' || typeof bv === 'string') {
        av = String(av).toLowerCase();
        bv = String(bv).toLowerCase();
      }
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });

    return rows;
  }

  function renderReportTable() {
    const tbody = document.getElementById('reportTableBody');
    const rows = getFilteredSortedReport();
    renderReportFinancialSummary(Reports.computeTotals(scopedReport()));

    document.querySelectorAll('#reportTable th[data-sort]').forEach(th => {
      th.classList.toggle('sorted-asc', th.dataset.sort === state.sort.key && state.sort.dir === 'asc');
      th.classList.toggle('sorted-desc', th.dataset.sort === state.sort.key && state.sort.dir === 'desc');
    });

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="13" class="empty-state">${
        state.currentReport.length === 0
          ? 'لا توجد بيانات - سجّل ساعات العمل واستورد الطلبات ثم اضغط "حساب"'
          : 'لا يوجد موظف مطابق في هذا القسم'
      }</td></tr>`;
      renderReportTotalsRow(rows);
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const prevDebt = Utils.rowPreviousDebt(r);
      const carried = Utils.rowCarriedDebt(r);
      const deptId = Utils.rowDepartmentId(r, Departments.MODERATORS_ID);
      // Historical rows render their own stored name; only rows that
      // predate the feature fall back to the live department list.
      const deptName = Utils.rowDepartmentName(r, Departments.nameOf(deptId));
      return `
      <tr class="clickable-row" data-id="${r.moderatorId}">
        <td>${Utils.escapeHtml(r.name)}</td>
        <td>
          <span class="dept-chip">
            <span class="dept-dot" style="background:${Utils.escapeHtml(Departments.colorOf(deptId))}"></span>
            ${Utils.escapeHtml(deptName)}
          </span>
        </td>
        <td>${Utils.formatHours(Utils.rowDailyHours(r))}</td>
        <td>${Utils.formatCurrency(Utils.rowSalary(r))}</td>
        <td class="${r.totalBonus < 0 ? 'text-danger' : 'text-success'}">${Utils.formatCurrency(r.totalBonus)}</td>
        <td class="${(r.totalAdjustments || 0) < 0 ? 'text-danger' : 'text-success'}">${Utils.formatCurrency(r.totalAdjustments || 0)}</td>
        <td class="text-danger">${Utils.formatCurrency(r.totalAdvances || 0)}</td>
        <td class="${prevDebt > 0 ? 'text-danger' : ''}">${Utils.formatCurrency(prevDebt)}</td>
        <td class="text-strong">${Utils.formatCurrency(r.finalSalary)}</td>
        <td class="${carried > 0 ? 'text-danger text-strong' : ''}">${Utils.formatCurrency(carried)}</td>
        <td>${Utils.formatNumber(r.ordersCount)}</td>
        <td>${Utils.formatNumber(r.totalPackages)}</td>
        <td>${Utils.formatCurrency(r.totalSales)}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.clickable-row').forEach(tr => {
      tr.addEventListener('click', () => openDetailsModal(tr.dataset.id));
    });

    renderReportTotalsRow(rows, Reports.computeTotals(rows));
  }

  /** Financial summary for the active report scope, before search filtering. */
  function renderReportFinancialSummary(totals) {
    const summary = document.getElementById('reportFinancialSummary');
    if (!summary) return;
    const deductions = Utils.round2((totals.totalAdvances || 0) + (totals.previousDebt || 0));
    summary.innerHTML = [
      ['إجمالي الراتب الأساسي', totals.salary],
      ['إجمالي البونص', totals.totalBonus],
      ['إجمالي التسويات', totals.totalAdjustments],
      ['إجمالي الخصومات', deductions],
      ['صافي المستحقات', totals.finalSalary]
    ].map(([label, value]) => `
      <div class="cs-item">
        <div class="cs-value">${Utils.formatCurrency(value || 0)}</div>
        <div class="cs-label">${label}</div>
      </div>`).join('');
  }

  /** Footer totals for exactly the rows currently on screen. */
  function renderReportTotalsRow(rows, totals) {
    const tfoot = document.getElementById('reportTableFoot');
    if (!tfoot) return;

    if (!rows || rows.length === 0) {
      tfoot.innerHTML = '';
      return;
    }

    const t = totals || Reports.computeTotals(rows);
    tfoot.innerHTML = `
      <tr>
        <td>الإجمالي</td>
        <td>${Utils.escapeHtml(currentScopeLabel())}</td>
        <td>${Utils.formatHours(t.workedHours)}</td>
        <td>${Utils.formatCurrency(t.salary)}</td>
        <td>${Utils.formatCurrency(t.totalBonus)}</td>
        <td>${Utils.formatCurrency(t.totalAdjustments)}</td>
        <td>${Utils.formatCurrency(t.totalAdvances)}</td>
        <td>${Utils.formatCurrency(t.previousDebt)}</td>
        <td class="text-strong">${Utils.formatCurrency(t.finalSalary)}</td>
        <td>${Utils.formatCurrency(t.carriedDebt)}</td>
        <td>${Utils.formatNumber(t.ordersCount)}</td>
        <td>${Utils.formatNumber(t.totalPackages)}</td>
        <td>${Utils.formatCurrency(t.totalSales)}</td>
      </tr>`;
  }

  /* ============================================================
   * EMPLOYEE DETAILS MODAL
   * ============================================================ */

  function openDetailsModal(employeeId) {
    const r = state.currentReport.find(x => x.moderatorId === employeeId);
    if (!r) return;

    const deptId = Utils.rowDepartmentId(r, Departments.MODERATORS_ID);

    document.getElementById('detailsModalTitle').textContent = r.name;
    const deptEl = document.getElementById('detailsDepartment');
    if (deptEl) {
      deptEl.textContent = Utils.rowDepartmentName(r, Departments.nameOf(deptId));
    }
    document.getElementById('detailsWorkedHours').textContent = Utils.formatHours(Utils.rowDailyHours(r));
    document.getElementById('detailsSalary').textContent = Utils.formatCurrency(Utils.rowSalary(r));
    document.getElementById('detailsBonus').textContent = Utils.formatCurrency(r.totalBonus);
    document.getElementById('detailsAdjustments').textContent = Utils.formatCurrency(r.totalAdjustments || 0);
    document.getElementById('detailsAdvances').textContent = Utils.formatCurrency(r.totalAdvances || 0);
    document.getElementById('detailsPreviousDebt').textContent = Utils.formatCurrency(Utils.rowPreviousDebt(r));
    document.getElementById('detailsFinalSalary').textContent = Utils.formatCurrency(r.finalSalary);
    document.getElementById('detailsCarriedDebt').textContent = Utils.formatCurrency(Utils.rowCarriedDebt(r));
    document.getElementById('detailsOrdersCount').textContent = Utils.formatNumber(r.ordersCount);
    document.getElementById('detailsPackagesCount').textContent = Utils.formatNumber(r.totalPackages);
    document.getElementById('detailsTotalSales').textContent = Utils.formatCurrency(r.totalSales);

    const dist = r.distribution || {};
    const distContainer = document.getElementById('detailsDistribution');
    const bucketLabels = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10+'];
    distContainer.innerHTML = bucketLabels.map(b => `
      <div class="dist-row">
        <span class="dist-label">${b} طرد</span>
        <span class="dist-value">${Utils.formatNumber(dist[b] || 0)}</span>
      </div>`).join('');

    document.getElementById('detailsModal').classList.add('open');
  }

  function closeDetailsModal() {
    document.getElementById('detailsModal').classList.remove('open');
  }

  async function syncGoogleSource(source, rows, errors, skippedSimilar = 0) {
    const result = await processImportedOrders(rows, errors, { departmentId: source.departmentId, sourceId: source.id, skippedSimilar });
    return result || { imported: 0, duplicates: 0, errors: (errors || []).length };
  }

  async function findSimilarGoogleOrders(rows) {
    if (!state.currentMonthId) throw new Error('الرجاء اختيار الشهر أولاً');
    const normal = (name, phone) => `${Utils.normalizeName(name)}|${String(phone || '').replace(/\D/g, '')}`;
    const snapshot = await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(state.currentMonthId).collection(MONTH_SUBCOLLECTIONS.ORDER_BATCHES).get();
    const existing = snapshot.docs.flatMap(doc => Array.isArray(doc.data().items) ? doc.data().items : []);
    return rows.map((row, index) => {
      const key = normal(row.customerName, row.customerPhone);
      const match = key === '|' ? null : existing.find(item => normal(item.customerName, item.customerPhone) === key);
      return match ? { index, existing: { orderDate: match.orderDate || '', departmentName: match.departmentName || '', moderatorName: match.moderatorName || '' } } : null;
    }).filter(Boolean);
  }

  function getSalaryProcessingContext() {
    const orderRows = typeof OrdersManagement !== 'undefined' ? OrdersManagement.getAll().filter(order => order.monthId === state.currentMonthId) : [];
    const metrics = new Map();
    orderRows.forEach(order => { const id=order.moderatorId; const m=metrics.get(id)||{ordersCount:0,deliveredOrders:0,returnedOrders:0,deferredOrders:0,shippingOrders:0,totalSales:0,totalPackages:0}; const s=Utils.normalizeName(order.shipmentStatus); m.ordersCount++;m.totalSales+=Number(order.saleValue === undefined ? order.price : order.saleValue)||0;m.totalPackages+=Number(order.packages||0);if(s.includes('تسليم'))m.deliveredOrders++;else if(s.includes('مرتجع'))m.returnedOrders++;else if(s.includes('مؤجل'))m.deferredOrders++;else if(s.includes('شحن'))m.shippingOrders++;metrics.set(id,m); });
    const rows = Array.isArray(state.currentReport) ? state.currentReport.map(row => ({ ...row, ...(metrics.get(row.moderatorId)||{}) })) : [];
    return { monthId: state.currentMonthId, rows, totals: Reports.computeTotals(rows) };
  }

  return { init, teardown, syncGoogleSource, findSimilarGoogleOrders, getSalaryProcessingContext, getSelectedMonthId: () => state.currentMonthId };
})();

/* ============================================================
 * SMALL SHARED UI HELPERS (Toast, Confirm dialog, Loading overlay)
 * ============================================================ */

const Toast = (() => {
  function show(message, type = 'info', action = null) {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    if (action && action.label && typeof action.onClick === 'function') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        action.onClick();
        el.remove();
      });
      el.appendChild(button);
    }
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    setTimeout(() => {
      el.classList.remove('visible');
      setTimeout(() => el.remove(), 300);
    }, 3500);
  }
  return { show };
})();

const Confirm = (() => {
  function show(message, onConfirm) {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmMessage').textContent = message;
    modal.classList.add('open');

    const yesBtn = document.getElementById('confirmYesBtn');
    const noBtn = document.getElementById('confirmNoBtn');

    const cleanup = () => {
      modal.classList.remove('open');
      yesBtn.removeEventListener('click', onYes);
      noBtn.removeEventListener('click', onNo);
    };
    const onYes = () => { cleanup(); onConfirm(); };
    const onNo = () => cleanup();

    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click', onNo);
  }
  return { show };
})();

const Loading = (() => {
  let counter = 0;
  function show(label = 'جاري التحميل...') {
    counter++;
    const overlay = document.getElementById('loadingOverlay');
    document.getElementById('loadingLabel').textContent = label;
    overlay.classList.add('visible');
  }
  /**
   * Changes the label of an already-visible overlay WITHOUT touching the
   * reference count.
   *
   * Multi-phase operations (back up, then delete; back up, then restore) want
   * to tell the admin which phase they're in. Calling `show()` again would do
   * that, but it also increments the counter - so a single `hide()` in the
   * `finally` would leave it at 1 and the overlay would never disappear,
   * making the app look frozen. This is the safe way to re-label.
   */
  function setLabel(label) {
    if (counter === 0) return;
    const el = document.getElementById('loadingLabel');
    if (el) el.textContent = label;
  }
  /**
   * Shows/updates a progress bar under the loading label (0-100). Purely
   * optional - callers that never call this never see a bar, since the
   * wrap stays hidden by default. Call with no argument (or a non-number)
   * to hide it again.
   */
  function setProgress(percent) {
    const wrap = document.getElementById('loadingProgressWrap');
    const bar = document.getElementById('loadingProgressBar');
    if (!wrap || !bar) return;
    if (typeof percent !== 'number' || !Number.isFinite(percent)) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
  }
  function hide() {
    counter = Math.max(0, counter - 1);
    if (counter === 0) {
      document.getElementById('loadingOverlay').classList.remove('visible');
      setProgress(); // reset for the next unrelated loading overlay use
    }
  }
  return { show, setLabel, setProgress, hide };
})();
