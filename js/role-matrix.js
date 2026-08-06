'use strict';

/* Custom roles are definitions, never an alternative authorization path.
 * On every create/edit, their resolved permissions are copied to assigned
 * user profiles. Firestore Rules then enforce that same stored list. */
const RoleMatrix = (() => {
  let editingId = null;
  const permissions = () => [...new Set(Object.values(Permissions.ROLES).flatMap(role => role.permissions).filter(p => p !== '*'))].sort();
  const esc = value => Utils.escapeHtml(String(value || ''));

  function mount() {
    const form = document.getElementById('settingsForm'); if (!form) return null;
    let panel = document.querySelector('[data-config-content="roles"]');
    if (!panel) { panel = document.createElement('div'); panel.className = 'config-panel'; panel.dataset.configContent = 'roles'; form.appendChild(panel); }
    if (!panel.querySelector('#rolesMatrixMount')) panel.innerHTML = '<div id="rolesMatrixMount"></div>';
    return panel.querySelector('#rolesMatrixMount');
  }
  function roleCard(role) {
    const custom = !!role.custom, editable = custom && Permissions.can('roles.manage');
    return `<section class="panel"><div class="panel-header"><div><h3>${esc(role.label)}</h3><p class="panel-subtitle">${esc(role.description || (custom ? 'دور مخصص' : 'دور نظام متوافق مع الحسابات القديمة'))}</p></div><div>${custom ? `<button class="btn btn-sm" data-role-edit="${esc(role.id)}">تعديل</button><button class="btn btn-sm" data-role-clone="${esc(role.id)}">نسخ</button><button class="btn btn-sm" data-role-delete="${esc(role.id)}">حذف</button>` : `<button class="btn btn-sm" data-role-clone="${esc(role.id)}">نسخ كدور جديد</button>`}</div></div><div class="permission-groups">${permissions().map(key => `<label class="permission-group-card"><span>${esc(key)}</span><input type="checkbox" disabled ${role.permissions.includes('*') || role.permissions.includes(key) ? 'checked' : ''}></label>`).join('')}</div>${editable ? '' : '<p class="muted">صلاحيات الدور المعروضة للقراءة.</p>'}</section>`;
  }
  function render() {
    const target = mount(); if (!target) return;
    const manageable = Permissions.can('roles.manage');
    target.innerHTML = `<div class="panel-header"><div><h3>Roles & Permissions</h3><p class="panel-subtitle">الأدوار المخصصة تُطبق على الحسابات وقواعد Firestore عبر قائمة الصلاحيات المحفوظة.</p></div>${manageable ? '<button class="btn btn-accent" id="roleCreateBtn" type="button">إنشاء دور</button>' : ''}</div><div class="roles-matrix">${Permissions.roleOptions().map(roleCard).join('')}</div>`;
    target.querySelector('#roleCreateBtn')?.addEventListener('click', () => openEditor());
    target.querySelectorAll('[data-role-edit]').forEach(button => button.addEventListener('click', () => openEditor(button.dataset.roleEdit)));
    target.querySelectorAll('[data-role-clone]').forEach(button => button.addEventListener('click', () => openEditor(button.dataset.roleClone, true)));
    target.querySelectorAll('[data-role-delete]').forEach(button => button.addEventListener('click', () => remove(button.dataset.roleDelete)));
  }
  function openEditor(id = null, clone = false) {
    Permissions.require('roles.manage');
    const source = Permissions.roleOptions().find(role => role.id === id);
    editingId = clone ? null : id;
    const name = clone ? `${source?.label || 'New role'} copy` : (source?.label || '');
    const description = clone ? source?.description || '' : source?.description || '';
    const allowed = new Set(source?.permissions || []);
    const target = mount();
    target.innerHTML = `<section class="panel"><div class="panel-header"><h3>${editingId ? 'تعديل الدور' : 'إنشاء دور'}</h3></div><div class="form-grid"><div class="field"><label for="roleNameInput">اسم الدور</label><input id="roleNameInput" required value="${esc(name)}"></div><div class="field"><label for="roleDescriptionInput">الوصف</label><input id="roleDescriptionInput" value="${esc(description)}"></div></div><div class="permission-groups">${permissions().map(key => `<label class="permission-group-card"><span>${esc(key)}</span><input type="checkbox" data-role-permission="${esc(key)}" ${allowed.has(key) ? 'checked' : ''}></label>`).join('')}</div><div class="wizard-actions"><button class="btn" type="button" id="roleCancelBtn">إلغاء</button><button class="btn btn-accent" type="button" id="roleSaveBtn">حفظ الدور</button></div></section>`;
    target.querySelector('#roleCancelBtn').addEventListener('click', render);
    target.querySelector('#roleSaveBtn').addEventListener('click', save);
  }
  async function save() {
    Permissions.require('roles.manage');
    const name = document.getElementById('roleNameInput').value.trim();
    const description = document.getElementById('roleDescriptionInput').value.trim();
    const selected = [...document.querySelectorAll('[data-role-permission]:checked')].map(input => input.dataset.rolePermission).sort();
    if (name.length < 2) throw new Error('اسم الدور يجب أن يحتوي على حرفين على الأقل.');
    if (!selected.length) throw new Error('اختر صلاحية واحدة على الأقل للدور.');
    const roles = db.collection(COLLECTIONS.ROLES), ref = editingId ? roles.doc(editingId) : roles.doc();
    const payload = { name, description, permissions: selected, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: auth.currentUser?.uid || null };
    if (!editingId) { payload.createdAt = firebase.firestore.FieldValue.serverTimestamp(); payload.createdBy = auth.currentUser?.uid || null; }
    const assignedUsers = await db.collection(COLLECTIONS.USERS).where('assignedRoleId', '==', ref.id).get();
    // One Firestore batch is the authorization boundary: role definition and
    // every resolved user permission change commit together. Refuse an
    // oversized migration instead of creating a partial privilege change.
    if (assignedUsers.size > 400) throw new Error('هذا الدور مرتبط بعدد كبير من الحسابات. قسّم الترحيل إلى دفعات آمنة أولاً.');
    const batch = db.batch();
    batch.set(ref, payload, { merge: !!editingId });
    assignedUsers.docs.forEach(doc => {
      const user = doc.data(), overrides = user.permissionOverrides || { allow: [], deny: [] };
      const set = new Set(selected); (overrides.allow || []).forEach(p => set.add(p)); (overrides.deny || []).forEach(p => set.delete(p));
      batch.update(doc.ref, { permissions: [...set].sort(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    await batch.commit();
    await AuditService.log(editingId ? 'roles.updated' : 'roles.created', { entity: 'roles', operation: editingId ? AuditService.OPERATION.UPDATE : AuditService.OPERATION.CREATE, documentId: ref.id, documentLabel: name, details: { permissions: selected, assignedUsersUpdated: true } });
    await Permissions.loadCustomRoles(); render(); Toast.show('تم حفظ الدور وتطبيق صلاحياته على الحسابات المرتبطة.', 'success');
  }
  async function remove(id) {
    Permissions.require('roles.manage');
    const assigned = await db.collection(COLLECTIONS.USERS).where('assignedRoleId', '==', id).limit(1).get();
    if (!assigned.empty) throw new Error('لا يمكن حذف دور مرتبط بحسابات. انقل الحسابات إلى دور آخر أولاً.');
    const role = Permissions.customRoleOptions().find(item => item.id === id);
    if (!confirm(`حذف الدور ${role?.label || ''}؟`)) return;
    await db.collection(COLLECTIONS.ROLES).doc(id).delete();
    await AuditService.log('roles.deleted', { entity: 'roles', operation: AuditService.OPERATION.DELETE, documentId: id, documentLabel: role?.label || id });
    await Permissions.loadCustomRoles(); render(); Toast.show('تم حذف الدور.', 'success');
  }
  async function init() {
    mount();
    if (!Permissions.can('roles.manage')) return render();
    // Custom roles are optional. `loadCustomRoles()` deliberately degrades to
    // an empty list on a new project or recoverable read failure, leaving the
    // built-in matrix fully usable without an alarming toast.
    await Permissions.loadCustomRoles();
    render();
  }
  return { init, render };
})();
