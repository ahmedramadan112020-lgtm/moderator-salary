/**
 * Read-only comparison of two persisted monthly reports. This module only
 * reads `monthly_reports/{monthId}` and never calls the payroll calculator.
 */
'use strict';

const MonthComparison = (() => {
  const state = { initialized: false, one: null, two: null, rows: [], sort: 'name', direction: 1, charts: {} };
  const number = value => Number(value) || 0;
  const escape = value => Utils.escapeHtml(String(value ?? '—'));
  const money = value => Utils.formatCurrency(number(value));
  const delta = (value, currency = true) => {
    const n = number(value); const mark = n > 0 ? '↑' : n < 0 ? '↓' : '—';
    const cls = n > 0 ? 'comparison-up' : n < 0 ? 'comparison-down' : 'comparison-flat';
    return `<span class="${cls}">${mark} ${currency ? money(Math.abs(n)) : Utils.formatNumber(Math.abs(n))}</span>`;
  };
  const percent = (from, to) => {
    const base = number(from); const change = number(to) - base;
    if (base === 0) return change === 0 ? { value: 0, label: '0%' } : { value: null, label: 'جديد' };
    const value = (change / Math.abs(base)) * 100;
    return { value, label: `${value > 0 ? '+' : ''}${value.toFixed(1)}%` };
  };

  function availableMonths() {
    return Months.all().filter(month => month && month.totals && month.employeeCount !== null);
  }

  function populateSelects() {
    const choices = availableMonths();
    const one = document.getElementById('comparisonMonthOne');
    const two = document.getElementById('comparisonMonthTwo');
    if (!one || !two) return;
    const optionHtml = choices.map(month => `<option value="${escape(month.id)}">${escape(month.label)}</option>`).join('');
    one.innerHTML = `<option value="">اختر الشهر الأول</option>${optionHtml}`;
    two.innerHTML = `<option value="">اختر الشهر الثاني</option>${optionHtml}`;
    if (!state.one && choices[1]) state.one = choices[1].id;
    if (!state.two && choices[0]) state.two = choices[0].id;
    if (state.one === state.two) state.two = choices.find(m => m.id !== state.one)?.id || null;
    one.value = state.one || '';
    two.value = state.two || '';
  }

  async function loadMonth(monthId) {
    const snap = await db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId).get();
    if (!snap.exists) throw new Error('الشهر المختار غير موجود');
    const data = snap.data() || {};
    const report = Array.isArray(data.report) ? data.report : [];
    return {
      id: monthId,
      label: data.monthLabel || Utils.monthLabelFromId(monthId),
      report,
      totals: data.totals || Reports.computeTotals(report),
      departments: Array.isArray(data.departmentTotals) ? data.departmentTotals : []
    };
  }

  function metrics(month) {
    const totals = month.totals || {};
    return [
      ['عدد الموظفين', month.report.length, false],
      ['الموظفون النشطون وقت الحساب', month.report.length, false],
      ['عدد الطلبات', totals.ordersCount, false],
      ['إجمالي المبيعات', totals.totalSales, true],
      ['إجمالي البونص', totals.totalBonus, true],
      ['إجمالي الرواتب', totals.salary, true],
      ['إجمالي السلف', totals.totalAdvances, true],
      ['إجمالي التسويات', totals.totalAdjustments, true],
      ['إجمالي الخصومات', number(totals.totalAdvances) + number(totals.previousDebt), true],
      ['صافي المستحقات', totals.finalSalary, true]
    ];
  }

  function renderMetrics(one, two) {
    const holder = document.getElementById('comparisonMetrics');
    if (!holder) return;
    holder.innerHTML = metrics(one).map(([label, first, isMoney], index) => {
      const second = metrics(two)[index][1]; const change = number(second) - number(first); const rate = percent(first, second);
      return `<article class="comparison-metric-card"><h3>${label}</h3><div class="comparison-values"><span>${isMoney ? money(first) : Utils.formatNumber(first)}</span><span>${isMoney ? money(second) : Utils.formatNumber(second)}</span></div><div class="comparison-change">${delta(change, isMoney)} <small class="${change > 0 ? 'comparison-up' : change < 0 ? 'comparison-down' : 'comparison-flat'}">${rate.label}</small></div></article>`;
    }).join('');
  }

  function employeeKey(row) { return row.moderatorId || `${row.name || ''}|${row.departmentId || row.departmentName || ''}`; }
  function rowMap(report) { return new Map(report.map(row => [employeeKey(row), row])); }
  function renderEmployeeRows(one, two) {
    const first = rowMap(one.report); const second = rowMap(two.report); const keys = new Set([...first.keys(), ...second.keys()]);
    state.rows = [...keys].map(key => {
      const a = first.get(key) || {}; const b = second.get(key) || {};
      const ordersOne = number(a.ordersCount), ordersTwo = number(b.ordersCount), netOne = number(a.finalSalary), netTwo = number(b.finalSalary);
      return { name: b.name || a.name || '—', departmentName: b.departmentName || a.departmentName || '—', ordersOne, ordersTwo, ordersDelta: ordersTwo - ordersOne, bonusDelta: number(b.totalBonus) - number(a.totalBonus), netOne, netTwo, netDelta: netTwo - netOne, netPercent: percent(netOne, netTwo).value, netPercentLabel: percent(netOne, netTwo).label };
    });
    const departments = [...new Set(state.rows.map(row => row.departmentName))].sort();
    document.getElementById('comparisonDepartmentFilter').innerHTML = `<option value="all">كل الأقسام</option>${departments.map(dept => `<option value="${escape(dept)}">${escape(dept)}</option>`).join('')}`;
    renderEmployeeTable();
  }

  function renderEmployeeTable() {
    const body = document.getElementById('comparisonEmployeesBody'); if (!body) return;
    const query = (document.getElementById('comparisonEmployeeSearch').value || '').trim().toLowerCase();
    const department = document.getElementById('comparisonDepartmentFilter').value;
    const rows = state.rows.filter(row => (department === 'all' || row.departmentName === department) && `${row.name} ${row.departmentName}`.toLowerCase().includes(query));
    rows.sort((a, b) => {
      const left = a[state.sort], right = b[state.sort];
      return typeof left === 'string' ? left.localeCompare(right, 'ar') * state.direction : (number(left) - number(right)) * state.direction;
    });
    body.innerHTML = rows.length ? rows.map(row => `<tr><td>${escape(row.name)}</td><td>${escape(row.departmentName)}</td><td>${Utils.formatNumber(row.ordersOne)}</td><td>${Utils.formatNumber(row.ordersTwo)}</td><td>${delta(row.ordersDelta, false)}</td><td>${delta(row.bonusDelta)}</td><td>${delta(row.netDelta)}</td><td class="${row.netDelta > 0 ? 'comparison-up' : row.netDelta < 0 ? 'comparison-down' : 'comparison-flat'}">${row.netPercentLabel}</td></tr>`).join('') : '<tr><td colspan="8" class="empty-cell">لا توجد نتائج مطابقة.</td></tr>';
  }

  function renderInsights() {
    const metric = (title, key, formatter) => {
      const rows = [...state.rows].sort((a, b) => number(b[key]) - number(a[key])).slice(0, 10);
      return `<div class="panel comparison-insight"><h3>${title}</h3><ol>${rows.map(row => `<li><span>${escape(row.name)}</span><strong>${formatter(row[key])}</strong></li>`).join('') || '<li>لا توجد بيانات</li>'}</ol></div>`;
    };
    const bestNet = [...state.rows].sort((a, b) => b.netDelta - a.netDelta).slice(0, 10);
    const worstNet = [...state.rows].sort((a, b) => a.netDelta - b.netDelta).slice(0, 10);
    document.getElementById('comparisonInsights').innerHTML = [
      metric('أفضل 10 — الطلبات', 'ordersTwo', Utils.formatNumber),
      metric('أفضل 10 — البونص', 'bonusDelta', money),
      metric('أفضل 10 — صافي المستحقات', 'netTwo', money),
      `<div class="panel comparison-insight"><h3>الأكثر تحسنًا</h3><ol>${bestNet.map(r => `<li><span>${escape(r.name)}</span>${delta(r.netDelta)}</li>`).join('') || '<li>لا توجد بيانات</li>'}</ol></div>`,
      `<div class="panel comparison-insight"><h3>الأكثر انخفاضًا</h3><ol>${worstNet.map(r => `<li><span>${escape(r.name)}</span>${delta(r.netDelta)}</li>`).join('') || '<li>لا توجد بيانات</li>'}</ol></div>`
    ].join('');
  }

  function renderDepartments(one, two) {
    const map = new Map();
    [one, two].forEach((month, index) => month.departments.forEach(dept => {
      const key = dept.departmentId || dept.departmentName; const entry = map.get(key) || { name: dept.departmentName || '—', one: {}, two: {} }; entry[index ? 'two' : 'one'] = dept; map.set(key, entry);
    }));
    document.getElementById('comparisonDepartmentsBody').innerHTML = map.size ? [...map.values()].map(item => {
      const a = item.one, b = item.two; const growth = percent(a.finalSalary, b.finalSalary);
      return `<tr><td>${escape(item.name)}</td><td>${Utils.formatNumber(a.employeeCount)} / ${Utils.formatNumber(b.employeeCount)}</td><td>${Utils.formatNumber(a.ordersCount)} / ${Utils.formatNumber(b.ordersCount)}</td><td>${money(a.totalBonus)} / ${money(b.totalBonus)}</td><td>${money(a.finalSalary)} / ${money(b.finalSalary)}</td><td class="${number(b.finalSalary) > number(a.finalSalary) ? 'comparison-up' : number(b.finalSalary) < number(a.finalSalary) ? 'comparison-down' : 'comparison-flat'}">${growth.label}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="empty-cell">لا توجد ملخصات أقسام محفوظة لهذين الشهرين.</td></tr>';
  }

  function renderCharts(one, two) {
    if (typeof Chart === 'undefined') return;
    Object.values(state.charts).forEach(chart => chart.destroy()); state.charts = {};
    const items = [['comparisonOrdersChart', 'ordersCount', 'الطلبات'], ['comparisonSalariesChart', 'salary', 'الرواتب'], ['comparisonBonusChart', 'totalBonus', 'البونص'], ['comparisonNetChart', 'finalSalary', 'صافي المستحقات']];
    items.forEach(([id, key, label]) => {
      const canvas = document.getElementById(id); if (!canvas) return;
      state.charts[id] = new Chart(canvas, { type: 'bar', data: { labels: [one.label, two.label], datasets: [{ label, data: [number(one.totals[key]), number(two.totals[key])], backgroundColor: ['rgba(61,90,254,.65)', 'rgba(34,197,94,.65)'], borderColor: ['#3d5afe', '#22c55e'], borderWidth: 1.5, borderRadius: 7 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,.06)' } } } } });
    });
  }

  async function compare() {
    const empty = document.getElementById('comparisonEmptyState'); const content = document.getElementById('comparisonContent');
    if (!state.one || !state.two || state.one === state.two) { empty.textContent = state.one === state.two ? 'اختر شهرين مختلفين للمقارنة.' : 'اختر شهرين لهما تقارير محفوظة لبدء المقارنة.'; empty.classList.remove('hidden'); content.classList.add('hidden'); return; }
    try {
      empty.textContent = 'جاري تحميل التقارير المحفوظة...'; empty.classList.remove('hidden');
      const [one, two] = await Promise.all([loadMonth(state.one), loadMonth(state.two)]);
      if (!one.report.length || !two.report.length) throw new Error('أحد الشهرين لا يحتوي على تقرير محفوظ بعد.');
      document.getElementById('comparisonMonthOneLabel').textContent = one.label; document.getElementById('comparisonMonthTwoLabel').textContent = two.label;
      renderMetrics(one, two); renderEmployeeRows(one, two); renderInsights(); renderDepartments(one, two); renderCharts(one, two);
      empty.classList.add('hidden'); content.classList.remove('hidden');
    } catch (err) { empty.textContent = err.message; empty.classList.remove('hidden'); content.classList.add('hidden'); console.warn('Month comparison read failed:', err); }
  }

  function bind() {
    ['comparisonMonthOne', 'comparisonMonthTwo'].forEach(id => document.getElementById(id).addEventListener('change', event => { state[id === 'comparisonMonthOne' ? 'one' : 'two'] = event.target.value || null; compare(); }));
    document.getElementById('comparisonEmployeeSearch').addEventListener('input', renderEmployeeTable);
    document.getElementById('comparisonDepartmentFilter').addEventListener('change', renderEmployeeTable);
    document.querySelectorAll('[data-comparison-sort]').forEach(head => head.addEventListener('click', () => { const key = head.dataset.comparisonSort; state.direction = state.sort === key ? -state.direction : 1; state.sort = key; renderEmployeeTable(); }));
  }

  function init() { if (state.initialized) return; state.initialized = true; bind(); populateSelects(); }
  function open() { populateSelects(); compare(); }
  function refreshMonths() { if (state.initialized) populateSelects(); }
  return { init, open, refreshMonths };
})();
