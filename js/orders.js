/*
 * orders.js
 * -----------------------------------------------------------------------
 * Orders Management for the existing `monthly_reports/{month}/orderBatches`
 * storage model. Orders stay embedded in their import batch intentionally:
 * that preserves the proven import/report pipeline while this module offers
 * a paginated, searchable operational view over those rows.
 * -----------------------------------------------------------------------
 */

'use strict';

const OrdersManagement = (() => {
  const PAGE_SIZE = 50;
  const state = {
    initialized: false,
    loading: false,
    busy: false,
    orders: [],
    batches: new Map(),
    page: 1,
    sort: { key: 'orderDate', direction: 'desc' },
    callbacks: null
  };

  function timestampMillis(value) {
    if (!value) return 0;
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (value instanceof Date) return value.getTime();
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatDate(value) {
    const ms = timestampMillis(value);
    return ms ? new Date(ms).toLocaleString('ar-EG') : '—';
  }

  function money(value) {
    return `${Utils.formatNumber(Number(value || 0))} ج.م`;
  }

  function employeeMap() {
    return new Map((state.callbacks.getEmployees() || []).map(employee => [employee.id, employee]));
  }

  function departmentName(id, fallback = '') {
    if (!id) return fallback || '—';
    const department = (state.callbacks.getDepartments() || []).find(d => d.id === id);
    return department ? department.name : (fallback || '—');
  }

  function orderId(batchId, item, index) {
    return item.orderId || `legacy-${batchId}-${index + 1}`;
  }

  function normalizeBatch(doc) {
    const data = doc.data() || {};
    const monthId = data.monthId || (doc.ref.parent.parent ? doc.ref.parent.parent.id : null);
    const importedAt = data.importedAt || data.createdAt || null;
    const batch = {
      id: doc.id,
      ref: doc.ref,
      monthId,
      importedAt,
      importedBy: data.importedBy || data.createdBy || 'غير معروف',
      importId: data.importId || null,
      updatedAt: data.updatedAt || null,
      updatedBy: data.updatedBy || null,
      autoCreatedEmployeeIds: Array.isArray(data.autoCreatedEmployeeIds) ? data.autoCreatedEmployeeIds : [],
      count: Array.isArray(data.items) ? data.items.length : Number(data.count || 0),
      items: Array.isArray(data.items) ? data.items : []
    };
    return batch;
  }

  async function fetchAllBatchDocs() {
    // The application already maintains a small, authorised month index.
    // Reading each known month's direct subcollection avoids a collection-
    // group query while retaining the existing least-privilege Rules path.
    const monthIds = Array.from(new Set(Months.all().map(month => month.id).filter(Boolean)));
    const snapshots = await Promise.all(monthIds.map(monthId =>
      db.collection(COLLECTIONS.MONTHLY_REPORTS).doc(monthId)
        .collection(MONTH_SUBCOLLECTIONS.ORDER_BATCHES).get()
    ));
    return snapshots.flatMap(snapshot => snapshot.docs);
  }

  function flattenBatch(batch, employees) {
    return batch.items.map((item, index) => {
      const employee = employees.get(item.moderatorId) || null;
      const departmentId = item.departmentId || (employee ? employee.departmentId : null);
      return {
        id: orderId(batch.id, item, index),
        persistedId: item.orderId || null,
        legacyIndex: index,
        batchId: batch.id,
        batchRef: batch.ref,
        monthId: batch.monthId,
        importedAt: batch.importedAt,
        importedBy: batch.importedBy,
        batchUpdatedAt: batch.updatedAt,
        batchUpdatedBy: batch.updatedBy,
        moderatorId: item.moderatorId || null,
        moderatorName: item.moderatorName || (employee ? employee.name : 'غير معروف'),
        departmentId,
        departmentName: item.departmentName || departmentName(departmentId, employee ? departmentName(employee.departmentId) : ''),
        packages: Number(item.packages || 0),
        price: Number(item.price || 0),
        saleValue: Number(item.saleValue === undefined ? item.price : item.saleValue),
        orderDate: item.orderDate || '', externalOrderNumber: item.externalOrderNumber || item.orderNumber || '',
        customerName: item.customerName || '', customerPhone: item.customerPhone || '', notes: item.notes || '',
        fullAddress: item.fullAddress || item.address || '', productName: item.productName || item.product || '',
        waybillNumber: item.waybillNumber || '', governorate: item.governorate || '',
        shipmentStatus: item.shipmentStatus || 'لم يتم التحديث',
        updatedAt: item.updatedAt || batch.updatedAt || null,
        updatedBy: item.updatedBy || batch.updatedBy || null
      };
    });
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    renderLoading();
    try {
      // Batch documents are compact; rows are flattened in memory but only
      // one 50-row page is rendered, keeping the DOM small for thousands of
      // orders.
      const docs = await fetchAllBatchDocs();
      const employees = employeeMap();
      const batches = docs.map(normalizeBatch)
        .sort((a, b) => timestampMillis(b.importedAt) - timestampMillis(a.importedAt));
      state.batches = new Map(batches.map(batch => [batch.id, batch]));
      state.orders = batches.flatMap(batch => flattenBatch(batch, employees));
      renderFilterOptions();
      populateOrderReportFilters();
      render();
      if (state.callbacks && typeof state.callbacks.onLoaded === 'function') state.callbacks.onLoaded(state.orders.slice());
    } catch (err) {
      console.error('Orders load failed:', err);
      Toast.show('تعذر تحميل الطلبات: ' + err.message, 'error');
      renderEmpty('تعذر تحميل الطلبات');
    } finally {
      state.loading = false;
    }
  }

  function filterValue(id) {
    const element = document.getElementById(id);
    return element ? String(element.value || '').trim() : '';
  }

  function filteredOrders() {
    const term = Utils.normalizeName(filterValue('ordersSearchInput'));
    const monthId = filterValue('ordersMonthFilter');
    const departmentId = filterValue('ordersDepartmentFilter');
    const moderatorId = filterValue('ordersModeratorFilter');
    const governorate = filterValue('ordersGovernorateFilter');
    const shipmentStatus = filterValue('ordersShipmentStatusFilter');
    const product = filterValue('ordersProductFilter');
    const fromDate = filterValue('ordersDateFrom');
    const toDate = filterValue('ordersDateTo');
    const result = state.orders.filter(order => {
      const search = !term ||
        Utils.normalizeName(order.moderatorName).includes(term) ||
        Utils.normalizeName(order.id).includes(term) ||
        Utils.normalizeName(order.externalOrderNumber).includes(term) ||
        Utils.normalizeName(order.customerName).includes(term) ||
        Utils.normalizeName(order.customerPhone).includes(term) ||
        Utils.normalizeName(order.productName).includes(term);
      return search &&
        (!monthId || order.monthId === monthId) &&
        (!departmentId || order.departmentId === departmentId) &&
        (!moderatorId || order.moderatorId === moderatorId) &&
        (!governorate || order.governorate === governorate) &&
        (!shipmentStatus || order.shipmentStatus === shipmentStatus) &&
        (!product || order.productName === product) &&
        (!fromDate || !order.orderDate || String(order.orderDate) >= fromDate) &&
        (!toDate || !order.orderDate || String(order.orderDate) <= toDate);
    });
    const { key, direction } = state.sort;
    return result.sort((a, b) => {
      const av = a[key] ?? '', bv = b[key] ?? '';
      const comparison = typeof av === 'number' && typeof bv === 'number'
        ? av - bv : String(av).localeCompare(String(bv), 'ar', { numeric: true });
      return direction === 'asc' ? comparison : -comparison;
    });
  }

  function renderFilterOptions() {
    const selections = [
      ['ordersMonthFilter', state.orders.map(order => [order.monthId, Utils.monthLabelFromId(order.monthId)])],
      ['ordersDepartmentFilter', Array.from(new Map(state.orders.map(order => [order.departmentId, order.departmentName])).entries())],
      ['ordersModeratorFilter', Array.from(new Map(state.orders.map(order => [order.moderatorId, order.moderatorName])).entries())],
      ['ordersGovernorateFilter', Array.from(new Map(state.orders.map(order => [order.governorate, order.governorate])).entries())],
      ['ordersShipmentStatusFilter', Array.from(new Map(state.orders.map(order => [order.shipmentStatus, order.shipmentStatus])).entries())],
      ['ordersProductFilter', Array.from(new Map(state.orders.map(order => [order.productName, order.productName])).entries())]
    ];
    selections.forEach(([id, options]) => {
      const select = document.getElementById(id);
      if (!select) return;
      const previous = select.value;
      const unique = Array.from(new Map(options.filter(([value]) => value)).entries())
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'ar'));
      select.innerHTML = '<option value="">الكل</option>' + unique.map(([value, label]) =>
        `<option value="${Utils.escapeHtml(value)}">${Utils.escapeHtml(label || 'غير محدد')}</option>`
      ).join('');
      if (unique.some(([value]) => value === previous)) select.value = previous;
    });
  }

  function renderLoading() {
    const body = document.getElementById('ordersTableBody');
    if (body) body.innerHTML = '<tr><td colspan="13" class="empty-state">جاري تحميل الطلبات…</td></tr>';
  }

  function renderEmpty(message) {
    const body = document.getElementById('ordersTableBody');
    if (body) body.innerHTML = `<tr><td colspan="13" class="empty-state">${Utils.escapeHtml(message)}</td></tr>`;
  }

  function orderRow(order) {
    return `<tr data-order-id="${Utils.escapeHtml(order.id)}">
      <td>${Utils.escapeHtml(order.orderDate || '—')}</td>
      <td class="orders-id">${Utils.escapeHtml(order.externalOrderNumber || order.id)}</td>
      <td>${Utils.escapeHtml(order.customerName || '—')}</td>
      <td>${Utils.escapeHtml(order.customerPhone || '—')}</td>
      <td>${Utils.escapeHtml(order.productName || '—')}</td>
      <td>${Utils.formatNumber(order.packages)}</td>
      <td>${money(order.price)}</td>
      <td>${Utils.escapeHtml(order.moderatorName)}</td>
      <td>${Utils.escapeHtml(order.departmentName)}</td>
      <td>${Utils.escapeHtml(order.waybillNumber || '—')}</td>
      <td>${Utils.escapeHtml(order.governorate || '—')}</td>
      <td>${Utils.escapeHtml(order.shipmentStatus)}</td>
      <td class="actions-cell">
        <button class="btn btn-sm" data-order-action="details" data-order-id="${Utils.escapeHtml(order.id)}" title="عرض التفاصيل">عرض</button>
      </td>
    </tr>`;
  }

  function render() {
    const result = filteredOrders();
    renderSummary();
    const totalPages = Math.max(1, Math.ceil(result.length / PAGE_SIZE));
    state.page = Math.min(state.page, totalPages);
    const pageRows = result.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    const body = document.getElementById('ordersTableBody');
    if (!body) return;
    body.innerHTML = pageRows.length ? pageRows.map(orderRow).join('') :
      '<tr><td colspan="13" class="empty-state">لا توجد طلبات مطابقة للفلاتر الحالية</td></tr>';
    document.getElementById('ordersCountLabel').textContent = `${Utils.formatNumber(result.length)} طلب`;
    document.getElementById('ordersPageLabel').textContent = `صفحة ${state.page} من ${totalPages}`;
    document.getElementById('ordersPrevBtn').disabled = state.page <= 1;
    document.getElementById('ordersNextBtn').disabled = state.page >= totalPages;
    renderBatches(result);
  }

  function renderSummary() {
    const statuses = { ordersTotalCount: state.orders.length, ordersDeliveredCount: 0, ordersReturnedCount: 0, ordersDeferredCount: 0, ordersShippingCount: 0, ordersNotUpdatedCount: 0 };
    state.orders.forEach(order => {
      const status = Utils.normalizeName(order.shipmentStatus);
      if (status.includes('تسليم')) statuses.ordersDeliveredCount++;
      else if (status.includes('مرتجع')) statuses.ordersReturnedCount++;
      else if (status.includes('مؤجل')) statuses.ordersDeferredCount++;
      else if (status.includes('شحن')) statuses.ordersShippingCount++;
      else if (status.includes('لم يتم التحديث')) statuses.ordersNotUpdatedCount++;
    });
    Object.entries(statuses).forEach(([id, value]) => { const node = document.getElementById(id); if (node) node.textContent = Utils.formatNumber(value); });
  }

  function renderBatches(visibleOrders) {
    const body = document.getElementById('ordersBatchesBody');
    if (!body) return;
    const visibleIds = new Set(visibleOrders.map(order => order.batchId));
    const batches = Array.from(state.batches.values())
      .filter(batch => visibleIds.has(batch.id))
      .sort((a, b) => timestampMillis(b.importedAt) - timestampMillis(a.importedAt));
    body.innerHTML = batches.length ? batches.map(batch => {
      const locked = Months.isLocked(batch.monthId);
      const disabled = state.busy || locked ? 'disabled' : '';
      return `<tr>
        <td class="orders-id">${Utils.escapeHtml(batch.id)}</td>
        <td>${Utils.escapeHtml(Utils.monthLabelFromId(batch.monthId))}</td>
        <td>${Utils.formatNumber(batch.count)}</td>
        <td>${Utils.escapeHtml(formatDate(batch.importedAt))}</td>
        <td>${Utils.escapeHtml(batch.importedBy)}</td>
        <td class="actions-cell">
          <button class="btn btn-sm" data-batch-action="filter" data-batch-id="${Utils.escapeHtml(batch.id)}">عرض الطلبات</button>
          <button class="btn btn-sm btn-danger-outline" data-batch-action="undo" data-batch-id="${Utils.escapeHtml(batch.id)}" ${disabled}>Undo Import</button>
        </td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty-state">لا توجد دفعات مطابقة</td></tr>';
  }

  function getOrder(id) {
    return state.orders.find(order => order.id === id) || null;
  }

  function modal(id, open) {
    document.getElementById(id).classList.toggle('open', open);
  }

  function openDetails(id) {
    const order = getOrder(id);
    if (!order) return;
    const sections = [
      ['بيانات العميل', [['الاسم', order.customerName || '—'], ['الهاتف', order.customerPhone || '—'], ['الملاحظات', order.notes || '—'], ['العنوان', order.fullAddress || '—']]],
      ['بيانات الطلب', [['رقم الطلب', order.externalOrderNumber || order.id], ['التاريخ', order.orderDate || '—'], ['المنتج', order.productName || '—'], ['عدد العبوات', Utils.formatNumber(order.packages)], ['السعر', money(order.price)]]],
      ['بيانات التشغيل', [['الموظف', order.moderatorName], ['القسم', order.departmentName], ['رقم البوليصة', order.waybillNumber || '—'], ['المحافظة', order.governorate || '—'], ['حالة الشحنة', order.shipmentStatus || 'لم يتم التحديث']]]
    ];
    document.getElementById('orderDetailsGrid').innerHTML = sections.map(([title, rows]) =>
      `<section class="order-details-section"><h3>${Utils.escapeHtml(title)}</h3>${rows.map(([label, value]) => `<div class="details-stat"><div class="l">${Utils.escapeHtml(label)}</div><div class="v">${Utils.escapeHtml(String(value))}</div></div>`).join('')}</section>`
    ).join('');
    modal('orderDetailsModal', true);
  }

  function fillEmployeeOptions(selected) {
    const select = document.getElementById('orderEditModerator');
    const employees = (state.callbacks.getEmployees() || []).filter(employee => employee.status !== 'inactive');
    select.innerHTML = employees.map(employee => `<option value="${Utils.escapeHtml(employee.id)}">${Utils.escapeHtml(employee.name)}</option>`).join('');
    select.value = selected || '';
  }

  function fillDepartmentOptions(selected) {
    const select = document.getElementById('orderEditDepartment');
    const departments = (state.callbacks.getDepartments() || []).filter(department => department.status !== 'archived');
    select.innerHTML = departments.map(department => `<option value="${Utils.escapeHtml(department.id)}">${Utils.escapeHtml(department.name)}</option>`).join('');
    select.value = selected || '';
  }

  function openEdit(id) {
    const order = getOrder(id);
    if (!order) return;
    if (Months.isLocked(order.monthId)) {
      Toast.show(`شهر ${Utils.monthLabelFromId(order.monthId)} مقفول ولا يمكن تعديل طلباته`, 'error');
      return;
    }
    document.getElementById('orderEditId').value = order.id;
    document.getElementById('orderEditPackages').value = order.packages;
    document.getElementById('orderEditPrice').value = order.price;
    document.getElementById('orderEditMonth').textContent = Utils.monthLabelFromId(order.monthId);
    fillEmployeeOptions(order.moderatorId);
    fillDepartmentOptions(order.departmentId);
    modal('orderEditModal', true);
  }

  async function ensureEditable(monthId, action) {
    try {
      Months.assertEditable(monthId, action);
    } catch (err) {
      throw err;
    }
  }

  function actorEmail() {
    return auth.currentUser ? (auth.currentUser.email || null) : null;
  }

  async function recalculate(monthId) {
    const ok = await state.callbacks.recalculate(monthId);
    if (!ok) throw new Error('تعذر إعادة حساب التقرير بعد تحديث الطلبات');
  }

  async function updateOrder(id) {
    Permissions.require('orders.write');
    const order = getOrder(id);
    if (!order || state.busy) return;
    const packages = Number(document.getElementById('orderEditPackages').value);
    const price = Number(document.getElementById('orderEditPrice').value);
    const moderatorId = document.getElementById('orderEditModerator').value;
    const departmentId = document.getElementById('orderEditDepartment').value;
    const employee = (state.callbacks.getEmployees() || []).find(item => item.id === moderatorId);
    if (!Number.isInteger(packages) || packages <= 0 || !Number.isFinite(price) || price < 0 || !employee || !departmentId) {
      Toast.show('راجع بيانات الطلب: الطرود رقم صحيح أكبر من صفر والسعر غير سالب', 'error');
      return;
    }
    state.busy = true;
    render();
    Loading.show('جاري تحديث الطلب وإعادة الحساب...');
    try {
      await ensureEditable(order.monthId, 'تعديل الطلب');
      await db.runTransaction(async transaction => {
        const snap = await transaction.get(order.batchRef);
        if (!snap.exists) throw new Error('دفعة الطلب لم تعد موجودة');
        const data = snap.data() || {};
        const items = Array.isArray(data.items) ? data.items.slice() : [];
        // The first management write on a legacy batch permanently assigns
        // IDs to every remaining item. That prevents an array index from
        // becoming a moving "ID" after a neighbouring legacy order is deleted.
        items.forEach((item, itemIndex) => {
          if (!item.orderId) items[itemIndex] = { ...item, orderId: orderId(order.batchId, item, itemIndex) };
        });
        const index = items.findIndex(item => item.orderId === order.id);
        if (index < 0 || !items[index]) throw new Error('تعذر العثور على الطلب داخل الدفعة');
        const before = { ...items[index] };
        const updated = {
          ...before,
          orderId: before.orderId || order.id,
          moderatorId: employee.id,
          moderatorName: employee.name,
          departmentId,
          departmentName: departmentName(departmentId),
          packages,
          price,
          saleValue: price,
          updatedAt: new Date(),
          updatedBy: actorEmail()
        };
        items[index] = updated;
        transaction.update(order.batchRef, {
          items,
          count: items.length,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedBy: actorEmail()
        });
        AuditService.appendToBatch(transaction, {
          action: AuditService.ACTION.ORDERS_UPDATED,
          entity: 'orders', operation: AuditService.OPERATION.UPDATE,
          documentId: order.id, documentLabel: order.moderatorName,
          monthId: order.monthId, before, after: updated,
          details: { batchId: order.batchId, orderId: order.id, monthId: order.monthId }
        });
      });
      await recalculate(order.monthId);
      modal('orderEditModal', false);
      await load();
      Toast.show('تم تحديث الطلب وإعادة حساب التقرير', 'success');
    } catch (err) {
      console.error('Order update failed:', err);
      Toast.show('تعذر تحديث الطلب: ' + err.message, 'error');
    } finally {
      state.busy = false;
      Loading.hide();
      render();
    }
  }

  async function deleteOrder(id) {
    Permissions.require('orders.write');
    const order = getOrder(id);
    if (!order || state.busy) return;
    state.busy = true;
    render();
    Loading.show('جاري حذف الطلب وإعادة الحساب...');
    try {
      await ensureEditable(order.monthId, 'حذف الطلب');
      await db.runTransaction(async transaction => {
        const snap = await transaction.get(order.batchRef);
        if (!snap.exists) throw new Error('دفعة الطلب لم تعد موجودة');
        const data = snap.data() || {};
        const items = Array.isArray(data.items) ? data.items.slice() : [];
        items.forEach((item, itemIndex) => {
          if (!item.orderId) items[itemIndex] = { ...item, orderId: orderId(order.batchId, item, itemIndex) };
        });
        const index = items.findIndex(item => item.orderId === order.id);
        if (index < 0 || !items[index]) throw new Error('تعذر العثور على الطلب داخل الدفعة');
        const removed = items[index];
        items.splice(index, 1);
        if (items.length === 0) transaction.delete(order.batchRef);
        else transaction.update(order.batchRef, {
          items, count: items.length,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: actorEmail()
        });
        AuditService.appendToBatch(transaction, {
          action: AuditService.ACTION.ORDERS_DELETED,
          entity: 'orders', operation: AuditService.OPERATION.DELETE,
          documentId: order.id, documentLabel: order.moderatorName,
          monthId: order.monthId, before: removed,
          details: { batchId: order.batchId, orderId: order.id, monthId: order.monthId }
        });
      });
      await recalculate(order.monthId);
      await load();
      Toast.show('تم حذف الطلب وإعادة حساب التقرير', 'success');
    } catch (err) {
      console.error('Order delete failed:', err);
      Toast.show('تعذر حذف الطلب: ' + err.message, 'error');
    } finally {
      state.busy = false;
      Loading.hide();
      render();
    }
  }

  async function undoBatch(batchId) {
    Permissions.require('orders.write');
    const batch = state.batches.get(batchId);
    if (!batch || state.busy) return;
    state.busy = true;
    render();
    Loading.show('جاري التراجع عن الاستيراد...');
    try {
      await ensureEditable(batch.monthId, 'التراجع عن الاستيراد');
      let removedBatch = null;
      await db.runTransaction(async transaction => {
        const snap = await transaction.get(batch.ref);
        if (!snap.exists) throw new Error('هذه الدفعة لم تعد موجودة');
        removedBatch = normalizeBatch(snap);
        transaction.delete(batch.ref);
        AuditService.appendToBatch(transaction, {
          action: AuditService.ACTION.ORDERS_BATCH_UNDONE,
          entity: 'orders', operation: AuditService.OPERATION.DELETE,
          documentId: batch.id, documentLabel: `دفعة ${batch.id}`,
          monthId: batch.monthId,
          before: { batchId: batch.id, count: removedBatch.count, autoCreatedEmployeeIds: removedBatch.autoCreatedEmployeeIds },
          details: { batchId: batch.id, monthId: batch.monthId, orderCount: removedBatch.count }
        });
      });

      // An imported employee is live master data. Removing a batch, resetting
      // its month, or deleting that month must never delete the employee.
      await recalculate(batch.monthId);
      await load();
      Toast.show('تم Undo Import وحذف طلبات الدفعة وإعادة الحساب', 'success');
    } catch (err) {
      console.error('Undo import failed:', err);
      Toast.show('تعذر التراجع عن الاستيراد: ' + err.message, 'error');
    } finally {
      state.busy = false;
      Loading.hide();
      render();
    }
  }

  const shipping = { rows: [], valid: [], matches: [], unmatched: [] };
  const shippingAliases = {
    customerName: ['اسمالعميل', 'العميل', 'customername', 'customer', 'client'],
    customerPhone: ['رقمالهاتف', 'الهاتف', 'الموبايل', 'phone', 'mobile', 'telephone'],
    waybillNumber: ['رقمالبوليصة', 'البوليصة', 'waybill', 'tracking', 'trackingnumber'],
    governorate: ['المحافظة', 'governorate', 'province']
  };
  const shippingKey = (name, phone) => `${Utils.normalizeName(name)}|${String(phone || '').replace(/\D/g, '')}`;
  function shippingStage(number) {
    document.querySelectorAll('[data-shipping-stage]').forEach(node => node.classList.toggle('active', Number(node.dataset.shippingStage) === number));
    document.querySelectorAll('[data-shipping-step-indicator]').forEach(node => node.classList.toggle('active', Number(node.dataset.shippingStepIndicator) === number));
  }
  function shippingHeaderIndex(headers, aliases) {
    return headers.findIndex(header => aliases.includes(Utils.normalizeName(header).replace(/[^a-z0-9\u0600-\u06FF]/g, '')));
  }
  async function analyzeShippingFile() {
    const file = document.getElementById('shippingFileInput').files[0];
    if (!file) return Toast.show('اختر ملف شركة الشحن أولاً', 'error');
    if (typeof XLSX === 'undefined') return Toast.show('مكتبة Excel غير متاحة', 'error');
    try {
      const buffer = await file.arrayBuffer(); const workbook = XLSX.read(buffer, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
      const headers = rows[0] || []; const index = Object.fromEntries(Object.entries(shippingAliases).map(([key, aliases]) => [key, shippingHeaderIndex(headers, aliases)]));
      const missing = Object.entries(index).filter(([, value]) => value < 0).map(([key]) => key);
      shipping.rows = rows.slice(1); shipping.valid = []; shipping.matches = []; shipping.unmatched = [];
      if (missing.length) { document.getElementById('shippingPreview').innerHTML = `<div class="error-box">الأعمدة المطلوبة مفقودة: ${missing.join('، ')}</div>`; document.getElementById('shippingValidation').innerHTML = '<div class="error-box">لا يمكن المتابعة قبل توفر جميع الأعمدة المطلوبة.</div>'; shippingStage(2); return; }
      shipping.valid = shipping.rows.map((row, line) => ({ line: line + 2, customerName: String(row[index.customerName] || '').trim(), customerPhone: String(row[index.customerPhone] || '').trim(), waybillNumber: String(row[index.waybillNumber] || '').trim(), governorate: String(row[index.governorate] || '').trim() }));
      const invalid = shipping.valid.filter(row => !row.customerName || !row.customerPhone || !row.waybillNumber || !row.governorate);
      shipping.valid = shipping.valid.filter(row => !invalid.includes(row));
      document.getElementById('shippingPreview').innerHTML = `<div class="hint-box">تمت قراءة ${Utils.formatNumber(shipping.rows.length)} صف. معاينة أول ${Math.min(5, shipping.valid.length)} صفوف.</div><div class="table-wrap"><table><tbody>${shipping.valid.slice(0, 5).map(row => `<tr><td>${Utils.escapeHtml(row.customerName)}</td><td>${Utils.escapeHtml(row.customerPhone)}</td><td>${Utils.escapeHtml(row.waybillNumber)}</td><td>${Utils.escapeHtml(row.governorate)}</td></tr>`).join('')}</tbody></table></div>`;
      document.getElementById('shippingValidation').innerHTML = invalid.length ? `<div class="error-box">يوجد ${invalid.length} صف غير صالح، وسيتم تجاهله. الحقول الأربعة مطلوبة لكل صف.</div>` : `<div class="hint-box">التحقق ناجح: ${Utils.formatNumber(shipping.valid.length)} صف صالح.</div>`;
      shippingStage(2);
    } catch (error) { console.error('Shipping file analysis failed', error); Toast.show('تعذر قراءة ملف الشحن: ' + error.message, 'error'); }
  }
  function matchShippingRows() {
    // A customer may legitimately have multiple orders. Keep a FIFO queue
    // for each name/phone key so one shipping row cannot overwrite the last
    // matching order repeatedly (the previous Map value did exactly that).
    const byKey = new Map(); state.orders.forEach(order => { const key = shippingKey(order.customerName, order.customerPhone); if (key !== '|') { const queue = byKey.get(key) || []; queue.push(order); byKey.set(key, queue); } });
    shipping.matches = []; shipping.unmatched = [];
    shipping.valid.forEach(row => { const queue = byKey.get(shippingKey(row.customerName, row.customerPhone)) || []; const order = queue.shift(); (order ? shipping.matches : shipping.unmatched).push(order ? { order, row, shipmentStatus: order.shipmentStatus || 'لم يتم التحديث' } : row); });
    document.getElementById('shippingMatching').innerHTML = `<div class="hint-box">تمت مطابقة ${Utils.formatNumber(shipping.matches.length)} طلب، ولم يتم العثور على ${Utils.formatNumber(shipping.unmatched.length)} صف. لن تُنشأ طلبات جديدة.</div>`;
    renderShippingResults(); shippingStage(4);
  }
  function renderShippingResults() {
    document.getElementById('shippingResultsBody').innerHTML = shipping.matches.map((match, index) => `<tr><td>${Utils.escapeHtml(match.order.customerName || match.row.customerName)}</td><td>${Utils.escapeHtml(match.order.customerPhone || match.row.customerPhone)}</td><td>${Utils.escapeHtml(match.order.moderatorName)}</td><td>${Utils.escapeHtml(match.order.departmentName)}</td><td>${Utils.escapeHtml(match.row.waybillNumber)}</td><td>${Utils.escapeHtml(match.row.governorate)}</td><td><select data-shipping-status="${index}"><option ${match.shipmentStatus === 'لم يتم التحديث' ? 'selected' : ''}>لم يتم التحديث</option><option ${match.shipmentStatus === 'تم التسليم' ? 'selected' : ''}>تم التسليم</option><option ${match.shipmentStatus === 'مرتجع' ? 'selected' : ''}>مرتجع</option><option ${match.shipmentStatus === 'مؤجل' ? 'selected' : ''}>مؤجل</option><option ${match.shipmentStatus === 'في الشحن' ? 'selected' : ''}>في الشحن</option></select></td></tr>`).join('') || '<tr><td colspan="7" class="empty-state">لا توجد طلبات مطابقة للمراجعة</td></tr>';
  }
  async function saveShippingUpdates() {
    if (!shipping.matches.length) return Toast.show('لا توجد طلبات مطابقة لحفظها', 'error');
    document.querySelectorAll('[data-shipping-status]').forEach(select => { shipping.matches[Number(select.dataset.shippingStatus)].shipmentStatus = select.value; });
    const batches = new Map(); shipping.matches.forEach(match => { if (!batches.has(match.order.batchId)) batches.set(match.order.batchId, []); batches.get(match.order.batchId).push(match); });
    try {
      for (const [batchId, matches] of batches) { const batch = state.batches.get(batchId); const items = batch.items.map((item, i) => { const id = orderId(batch.id, item, i); const match = matches.find(entry => entry.order.id === id); return match ? { ...item, orderId: id, waybillNumber: match.row.waybillNumber, governorate: match.row.governorate, shipmentStatus: match.shipmentStatus, updatedAt: new Date(), updatedBy: actorEmail() } : item; }); await batch.ref.update({ items, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: actorEmail() }); }
      document.getElementById('shippingSuccess').textContent = `اكتمل الحفظ: ${shipping.matches.length} طلب مطابق تم تحديثه، و${shipping.unmatched.length} صف غير مطابق.`; await load(); shippingStage(6); Toast.show('تم حفظ تحديثات الشحن', 'success');
    } catch (error) { console.error('Shipping updates failed', error); Toast.show('تعذر حفظ تحديثات الشحن: ' + error.message, 'error'); }
  }

  let generatedOrderReport = [];
  function reportSelectOptions(id, pairs) {
    const select = document.getElementById(id); if (!select) return;
    const current = select.value; const unique = Array.from(new Map(pairs.filter(([value]) => value)).entries());
    select.innerHTML = '<option value="">الكل</option>' + unique.map(([value, label]) => `<option value="${Utils.escapeHtml(value)}">${Utils.escapeHtml(label)}</option>`).join('');
    if (unique.some(([value]) => value === current)) select.value = current;
  }
  function populateOrderReportFilters() {
    reportSelectOptions('ordersReportDepartment', state.orders.map(o => [o.departmentId, o.departmentName]));
    reportSelectOptions('ordersReportEmployee', state.orders.map(o => [o.moderatorId, o.moderatorName]));
    reportSelectOptions('ordersReportGovernorate', state.orders.map(o => [o.governorate, o.governorate]));
    reportSelectOptions('ordersReportProduct', state.orders.map(o => [o.productName, o.productName]));
    reportSelectOptions('ordersReportStatus', state.orders.map(o => [o.shipmentStatus, o.shipmentStatus]));
  }
  function orderReportRows() {
    const v = id => filterValue(id); const type = v('ordersReportType');
    return state.orders.filter(o => (!v('ordersReportDateFrom') || !o.orderDate || String(o.orderDate) >= v('ordersReportDateFrom')) && (!v('ordersReportDateTo') || !o.orderDate || String(o.orderDate) <= v('ordersReportDateTo')) && (!v('ordersReportDepartment') || o.departmentId === v('ordersReportDepartment')) && (!v('ordersReportEmployee') || o.moderatorId === v('ordersReportEmployee')) && (!v('ordersReportGovernorate') || o.governorate === v('ordersReportGovernorate')) && (!v('ordersReportProduct') || o.productName === v('ordersReportProduct')) && (!v('ordersReportStatus') || o.shipmentStatus === v('ordersReportStatus')) && (type !== 'employee' || !!v('ordersReportEmployee')) && (type !== 'department' || !!v('ordersReportDepartment')));
  }
  function reportCard(label, value) { return `<div class="stat-card"><div class="stat-label">${Utils.escapeHtml(label)}</div><div class="stat-value">${Utils.escapeHtml(String(value))}</div></div>`; }
  function generateOrderReport() {
    const type = filterValue('ordersReportType');
    if ((type === 'employee' && !filterValue('ordersReportEmployee')) || (type === 'department' && !filterValue('ordersReportDepartment'))) return Toast.show('اختر الموظف أو القسم أولاً', 'error');
    generatedOrderReport = orderReportRows();
    const countStatus = phrase => generatedOrderReport.filter(o => Utils.normalizeName(o.shipmentStatus).includes(phrase)).length;
    const delivered = countStatus('تسليم'), returned = countStatus('مرتجع'), deferred = countStatus('مؤجل'), shippingCount = countStatus('شحن'); const total = generatedOrderReport.length;
    const pct = value => total ? `${((value / total) * 100).toFixed(1)}%` : '0%';
    document.getElementById('ordersReportMetrics').innerHTML = [['إجمالي الطلبات', total], ['تم التسليم', delivered], ['مرتجع', returned], ['مؤجل', deferred], ['في الشحن', shippingCount], ['لم يتم التحديث', countStatus('لم يتم التحديث')], ['نسبة التسليم', pct(delivered)], ['نسبة المرتجع', pct(returned)], ['نسبة المؤجل', pct(deferred)], ['نسبة في الشحن', pct(shippingCount)]].map(([l, v]) => reportCard(l, typeof v === 'string' ? v : Utils.formatNumber(v))).join('');
    const employeeIds = new Set(generatedOrderReport.map(o => o.moderatorId)); const payrollRows = (state.callbacks.getCurrentReport ? state.callbacks.getCurrentReport() : []).filter(r => employeeIds.has(r.moderatorId));
    const sum = (rows, keys) => rows.reduce((n, row) => n + Number(keys.map(k => row[k]).find(x => x !== undefined) || 0), 0);
    const financial = [['إجمالي قيمة الطلبات', money(generatedOrderReport.reduce((n, o) => n + o.price, 0))], ['إجمالي العبوات', Utils.formatNumber(generatedOrderReport.reduce((n, o) => n + o.packages, 0))], ['إجمالي البونص', money(sum(payrollRows, ['bonus', 'totalBonus']))], ['إجمالي العمولة', money(sum(payrollRows, ['commission', 'totalCommission']))], ['إجمالي الرواتب', money(sum(payrollRows, ['baseSalary', 'salary']))], ['صافي المستحقات', money(sum(payrollRows, ['netSalary', 'netPay', 'net']))]];
    document.getElementById('ordersReportFinancial').innerHTML = financial.map(([l, v]) => reportCard(l, v)).join('');
    document.getElementById('ordersReportTitle').textContent = `${type === 'employee' ? 'تقرير موظف' : type === 'department' ? 'تقرير قسم' : 'تقرير عام'} — ${Utils.formatNumber(total)} طلب مطابق.`;
    document.getElementById('ordersReportTableBody').innerHTML = generatedOrderReport.map(o => `<tr><td>${Utils.escapeHtml(o.orderDate || '—')}</td><td>${Utils.escapeHtml(o.externalOrderNumber || o.id)}</td><td>${Utils.escapeHtml(o.customerName || '—')}</td><td>${Utils.escapeHtml(o.productName || '—')}</td><td>${Utils.formatNumber(o.packages)}</td><td>${money(o.price)}</td><td>${Utils.escapeHtml(o.moderatorName)}</td><td>${Utils.escapeHtml(o.departmentName)}</td><td>${Utils.escapeHtml(o.governorate || '—')}</td><td>${Utils.escapeHtml(o.shipmentStatus)}</td></tr>`).join('') || '<tr><td colspan="10" class="empty-state">لا توجد طلبات مطابقة</td></tr>';
    document.getElementById('ordersReportOutput').classList.remove('hidden');
  }
  function exportOrderReport() {
    if (!generatedOrderReport.length) return Toast.show('أنشئ تقريرًا أولاً', 'error'); if (typeof XLSX === 'undefined') return Toast.show('تصدير Excel غير متاح', 'error');
    const rows = generatedOrderReport.map(o => ({ 'التاريخ': o.orderDate, 'رقم الطلب': o.externalOrderNumber || o.id, 'العميل': o.customerName, 'الهاتف': o.customerPhone, 'المنتج': o.productName, 'العبوات': o.packages, 'السعر': o.price, 'الموظف': o.moderatorName, 'القسم': o.departmentName, 'المحافظة': o.governorate, 'حالة الشحنة': o.shipmentStatus })); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Order Report'); XLSX.writeFile(wb, 'orders-report.xlsx');
  }

  function bind() {
    document.getElementById('ordersRefreshBtn').addEventListener('click', load);
    document.getElementById('ordersSearchInput').addEventListener('input', () => { state.page = 1; render(); });
    ['ordersMonthFilter', 'ordersDepartmentFilter', 'ordersModeratorFilter', 'ordersGovernorateFilter', 'ordersShipmentStatusFilter', 'ordersProductFilter', 'ordersDateFrom', 'ordersDateTo'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => { state.page = 1; render(); });
    });
    document.getElementById('ordersPrevBtn').addEventListener('click', () => { state.page -= 1; render(); });
    document.getElementById('ordersNextBtn').addEventListener('click', () => { state.page += 1; render(); });
    document.getElementById('ordersTableBody').addEventListener('click', event => {
      const button = event.target.closest('[data-order-action]');
      if (!button) {
        const row = event.target.closest('tr[data-order-id]');
        if (row) openDetails(row.dataset.orderId);
        return;
      }
      const id = button.dataset.orderId;
      if (button.dataset.orderAction === 'details') openDetails(id);
      if (button.dataset.orderAction === 'edit') openEdit(id);
      if (button.dataset.orderAction === 'delete') {
        const order = getOrder(id);
        if (order) Confirm.show(`حذف الطلب ${order.id} نهائيًا؟ سيتم إعادة حساب تقرير ${Utils.monthLabelFromId(order.monthId)}.`, () => deleteOrder(id));
      }
    });
    document.querySelectorAll('[data-order-sort]').forEach(header => header.addEventListener('click', () => {
      const key = header.dataset.orderSort;
      state.sort.direction = state.sort.key === key && state.sort.direction === 'asc' ? 'desc' : 'asc';
      state.sort.key = key; state.page = 1; render();
    }));
    document.getElementById('ordersBatchesBody').addEventListener('click', event => {
      const button = event.target.closest('[data-batch-action]');
      if (!button) return;
      const batchId = button.dataset.batchId;
      if (button.dataset.batchAction === 'filter') {
        const batchOrders = state.orders.filter(order => order.batchId === batchId);
        if (batchOrders.length) openDetails(batchOrders[0].id);
      }
      if (button.dataset.batchAction === 'undo') {
        const batch = state.batches.get(batchId);
        if (batch) Confirm.show(`Undo Import للدفعة ${batch.id}؟ سيُحذف ${batch.count} طلبًا فقط ثم يُعاد حساب التقرير.`, () => undoBatch(batchId));
      }
    });
    document.getElementById('orderDetailsCloseBtn').addEventListener('click', () => modal('orderDetailsModal', false));
    document.getElementById('orderEditCancelBtn').addEventListener('click', () => modal('orderEditModal', false));
    document.getElementById('orderEditSaveBtn').addEventListener('click', () => updateOrder(document.getElementById('orderEditId').value));
    document.getElementById('shippingAnalyzeBtn').addEventListener('click', analyzeShippingFile);
    document.getElementById('shippingMatchBtn').addEventListener('click', matchShippingRows);
    document.querySelectorAll('[data-shipping-next]').forEach(button => button.addEventListener('click', () => shippingStage(Number(button.dataset.shippingNext))));
    document.querySelectorAll('[data-shipping-back]').forEach(button => button.addEventListener('click', () => shippingStage(Number(button.dataset.shippingBack))));
    document.getElementById('shippingApplyStatusBtn').addEventListener('click', () => { const status = document.getElementById('shippingApplyStatus').value; shipping.matches.forEach(match => { match.shipmentStatus = status; }); renderShippingResults(); });
    document.getElementById('shippingSaveBtn').addEventListener('click', saveShippingUpdates);
    document.getElementById('shippingRestartBtn').addEventListener('click', () => { shipping.rows = []; shipping.valid = []; shipping.matches = []; shipping.unmatched = []; document.getElementById('shippingFileInput').value = ''; shippingStage(1); });
    document.getElementById('ordersGenerateReportBtn').addEventListener('click', generateOrderReport);
    document.getElementById('ordersReportExcelBtn').addEventListener('click', exportOrderReport);
    document.getElementById('ordersReportPrintBtn').addEventListener('click', () => { if (generatedOrderReport.length) window.print(); else Toast.show('أنشئ تقريرًا أولاً', 'error'); });
    document.getElementById('ordersReportPdfBtn').addEventListener('click', () => { if (generatedOrderReport.length) { window.print(); Toast.show('اختر “حفظ كـ PDF” من نافذة الطباعة', 'info'); } else Toast.show('أنشئ تقريرًا أولاً', 'error'); });
  }

  function init(callbacks) {
    if (state.initialized) return;
    state.callbacks = callbacks;
    bind();
    state.initialized = true;
    load(); // Read-only cache shared by the Orders Center and Dashboard analytics.
  }

  async function open() {
    if (!state.initialized) return;
    await load();
  }

  return { init, open, refresh: load, getAll: () => state.orders.slice() };
})();
