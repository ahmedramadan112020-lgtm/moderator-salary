/**
 * service-common.js
 * -----------------------------------------------------------------------
 * ServiceCommon — the shared foundation under AuditService, BackupService,
 * DataLayer and UndoService.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The four new services all need the same handful of primitives: who is the
 * current user, how do I turn a Firestore document into something I can
 * store inside another document, how do I commit more than 500 writes, how
 * do I put a Timestamp into sessionStorage and get a Timestamp back out.
 *
 * Written once here, those primitives are identical everywhere. Written four
 * times, they drift — and the place they drift is exactly the place it hurts
 * most: an audit entry that records a slightly different "before" than the
 * backup does, or an undo that revives a date as a string.
 *
 * THE TIMESTAMP PROBLEM (the reason plainClone exists)
 * ----------------------------------------------------
 * A document read from Firestore contains live SDK objects:
 * `firebase.firestore.Timestamp` instances, `DocumentReference`s, and
 * `GeoPoint`s. Three things go wrong if those are passed around as-is:
 *
 *   1. Writing one INSIDE another document (an audit `before` snapshot, a
 *      backup chunk) nests a Timestamp, which Firestore accepts — but a
 *      nested Timestamp read back later is indistinguishable from a field
 *      the app itself set, so restores start writing "now" into createdAt.
 *   2. `JSON.stringify` turns a Timestamp into `{seconds, nanoseconds}`,
 *      which silently stops being a date. sessionStorage does exactly this.
 *   3. `serverTimestamp()` sentinels can't be cloned at all — they are
 *      write-only tokens and reading one back gives null.
 *
 * So every value crossing a boundary goes through `plainClone`, which
 * converts Timestamps to a tagged marker `{_tsMillis: <millis>}`. `reviveClone`
 * turns markers back into real Timestamps. The tag is deliberately ugly and
 * specific: no payroll field will ever collide with it.
 *
 * WHAT THIS FILE DOES NOT DO
 * --------------------------
 * No Firestore writes, no audit entries, no UI. It is pure helpers, so it
 * can be loaded before every other new service and depended on freely.
 * -----------------------------------------------------------------------
 */

'use strict';

