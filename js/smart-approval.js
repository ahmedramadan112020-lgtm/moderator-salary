/** Read-only readiness assessment that runs before the existing close flow. */
'use strict';

const SmartApproval = (() => {
  let initialized = false;
  let latest = null;
  let proceed = null;
  const n = value => Number(value) || 0;
  const finite = value => Number.isFinite(Number(value));
  const esc = value => Utils.escapeHtml(String(value));

  function item(kind, text) { return { kind, text }; }
  function assess(context) {
    const critical = [], warnings = [], recommendations = [];
    const month = context.month || {};
    const report = Array.isArray(context.report) ? context.report : [];
    const totals = context.totals || {};
    if (!context.monthId || !Utils.isValidMonthId(context.monthId)) critical.push(item('failed', 'لا يوجد شهر نشط صالح للاعتماد.'));
    if (!month || month.status === Months.STATUS.LOCKED || month.archived) critical.push(item('failed', 'حالة الشهر لا تسمح بالاعتماد.'));
    if (!month.calculatedAt && !month.totals) critical.push(item('failed', 'لا يوجد تقرير محسوب ومحفوظ لهذا الشهر.'));
    if (!report.length) critical.push(item('failed', 'بيانات التقرير فارغة.'));

    const requiredNumbers = ['salary', 'ordersCount', 'totalSales', 'totalBonus', 'totalAdvances', 'totalAdjustments', 'finalSalary'];
    const malformed = report.filter(row => !row || !row.moderatorId || !row.name || !row.departmentId || requiredNumbers.some(key => !finite(row[key])));
    if (malformed.length) critical.push(item('failed', `يوجد ${malformed.length} صف تقرير ناقص أو تالف (اسم/قسم/قيم مالية).`));
    const computed = Reports.computeTotals(report);
    const inconsistent = requiredNumbers.some(key => finite(totals[key]) && Math.abs(n(totals[key]) - n(computed[key])) > 0.02);
    if (report.length && (!totals || inconsistent)) critical.push(item('failed', 'إجماليات التقرير المحفوظة لا تطابق صفوف التقرير.'));

    const noHours = report.filter(row => !n(row.dailyWorkHours)).length;
    const noOrders = report.filter(row => !n(row.ordersCount)).length;
    const zeroSalary = report.filter(row => !n(row.salary)).length;
    if (noHours) warnings.push(item('warning', `${noHours} موظفًا بلا ساعات عمل مسجلة في التقرير.`));
    if (noOrders) warnings.push(item('warning', `${noOrders} موظفًا بلا طلبات هذا الشهر.`));
    if (zeroSalary) warnings.push(item('warning', `${zeroSalary} موظفًا براتب أساسي صفر؛ راجع إن كان ذلك مقصودًا.`));
    const emptyDepartments = (context.departments || []).filter(dept => dept.status !== 'archived' && !report.some(row => row.departmentId === dept.id)).length;
    if (emptyDepartments) warnings.push(item('warning', `يوجد ${emptyDepartments} قسم نشط بلا موظفين في التقرير.`));
    if (n(totals.totalAdvances) > n(totals.finalSalary) * 0.35 && n(totals.totalAdvances) > 0) warnings.push(item('warning', 'إجمالي السلف مرتفع مقارنة بصافي المستحقات.'));
    if (Math.abs(n(totals.totalAdjustments)) > n(totals.finalSalary) * 0.2 && n(totals.totalAdjustments) !== 0) warnings.push(item('warning', 'إجمالي التسويات مرتفع مقارنة بصافي المستحقات.'));

    recommendations.push(item('passed', 'سيتم إنشاء Backup تلقائي قبل قفل الشهر ضمن مسار الاعتماد الحالي.'));
    recommendations.push(item('passed', 'راجع التقرير أو صدّره إلى Excel قبل الاعتماد النهائي عند الحاجة.'));
    if (warnings.length) recommendations.push(item('passed', 'راجع التحذيرات أعلاه قبل متابعة الاعتماد.'));
    const score = Math.max(0, 100 - critical.length * 35 - warnings.length * 5);
    return { monthId: context.monthId, score, critical, warnings, recommendations, totalChecks: critical.length + warnings.length + recommendations.length };
  }

  function close() { document.getElementById('smartApprovalModal').classList.remove('open'); }
  function group(title, icon, css, entries) {
    if (!entries.length) return '';
    return `<section class="smart-approval-group ${css}"><h4>${icon} ${title} <span>${entries.length}</span></h4><ul>${entries.map(entry => `<li>${esc(entry.text)}</li>`).join('')}</ul></section>`;
  }
  function render(result) {
    const blocked = result.critical.length > 0;
    const status = blocked ? 'غير جاهز للاعتماد' : result.score >= 90 ? 'جاهز للاعتماد' : 'يحتاج مراجعة';
    const tone = blocked ? 'danger' : result.score >= 90 ? 'success' : 'warning';
    document.getElementById('smartApprovalScore').innerHTML = `<div class="smart-score ${tone}">${result.score}%</div><div><strong>${status}</strong><span>فحص جاهزية تقرير ${esc(Utils.monthLabelFromId(result.monthId))}</span></div>`;
    document.getElementById('smartApprovalGroups').innerHTML = group('أخطاء مانعة', '✖', 'danger', result.critical) + group('تحذيرات', '⚠', 'warning', result.warnings) + group('اقتراحات', '✔', 'info', result.recommendations);
    document.getElementById('smartApprovalSummary').innerHTML = `<span>الفحوصات: <strong>${result.totalChecks}</strong></span><span>الأخطاء: <strong>${result.critical.length}</strong></span><span>التحذيرات: <strong>${result.warnings.length}</strong></span><span>الاقتراحات: <strong>${result.recommendations.length}</strong></span>`;
    const confirm = document.getElementById('smartApprovalConfirmBtn');
    const cancel = document.getElementById('smartApprovalCancelBtn');
    confirm.classList.toggle('hidden', blocked); cancel.textContent = blocked ? 'إغلاق' : 'إلغاء';
  }
  async function open(context, onProceed) {
    latest = null; proceed = onProceed;
    const modal = document.getElementById('smartApprovalModal');
    document.getElementById('smartApprovalLoading').classList.remove('hidden'); document.getElementById('smartApprovalResults').classList.add('hidden'); document.getElementById('smartApprovalConfirmBtn').classList.add('hidden');
    modal.classList.add('open');
    await new Promise(resolve => requestAnimationFrame(resolve));
    latest = assess(context); render(latest);
    document.getElementById('smartApprovalLoading').classList.add('hidden'); document.getElementById('smartApprovalResults').classList.remove('hidden');
    return latest;
  }
  function init() {
    if (initialized) return; initialized = true;
    document.getElementById('smartApprovalCloseBtn').addEventListener('click', close);
    document.getElementById('smartApprovalCancelBtn').addEventListener('click', close);
    document.getElementById('smartApprovalConfirmBtn').addEventListener('click', () => { if (!latest || latest.critical.length) return; close(); if (typeof proceed === 'function') proceed(latest); });
  }
  return { init, open, assess };
})();
