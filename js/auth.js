/**
 * auth.js
 * -----------------------------------------------------------------------
 * Handles Firebase Authentication (Email & Password):
 *   - Login form submission (login.html)
 *   - Logout
 *   - Auth-state guard for the dashboard (dashboard.html)
 *   - Admin role lookup/creation in the `users` Firestore collection
 * -----------------------------------------------------------------------
 */

'use strict';

const Auth = (() => {
  // `redirectIfLoggedIn()` also observes the sign-in initiated by the form.
  // Keep that observer from navigating away until `login()` has finished
  // loading/creating the Firestore profile that `guardPage()` depends on.
  let loginInProgress = false;

  /**
   * Ensures a `users/{uid}` document exists for the signed-in user.
   *
   * The very first user ever to sign in to a brand-new deployment is
   * automatically promoted to 'admin': they atomically claim the
   * one-time `settings/adminBootstrap` marker in the same batch as their
   * own user doc, so two people signing in for the first time at once
   * can't both become admin (Firestore rules only let the doc through if
   * the marker doesn't already exist - see firebase/firestore.rules).
   *
   * Every user after that is created as 'pending' and must be promoted
   * to 'admin' by an existing admin (editing their `role` field in the
   * Firestore console, or via a future in-app user-management screen).
   * `guardPage()` already blocks any non-'admin' role with a "not
   * authorized" screen, so this is fully backward compatible with
   * existing admin accounts created before this change.
   */
  async function ensureUserDoc(user) {
    const ref = db.collection(COLLECTIONS.USERS).doc(user.uid);
    const snap = await ref.get();
    if (snap.exists) return migrateProfile(user, snap.data());

    const bootstrapRef = db.collection(COLLECTIONS.SETTINGS).doc('adminBootstrap');
    const bootstrapSnap = await bootstrapRef.get();

    if (!bootstrapSnap.exists) {
      try {
        // A transaction (not a plain batch) so that if two people sign in
        // for the very first time at almost the same moment, Firestore's
        // optimistic-concurrency check on the bootstrapRef read guarantees
        // only one of the two transactions can actually commit - the
        // loser throws and falls through to the 'pending' path below,
        // rather than both racing batches possibly both succeeding.
        await db.runTransaction(async (tx) => {
          const freshBootstrap = await tx.get(bootstrapRef);
          if (freshBootstrap.exists) throw new Error('adminBootstrap already claimed');
          tx.set(ref, {
            email: user.email,
            // Keep the physical role as `admin`: deployments with the prior
            // ruleset still accept it. `systemRole` carries the new logical
            // role used by the central permission service.
            role: 'admin', systemRole: 'super_admin',
            status: 'active',
            permissionOverrides: { allow: [], deny: [] },
            permissions: ['*'],
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          tx.set(bootstrapRef, {
            claimedBy: user.uid,
            claimedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        });
        return { email: user.email, role: 'admin', systemRole: 'super_admin', status: 'active', permissions: ['*'] };
      } catch (err) {
        // Lost the race to another concurrent first sign-in (or rules
        // denied it because the marker was claimed a moment ago) - fall
        // through to the regular 'pending' path below.
        console.warn('Admin bootstrap claim failed, falling back to pending:', err.message);
      }
    }

    const pendingProfile = {
      email: user.email,
      role: 'pending', status: 'pending', permissionOverrides: { allow: [], deny: [] }, permissions: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await ref.set(pendingProfile);
    return pendingProfile;
  }

  async function migrateProfile(user, profile) {
    const next = { ...profile };
    const bootstrap = await db.collection(COLLECTIONS.SETTINGS).doc('adminBootstrap').get();
    const isBootstrapUser = bootstrap.exists && bootstrap.data().claimedBy === user.uid;
    // Revert the physical role to admin for compatibility with already
    // deployed rules, while preserving Super Admin capability explicitly.
    if (isBootstrapUser) { next.role = 'admin'; next.systemRole = 'super_admin'; }
    if (!next.status) next.status = 'active';
    if (!next.permissionOverrides) next.permissionOverrides = { allow: [], deny: [] };
    if (!Array.isArray(next.permissions) && typeof Permissions !== 'undefined') next.permissions = Permissions.effective(next.systemRole || next.role, next.permissionOverrides);
    const changed = next.role !== profile.role || next.systemRole !== profile.systemRole || next.status !== profile.status || !profile.permissionOverrides || !Array.isArray(profile.permissions);
    if (changed) await db.collection(COLLECTIONS.USERS).doc(user.uid).update({ role: next.role, systemRole: next.systemRole || null, status: next.status, permissionOverrides: next.permissionOverrides, permissions: next.permissions, migratedAt: firebase.firestore.FieldValue.serverTimestamp() });
    return next;
  }

  /**
   * Signs a user in with email/password. Throws on failure with a
   * human-readable Arabic message for display in the login form.
   */
  async function login(email, password) {
    loginInProgress = true;
    try {
      const cred = await auth.signInWithEmailAndPassword(email, password);
      const profile = await ensureUserDoc(cred.user);
      if ((profile.status || 'active') !== 'active') { await auth.signOut(); throw new Error('تم تعطيل هذا الحساب أو إيقافه'); }
      await db.collection(COLLECTIONS.USERS).doc(cred.user.uid).set({ lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(), lastActivityAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
      if (typeof AuditService !== 'undefined') await AuditService.log('auth.login', { entity:'users', operation:AuditService.OPERATION.UPDATE, documentId:cred.user.uid, documentLabel:cred.user.email || cred.user.uid, details:{ event:'login' } });
      return cred.user;
    } catch (err) {
      if (typeof AuditService !== 'undefined') AuditService.log('auth.login_failed', { entity:'auth', operation:AuditService.OPERATION.UPDATE, documentLabel:email || 'unknown', severity:AuditService.SEVERITY.WARNING, details:{ event:'login_failed', code:err.code || 'unknown' } }).catch(()=>{});
      throw new Error(mapAuthError(err.code));
    } finally {
      loginInProgress = false;
    }
  }

  async function logout() {
    if (auth.currentUser && typeof AuditService !== 'undefined') await AuditService.log('auth.logout', { entity:'users', operation:AuditService.OPERATION.UPDATE, documentId:auth.currentUser.uid, documentLabel:auth.currentUser.email || auth.currentUser.uid, details:{ event:'logout' } });
    await auth.signOut();
    window.location.href = 'login.html';
  }

  function mapAuthError(code) {
    const map = {
      'auth/invalid-email': 'صيغة البريد الإلكتروني غير صحيحة',
      'auth/user-disabled': 'تم تعطيل هذا الحساب',
      'auth/user-not-found': 'لا يوجد حساب بهذا البريد الإلكتروني',
      'auth/wrong-password': 'كلمة المرور غير صحيحة',
      'auth/invalid-credential': 'بيانات الدخول غير صحيحة',
      'auth/too-many-requests': 'محاولات كثيرة جدًا، حاول لاحقًا',
      'auth/network-request-failed': 'تعذر الاتصال بالخادم، تحقق من الإنترنت'
    };
    return map[code] || 'حدث خطأ أثناء تسجيل الدخول، حاول مرة أخرى';
  }

  /**
   * Guards a protected page: redirects to login.html if not authenticated,
   * and calls back with the user + role once confirmed. Use at the top of
   * dashboard.html's bootstrap logic.
   */
  function guardPage(onReady) {
    auth.onAuthStateChanged(async (user) => {
      if (!user) {
        window.location.href = 'login.html';
        return;
      }
      try {
        const profile = await ensureUserDoc(user);
        await db.collection(COLLECTIONS.USERS).doc(user.uid).set({ lastActivityAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
        Permissions.setProfile(profile);
        if ((profile.status || 'active') !== 'active' || !Permissions.can('dashboard.read')) {
          document.body.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:center;height:100vh;
                        color:#e8eaed;background:#0f1115;font-family:'Cairo',sans-serif;text-align:center;">
              <div>
                <h2>غير مصرح لك بالدخول</h2>
                <p>حسابك غير مفعل كمسؤول. تواصل مع مسؤول النظام.</p>
                <button onclick="Auth.logout()" style="margin-top:16px;padding:10px 20px;border:none;
                        border-radius:8px;background:#3d5afe;color:#fff;cursor:pointer;">تسجيل الخروج</button>
              </div>
            </div>`;
          return;
        }
        onReady(user, profile);
      } catch (err) {
        console.error('Auth guard error:', err);
      }
    });
  }

  /**
   * Redirects away from login.html if the user is already authenticated.
   */
  function redirectIfLoggedIn() {
    auth.onAuthStateChanged((user) => {
      // On an explicit sign-in, the submit handler redirects only after
      // `login()` has resolved. Redirecting here earlier races the profile
      // read and leaves the dashboard bootstrap waiting for it.
      if (user && !loginInProgress) window.location.href = 'dashboard.html';
    });
  }

  return { login, logout, guardPage, redirectIfLoggedIn };
})();
