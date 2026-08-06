# نظام إدارة رواتب وبونص المشرفين | Moderator Salary & Bonus Management System

A production-ready, Arabic-interface web application for calculating moderator
fixed salaries, per-order bonuses, final salaries, and monthly sales/order
statistics — with unlimited monthly history stored in Firebase Firestore.

No build step, no framework, no bundler: plain HTML/CSS/JavaScript that runs
directly on GitHub Pages (or any static host) and talks to Firebase for auth
and data storage.

Current stable release: **7.0.10-uat-dashboard**. See [CHANGELOG.md](CHANGELOG.md)
for the production stabilization record and intentionally deferred server-side
capabilities.

---

## Table of Contents

1. [Features](#features)
2. [Project Structure](#project-structure)
3. [Firebase Setup](#firebase-setup)
4. [Firestore Configuration](#firestore-configuration)
5. [Authentication Setup](#authentication-setup)
6. [Updating Firebase Keys](#updating-firebase-keys)
7. [Running Locally](#running-locally)
8. [GitHub Pages Deployment](#github-pages-deployment)
9. [Production Deployment Checklist](#production-deployment-checklist)
10. [How the Bonus Calculation Works](#how-the-bonus-calculation-works)
11. [Month Lifecycle (Active Month System)](#month-lifecycle-active-month-system)
12. [Data Model](#data-model)
13. [Troubleshooting](#troubleshooting)

---

## Features

- 🔐 Email/Password authentication (Firebase Auth), admin-only dashboard access
- 👥 Full moderator CRUD (name, fixed salary) stored in Firestore
- 📥 Two import methods: paste text (tab/space separated) **or** upload an Excel file
- 🧹 Automatic name cleaning + fuzzy matching (Levenshtein distance) merges
  typo'd name variants into the same moderator, with full Arabic support
- 🎁 Per-order bonus calculation engine following the exact business rule table
- 📊 Permission-aware executive Dashboard, operational widgets, alerts, recent
  activity, and responsive Chart.js visualizations with deterministic empty states
- 🔎 Instant search and column sorting on both the moderators and report tables
- 📄 Export to Excel (SheetJS), export to PDF (jsPDF), copy to clipboard, and
  a dedicated A4 print layout with company name, signatures, and totals
- 🗓️ Unlimited monthly reports — every month is stored independently and never
  overwritten; switch between any past month at any time
- ⚡ Import pipeline batches Firestore writes (500 orders/write) so importing
  100,000+ orders stays fast and stays within Firestore's batch limits
- 🌙 Dark, responsive, RTL Arabic admin UI with toasts, confirmation dialogs,
  and loading indicators
- 🏢 Multi-department support — hourly or fixed-salary departments, each with
  its own bonus ladder
- 📅 **Active Month system** — the app always opens on a single, shared
  "Active Month" stored in Firestore (`settings/system.activeMonthId`), never
  on the device clock. A "شهر العمل" dropdown at the top of every page lets
  you switch to any past (locked, read-only) or upcoming month
- 🔒 **إنهاء الشهر (Close Month)** — one confirmed action that snapshots the
  month's results, backs up its input data, publishes a monthly summary,
  writes an audit-log entry, locks the month against further edits, and
  opens + activates the next month automatically. See
  [Month Lifecycle](#month-lifecycle-active-month-system) below
- 🗄️ **الأرشيف (Archive)** — a dedicated sidebar page listing every locked
  month with its totals (salaries, advances, adjustments, bonus, employee
  count, close date) and a read-only drill-down into any of them
- 💵 **السلف والتسويات (Advances & Adjustments)** — advances and manual
  adjustments live on one combined page with a type filter/tabs, a shared
  table (with a "نوع العملية" column), search, and running totals
- 🤝 End-of-service settlements (مخالصة نهاية الخدمة) for employees who leave
  mid-month, prorated against the same bonus/salary engine as payroll
- 🧾 Append-only Audit Trail for operational, payroll, backup, restore, source,
  and authentication events
- 🛡️ Persisted custom role matrix with resolved permissions enforced in both the
  client and Firestore Rules
- 🗄️ Full and scoped Backup & Restore for orders, payroll snapshots, settings,
  roles, and audit data
- 🔗 Google Sheets and Excel data sources with CSV validation, sync review, and
  source-level audit entries

---

## Project Structure

```
moderator-salary-system/
├── index.html            # Auth-state router (redirects to login/dashboard)
├── login.html             # Login page
├── dashboard.html         # Main single-page dashboard (all views)
├── css/
│   └── style.css          # Full dark-theme stylesheet
├── js/
│   ├── firebase.js        # Firebase init + COLLECTIONS / MONTH_SUBCOLLECTIONS constants
│   ├── auth.js             # Login / logout / auth guard / admin role
│   ├── utils.js            # Name normalization, fuzzy match, bonus rules, parsing
│   ├── service-common.js    # ServiceCommon — shared primitives for the four services below
│   ├── audit.js             # AuditService — mandatory audit trail with severity levels
│   ├── backup.js            # BackupService — restorable backups, compare + restore
│   ├── data-layer.js        # DataLayer — the single audited write path (CRUD + undo)
│   ├── undo.js              # UndoService — 30-second undo window
│   ├── departments.js       # Department CRUD, per-department bonus rules, salary types
│   ├── migration.js         # One-shot, idempotent, auto-run startup migrations
│   ├── charts.js           # Chart.js rendering
│   ├── reports.js          # Excel / PDF / copy / print export logic
│   ├── months.js            # Active Month, close-month lifecycle, archive
│   ├── settlements.js       # End-of-service settlement calculation/approval
│   ├── analytics.js         # AnalyticsService — read-only KPIs/insights from Monthly Summaries
│   └── app.js               # Main app controller (state, CRUD, calculation, UI)
├── firebase/
│   ├── firestore.rules      # Security rules (admin-only access, append-only audit log)
│   └── firestore.indexes.json
├── assets/                 # (place any logo/images here if desired)
├── firebase.json           # Firebase CLI config (rules deployment only)
├── .gitignore
└── README.md
```

> **Script load order matters.** There is no bundler: `dashboard.html` loads
> the files in dependency order (`firebase.js` → `utils.js` →
> `service-common.js` → `audit.js` → `departments.js` → `backup.js` →
> `data-layer.js` → `undo.js` → … → `app.js`). If you add a module, place it
> after everything it dereferences **at load time**.

---

## Audit Log, Backups & Undo

### Audit Log — mandatory by construction

Every create, update and delete goes through `DataLayer`, which puts the
business write **and its audit entry in the same Firestore `WriteBatch`**.
Firestore commits a batch atomically, so an action that changed data without
being logged is not something the code can express.

Each entry records: the user, server timestamp, action, entity, document id and
label, the month it belongs to, the **before/after delta** (only the fields that
actually changed), and a **severity**:

| Severity | Meaning | Examples |
|---|---|---|
| `info` | routine, expected work | adding an advance, editing a name |
| `warning` | reversible but consequential | deleting a record, archiving a department, changing global settings, undo |
| `critical` | irreversible or system-wide | closing a month, approving a settlement, restoring a backup, clearing a month, deleting an employee |

`firestore.rules` denies `update` and `delete` on `audit_logs` outright — to
admins too. Corrections are made by appending, never by rewriting.

**Adding a new collection** to the audit system is one call, no rewrite:

```js
DataLayer.registerCollection('bonuses', {
  collection: 'bonuses', entity: 'bonuses',
  label: 'حافز', labelField: 'employeeName', monthField: 'monthId'
});
```

It immediately gets audit logging with correct severity, month-lock
enforcement, undo support and auto-backup-before-delete.

### Backups

Two different things are called "backup" in this codebase:

- **Per-month backup** (`monthly_reports/{monthId}/backups/*`, written by
  `Months.createBackup`) freezes one month's *inputs* when it closes. It is
  evidence and is never restored.
- **System backup** (top-level `backups` collection, `BackupService`) is a
  restorable point-in-time copy of the live master data — employees,
  departments, advances, adjustments, settings.

Each system backup stores full metadata: name, date/time, user, reason
(trigger), type (automatic/manual/scheduled), collection count, document count
and approximate size. The manifest is written **last**, after its chunks, so an
interrupted backup has no manifest and can never be restored from.

**Automatic backups** are taken before: closing a month, any restore, deleting
an employee, clearing a month's data, approving a final settlement, and
archiving a department. **Manual backups** come from the button on the
النسخ الاحتياطية page.

**Restore** never deletes. It adds what is missing (under the original
document ids, so every reference stays valid), updates what differs, leaves
records created after the backup alone, and skips anything belonging to a
locked month. It shows a full comparison first, requires an explicit
acknowledgement, takes a backup of the current state, and logs the result at
`critical` severity.

> **Scheduled daily backups are deliberately not implemented.** This is a
> static site with no backend, so a "daily" backup would only run when someone
> happened to open the dashboard — which is not a daily backup, and false
> confidence is worse than a known gap. `BackupService.runScheduled()` is the
> ready-made seam: point a scheduled Cloud Function at it and daily backups
> work with no other change.

### Undo (30 seconds)

Adding, editing and deleting any registered record can be undone for 30
seconds via the snackbar. The pending operation is mirrored into
`sessionStorage`, so an accidental refresh doesn't cost the undo; the window is
measured from the original operation, so a refresh cannot extend it.

Only the **most recent** operation is undoable — these operations are not
independent, and undoing something from four actions ago would produce a
database state nobody reasoned about.

**Closing a month, approving a settlement and restoring a backup have no
undo.** That is not an oversight: `firestore.rules` makes a locked month reject
every further write and a settlement create-only, so an undo button for them
would be a lie the database would refuse. Their safety net is the automatic
backup plus the audit trail.

---

## Firebase Setup

1. Go to the [Firebase Console](https://console.firebase.google.com/) and
   click **Add project**. Give it a name (e.g. `moderator-salary-system`)
   and finish the wizard (Google Analytics is optional, not required).
2. Inside your new project, click the **Web** icon (`</>`) to register a new
   web app. Give it a nickname — you do **not** need Firebase Hosting for
   this step since the app will be deployed to GitHub Pages.
3. Firebase will show you a `firebaseConfig` object with keys like `apiKey`,
   `authDomain`, `projectId`, etc. Copy this — you'll paste it into
   `js/firebase.js` (see [Updating Firebase Keys](#updating-firebase-keys)).
4. In the left sidebar, go to **Build → Firestore Database → Create database**.
   - Choose **Production mode** (the security rules provided in
     `firebase/firestore.rules` will handle access control).
   - Pick the Firestore location closest to your users.
5. In the left sidebar, go to **Build → Authentication → Get started**.
   - Under the **Sign-in method** tab, enable **Email/Password**.
   - Under the **Users** tab, click **Add user** and create the first admin
     account (this is the email/password you'll use to log into the app —
     the app automatically grants the very first signed-in user the
     `admin` role, see `js/auth.js`).

---

## Firestore Configuration

Deploy the included security rules so only admin users can read/write data.

### Option A — Firebase CLI (recommended)

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # select your project, give it an alias e.g. "default"
firebase deploy --only firestore:rules
```

### Option B — Manually via the console

1. Go to **Firestore Database → Rules** in the Firebase console.
2. Copy the contents of `firebase/firestore.rules` and paste them in, replacing
   the default rules.
3. Click **Publish**.

The rules require every request to come from a signed-in user whose
`users/{uid}` document has `role: "admin"`. The app creates this document
automatically the first time each user logs in (see `Auth.ensureUserDoc` in
`js/auth.js`); the very first user to ever log in is auto-promoted to admin.

---

## Authentication Setup

Only **Email/Password** sign-in is used (no social login, matching the
brief). To add more staff accounts later:

1. Firebase Console → **Authentication → Users → Add user**.
2. The new user can log in immediately, but only the very first account
   ever to sign in to a deployment is auto-promoted to `role: "admin"`
   (it atomically claims the one-time `settings/adminBootstrap` marker —
   see `js/auth.js` and `firebase/firestore.rules`). Every account after
   that is created with `role: "pending"` and sees a "not authorized"
   screen until an existing admin promotes them.
3. To promote a new staff account: Firebase Console → **Firestore
   Database → users/{their uid}** → change `role` to `admin`.
4. To revoke access, delete the user from **Authentication → Users**, or
   change their `role` field away from `admin` in the `users` Firestore
   collection.

---

## Updating Firebase Keys

Open **`js/firebase.js`** and replace the placeholder values with the config
copied from your Firebase project (Project Settings → General → Your apps):

```js
const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

That's the only file you need to edit to connect the app to your Firebase
project. This is a client-side config (not a secret key) — it's safe to
commit as long as your Firestore security rules are properly deployed.

---

## Running Locally

Because the app uses Firebase Authentication, it must be served over
`http://localhost` or `https://` (opening `index.html` directly via
`file://` will not work correctly with Firebase Auth redirects).

Any static file server works, for example:

```bash
# Python 3
python3 -m http.server 8080

# Node.js (http-server package)
npx http-server -p 8080
```

Then open `http://localhost:8080` in your browser.

> **Tip:** If you want to develop against a local emulator instead of live
> Firebase, install the Firebase Emulator Suite (`firebase init emulators`)
> and point `js/firebase.js` at `auth.useEmulator(...)` /
> `db.useEmulator(...)` during development.

---

## GitHub Pages Deployment

1. Push this project to a GitHub repository.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Select your branch (e.g. `main`) and the root folder (`/`), then **Save**.
5. GitHub will publish the site at `https://<your-username>.github.io/<repo-name>/`.
6. **Important:** In the Firebase Console, go to **Authentication → Settings →
   Authorized domains** and add your GitHub Pages domain
   (`<your-username>.github.io`) so Firebase Auth accepts sign-ins from it.

That's it — no build step is required since the project is plain HTML/CSS/JS.

---

## Production Deployment Checklist

- [ ] Firebase project created, Firestore + Auth enabled
- [ ] `js/firebase.js` updated with your real `firebaseConfig`
- [ ] Firestore rules deployed (`firebase/firestore.rules`)
- [ ] At least one admin user created in Firebase Authentication
- [ ] GitHub Pages domain added to Firebase Auth **Authorized domains**
- [ ] Company name set under **Settings** inside the app (used on printed
      reports and PDFs)
- [ ] Test a full cycle: add a moderator → import orders → calculate →
      export/print

---

## How the Bonus Calculation Works

Bonus is calculated **per order**, based on that order's package count, then
summed per moderator:

| Packages in order | Bonus (EGP) |
|---|---|
| 1 | −3 |
| 2 | 0 |
| 3 | 0 |
| 4 | +2 |
| 5 | +3 |
| 6 – 9 | +5 |
| 10+ | +10 |

```
Final Salary = Fixed Salary + Σ(bonus of every order that moderator handled)
```

This logic lives in `Utils.calculateOrderBonus()` in `js/utils.js`.

---

## Month Lifecycle (Active Month System)

The app never asks the device clock which month it is. Instead there is a
single **Active Month**, stored in Firestore at `settings/system.activeMonthId`
and shared by every admin/device. All logic for this lives in `js/months.js`.

### شهر العمل (the month picker)

The dropdown at the top of every page (`#monthSelect`) lists the Active
Month, every previous month, and any month created ahead of time. Selecting
a **locked** month switches the whole dashboard into read-only mode for it
(a banner appears, every editing control is disabled). Selecting the
**Active Month** re-enables editing. Switching the dropdown never changes
which month is Active — only what you're *looking at*. To change the Active
Month itself, use **إدارة الشهور → اشتغل على الشهر النشط** or close the
current month.

### إنهاء الشهر (Close Month)

Found on the **إدارة الشهور** page. After a confirmation dialog, closing a
month runs these steps, in this order, so a connection drop mid-way never
leaves the month partially/incorrectly locked:

1. **Snapshot** — a frozen copy of the calculated output (report rows,
   totals, department totals, the bonus tables actually used) under
   `monthly_reports/{monthId}/snapshots/{autoId}`.
2. **Backup** — a frozen copy of the input data (employees, advances,
   adjustments, departments, settings) under
   `monthly_reports/{monthId}/backups/{chunkId}`, chunked at 300 rows/doc.
3. **Monthly Summary** — the small index document at
   `monthly_summaries/{monthId}` that the Archive and month dropdown read,
   so they never have to download a full report just to show a total.
4. **Audit log entry** (`audit_logs`, action `month_closed`).
5. **Lock** — `monthly_reports/{monthId}.status` becomes `'locked'`. From
   this point the Firestore rules themselves refuse any further write to
   that month (its report, its advances/adjustments, its summary) — not
   just the UI.
6. **Next month** is created (`status: 'open'`) if it doesn't already exist,
   and becomes the new Active Month.

A month can only be closed once it has a calculated report. Locked months
can never be closed again, edited, or deleted (deletion is denied outright,
even to admins, in the Firestore rules) — the only way to correct a mistake
in a closed month is a manual adjustment inside the month that is currently
open, which leaves a visible trail instead of silently rewriting history.

### الأرشيف (Archive)

Lists every locked month (totals for salaries, advances, adjustments,
bonus, employee count, and the date it was closed), reading only the
lightweight `monthly_summaries` documents. Opening a month from the archive
loads it read-only via `Months.loadMonthDetails()` — no recalculation, no
edits possible.

### Backward compatibility

Months created before this feature has no `status` field at all and are
treated as `'open'` — exactly what they always were — so **no migration
step runs** for existing month documents; behavior for old data is
unchanged. The one genuinely one-time step is a *summary backfill*: on first
load after upgrading, `Months.init()` builds a `monthly_summaries/{monthId}`
document for every pre-existing month (so the Archive/dropdown have
something to read) and records completion in
`settings/system.summariesBackfilledAt` so it never re-runs.

---

## Data Model

```
users/{uid}
  email, role ('admin' | 'pending')

moderators/{moderatorId}            # physical collection name kept for
  name, normalizedName, fixedSalary # backward compatibility; the app calls
  createdAt, departmentId           # these "employees" everywhere else
  status ('active' | 'inactive'), hireDate, notes

departments/{departmentId}
  name, color, salaryType ('hourly' | 'fixed'), bonusRules, status
  ('active' | 'archived' — never hard-deleted, historical reports
  reference departmentId forever)

monthly_reports/{monthId}          e.g. "2026-08"
  monthLabel, createdAt, calculatedAt
  status ('open' | 'locked')       # absent on legacy docs == 'open'
  closedAt, closedBy, snapshotId, backupChunks
  bonusRules, departmentBonusRules, carryDebt   # frozen at month creation
  report: [ { moderatorId, name, fixedSalary, ordersCount,
              totalPackages, totalSales, totalBonus, finalSalary,
              departmentId, distribution: {1..9, "10+"} } ]
  totals: { fixedSalary, ordersCount, totalPackages, totalSales,
            totalBonus, finalSalary, carriedDebt }
  departmentTotals: [ { departmentId, ... } ]

  orderBatches/{batchId}            (chunks of up to 500 raw orders)
    items: [ { moderatorId, moderatorName, packages, price } ]
    count, createdAt

  snapshots/{autoId}                # written once, at close time — never edited
    report, totals, departmentTotals, bonusRules, closedAt

  backups/{chunkId}                 # frozen INPUT data, at close time
    employees | advances | adjustments | departments | settings (chunked)

monthly_summaries/{monthId}         # small index the Archive/dropdown read
  monthLabel, status, employeeCount, totals, departmentTotals,
  calculatedAt, closedAt, closedBy, snapshotId, backupChunks

advances/{advanceId}
  moderatorId, moderatorName, departmentId, amount, date, note, monthId

adjustments/{adjustmentId}
  moderatorId, moderatorName, departmentId, amount, date, reason, monthId

settlements/{settlementId}          # end-of-service (مخالصة نهاية الخدمة)
  moderatorId, moderatorName, departmentId, lastWorkingDay, breakdown
  (prorated salary, bonus, adjustments, advances, carried debt), netAmount
  approvedAt, approvedBy                       # create-only, never edited

audit_logs/{logId}                  # append-only
  action ('month_closed' | 'month_created' | 'active_month_changed'),
  monthId, performedBy, performedAt, ...details

settings/general
  companyName

settings/system                     # Active Month + one-time markers
  activeMonthId, activeMonthUpdatedAt, summariesBackfilledAt,
  summariesBackfilledCount, serverTimeProbe

settings/migrations                 # per-migration completion markers
  employeesDepartmentV1: { completedAt, migratedCount, defaultDepartmentId }

settings/adminBootstrap                  (internal, see Authentication Setup)
  claimedBy, claimedAt
```

Storing raw orders in **chunked batch documents** (rather than one Firestore
document per order) keeps writes cheap and reads fast even at 100,000+
orders/month — a single "Calculate" pass streams every batch once and
aggregates in memory in a single O(n) loop (see `App.calculateReport()` in
`js/app.js`).

---

## Troubleshooting

**"Missing or insufficient permissions" errors** — Your Firestore rules
haven't been deployed yet, or your account doesn't have a `users/{uid}`
document with `role: "admin"`. Re-check the [Firestore Configuration](#firestore-configuration)
and [Authentication Setup](#authentication-setup) sections.

**Login redirects back to the login page** — Make sure your domain (or
`localhost`) is listed under Firebase Authentication's Authorized domains.

**Excel import doesn't detect columns correctly** — The importer expects
column order **Name → Packages → Price**, with an optional header row.

**Charts don't appear** — Charts only render once a report has been
calculated for the selected month (click **Calculate** on the Report page).