const ServiceCommon = (() => {

  /* ============================================================
   * FIRESTORE LIMITS
   * ============================================================ */

  /**
   * Firestore caps a batched write at 500 operations. Every batch in the new
   * services carries the business write PLUS its audit entry, so the safe
   * chunk size is deliberately well under the limit rather than exactly at
   * it — a caller that adds one more write to a "full" batch would
   * otherwise fail at commit time with a completely opaque error.
   */
  const BATCH_LIMIT = 500;
  const SAFE_BATCH_SIZE = 400;

  /**
   * Firestore caps a single document at ~1 MB. Backup and audit payloads are
   * chunked by row count rather than measured bytes (see BACKUP_CHUNK), but
   * an audit `before/after` pair is a single field on a single document, so
   * it needs a real byte ceiling. 40 KB per side leaves the rest of the
   * document (action, user, monthId, timestamps) enormous headroom while
   * still capturing any realistic employee/advance/department record whole.
   */
  const MAX_SNAPSHOT_BYTES = 40 * 1024;

  /* ============================================================
   * CURRENT USER
   * ============================================================ */

  /**
   * The signed-in user, or null.
   *
   * `auth` is a global const from firebase.js. Reading a `const` while it is
   * still in its temporal dead zone THROWS on `typeof`, so this is wrapped
   * rather than guarded with a typeof check — the same reasoning documented
   * in months.js#reportError.
   */
  function currentUser() {
    try {
      return (auth && auth.currentUser) ? auth.currentUser : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Identity fields stamped onto every audit entry and every backup.
   *
   * Stores the email as well as the uid on purpose. The uid is the stable
   * key, but an audit trail nobody can read without cross-referencing
   * another collection doesn't get read — and if the Auth user is ever
   * deleted, the email is the only remaining trace of who acted.
   */
  function actor() {
    const user = currentUser();
    return {
      userId: user ? user.uid : null,
      userEmail: user ? (user.email || null) : null
    };
  }

  /* ============================================================
   * SERVER TIME
   * ============================================================ */

  /** The `serverTimestamp()` sentinel. Never the device clock. */
  function serverTimestamp() {
    return firebase.firestore.FieldValue.serverTimestamp();
  }

  /** The sentinel that REMOVES a field, used by undo of an "add field" edit. */
  function deleteField() {
    return firebase.firestore.FieldValue.delete();
  }

  /* ============================================================
   * CLONING  (Firestore value <-> plain JSON)
   * ============================================================ */

  /**
   * The key used to tag a converted Timestamp.
   *
   * NOT `__ts__`, deliberately. Firestore rejects any field name that BEGINS
   * AND ENDS with a double underscore - that pattern is reserved - and this
   * key becomes a real field name the moment a cloned value is written inside
   * an audit document's `before`/`after`. A `__ts__` key would make every
   * audit entry that carries a date fail at write time with an opaque
   * "invalid field name" error.
   *
   * A single leading underscore is safe, and `_tsMillis` still cannot collide
   * with any payroll field (`name`, `amount`, `monthId`, `createdAt`, ...).
   */
  const TS_KEY = '_tsMillis';

  /**
   * True for a FieldValue sentinel (`serverTimestamp()`, `delete()`, ...).
   *
   * These are WRITE-ONLY tokens: they have no value to read, and cloning one
   * structurally yields a meaningless `{}` (or an internal `_methodName`).
   * They legitimately appear in a payload being written - DataLayer stamps
   * `createdAt: serverTimestamp()` on every new record - and that same
   * payload is handed to the audit entry as its `after`. So they must be
   * recognised and replaced with a readable marker rather than silently
   * flattened into an empty map.
   */
  function isFieldValueSentinel(value) {
    if (!value || typeof value !== 'object') return false;
    try {
      const FieldValue = firebase.firestore.FieldValue;
      if (FieldValue && value instanceof FieldValue) return true;
    } catch (err) {
      /* fall through to the duck-type check below */
    }
    // The compat SDK wraps sentinels in a class exposing `_methodName`; the
    // instanceof check above can miss across SDK copies, so this is the
    // belt-and-braces path.
    return typeof value._methodName === 'string';
  }

  /** True for a Firestore Timestamp (duck-typed: works across SDK copies). */
  function isTimestamp(value) {
    return !!value &&
      typeof value === 'object' &&
      typeof value.toDate === 'function' &&
      typeof value.seconds === 'number';
  }

  /** True for our own tagged timestamp marker. */
  function isTimestampMarker(value) {
    return !!value &&
      typeof value === 'object' &&
      Object.prototype.hasOwnProperty.call(value, TS_KEY) &&
      typeof value[TS_KEY] === 'number';
  }

  /**
   * Deep-converts a Firestore document into plain JSON-safe data.
   *
   *   Timestamp        -> { _tsMillis: millis }
   *   Date             -> { _tsMillis: millis }
   *   FieldValue        -> '(server-value)' (write-only sentinel, unreadable)
   *   DocumentReference-> its path string
   *   undefined        -> dropped (Firestore rejects undefined outright)
   *   function/symbol  -> dropped
   *
   * Anything else is copied structurally. Cycles are impossible in Firestore
   * data, so no cycle guard is needed.
   */
  function plainClone(value) {
    if (value === null || value === undefined) return null;

    // Write-only sentinels first: they must never reach the structural
    // branch below, which would flatten them into a meaningless `{}`.
    // Replaced with a readable marker so an audit entry showing a newly
    // created record reads "createdAt: (وقت السيرفر)" instead of "{}".
    if (isFieldValueSentinel(value)) {
      return SERVER_VALUE_MARKER;
    }

    if (isTimestamp(value)) {
      return { [TS_KEY]: value.toDate().getTime() };
    }
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : { [TS_KEY]: value.getTime() };
    }
    // A DocumentReference has a `path`; keep it as a readable string.
    if (typeof value === 'object' && typeof value.path === 'string' &&
        typeof value.id === 'string' && typeof value.collection === 'function') {
      return value.path;
    }

    const t = typeof value;
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'number') return Number.isFinite(value) ? value : null;
    if (t === 'function' || t === 'symbol' || t === 'bigint') return null;

    if (Array.isArray(value)) {
      return value.map(v => plainClone(v));
    }

    if (t === 'object') {
      const out = {};
      Object.keys(value).forEach(key => {
        const v = value[key];
        if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return;
        out[key] = plainClone(v);
      });
      return out;
    }

    return null;
  }

  /** The placeholder `plainClone` substitutes for a write-only sentinel. */
  const SERVER_VALUE_MARKER = '(server-value)';

  /**
   * The inverse of `plainClone`: turns tagged markers back into real
   * Firestore Timestamps so a restored/undone document carries genuine
   * dates rather than numbers.
   *
   * A `'(server-value)'` placeholder is turned back into a live
   * `serverTimestamp()` sentinel rather than restored as that literal string.
   * This matters for undo-of-a-delete: the deleted document's `createdAt` was
   * captured while its sentinel was still unresolved (a local write reads back
   * as a pending sentinel for a few milliseconds), and writing the string
   * "(server-value)" into a date field would corrupt it. Re-issuing the
   * sentinel gives the recreated record a real timestamp instead.
   */
  function reviveClone(value) {
    if (value === null || value === undefined) return value;

    // FieldValue sentinels (`serverTimestamp()`, `delete()`) are write-only
    // tokens. They are not plain objects and must be preserved as live
    // Firestore sentinels, not cloned into a custom object that Firestore
    // rejects with "Expected type 'Ju', but it was: a custom Xu object".
    if (isFieldValueSentinel(value)) {
      return value;
    }

    // Real Firestore Timestamp / Date values are already valid for a write.
    // Only a marker produced by plainClone must be turned back into a
    // Timestamp; otherwise we end up sending a custom plain object to Firestore.
    if (isTimestamp(value)) return value;
    if (value instanceof Date) return value;
    if (isTimestampMarker(value)) {
      return firebase.firestore.Timestamp.fromMillis(value[TS_KEY]);
    }
    if (value === SERVER_VALUE_MARKER) {
      return serverTimestamp();
    }
    if (Array.isArray(value)) {
      return value.map(v => reviveClone(v));
    }
    if (typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach(key => { out[key] = reviveClone(value[key]); });
      return out;
    }
    return value;
  }

  /* ============================================================
   * SIZE ESTIMATION
   * ============================================================ */

  /**
   * Approximate byte size of a value once serialized.
   *
   * Deliberately an ESTIMATE and labelled as one everywhere it surfaces.
   * Firestore's real accounting (field-name overhead, index entries, varint
   * encoding) is not reproducible client-side, and pretending otherwise
   * would put a precise-looking wrong number in front of the admin. What
   * this is actually for is two honest jobs: showing a human "roughly how
   * big is this backup", and deciding whether an audit snapshot needs
   * truncating.
   */
  function estimateSize(value) {
    try {
      const json = JSON.stringify(value);
      if (typeof json !== 'string') return 0;
      // Rough UTF-8 accounting: Arabic sits in the 2-byte range, ASCII in
      // the 1-byte range, so counting code units under-reports Arabic text.
      // Blob gives the true byte length when available.
      if (typeof Blob === 'function') {
        try { return new Blob([json]).size; } catch (err) { /* fall through */ }
      }
      let bytes = 0;
      for (let i = 0; i < json.length; i++) {
        const code = json.charCodeAt(i);
        bytes += code < 0x80 ? 1 : (code < 0x800 ? 2 : 3);
      }
      return bytes;
    } catch (err) {
      return 0;
    }
  }

  /**
   * A snapshot safe to store inside an audit document.
   *
   * Oversized payloads are replaced by a marker rather than truncated
   * mid-structure: half a record looks like real data and would be trusted
   * as such, while an explicit `_truncated` marker tells the reader exactly
   * why the detail isn't there. The document id is always kept, so the full
   * row is still findable in a backup.
   *
   * Field names use a SINGLE leading underscore: Firestore rejects any name
   * that both begins and ends with a double underscore, and these become real
   * field names inside the audit document.
   */
  function boundedSnapshot(value) {
    const clone = plainClone(value);
    const size = estimateSize(clone);
    if (size <= MAX_SNAPSHOT_BYTES) return clone;

    return {
      _truncated: true,
      _reason: 'snapshot_too_large',
      _approxBytes: size,
      id: (clone && clone.id) ? clone.id : null
    };
  }

  /* ============================================================
   * DIFFING
   * ============================================================ */

  /**
   * Order-insensitive JSON, for comparing two values structurally.
   *
   * Plain `JSON.stringify` is key-ORDER sensitive, and that matters here:
   * Firestore returns map keys in its own (sorted) order, while an object
   * built by a form literal keeps source order. So the bonus-rules table
   * `{'1':…, '6_9':…, '10+':…}` read back from the database stringifies
   * differently from the identical table just built in the UI - and every
   * save would look like a change, logging a no-op edit every time the
   * settings form is submitted.
   *
   * Sorting keys at every level makes the comparison structural, which is
   * what "did this actually change" means. Arrays keep their order, because
   * for an array order IS data.
   */
  function stableStringify(value) {
    if (value === null || value === undefined) return 'null';

    const t = typeof value;
    if (t === 'number' || t === 'boolean') return JSON.stringify(value);
    if (t === 'string') return JSON.stringify(value);

    if (Array.isArray(value)) {
      return '[' + value.map(v => stableStringify(v)).join(',') + ']';
    }
    if (t === 'object') {
      const keys = Object.keys(value).sort();
      return '{' + keys
        .map(k => JSON.stringify(k) + ':' + stableStringify(value[k]))
        .join(',') + '}';
    }
    return 'null';
  }

  /**
   * The field-level difference between two states.
   *
   * Returns `{ changed: [...], before: {...}, after: {...} }` carrying ONLY
   * the fields that actually differ. Storing just the delta rather than two
   * whole documents is what keeps a busy audit log small enough to read and
   * cheap enough to query — and it makes "what did this edit actually do"
   * answerable at a glance instead of by eye-diffing two JSON blobs.
   *
   * Compares via `stableStringify` on the cloned values, so nested objects
   * compare structurally regardless of key order and Timestamps compare by
   * their millis.
   */
  function diff(beforeValue, afterValue) {
    const before = plainClone(beforeValue) || {};
    const after = plainClone(afterValue) || {};

    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changed = [];
    const beforeDelta = {};
    const afterDelta = {};

    keys.forEach(key => {
      // Bookkeeping fields change on literally every write; recording them
      // as "changes" would bury the one field the admin actually edited.
      if (key === 'updatedAt' || key === 'createdAt') return;

      const b = before[key];
      const a = after[key];
      if (stableStringify(b) === stableStringify(a)) return;

      changed.push(key);
      beforeDelta[key] = b === undefined ? null : b;
      afterDelta[key] = a === undefined ? null : a;
    });

    return { changed, before: beforeDelta, after: afterDelta };
  }

  /* ============================================================
   * BATCHING
   * ============================================================ */

  /**
   * Runs `apply(batch, item)` over every item, committing in safe chunks.
   *
   * Firestore has no "big batch" — 500 operations is the hard ceiling — so
   * anything that can touch an unbounded number of documents (a restore, a
   * bulk delete) has to be chunked. Chunking is NOT the same as atomic:
   * each chunk commits independently, so callers that need all-or-nothing
   * must fit inside a single batch or use a transaction instead.
   *
   * @param {Array} items
   * @param {(batch, item) => number|void} apply  returns how many ops it
   *        added (defaults to 1), so a caller writing two documents per item
   *        is still counted correctly against the limit.
   * @param {(completedItems: number, totalItems: number) => void} [onProgress]
   *        Invoked first with 0 and then after each successfully committed
   *        batch, so UI progress never claims writes that Firestore has not
   *        acknowledged yet.
   * @returns {Promise<number>} committed operation count
   */
  async function commitInChunks(items, apply, chunkSize = SAFE_BATCH_SIZE, onProgress) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return 0;

    let batch = db.batch();
    let ops = 0;
    let total = 0;
    let itemsCommitted = 0;
    let itemsInBatch = 0;

    if (typeof onProgress === 'function') onProgress(0, list.length);

    for (const item of list) {
      const added = apply(batch, item);
      const count = Number.isFinite(added) ? added : 1;
      ops += count;
      total += count;
      itemsInBatch++;

      // Commit BEFORE exceeding the ceiling, never after.
      if (ops >= chunkSize) {
        await batch.commit();
        itemsCommitted += itemsInBatch;
        // Optional progress hook (e.g. a preview-modal progress bar). Never
        // required by existing callers - only invoked when provided.
        if (typeof onProgress === 'function') onProgress(itemsCommitted, list.length);
        batch = db.batch();
        ops = 0;
        itemsInBatch = 0;
      }
    }

    if (ops > 0) {
      await batch.commit();
      itemsCommitted += itemsInBatch;
      if (typeof onProgress === 'function') onProgress(itemsCommitted, list.length);
    }
    return total;
  }

  /** Splits an array into fixed-size slices. */
  function chunk(items, size) {
    const list = Array.isArray(items) ? items : [];
    const n = Math.max(1, Number(size) || 1);
    const out = [];
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
  }

  /* ============================================================
   * SESSION STORAGE  (the Undo window survives a refresh)
   * ============================================================ */

  /**
   * Reads and writes JSON in sessionStorage, tolerating every way it can
   * fail: disabled by policy, full, or private-mode quota of zero. Undo is a
   * convenience, so losing its persistence must never throw into a payroll
   * flow — a failed save simply means undo won't survive a refresh.
   */
  function sessionSet(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(plainClone(value)));
      return true;
    } catch (err) {
      console.warn('sessionStorage write failed:', err.message);
      return false;
    }
  }

  function sessionGet(key) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn('sessionStorage read failed:', err.message);
      return null;
    }
  }

  function sessionRemove(key) {
    try {
      sessionStorage.removeItem(key);
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ============================================================
   * FILE DOWNLOAD  (backup JSON export)
   * ============================================================ */

  /**
   * Triggers a browser download of `data` as pretty-printed JSON.
   *
   * Revokes the object URL after a delay rather than immediately: Safari
   * cancels an in-flight download when the URL is revoked synchronously.
   */
  function downloadJson(filename, data) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1500);
  }

  /**
   * A filesystem-safe version of a label, for download filenames.
   * Arabic is preserved (it is perfectly legal in a filename); only the
   * characters Windows and POSIX actually reject are replaced.
   */
  function safeFilename(name) {
    return String(name || 'backup')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '_')
      .slice(0, 120);
  }

  /* ============================================================
   * IDS & LABELS
   * ============================================================ */

  /**
   * A sortable, human-readable id derived from a Date:
   * "2026-08-03_14-32-07". Used for backup document ids so the collection
   * lists chronologically without needing an index, and so an id pasted
   * into a conversation is self-explanatory.
   */
  function timestampId(date) {
    const d = (date instanceof Date && !isNaN(date.getTime())) ? date : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
           `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  return {
    // limits
    BATCH_LIMIT,
    SAFE_BATCH_SIZE,
    MAX_SNAPSHOT_BYTES,
    // user
    currentUser,
    actor,
    // time
    serverTimestamp,
    deleteField,
    // cloning
    isTimestamp,
    isFieldValueSentinel,
    plainClone,
    reviveClone,
    // size & diff
    estimateSize,
    boundedSnapshot,
    stableStringify,
    diff,
    // batching
    commitInChunks,
    chunk,
    // session
    sessionSet,
    sessionGet,
    sessionRemove,
    // files
    downloadJson,
    safeFilename,
    timestampId
  };
})();
