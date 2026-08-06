/**
 * firebase.js
 * -----------------------------------------------------------------------
 * Central Firebase initialization. This file loads the Firebase SDK
 * (via CDN, using the "compat" build so it can be included with plain
 * <script> tags and requires no bundler/build step — important for a
 * project that must run directly on GitHub Pages).
 *
 * IMPORTANT: Replace the values in `firebaseConfig` below with your own
 * project's credentials. See README.md -> "Firebase Setup" for the
 * step-by-step guide on where to find these values in the Firebase
 * console.
 * -----------------------------------------------------------------------
 */

'use strict';

// -----------------------------------------------------------------------
// 1) Your Firebase project configuration.
//    Firebase Console -> Project Settings -> General -> Your apps -> Web app
// -----------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyBt_5dwDBgyiHAj5OsnAA1fwHXQ2sd3-tk",
  authDomain: "moderator-salary9.firebaseapp.com",
  projectId: "moderator-salary9",
  storageBucket: "moderator-salary9.firebasestorage.app",
  messagingSenderId: "604946335764",
  appId: "1:604946335764:web:2b8b640d8af215c59abf01"
};

// -----------------------------------------------------------------------
// 2) Initialize Firebase (compat SDK loaded from CDN in the HTML files)
// -----------------------------------------------------------------------
firebase.initializeApp(firebaseConfig);

// Shared references used across the whole application
const auth = firebase.auth();
const db = firebase.firestore();

// Use Firestore's default in-memory cache. The optional multi-tab IndexedDB
// persistence path could hold a newly opened dashboard before its first live
// reads completed, leaving the active month and every Firestore-backed view
// empty. No application data or workflow depends on offline persistence.

// Firestore collection name constants, kept in one place to avoid typos
// scattered across the codebase.
//
// EMPLOYEES vs MODERATORS
// -----------------------
// The app grew from a moderators-only tool into a company-wide payroll
// system, so "moderator" became "employee" throughout the UI and the code.
// The PHYSICAL Firestore collection deliberately stays `moderators`:
//
//   * every existing deployment already has live data in it,
//   * advances/adjustments and every historical monthly_report row
//     reference those exact document ids (`moderatorId`),
//   * copying documents into a differently-named collection would risk a
//     partially-migrated database and buys nothing functionally.
//
// So EMPLOYEES is the name the code uses from now on, MODERATORS is kept
// as a legacy alias pointing at the same collection. Renaming the
// collection is therefore a zero-data-loss no-op that never has to happen.
const COLLECTIONS = {
  USERS: 'users',
  ROLES: 'roles',
  SALARY_PROCESSING: 'salary_processing',
  EMPLOYEES: 'moderators',
  MODERATORS: 'moderators',   // legacy alias - same collection as EMPLOYEES
  DEPARTMENTS: 'departments',
  MONTHLY_REPORTS: 'monthly_reports',
  SETTINGS: 'settings',
  ADVANCES: 'advances',
  ADJUSTMENTS: 'adjustments',

  // ---- Month lifecycle (Active Month / close-month) ----
  //
  // MONTHLY_SUMMARIES is a deliberately SMALL, flat index document per
  // month: status, label, totals and the per-department summary - and
  // never the per-employee report rows. It exists because the Months
  // page, the Archive page and the month dropdown all need to list every
  // month at once, and reading `monthly_reports` for that would download
  // every historical report row on every page load (Firestore has no
  // projection/"select only these fields" query).
  //
  // It is also the document the reporting features planned for later
  // phases read from, which is why it is written at close time.
  MONTHLY_SUMMARIES: 'monthly_summaries',

  // Append-only trail of significant admin actions (closing a month,
  // creating a snapshot/backup...). Never edited, never deleted - see
  // firebase/firestore.rules.
  //
  // Every write in the app funnels through DataLayer, which puts the
  // business write and its audit entry in ONE batch - so an action that
  // committed without being logged is not something the code can express.
  AUDIT_LOGS: 'audit_logs',

  // ---- System-wide backups (BackupService) ----
  //
  // Distinct from the per-month `backups` SUBCOLLECTION written when a month
  // closes (MONTH_SUBCOLLECTIONS.BACKUPS). That one freezes the inputs of
  // one specific month and lives under it forever. THIS one is a restorable
  // point-in-time copy of the whole live database - employees, departments,
  // advances, adjustments, settings - taken automatically before anything
  // destructive and manually on demand.
  //
  // Each document here is a small MANIFEST (name, reason, type, counts,
  // approximate size, who and when). The actual rows live in the `chunks`
  // subcollection beneath it, because a company's full employee list plus
  // every advance would blow past Firestore's 1 MB document limit.
  BACKUPS: 'backups',

  // Final settlements (مخالصة نهاية الخدمة). One document per approved
  // settlement, keyed by an auto id and carrying a full breakdown snapshot
  // of how the figure was reached.
  //
  // A settlement is a permanent financial record: once approved it is never
  // edited or deleted. Re-hiring the same person later creates no conflict
  // because the settlement is keyed independently of the employee's status.
  SETTLEMENTS: 'settlements'
};

/**
 * Subcollection names hanging off a `monthly_reports/{monthId}` document.
 * Kept here beside COLLECTIONS so no string literal is ever retyped.
 *
 * ORDER_BATCHES already existed (the raw imported orders, written in
 * chunks of 500 by the import pipeline). SNAPSHOTS and BACKUPS are added
 * by the month-closing flow:
 *
 *   SNAPSHOTS - the frozen OUTPUT of the month: report rows, totals and
 *               department totals, plus the bonus tables it was
 *               calculated with. One document per close.
 *   BACKUPS   - the frozen INPUT of the month: employees, advances,
 *               adjustments, departments and settings as they were at
 *               closing time, split across chunk documents so a large
 *               company can never hit Firestore's 1 MB document limit.
 */
const MONTH_SUBCOLLECTIONS = {
  ORDER_BATCHES: 'orderBatches',
  SNAPSHOTS: 'snapshots',
  BACKUPS: 'backups'
};

/**
 * Subcollection names hanging off a `backups/{backupId}` document.
 *
 * A backup manifest is deliberately tiny so the Backups page can list every
 * backup in one cheap read. The rows themselves are split into CHUNKS
 * beneath it - one document per collection per 300 rows - for the same
 * reason the month backup is chunked: Firestore caps a document at 1 MB and
 * a backup that silently stops working once the company grows is worse than
 * no backup at all.
 */
const BACKUP_SUBCOLLECTIONS = {
  CHUNKS: 'chunks'
};
