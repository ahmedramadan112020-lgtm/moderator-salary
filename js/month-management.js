/**
 * month-management.js
 * -----------------------------------------------------------------------
 * Dedicated Month Management screen. It deliberately delegates all writes
 * to Months (and the existing close-month workflow) so this UI cannot fork
 * the established payroll lifecycle or create a second source of truth.
 * -----------------------------------------------------------------------
 */

'use strict';

const MonthManagement = (() => {
  const state = { initialized: false, busy: false, callbacks: null, pendingResetMonthId: null };

  function timestamp(value) {
    return Utils.formatDateTime(value);
  }

  function totals(month) { return month && month.totals ? month.totals : {}; }

  function statusBadge(month) {
    if (month.archived) return '<span class="badge badge-archived">مؤرشف</span>';
    if (month.status === Months.STATUS.LOCKED) return '<span class="badge badge-locked">مقفل / معتمد</span>';
    return '<span class="badge badge-open">مفتوح</span>';
  }

  function renderOverview() {
    const all = Months.all();
    const activeId = Months.activeMonthId();
    const openCount = all.filter(month => month.status === Months.STATUS.OPEN && !month.archived).length;
    const archivedCount = all.filter(month => month.archived).length;
    const lockedCount = all.filter(month => month.status === Months.STATUS.LOCKED).length;
    const active = activeId ? Months.byId(activeId) : null;
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    set('monthsOverviewActive', active ? active.label : '—');
    set('monthsOverviewOpen', Utils.formatNumber(openCount));
    set('monthsOverviewLocked', Utils.formatNumber(lockedCount));
    set('monthsOverviewArchived', Utils.formatNumber(archivedCount));
  }

  function actionButtons(month) {
    const active = month.id === Months.activeMonthId();
    const disabled = state.busy ? 'disabled' : '';
    const buttons = [
      `<button class="btn-icon" ${disabled} data-month-action="activate" data-month-id="${Utils.escapeHtml(month.id)}" title="جعل الشهر نشطًا">▶</button>`
    ];

    if (month.archived) {
      buttons.push(`<button class="btn btn-sm" ${disabled} data-month-action="restore" data-month-id="${Utils.escapeHtml(month.id)}">إلغاء الأرشفة</button>`);
      return buttons.join('');
    }
    if (month.status === Months.STATUS.LOCKED) {
      buttons.push(`<button class="btn btn-sm" ${disabled} data-month-action="unlock" data-month-id="${Utils.escapeHtml(month.id)}">فتح القفل</button>`);
      buttons.push(`<button class="btn btn-sm" ${disabled} data-month-action="reopen" data-month-id="${Utils.escapeHtml(month.id)}">إعادة فتح</button>`);
      return buttons.join('');
    }

    if (active && month.totals) {
      // Approval is the system's only valid locking path: it writes the
      // snapshot and backup before status becomes locked.
      buttons.push(`<button class="btn btn-accent btn-sm" ${disabled} data-month-action="approve" data-month-id="${Utils.escapeHtml(month.id)}">اعتماد وقفل</button>`);
    }
    buttons.push(`<button class="btn btn-danger-outline btn-sm" ${disabled} data-month-action="reset" data-month-id="${Utils.escapeHtml(month.id)}">🗑️ إفراغ المحتوى</button>`);
    if (!active) {
      buttons.push(`<button class="btn btn-sm" ${disabled} data-month-action="archive" data-month-id="${Utils.escapeHtml(month.id)}">أرشفة</button>`);
      if (month.isEmpty || ((month.orderCount || 0) === 0 && !month.totals)) {
        buttons.push(`<button class="btn btn-danger-outline btn-sm" ${disabled} data-month-action="delete" data-month-id="${Utils.escapeHtml(month.id)}">حذف الفارغ</button>`);
      }
    }
    return buttons.join('');
  }

  function render() {
    if (!state.initialized) return;
    renderOverview();
    const body = document.getElementById('monthsTableBody');
    if (!body) return;
    const activeId = Months.activeMonthId();
    const rows = Months.all();
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="12" class="empty-state">لا توجد شهور مسجلة بعد</td></tr>';
      return;
    }
    body.innerHTML = rows.map(month => {
      const t = totals(month);
      const classes = [
        month.id === activeId ? 'row-active-month' : '',
        month.status === Months.STATUS.LOCKED ? 'row-locked' : '',
        month.archived ? 'row-archived' : ''
      ].filter(Boolean).join(' ');
      const orderCount = month.orderCount === null || month.orderCount === undefined ? '—' : Utils.formatNumber(month.orderCount);
      return `<tr class="${classes}">
        <td><strong>${Utils.escapeHtml(month.label)}</strong>${month.id === activeId ? '<div class="text-muted-inline">نشط</div>' : ''}</td>
        <td>${statusBadge(month)}</td>
        <td>${orderCount}</td>
        <td>${month.employeeCount === null || month.employeeCount === undefined ? '—' : Utils.formatNumber(month.employeeCount)}</td>
        <td>${Utils.formatCurrency(t.totalSales || 0)}</td>
        <td>${Utils.formatCurrency(t.salary || 0)}</td>
        <td>${Utils.formatCurrency(t.totalBonus || 0)}</td>
        <td>${timestamp(month.createdAt)}</td>
        <td>${timestamp(month.updatedAt || month.calculatedAt || month.closedAt)}</td>
        <td>${month.status === Months.STATUS.LOCKED ? '🔒 مقفل' : '🔓 مفتوح'}</td>
        <td>${month.archived ? 'مؤرشف' : 'نشط'}</td>
        <td class="actions-cell months-actions">${actionButtons(month)}</td>
      </tr>`;
    }).join('');
  }

  async function perform(label, task) {
    if (state.busy) return;
    state.busy = true;
    render();
    Loading.show(label);
    try {
      await task();
      render();
      return true;
    } catch (err) {
      console.error('Month management action failed:', err);
      Toast.show(err.message || 'تعذر تنفيذ عملية الشهر', 'error');
      return false;
    } finally {
      state.busy = false;
      Loading.hide();
      render();
    }
  }

  function openCreateModal() {
    const input = document.getElementById('monthCreateInput');
    input.value = '';
    document.getElementById('monthCreateModal').classList.add('open');
    input.focus();
  }

  function closeCreateModal() {
    document.getElementById('monthCreateModal').classList.remove('open');
  }

  function syncResetConfirmation() {
    const input = document.getElementById('monthResetConfirmInput');
    const confirm = document.getElementById('monthResetConfirmBtn');
    confirm.disabled = state.busy || input.value.trim() !== state.pendingResetMonthId;
  }

  function openResetModal(monthId) {
    const month = Months.byId(monthId);
    if (!month || month.archived || month.status === Months.STATUS.LOCKED) return;
    state.pendingResetMonthId = monthId;
    const input = document.getElementById('monthResetConfirmInput');
    document.getElementById('monthResetExpectedId').textContent = monthId;
    input.value = '';
    document.getElementById('monthResetModal').classList.add('open');
    syncResetConfirmation();
    input.focus();
  }

  function closeResetModal() {
    if (state.busy) return;
    state.pendingResetMonthId = null;
    document.getElementById('monthResetModal').classList.remove('open');
  }

  async function submitReset(event) {
    event.preventDefault();
    const monthId = state.pendingResetMonthId;
    if (!monthId || document.getElementById('monthResetConfirmInput').value.trim() !== monthId) {
      Toast.show('اكتب معرّف الشهر نفسه قبل التأكيد', 'error');
      return;
    }
    const completed = await perform('جاري إنشاء النسخة الاحتياطية وإفراغ الشهر...', async () => {
      const result = await state.callbacks.reset(monthId);
      state.pendingResetMonthId = null;
      document.getElementById('monthResetModal').classList.remove('open');
      Toast.show(`تم إفراغ ${Utils.monthLabelFromId(monthId)} والتحقق من البيانات المحفوظة. نسخة الأمان: ${result.backupId}`, 'success');
    });
    if (!completed) syncResetConfirmation();
  }

  async function createMonth(event) {
    if (event) event.preventDefault();
    const monthId = document.getElementById('monthCreateInput').value.trim();
    if (!Utils.isValidMonthId(monthId)) {
      Toast.show('صيغة غير صحيحة. استخدم مثال: 2026-09', 'error');
      return;
    }
    await perform('جاري إنشاء الشهر...', async () => {
      const created = await state.callbacks.create(monthId);
      if (!created) {
        Toast.show('هذا الشهر موجود بالفعل', 'error');
        return;
      }
      closeCreateModal();
      Toast.show(`تم إنشاء شهر ${Utils.monthLabelFromId(monthId)}`, 'success');
    });
  }

  function bind() {
    document.getElementById('monthsCreateBtn').addEventListener('click', openCreateModal);
    document.getElementById('monthCreateForm').addEventListener('submit', createMonth);
    document.getElementById('closeMonthCreateModal').addEventListener('click', closeCreateModal);
    document.getElementById('cancelMonthCreateBtn').addEventListener('click', closeCreateModal);
    document.getElementById('monthResetForm').addEventListener('submit', submitReset);
    document.getElementById('closeMonthResetModal').addEventListener('click', closeResetModal);
    document.getElementById('cancelMonthResetBtn').addEventListener('click', closeResetModal);
    document.getElementById('monthResetConfirmInput').addEventListener('input', syncResetConfirmation);
    document.getElementById('monthsTableBody').addEventListener('click', event => {
      const button = event.target.closest('[data-month-action]');
      if (!button || state.busy) return;
      const monthId = button.dataset.monthId;
      const month = Months.byId(monthId);
      if (!month) return;
      const action = button.dataset.monthAction;
      const permission = action === 'approve' ? 'reports.approve' : (['reset', 'delete'].includes(action) ? 'months.destructive' : 'months.write');
      try { Permissions.require(permission); } catch (err) { Toast.show(err.message, 'error'); return; }

      if (action === 'activate') {
        perform('جاري تفعيل الشهر...', async () => {
          await state.callbacks.activate(monthId);
          Toast.show(`تم تفعيل ${month.label}`, 'success');
        });
      } else if (action === 'approve') {
        state.callbacks.approve(monthId);
      } else if (action === 'unlock') {
        Confirm.show(`فتح قفل شهر ${month.label} بدون جعله الشهر النشط؟`, () => perform('جاري فتح القفل...', async () => {
          await state.callbacks.unlock(monthId);
          Toast.show(`تم فتح قفل ${month.label}`, 'success');
        }));
      } else if (action === 'reopen') {
        Confirm.show(`إعادة فتح ${month.label} وجعله الشهر النشط؟`, () => perform('جاري إعادة فتح الشهر...', async () => {
          await state.callbacks.reopen(monthId);
          Toast.show(`تمت إعادة فتح ${month.label}`, 'success');
        }));
      } else if (action === 'archive') {
        Confirm.show(`أرشفة ${month.label}؟ لن يقبل استيرادًا أو تعديلًا حتى إلغاء الأرشفة.`, () => perform('جاري أرشفة الشهر...', async () => {
          await Months.archiveMonth(monthId);
          Toast.show(`تمت أرشفة ${month.label}`, 'success');
        }));
      } else if (action === 'restore') {
        perform('جاري إلغاء الأرشفة...', async () => {
          await Months.restoreArchivedMonth(monthId);
          Toast.show(`تمت استعادة ${month.label}`, 'success');
        });
      } else if (action === 'reset') {
        openResetModal(monthId);
      } else if (action === 'delete') {
        Confirm.show(`حذف الشهر الفارغ ${month.label} نهائيًا؟`, () => perform('جاري حذف الشهر الفارغ...', async () => {
          await Months.deleteEmptyMonth(monthId);
          Toast.show(`تم حذف ${month.label}`, 'success');
        }));
      }
    });
  }

  function init(callbacks) {
    if (state.initialized) return;
    state.callbacks = callbacks;
    bind();
    Months.onChange(render);
    state.initialized = true;
    render();
  }

  function open() { render(); }

  return { init, open, render };
})();
