'use strict';

/*
 * Read-only executive analytics for the active Dashboard scope.  App passes
 * the already-loaded order cache and current audit page in so this module
 * never performs its own read or silently widens the selected month/section.
 */
const DashboardWidgets = (() => {
  const n = value => Utils.formatNumber(Number(value) || 0);
  const pct = (value, total) => total ? `${((value / total) * 100).toFixed(1)}%` : '0%';
  const can = permission => typeof Permissions === 'undefined' || Permissions.can(permission);

  function empty(title, message = 'لا توجد بيانات ضمن النطاق المحدد.') {
    return `<section class="panel executive-widget"><div class="panel-header"><h3>${Utils.escapeHtml(title)}</h3></div><div class="widget-empty">${Utils.escapeHtml(message)}</div></section>`;
  }

  function aggregate(orders) {
    const groups = { employee: new Map(), department: new Map(), product: new Map(), governorate: new Map() };
    const statuses = { delivered: 0, returned: 0, deferred: 0, shipping: 0, unknown: 0 };
    const add = (map, key, order, delivered, returned) => {
      const row = map.get(key) || { name: key, orders: 0, packages: 0, sales: 0, delivered: 0, returned: 0, department: '' };
      row.orders += 1;
      row.packages += Number(order.packages || 0);
      row.sales += Number(order.saleValue === undefined ? order.price : order.saleValue) || 0;
      row.delivered += delivered ? 1 : 0;
      row.returned += returned ? 1 : 0;
      if (order.departmentName) row.department = order.departmentName;
      map.set(key, row);
    };

    orders.forEach(order => {
      const status = Utils.normalizeName(order.shipmentStatus || '');
      const delivered = status.includes('تسليم');
      const returned = status.includes('مرتجع');
      if (delivered) statuses.delivered += 1;
      else if (returned) statuses.returned += 1;
      else if (status.includes('مؤجل')) statuses.deferred += 1;
      else if (status.includes('شحن')) statuses.shipping += 1;
      else statuses.unknown += 1;

      add(groups.employee, order.moderatorName || 'غير محدد', order, delivered, returned);
      add(groups.department, order.departmentName || 'غير محدد', order, delivered, returned);
      add(groups.product, order.productName || 'غير محدد', order, delivered, returned);
      add(groups.governorate, order.governorate || 'غير محدد', order, delivered, returned);
    });
    return { total: orders.length, statuses, groups };
  }

  function list(title, rows, type) {
    if (!rows.length) return empty(title);
    const detailFor = row => {
      if (type === 'employee') return `${Utils.escapeHtml(row.department || '—')} · ${n(row.orders)} طلب · ${n(row.delivered)} تم التسليم · ${pct(row.delivered, row.orders)} · ${Utils.formatCurrency(row.sales)} · ${n(row.packages)} عبوة`;
      if (type === 'department') return `${n(row.orders)} طلب · ${Utils.formatCurrency(row.sales)} · تسليم ${pct(row.delivered, row.orders)} · مرتجع ${pct(row.returned, row.orders)}`;
      if (type === 'product') return `${n(row.orders)} طلب · ${n(row.packages)} عبوة · ${Utils.formatCurrency(row.sales)}`;
      return `${n(row.orders)} طلب · تسليم ${pct(row.delivered, row.orders)}`;
    };
    return `<section class="panel executive-widget"><div class="panel-header"><h3>${title}</h3></div><div class="widget-ranking">${rows.slice(0, 5).map((row, index) => `<div><strong>${index + 1}. ${Utils.escapeHtml(row.name)}</strong><span>${detailFor(row)}</span></div>`).join('')}</div></section>`;
  }

  function shipping(summary) {
    if (!summary.total) return empty('حالة الشحن');
    const rows = [['تم التسليم', summary.statuses.delivered], ['مرتجع', summary.statuses.returned], ['مؤجل', summary.statuses.deferred], ['في الشحن', summary.statuses.shipping], ['لم يتم التحديث', summary.statuses.unknown]];
    return `<section class="panel executive-widget"><div class="panel-header"><h3>حالة الشحن</h3></div><div class="widget-ranking">${rows.map(([label, value]) => `<div><strong>${label}</strong><span>${n(value)} · ${pct(value, summary.total)}</span></div>`).join('')}</div></section>`;
  }

  function recentActivity(logs) {
    if (!can('audit.read')) return empty('النشاط الأخير', 'لا تملك صلاحية عرض سجل التدقيق.');
    if (!logs.length) return empty('النشاط الأخير', 'لا توجد عمليات مسجلة بعد.');
    return `<section class="panel executive-widget"><div class="panel-header"><h3>النشاط الأخير</h3></div><div class="widget-ranking">${logs.slice(0, 5).map(log => {
      const label = typeof AuditService !== 'undefined' ? AuditService.labelFor(log.action) : (log.action || 'عملية نظام');
      return `<div><strong>${Utils.escapeHtml(label)}</strong><span>${Utils.escapeHtml(Utils.formatDateTime(log.at || log.createdAt))}</span></div>`;
    }).join('')}</div></section>`;
  }

  function renderAlerts(summary, hasOrderPermission) {
    const items = [];
    if (!hasOrderPermission) items.push(['alert-info', 'البيانات التشغيلية محمية', 'لا تملك صلاحية عرض الطلبات وحالات الشحن.']);
    else if (!summary.total) items.push(['alert-info', 'لا توجد طلبات في النطاق الحالي', 'غيّر الشهر أو القسم، أو استورد طلبات لهذا الشهر.']);
    else {
      if (summary.statuses.unknown) items.push(['alert-info', 'طلبات لم يتم تحديثها', `${n(summary.statuses.unknown)} طلبًا يحتاج تحديث حالة الشحن.`]);
      if (summary.statuses.returned / summary.total >= 0.15) items.push(['alert-warning', 'ارتفاع نسبة المرتجع', `نسبة المرتجع الحالية ${pct(summary.statuses.returned, summary.total)}.`]);
      const risky = [...summary.groups.department.values()].find(row => row.orders >= 5 && row.returned / row.orders >= 0.2);
      if (risky) items.push(['alert-warning', 'مرتجعات مرتفعة في قسم', `${risky.name}: ${pct(risky.returned, risky.orders)} مرتجع.`]);
      if (!items.length) items.push(['alert-success', 'لا توجد تنبيهات تشغيلية', 'حالات الشحن ضمن النطاق الطبيعي.']);
    }
    const node = document.getElementById('dashboardAlertsGrid');
    if (node) node.innerHTML = items.map(([kind, title, detail]) => `<div class="alert-card ${kind}"><span class="alert-icon">ℹ</span><div><strong>${Utils.escapeHtml(title)}</strong><p>${Utils.escapeHtml(detail)}</p></div></div>`).join('');
  }

  function refresh(context = {}) {
    const mount = document.getElementById('dashboardOperationalWidgets');
    if (!mount) return;
    const hasOrderPermission = can('orders.read');
    const orders = hasOrderPermission && Array.isArray(context.orders) ? context.orders : [];
    const summary = aggregate(orders);
    const sorted = map => [...map.values()].sort((a, b) => b.orders - a.orders || b.sales - a.sales);

    mount.innerHTML = hasOrderPermission
      ? [shipping(summary), list('أفضل الموظفين', sorted(summary.groups.employee), 'employee'), list('أفضل الأقسام', sorted(summary.groups.department), 'department'), list('أفضل المنتجات', sorted(summary.groups.product), 'product'), list('أفضل المحافظات', sorted(summary.groups.governorate), 'governorate'), recentActivity(Array.isArray(context.auditLogs) ? context.auditLogs : [])].join('')
      : [empty('التحليلات التنفيذية', 'لا تملك صلاحية عرض بيانات الطلبات.'), recentActivity(Array.isArray(context.auditLogs) ? context.auditLogs : [])].join('');
    renderAlerts(summary, hasOrderPermission);
  }

  function init() {
    const mount = document.getElementById('dashboardOperationalWidgets');
    if (mount) mount.innerHTML = empty('التحليلات التنفيذية', 'جارٍ تحميل بيانات الشهر الحالي.');
  }

  return { init, refresh, empty };
})();
