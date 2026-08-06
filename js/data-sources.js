'use strict';

/* Data Sources ----------------------------------------------------------
 * Source definitions live in settings/general. Excel files are intentionally
 * selected at sync time: putting file bytes in Firestore would hit its 1 MB
 * document limit and create a misleading, non-restorable “saved file”. */
const DataSources = (() => {
  let sources = [];
  const $ = id => document.getElementById(id);
  const escape = value => Utils.escapeHtml(String(value ?? '—'));
  const aliases = { orderDate:['التاريخ','date','orderdate'], externalOrderNumber:['رقمالطلب','ordernumber','orderid'], customerName:['اسمالعميل','customername','customer'], customerPhone:['رقمالهاتف','phone','mobile'], notes:['ملاحظات','notes'], fullAddress:['العنوان','address'], productName:['اسمالمنتج','productname','product'], packages:['عددالعبوات','العبوات','packages','qty','quantity'], price:['السعر','price','amount'], name:['اسمالموظف','الموظف','employee','employeename','moderator'] };
  const norm = value => Utils.normalizeName(String(value || '')).replace(/[^a-z0-9\u0600-\u06FF]/g, '');
  const departments = () => (typeof Departments !== 'undefined' ? Departments.all() : []).filter(d => d.status !== 'archived');
  const sourceById = id => sources.find(source => source.id === id);
  const scopeLabel = type => type === 'google-sheets' ? 'Google Sheets' : 'Excel';

  function requireManage() { Permissions.require('settings.read'); Permissions.require('settings.write'); }
  function requireSync() { Permissions.require('settings.read'); Permissions.require('settings.write'); Permissions.require('orders.import'); }
  function options(selected) { return departments().map(d => `<option value="${escape(d.id)}" ${d.id === selected ? 'selected' : ''}>${escape(d.name)}</option>`).join(''); }
  function status(source) { return source.lastSyncStatus === 'error' ? ['فشل آخر مزامنة','badge-locked'] : source.lastSyncAt ? ['تمت المزامنة','badge-active'] : ['جاهز للمزامنة','badge']; }
  function render() {
    const body = $('dataSourcesBody'); if (!body) return;
    body.innerHTML = sources.length ? sources.map(source => { const state = status(source); return `<tr><td>${escape((departments().find(d => d.id === source.departmentId) || {}).name)}</td><td>${scopeLabel(source.type)}</td><td>${escape(source.name || source.sheetName || source.fileName || 'بدون اسم')}</td><td><span class="badge ${state[1]}">${state[0]}</span></td><td>${escape(source.lastSyncAt)}</td><td>${escape(source.lastOrderCount || 0)}</td><td><button class="btn btn-sm" data-source-sync="${escape(source.id)}">مزامنة</button><button class="btn btn-sm" data-source-edit="${escape(source.id)}">تعديل</button><button class="btn btn-sm btn-danger-outline" data-source-delete="${escape(source.id)}">حذف</button></td></tr>`; }).join('') : '<tr><td colspan="7" class="empty-state">لا توجد مصادر بيانات مضافة</td></tr>';
  }
  function typeUI() { const google = $('dataSourceType').value === 'google-sheets'; $('dataSourceGoogleFields').classList.toggle('hidden', !google); $('dataSourceExcelFields').classList.toggle('hidden', google); }
  function editor(source = null) {
    requireManage();
    $('dataSourceEditor').classList.remove('hidden'); $('dataSourceEditorTitle').textContent = source ? 'تعديل مصدر بيانات' : 'إضافة مصدر بيانات';
    $('dataSourceId').value = source?.id || ''; $('dataSourceType').value = source?.type || 'google-sheets'; $('dataSourceDepartment').innerHTML = options(source?.departmentId); $('dataSourceName').value = source?.name || ''; $('dataSourceUrl').value = source?.url || ''; $('dataSourceSheetName').value = source?.sheetName || ''; $('dataSourceRange').value = source?.range || ''; $('dataSourceExcelFile').value = ''; typeUI();
  }
  async function persist() { await db.collection(COLLECTIONS.SETTINGS).doc('general').set({ dataSources: sources, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }); }
  async function audit(action, source, details = {}) { await AuditService.log(action, { entity:'settings', operation:AuditService.OPERATION.UPDATE, documentId:'general', documentLabel:source.name || source.id, details:{ sourceId:source.id, sourceType:source.type, departmentId:source.departmentId, ...details } }); }
  function validGoogleUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'docs.google.com' && /^\/spreadsheets\//.test(url.pathname); } catch (_) { return false; } }
  async function save() {
    requireManage();
    const type = $('dataSourceType').value, departmentId = $('dataSourceDepartment').value, url = $('dataSourceUrl').value.trim(), id = $('dataSourceId').value || db.collection(COLLECTIONS.SETTINGS).doc().id;
    if (!departmentId) throw new Error('اختر القسم المرتبط بالمصدر.');
    if (type === 'google-sheets' && (!validGoogleUrl(url) || !$('dataSourceSheetName').value.trim())) throw new Error('أدخل رابط Google Sheet صحيحًا واسم ورقة العمل.');
    const file = $('dataSourceExcelFile').files[0];
    if (type === 'excel' && !file && !sourceById(id)) throw new Error('اختر ملف Excel للمصدر.');
    const before = sourceById(id);
    const source = { id, type, departmentId, name:$('dataSourceName').value.trim(), url:type === 'google-sheets' ? url : '', sheetName:type === 'google-sheets' ? $('dataSourceSheetName').value.trim() : '', range:type === 'google-sheets' ? $('dataSourceRange').value.trim() : '', fileName:type === 'excel' ? (file?.name || before?.fileName || '') : '', lastSyncAt:before?.lastSyncAt || null, lastOrderCount:before?.lastOrderCount || 0, lastSyncStatus:before?.lastSyncStatus || null };
    sources = sources.filter(item => item.id !== id).concat(source); await persist(); await audit(before ? 'data_sources.updated' : 'data_sources.created', source, { fileName:source.fileName || null }); render(); $('dataSourceEditor').classList.add('hidden');
    if (type === 'excel' && file) await sync(source, file);
    Toast.show('تم حفظ مصدر البيانات.', 'success');
  }
  async function remove(id) { requireManage(); const source = sourceById(id); if (!source) return; sources = sources.filter(item => item.id !== id); await persist(); await audit('data_sources.deleted', source); render(); Toast.show('تم حذف مصدر البيانات.', 'success'); }
  async function load() { const snap = await db.collection(COLLECTIONS.SETTINGS).doc('general').get(); sources = snap.exists && Array.isArray(snap.data().dataSources) ? snap.data().dataSources : []; render(); }

  function parseCsv(text) {
    const input = String(text || '').replace(/^\uFEFF/, ''); const first = input.split(/\r?\n/, 1)[0] || ''; const delimiter = ['\t',';',','].sort((a,b) => (first.split(b).length - first.split(a).length))[0]; const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < input.length; i++) { const char = input[i], next = input[i + 1]; if (char === '"') { if (quoted && next === '"') { cell += '"'; i++; } else quoted = !quoted; } else if (!quoted && char === delimiter) { row.push(cell); cell = ''; } else if (!quoted && (char === '\n' || char === '\r')) { if (char === '\r' && next === '\n') i++; row.push(cell); if (row.some(value => value !== '')) rows.push(row); row = []; cell = ''; } else cell += char; }
    if (quoted) throw new Error('ملف CSV يحتوي على اقتباس غير مغلق.'); row.push(cell); if (row.some(value => value !== '')) rows.push(row); return rows;
  }
  function headerMap(headers) { const normalized = headers.map(norm); return Object.fromEntries(Object.entries(aliases).map(([field, names]) => [field, normalized.findIndex(header => names.includes(header))])); }
  function normalizeRows(matrix) {
    const headers = matrix.shift() || [], map = headerMap(headers), missing = ['name','packages','price'].filter(field => map[field] < 0); if (missing.length) throw new Error(`الأعمدة المطلوبة غير موجودة: ${missing.join(', ')}`);
    const errors = [], orders = [];
    matrix.forEach((row, index) => { const read = field => map[field] >= 0 ? String(row[map[field]] ?? '').trim() : ''; const packages = Number(String(read('packages')).replace(/,/g, '')), price = Number(String(read('price')).replace(/,/g, '')); if (!read('name') || !Number.isInteger(packages) || packages <= 0 || !Number.isFinite(price) || price < 0) { errors.push({ lineNumber:index + 2, reason:'الاسم أو العبوات أو السعر غير صالح' }); return; } orders.push({ name:read('name'), packages, price, orderDate:read('orderDate'), externalOrderNumber:read('externalOrderNumber'), customerName:read('customerName'), customerPhone:read('customerPhone'), notes:read('notes'), fullAddress:read('fullAddress'), productName:read('productName'), waybillNumber:'', governorate:'', shipmentStatus:'لم يتم التحديث' }); });
    return { orders, errors, headers };
  }
  async function readExcel(file) { if (typeof XLSX === 'undefined') throw new Error('مكتبة Excel غير متاحة.'); const book = XLSX.read(await file.arrayBuffer(), { type:'array' }); if (!book.SheetNames.length) throw new Error('ملف Excel لا يحتوي على ورقة عمل.'); return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header:1, defval:'' }); }
  function googleCsvUrl(source) { const base = source.url.replace(/\/edit(?:\/.*)?$/, '').replace(/\/$/, ''); const params = new URLSearchParams({ tqx:'out:csv', sheet:source.sheetName }); if (source.range) params.set('range', source.range); return `${base}/gviz/tq?${params}`; }
  async function readGoogle(source) { const response = await fetch(googleCsvUrl(source), { credentials:'omit' }); if (!response.ok) throw new Error(`فشل الاتصال بـ Google Sheets (${response.status}). تأكد أن الورقة منشورة وقابلة للقراءة.`); return parseCsv(await response.text()); }
  async function testGoogle() { requireManage(); const source = { type:'google-sheets', url:$('dataSourceUrl').value.trim(), sheetName:$('dataSourceSheetName').value.trim(), range:$('dataSourceRange').value.trim() }; if (!validGoogleUrl(source.url) || !source.sheetName) throw new Error('أدخل رابطًا صحيحًا واسم ورقة العمل.'); const parsed = normalizeRows(await readGoogle(source)); Toast.show(`الاتصال صالح: ${parsed.orders.length} صف قابل للاستيراد، ${parsed.errors.length} صف يحتاج مراجعة.`, 'success'); }
  async function chooseExcel(source) { const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.xlsx,.xls'; picker.addEventListener('change', () => { const file = picker.files[0]; if (file) sync(source, file).catch(showSyncError); }, { once:true }); picker.click(); }
  async function sync(source, excelFile = null) {
    requireSync(); const started = Date.now();
    try {
      const parsed = normalizeRows(source.type === 'google-sheets' ? await readGoogle(source) : await readExcel(excelFile));
      const similar = await App.findSimilarGoogleOrders(parsed.orders); const skipped = similar.length ? await reviewSimilar(parsed.orders, similar, source) : []; if (skipped === null) return;
      const selected = parsed.orders.filter((_, index) => !skipped.includes(index)); const result = await App.syncGoogleSource(source, selected, parsed.errors, skipped.length);
      Object.assign(source, { lastSyncAt:new Date().toLocaleString('ar-EG'), lastOrderCount:result.imported || 0, lastSyncStatus:'success', fileName:excelFile?.name || source.fileName || '' }); sources = sources.map(item => item.id === source.id ? source : item); await persist(); await audit('data_sources.synced', source, { imported:result.imported || 0, skipped:skipped.length, validationErrors:parsed.errors.length, durationMs:Date.now() - started }); render(); Toast.show(`اكتملت مزامنة ${source.name || source.sheetName || source.fileName}: ${result.imported || 0} طلب جديد.`, 'success');
    } catch (error) { Object.assign(source, { lastSyncAt:new Date().toLocaleString('ar-EG'), lastOrderCount:0, lastSyncStatus:'error' }); sources = sources.map(item => item.id === source.id ? source : item); await persist(); await audit('data_sources.sync_failed', source, { message:error.message, durationMs:Date.now() - started }); render(); throw error; }
  }
  function showSyncError(error) { Toast.show('تعذر مزامنة المصدر: ' + error.message, 'error'); }
  function openSourcePicker() {
    requireSync(); if (!sources.length) return Toast.show('أضف مصدر بيانات أولًا.', 'info');
    const modal = document.createElement('div'); modal.className = 'modal-backdrop open'; modal.innerHTML = `<div class="modal"><div class="modal-header"><h3>اختيار مصادر المزامنة</h3></div><div class="modal-body"><p class="muted">اختر مصدرًا واحدًا أو أكثر. سيطلب النظام ملفًا لكل مصدر Excel.</p>${sources.map(source => `<label class="check-field"><input type="checkbox" value="${escape(source.id)}"><span>${escape(source.name || source.sheetName || source.fileName || source.id)} — ${scopeLabel(source.type)}</span></label>`).join('')}</div><div class="modal-footer"><button class="btn" data-cancel>إلغاء</button><button class="btn btn-accent" data-confirm>بدء المزامنة</button></div></div>`; document.body.appendChild(modal);
    modal.querySelector('[data-cancel]').onclick = () => modal.remove(); modal.querySelector('[data-confirm]').onclick = async () => { const selected = [...modal.querySelectorAll('input:checked')].map(input => sourceById(input.value)).filter(Boolean); if (!selected.length) return Toast.show('اختر مصدرًا واحدًا على الأقل.', 'error'); modal.remove(); for (const source of selected) { try { if (source.type === 'excel') await chooseExcel(source); else await sync(source); } catch (error) { showSyncError(error); } } };
  }
  function bind() {
    $('dataSourceAddBtn').addEventListener('click', () => { try { editor(); } catch (error) { Toast.show(error.message, 'error'); } }); $('dataSourceType').addEventListener('change', typeUI); $('dataSourceCancelBtn').addEventListener('click', () => $('dataSourceEditor').classList.add('hidden')); $('dataSourceSaveBtn').addEventListener('click', () => save().catch(showSyncError)); $('dataSourceTestBtn').addEventListener('click', () => testGoogle().catch(showSyncError));
    $('dataSourcesBody').addEventListener('click', event => { const edit = event.target.closest('[data-source-edit]'), del = event.target.closest('[data-source-delete]'), syncButton = event.target.closest('[data-source-sync]'); try { if (edit) editor(sourceById(edit.dataset.sourceEdit)); if (del) Confirm.show('حذف مصدر البيانات؟', () => remove(del.dataset.sourceDelete).catch(showSyncError)); if (syncButton) { const source = sourceById(syncButton.dataset.sourceSync); if (source.type === 'excel') chooseExcel(source); else sync(source).catch(showSyncError); } } catch (error) { showSyncError(error); } });
  }
  function init() { bind(); $('dataSourcesSyncBtn').addEventListener('click', () => { try { openSourcePicker(); } catch (error) { showSyncError(error); } }); load().catch(showSyncError); }
  return { init, parseCsv, normalizeRows };
})();
