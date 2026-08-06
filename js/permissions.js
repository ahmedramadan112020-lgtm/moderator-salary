/* Roles + Permissions ---------------------------------------------------
 * Built-in roles are immutable compatibility templates. Custom roles live in
 * Firestore and every assigned account stores its resolved `permissions`
 * array, so client checks and Firestore Rules evaluate the same access list.
 */
'use strict';

const Permissions = (() => {
  const ROLES = {
    owner: { label: 'Owner', permissions: ['*'], system: true },
    super_admin: { label: 'Owner', permissions: ['*'], system: true },
    admin: { label: 'Admin', permissions: [
      'dashboard.read','departments.read','departments.write','employees.read','employees.write','employees.delete',
      'orders.read','orders.write','orders.import','months.read','months.write','months.destructive',
      'reports.read','reports.calculate','reports.export','reports.approve','transactions.read','transactions.write',
      'salary_processing.read','salary_processing.write','salary_processing.approve','salary_processing.pay','salary_processing.export',
      'settlements.read','settlements.write','backups.read','backups.create','backups.restore','backups.download',
      'archive.read','comparison.read','audit.read','settings.read','settings.write'
    ] },
    accountant: { label: 'Accountant', permissions: [
      'dashboard.read','employees.read','departments.read','orders.read','months.read','reports.read','reports.calculate','reports.export',
      'salary_processing.read','salary_processing.write','salary_processing.export','transactions.read','transactions.write','settlements.read','backups.read','backups.download','archive.read','comparison.read','audit.read'
    ] },
    hr: { label: 'HR', permissions: ['dashboard.read','departments.read','departments.write','employees.read','employees.write','orders.read','months.read','reports.read'] },
    viewer: { label: 'Viewer', permissions: ['dashboard.read','months.read','reports.read','archive.read','comparison.read'] },
    sales_manager: { label: 'Sales Manager', permissions: ['dashboard.read','orders.read','orders.import','reports.read','reports.export'] },
    supervisor: { label: 'Supervisor', permissions: ['dashboard.read','employees.read','orders.read','reports.read'] },
    shipping: { label: 'Shipping', permissions: ['dashboard.read','orders.read','orders.write'] },
    data_entry: { label: 'Data Entry', permissions: ['dashboard.read','orders.read','orders.import'] },
    pending: { label: 'Pending', permissions: [] }
  };
  const VALID_STATUSES = ['active', 'suspended', 'pending', 'disabled'];
  let profile = null;
  let customRoles = new Map();

  function normalizeRole(role) { return ROLES[role] || customRoles.get(role) || null; }
  function profileRole(value = profile) { return (value && (value.assignedRoleId || value.systemRole || value.role)) || 'pending'; }
  function roleDefinition(role) { return ROLES[role] || customRoles.get(role) || ROLES.pending; }
  function effective(role, overrides = {}) {
    const base = roleDefinition(role).permissions || [];
    if (base.includes('*')) return ['*'];
    const set = new Set(base);
    (overrides.allow || []).forEach(p => set.add(p));
    (overrides.deny || []).forEach(p => set.delete(p));
    return [...set].sort();
  }
  function setProfile(value) { profile = value || {}; }
  function isActive() { return profile && (profile.status || 'active') === 'active'; }
  function can(permission) {
    if (!isActive()) return false;
    const list = Array.isArray(profile.permissions) ? profile.permissions : effective(profileRole(), profile.permissionOverrides || {});
    return list.includes('*') || list.includes(permission);
  }
  function require(permission) { if (!can(permission)) throw new Error('ليس لديك صلاحية تنفيذ هذه العملية.'); }
  function roleOptions() { return [...Object.entries(ROLES).filter(([id]) => id !== 'pending').map(([id, role]) => ({ id, ...role })), ...[...customRoles.values()].map(role => ({ ...role, custom: true }))]; }
  function customRoleOptions() { return [...customRoles.values()].map(role => ({ ...role, custom: true })); }
  async function loadCustomRoles() {
    // `roles` is an optional collection. Firestore returns an empty snapshot
    // for a new project where it has never existed, and the immutable
    // built-in templates below remain the complete role catalogue in that
    // state. A failed optional read must have the same safe fallback: never
    // keep stale custom roles and never block authentication or built-ins.
    customRoles = new Map();
    if (!db || !COLLECTIONS.ROLES) return [];
    try {
      const snap = await db.collection(COLLECTIONS.ROLES).orderBy('name').get();
      customRoles = new Map(snap.docs.map(doc => {
        const data = doc.data() || {};
        return [doc.id, { id: doc.id, label: data.name || doc.id, name: data.name || doc.id, description: data.description || '', permissions: Array.isArray(data.permissions) ? data.permissions : [] }];
      }));
    } catch (error) {
      // This is recoverable: RoleMatrix can still render every built-in role
      // and the client authorization model does not depend on this query.
      console.warn('Custom roles could not be loaded; using built-in roles only:', error.message);
    }
    return customRoleOptions();
  }
  function applyUI() {
    const views = { dashboard:'dashboard.read', departments:'departments.read', moderators:'employees.read', import:'orders.import', orders:'orders.read', months:'months.read', 'month-comparison':'comparison.read', report:'reports.read', transactions:'transactions.read', settlement:'settlements.read', archive:'archive.read', backups:'backups.read', audit:'audit.read', settings:'settings.read', users:'users.manage' };
    document.querySelectorAll('.nav-item[data-view]').forEach(el => { el.hidden = !can(views[el.dataset.view] || 'dashboard.read'); });
    document.querySelectorAll('[data-permission]').forEach(el => { const allowed = can(el.dataset.permission); el.disabled = !allowed; el.hidden = el.dataset.permissionMode === 'hide' && !allowed; if (!allowed) el.title = 'ليس لديك صلاحية لهذه العملية'; });
  }
  return { ROLES, VALID_STATUSES, normalizeRole, profileRole, roleDefinition, effective, setProfile, can, require, roleOptions, customRoleOptions, loadCustomRoles, applyUI };
})();
