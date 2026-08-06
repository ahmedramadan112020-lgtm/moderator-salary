'use strict';

const UserManagement = (() => {
  let users = [], search = '', statusFilter = 'all', initialized = false;
  // Central presentation catalogue. Stored permission keys remain unchanged.
  const PERMISSION_GROUPS = [
    { label: 'الموظفون', icon: 'users', items: [['employees.read','عرض الموظفين'],['employees.write','إدارة الموظفين'],['employees.delete','حذف الموظفين']] },
    { label: 'الطلبات', icon: 'receipt-text', items: [['orders.read','عرض الطلبات'],['orders.import','استيراد الطلبات'],['orders.write','إدارة الطلبات']] },
    { label: 'الشهور', icon: 'calendar-days', items: [['months.read','عرض الشهور'],['months.write','إدارة الشهور'],['months.destructive','إفراغ أو حذف شهر']] },
    { label: 'التقارير', icon: 'file-text', items: [['reports.read','عرض التقارير'],['reports.calculate','حساب التقرير'],['reports.export','تصدير التقرير'],['reports.approve','اعتماد التقرير']] },
    { label: 'المالية', icon: 'wallet-cards', items: [['transactions.read','عرض السلف والتسويات'],['transactions.write','إدارة السلف والتسويات'],['settlements.read','عرض التسويات النهائية'],['settlements.write','إدارة التسويات النهائية']] },
    { label: 'النسخ والأرشيف', icon: 'archive', items: [['backups.read','عرض النسخ الاحتياطية'],['backups.create','إنشاء نسخة احتياطية'],['backups.download','تنزيل نسخة احتياطية'],['backups.restore','استعادة نسخة احتياطية'],['archive.read','عرض الأرشيف'],['comparison.read','مقارنة الشهور']] },
    { label: 'الإدارة', icon: 'settings', items: [['audit.read','عرض سجل العمليات'],['settings.read','عرض الإعدادات'],['settings.write','إدارة الإعدادات'],['users.manage','إدارة المستخدمين والصلاحيات']] }
  ];
  function statusLabel(status) { return ({active:'نشط', suspended:'موقوف مؤقتًا', pending:'بانتظار التفعيل', disabled:'معطّل'})[status] || status; }
  function setTableState(message, className = 'empty-cell') {
    const body = document.getElementById('usersTableBody');
    if (body) body.innerHTML = `<tr><td colspan="8" class="${className}">${Utils.escapeHtml(message)}</td></tr>`;
  }
  function bind() {
    if (initialized) return;
    initialized = true;
    document.getElementById('usersTableBody').addEventListener('click', event => onAction(event).catch(showActionError));
    document.getElementById('usersSearch').addEventListener('input', e => { search = e.target.value.toLowerCase(); render(); });
    document.getElementById('usersStatusFilter').addEventListener('change', e => { statusFilter = e.target.value; render(); });
    document.getElementById('refreshUsersBtn').addEventListener('click', () => refresh().catch(showActionError));
    document.getElementById('userEditorCancelBtn').addEventListener('click', close);
    document.getElementById('copyPermissionsBtn').addEventListener('click', copyPermissions);
    document.getElementById('userEditorForm').addEventListener('submit', event => save(event).catch(showActionError));
  }
  function showActionError(error) { Toast.show('تعذر تحميل أو تحديث المستخدمين: ' + error.message, 'error'); }
  async function init() {
    if (!Permissions.can('users.manage')) return;
    bind();
    await refresh();
  }
  async function refresh() {
    Permissions.require('users.manage');
    setTableState('جارٍ تحميل المستخدمين…');
    try {
      const snap = await db.collection(COLLECTIONS.USERS).orderBy('email').get();
      users = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      render();
    } catch (error) {
      // Keep the management page alive and leave the refresh control bound;
      // a transient Firestore failure must be recoverable from this screen.
      setTableState('تعذر تحميل المستخدمين. استخدم زر «تحديث» لإعادة المحاولة.');
      throw error;
    }
  }
  function render() {
    const body = document.getElementById('usersTableBody'); if (!body) return;
    const shown = users.filter(u => (!search || String(u.email || u.id).toLowerCase().includes(search)) && (statusFilter === 'all' || (u.status || 'active') === statusFilter));
    body.innerHTML = shown.map(u => `<tr><td>${Utils.escapeHtml(u.email || u.id)}</td><td>${Utils.escapeHtml(Permissions.roleDefinition(Permissions.profileRole(u)).label)}</td><td><span class="badge">${Utils.escapeHtml(statusLabel(u.status || 'active'))}</span></td><td>${Utils.formatDateTime(u.lastLoginAt) || '—'}</td><td>${Utils.formatDateTime(u.lastActivityAt) || '—'}</td><td>${Utils.formatNumber(u.activeSessions || 0)}</td><td>${(u.permissions || Permissions.effective(Permissions.profileRole(u), u.permissionOverrides)).length}</td><td><button class="btn btn-sm" data-user-id="${u.id}">تعديل</button><button class="btn btn-sm" data-reset-user="${u.id}">Reset Password</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty-cell">لا توجد حسابات.</td></tr>';
  }
  async function onAction(e) { const reset=e.target.closest('[data-reset-user]'); if(reset){const u=users.find(x=>x.id===reset.dataset.resetUser);if(!u?.email)return Toast.show('البريد الإلكتروني غير متاح','error');await auth.sendPasswordResetEmail(u.email);await AuditService.log('auth.password_reset_requested',{entity:'users',operation:AuditService.OPERATION.UPDATE,documentId:u.id,documentLabel:u.email,details:{event:'password_reset_requested'}});return Toast.show('تم إرسال رابط إعادة تعيين كلمة المرور','success');} const btn=e.target.closest('[data-user-id]'); if (btn) open(btn.dataset.userId); }
  function open(id) {
    const u=users.find(x=>x.id===id); if (!u) return;
    document.getElementById('userEditorId').value=id;
    document.getElementById('userEditorEmail').textContent=u.email || id;
    const roleSelect = document.getElementById('userRoleSelect');
    roleSelect.innerHTML = Permissions.roleOptions().map(role => `<option value="${Utils.escapeHtml(role.id)}">${Utils.escapeHtml(role.label)}${role.custom ? ' (Custom)' : ''}</option>`).join('');
    roleSelect.value=Permissions.profileRole(u);
    document.getElementById('userStatusSelect').value=u.status || 'active';
    document.getElementById('userAllowInput').value=(u.permissionOverrides?.allow || []).join(', ');
    document.getElementById('userDenyInput').value=(u.permissionOverrides?.deny || []).join(', ');
    renderCopyUsers(u.id);
    renderPermissionGroups(u);
    document.getElementById('userEditorModal').classList.add('open');
  }
  function close() { document.getElementById('userEditorModal').classList.remove('open'); }
  function split(value) { return [...new Set(String(value || '').split(',').map(x=>x.trim()).filter(Boolean))]; }
  function permissionName(key) {
    for (const group of PERMISSION_GROUPS) { const found = group.items.find(([id]) => id === key); if (found) return found[1]; }
    return key;
  }
  function renderCopyUsers(currentId) {
    const select = document.getElementById('copyPermissionsFrom');
    select.value = '';
    select.innerHTML = '<option value="">اختر مستخدمًا…</option>' + users.filter(u => u.id !== currentId).map(u => `<option value="${Utils.escapeHtml(u.id)}">${Utils.escapeHtml(u.email || u.id)}</option>`).join('');
  }
  function copyPermissions() {
    const source = users.find(u => u.id === document.getElementById('copyPermissionsFrom').value);
    if (!source) { Toast.show('اختر مستخدمًا لنسخ صلاحياته أولًا.', 'error'); return; }
    const overrides = source.permissionOverrides || { allow: [], deny: [] };
    document.getElementById('userAllowInput').value = (overrides.allow || []).join(', ');
    document.getElementById('userDenyInput').value = (overrides.deny || []).join(', ');
    renderPermissionGroups({ permissionOverrides: overrides });
    Toast.show(`تم نسخ الصلاحيات المخصصة من ${source.email || 'المستخدم المحدد'}.`, 'success');
  }
  function renderPermissionGroups(u) {
    const allow = new Set(u.permissionOverrides?.allow || []), deny = new Set(u.permissionOverrides?.deny || []);
    document.getElementById('permissionGroups').innerHTML = PERMISSION_GROUPS.map(group => `<section class="permission-group-card"><h4><i data-lucide="${group.icon}" aria-hidden="true"></i>${group.label}</h4>${group.items.map(([id,label]) => `<label><span>${label}</span><select data-permission="${id}" aria-label="${label}"><option value="default">افتراضي</option><option value="allow" ${allow.has(id) ? 'selected' : ''}>منح</option><option value="deny" ${deny.has(id) ? 'selected' : ''}>سحب</option></select></label>`).join('')}</section>`).join('');
    if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  }
  async function save(e) {
    e.preventDefault(); Permissions.require('users.manage');
    const id=document.getElementById('userEditorId').value, role=document.getElementById('userRoleSelect').value;
    if (!Permissions.roleDefinition(role) || role === 'pending') throw new Error('اختر دورًا صالحًا.');
    const status=document.getElementById('userStatusSelect').value;
    const permissionOverrides={ allow:split(document.getElementById('userAllowInput').value), deny:split(document.getElementById('userDenyInput').value) };
    document.querySelectorAll('#permissionGroups select[data-permission]').forEach(select => {
      if (select.value === 'allow') permissionOverrides.allow.push(select.dataset.permission);
      if (select.value === 'deny') permissionOverrides.deny.push(select.dataset.permission);
    });
    permissionOverrides.allow = [...new Set(permissionOverrides.allow)].filter(p => !permissionOverrides.deny.includes(p));
    permissionOverrides.deny = [...new Set(permissionOverrides.deny)];
    const existing = users.find(u => u.id === id) || {};
    const beforeEffective = Permissions.effective(Permissions.profileRole(existing), existing.permissionOverrides || {});
    const afterEffective = Permissions.effective(role, permissionOverrides);
    const addedPermissions = afterEffective.filter(p => !beforeEffective.includes(p));
    const removedPermissions = beforeEffective.filter(p => !afterEffective.includes(p));
    // `assignedRoleId` is the canonical role reference. Keep `role` for old
    // accounts and Firestore bootstrap compatibility; custom roles never
    // masquerade as admin and are authorised through their stored list.
    const payload = { role, assignedRoleId: role, systemRole: role === 'super_admin' ? 'super_admin' : null, status, permissionOverrides, permissions: afterEffective, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    const batch = db.batch();
    batch.update(db.collection(COLLECTIONS.USERS).doc(id), payload);
    if (addedPermissions.length || removedPermissions.length) {
      AuditService.appendToBatch(batch, {
        action: 'USER_PERMISSIONS_UPDATED', entity: 'users', operation: AuditService.OPERATION.UPDATE,
        documentId: id, documentLabel: existing.email || id,
        before: { permissionOverrides: existing.permissionOverrides || {}, permissions: beforeEffective },
        after: { permissionOverrides, permissions: afterEffective }, changed: ['permissionOverrides', 'permissions'],
        details: { targetUser: existing.email || id, addedPermissions, removedPermissions, addedPermissionNames: addedPermissions.map(permissionName), removedPermissionNames: removedPermissions.map(permissionName) }
      });
    }
    await batch.commit();
    close(); await refresh(); Toast.show('تم حفظ دور وصلاحيات المستخدم.', 'success');
  }
  return { init, refresh };
})();
