# Changelog

## 7.0.10-uat-dashboard

- UAT Dashboard: stopped unauthorized employee, transaction, department, and settings reads during application startup for limited roles.
- Kept Dashboard usable with permission-safe defaults and masked the pending-transactions status when transaction access is absent.
- Prevented the legacy employee migration from attempting writes for read-only employee roles.

## 7.0.9-user-management-resilience

- Bound User Management controls before its first Firestore read, so search, refresh, edit, and retry remain available after a transient users-query failure.
- Added explicit loading and retryable error states for the users table without interrupting application initialization.
- Made User Management initialization idempotent and wrapped asynchronous UI handlers to prevent unhandled promise errors.
- Verified Super Admin authentication and `users` collection access against the configured Firebase project.

## 7.0.8-role-matrix-resilience

- Made custom-role loading fail-safe: an absent, empty, or temporarily unreadable `roles` collection now resolves to an empty custom-role list without affecting built-in roles.
- Cleared stale custom-role cache before every load and retained built-in role templates as the independent fallback catalogue.
- Removed the recoverable custom-role loading toast from Role Matrix initialization; the matrix continues with built-in roles only.
- Documented in Firestore Rules that no role seed or first-run migration is required for a new project.

## 7.0.7-final-stable

- Completed the final stability pass across the shared data, permission, audit, UI, and module integration paths.
- Fixed Salary Processing lifecycle timing: it now initializes after authenticated application startup and refreshes when the selected month changes.
- Removed superseded Salary Processing write/export implementations, guarded the read path, and release chart instances when their data becomes empty.
- Added the missing Firestore audit authorization for Salary Processing exports and normalized Audit labels for payroll, roles, users, and data sources.
- Corrected Salary Processing operational sales metrics to use `saleValue` with legacy `price` fallback.
- Fixed shipping matching for repeated customer name/phone pairs by consuming one order per shipping row instead of repeatedly updating the last matching order.
- Added final static regression coverage for JavaScript syntax, DOM references, authorization branches, bonus calculation, complex CSV parsing, chart states, dashboard widgets, and Firestore Rules compilation.

## 7.0.6-dashboard

- Scoped every operational Dashboard widget to the selected month and department instead of aggregating all historical orders.
- Corrected executive sales aggregation to prefer the persisted `saleValue`, preserving compatibility with older rows that only have `price`.
- Completed the operational row with recent audit activity, permission-safe data/empty states, shipping status, rankings, and actionable alerts.
- Added deterministic empty states for all Dashboard charts, including the Chart.js-unavailable case, and refresh the Dashboard once the shared order cache finishes loading.
- Applied permission-aware Dashboard values and quick actions, including protected employee, report, transaction, backup, audit, and order data.
- Kept KPI, pending-transaction, and department counts aligned to the active department scope; refined the operational grid for desktop, laptop, and tablet layouts.

## 7.0.5-data-sources

- Rebuilt Data Sources around real Google Sheets and Excel import flows, with source-level sync actions and multi-source selection UI.
- Replaced line-splitting CSV parsing with delimiter detection and RFC-style quoted-field handling, including escaped quotes and malformed-file rejection.
- Added live Google Sheets connection and schema validation, plus Excel workbook parsing through SheetJS at sync time.
- Added source create, update, delete, successful sync, and failed sync audit records.
- Enforced settings read/write and orders import permissions before source administration or synchronization.
- Clarified that Excel files are intentionally selected at sync time rather than stored in Firestore documents.

## 7.0.4-backup-restore

- Expanded full backups to include order batches, Salary Processing snapshots, settings (including bonus rules and data sources), role definitions, user role assignments, and the audit trail.
- Added independent partial backup and restore scopes for orders, salary processing, settings, roles and permissions, and audit records.
- Stored each backup's exact collection scope in its manifest; comparison and restore use that persisted scope only.
- Made the pre-restore safety backup mandatory and added elevated restore rules for protected payroll snapshots and role assignments.
- Preserved audit immutability during restore: missing audit records may be recreated, existing records are never overwritten.

## 7.0.3-role-matrix

- Added persisted custom roles with create, edit, clone, and guarded delete operations.
- Roles resolve into a stored permission list on each assigned user; role edits update that list atomically with the definition.
- Added custom-role assignment to User Management while retaining legacy built-in role profiles.
- Enforced custom-role permissions in Firestore Rules for employees, departments, settings, transactions, monthly reporting, settlements, salary processing, audit logs, and backups.
- Restricted role-definition management and role assignment to the existing Super Admin boundary.

## 7.0.2-critical-fixes

- Added production Firestore access rules for `salary_processing`; paid payroll snapshots remain immutable.
- Enforced distinct Salary Processing permissions for review, manual adjustment, approval, payment, and Excel export.
- Included manual additions, deductions, resulting net pay, and adjustment notes in salary snapshot Excel exports.
- Added audit records for payroll manual adjustments and exports.
- Scoped Configuration Center tabs so tabs in the salary details drawer cannot change or hide Settings panels.

## 7.0.0-stable

- Performed static JavaScript validation across all application modules.
- Consolidated the production handoff around central services for permissions, audit records, backups, orders, salary snapshots, and authentication metadata.
- Confirmed optional, backward-compatible storage for salary snapshots, data sources, user security metadata, and payment status.
- Documented intentional client-side limitations: revoking sessions on other devices requires Firebase Admin SDK / Cloud Functions; Google Sheets requires a publicly readable, CORS-accessible sheet.
