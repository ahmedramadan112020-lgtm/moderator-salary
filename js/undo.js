/**
 * undo.js
 * -----------------------------------------------------------------------
 * UndoService — a 30-second window to take back the last write.
 *
 * WHAT IT COVERS
 * --------------
 * Add, edit and delete of any collection registered with DataLayer:
 * employees, departments, advances, adjustments, settings. Every one of those
 * returns an undo descriptor, so undo is a property of writing through the
 * data layer rather than a feature wired into individual handlers.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER
 * -----------------------------------
 * Closing a month, approving a final settlement, and restoring a backup.
 * Not an oversight — those three are protected server-side in
 * firebase/firestore.rules: a locked month rejects every further write, and a
 * settlement is create-only. Offering an "undo" button that the database
 * would refuse is worse than offering nothing, because it teaches the admin
 * that those actions are reversible when they are not.
 *
 * Their safety net is different and stronger: an automatic backup is taken
 * before each of them, and the whole thing is audited. Recovery is a
 * deliberate, logged restore — not a reflex click.
 *
 * WHY ONE SLOT, NOT A STACK
 * -------------------------
 * Only the most recent operation is undoable. A stack sounds more capable but
 * is wrong here: these operations are not independent. Undoing an employee's
 * salary edit from four actions ago, after two advances have been added and
 * the report recalculated, produces a database state that never existed and
 * that nobody reasoned about. One slot with a short fuse means undo always
 * means exactly "that thing I just did was a mistake".
 *
 * WHY 30 SECONDS, ENFORCED ON READ
 * --------------------------------
 * The deadline is stored as the operation's TIMESTAMP, and freshness is
 * computed when undo is attempted. Storing a precomputed "expires at" would
 * be trivially wrong across a refresh, a suspended laptop, or a device whose
 * clock is off — all of which happen. Comparing `Date.now()` against the
 * recorded moment means a stale entry is always recognised as stale.
 *
 * SURVIVING A REFRESH
 * -------------------
 * The pending operation is mirrored into `sessionStorage`, so accidentally
 * hitting F5 within the window doesn't cost the undo. sessionStorage (not
 * localStorage) on purpose: the window is 30 seconds, and an undo offer
 * resurrected in a new tab tomorrow would be an invitation to corrupt data.
 * Timestamps are stored via ServiceCommon's tagged-marker format, because
 * plain `JSON.stringify` silently turns a Firestore Timestamp into
 * `{seconds, nanoseconds}` and it stops being a date.
 *
 * CONCURRENCY
 * -----------
 * The actual reversal runs in DataLayer.applyUndo, which re-reads the
 * document and refuses if the world moved on: the record was already
 * deleted, or recreated elsewhere, or its month has since been closed. So a
 * stale undo fails with an explanation instead of overwriting someone else's
 * work.
 * -----------------------------------------------------------------------
 */

'use strict';

const UndoService = (() => {

  /* ============================================================
   * CONSTANTS
   * ============================================================ */

  /** The window, in milliseconds. */
  const WINDOW_MS = 30 * 1000;

  /** How often the countdown UI refreshes. */
  const TICK_MS = 250;

  const STORAGE_KEY = 'msys.undo.pending';

  /* ============================================================
   * STATE
   * ============================================================ */

  const state = {
    // The single undoable operation, or null.
    pending: null,
    // setTimeout handle that expires the window.
    expiryTimer: null,
    // setInterval handle for the countdown.
    tickTimer: null,
    // Guard against a double-click firing two reversals of one operation.
    applying: false
  };

  /* ============================================================
   * FRESHNESS
   * ============================================================ */

  /** Milliseconds left in the window, floored at 0. */
  function remainingMs(descriptor) {
    if (!descriptor || !Number.isFinite(descriptor.at)) return 0;
    // A descriptor timestamped in the FUTURE means the clock moved backwards
    // (NTP correction, manual change). Treated as expired: refusing a
    // legitimate undo is a minor annoyance, while trusting a nonsensical
    // timestamp could keep an undo alive indefinitely.
    const elapsed = Date.now() - descriptor.at;
    if (elapsed < 0) return 0;
    return Math.max(0, WINDOW_MS - elapsed);
  }

  function isFresh(descriptor) {
    return remainingMs(descriptor) > 0;
  }

  /* ============================================================
   * OFFERING AN UNDO
   * ============================================================ */

  /**
   * Registers an operation as undoable and shows the snackbar.
   *
   * Replaces any previous pending operation — see the header for why there is
   * only ever one slot. A null/undefined descriptor is accepted and ignored,
   * so callers can pass `result.undo` straight through without checking
   * whether that particular collection is undoable.
   *
   * @param {object} descriptor  from DataLayer (create/update/remove)
   * @param {string} message     what the snackbar says
   */
  function offer(descriptor, message) {
    if (!descriptor) return false;

    clearTimers();

    state.pending = {
      ...descriptor,
      // Stamped here rather than trusting the descriptor's own `at`, so the
      // window starts when the user was actually told about it.
      at: Date.now(),
      message: message || defaultMessage(descriptor)
    };

    ServiceCommon.sessionSet(STORAGE_KEY, state.pending);
    renderSnackbar();
    startTimers();
    return true;
  }

  /** Fallback snackbar text, derived from the operation. */
  function defaultMessage(descriptor) {
    const verb = AuditService.OPERATION_LABELS[descriptor.operation] || 'تعديل';
    const label = descriptor.documentLabel
      ? ` "${descriptor.documentLabel}"`
      : '';
    return `تم ${verb} ${descriptor.entityLabel || ''}${label}`;
  }

  /* ============================================================
   * APPLYING
   * ============================================================ */

  /**
   * Reverses the pending operation.
   *
   * Re-validates freshness at the moment of the click, not when the button
   * was drawn: a snackbar left on screen by a stalled timer must not be able
   * to undo something from five minutes ago.
   */
  async function apply() {
    if (state.applying) return false;

    const descriptor = state.pending;
    if (!descriptor) {
      Toast.show('مفيش عملية للتراجع عنها', 'error');
      return false;
    }
    if (!isFresh(descriptor)) {
      Toast.show('انتهت مدة التراجع (30 ثانية)', 'error');
      dismiss();
      return false;
    }

    state.applying = true;
    // Hide the snackbar immediately: leaving a live Undo button on screen
    // during an async reversal invites a second click on an operation that is
    // already being undone.
    hideSnackbar();
    clearTimers();

    Loading.show('جاري التراجع عن العملية...');
    try {
      const result = await DataLayer.applyUndo(descriptor);

      Toast.show(
        `تم التراجع عن ${AuditService.OPERATION_LABELS[descriptor.operation] || 'العملية'} ` +
        `${result.entityLabel || ''}`.trim(),
        'success'
      );

      clear();
      return true;
    } catch (err) {
      console.error('Undo failed:', err);
      // The Arabic messages thrown by DataLayer/Months are written for the
      // admin, so they are surfaced verbatim rather than replaced.
      Toast.show('تعذر التراجع: ' + err.message, 'error');
      // The operation stays cleared: a failed undo means the world has moved
      // on (record already gone, month now closed), and retrying would fail
      // the same way while implying it might not.
      clear();
      return false;
    } finally {
      state.applying = false;
      Loading.hide();
    }
  }

  /* ============================================================
   * CLEARING
   * ============================================================ */

  /** Forgets the pending operation and removes the snackbar. */
  function clear() {
    state.pending = null;
    clearTimers();
    hideSnackbar();
    ServiceCommon.sessionRemove(STORAGE_KEY);
  }

  /** User dismissed the snackbar: same as clear, but named for intent. */
  function dismiss() { clear(); }

  function clearTimers() {
    if (state.expiryTimer) { clearTimeout(state.expiryTimer); state.expiryTimer = null; }
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
  }

  function startTimers() {
    const remaining = remainingMs(state.pending);
    if (remaining <= 0) { clear(); return; }

    state.expiryTimer = setTimeout(() => clear(), remaining);
    state.tickTimer = setInterval(updateCountdown, TICK_MS);
  }

  /* ============================================================
   * RESTORING ACROSS A REFRESH
   * ============================================================ */

  /**
   * Re-offers a pending undo after a page reload, if it's still within the
   * window. Called once at startup.
   *
   * Note it does NOT re-stamp `at`: the window is measured from the original
   * operation, so a refresh can't extend it.
   */
  function restoreFromSession() {
    const stored = ServiceCommon.sessionGet(STORAGE_KEY);
    if (!stored) return false;

    if (!isFresh(stored)) {
      ServiceCommon.sessionRemove(STORAGE_KEY);
      return false;
    }
    // A descriptor for a collection that no longer exists (an app update
    // removed it) would fail confusingly at apply time, so it's discarded now.
    try {
      DataLayer.specOf(stored.collectionKey);
    } catch (err) {
      ServiceCommon.sessionRemove(STORAGE_KEY);
      return false;
    }

    state.pending = stored;
    renderSnackbar();
    startTimers();
    return true;
  }

  /* ============================================================
   * UI  (snackbar)
   * ============================================================ */

  function container() {
    return document.getElementById('undoSnackbarContainer');
  }

  /**
   * Draws the snackbar.
   *
   * Rebuilt from scratch on each offer rather than mutated, so a rapid
   * sequence of operations can't leave a stale listener bound to a previous
   * descriptor — the classic source of "undo reversed the wrong thing".
   */
  function renderSnackbar() {
    const host = container();
    if (!host || !state.pending) return;

    const seconds = Math.ceil(remainingMs(state.pending) / 1000);

    host.innerHTML = `
      <div class="undo-snackbar" id="undoSnackbar" role="status" aria-live="polite">
        <span class="undo-icon" aria-hidden="true">↩️</span>
        <div class="undo-text">
          <div class="undo-message">${Utils.escapeHtml(state.pending.message)}</div>
          <div class="undo-hint">
            التراجع متاح لمدة <strong id="undoCountdown">${seconds}</strong> ثانية
          </div>
        </div>
        <button type="button" class="undo-btn" id="undoApplyBtn">تراجع</button>
        <button type="button" class="undo-close" id="undoDismissBtn" title="إغلاق">✕</button>
      </div>`;

    document.getElementById('undoApplyBtn').addEventListener('click', apply);
    document.getElementById('undoDismissBtn').addEventListener('click', dismiss);

    requestAnimationFrame(() => {
      const el = document.getElementById('undoSnackbar');
      if (el) el.classList.add('visible');
    });
  }

  function updateCountdown() {
    const el = document.getElementById('undoCountdown');
    if (!el || !state.pending) return;
    const seconds = Math.ceil(remainingMs(state.pending) / 1000);
    el.textContent = String(Math.max(0, seconds));
  }

  function hideSnackbar() {
    const host = container();
    if (!host) return;
    const el = document.getElementById('undoSnackbar');
    if (!el) { host.innerHTML = ''; return; }

    el.classList.remove('visible');
    // Let the CSS transition finish before removing the node, and guard
    // against the snackbar having already been replaced by a newer one.
    setTimeout(() => {
      if (el.parentElement === host) host.innerHTML = '';
    }, 250);
  }

  /* ============================================================
   * QUERIES
   * ============================================================ */

  function hasPending() { return !!state.pending && isFresh(state.pending); }
  function pending() { return state.pending; }

  return {
    WINDOW_MS,
    offer,
    apply,
    clear,
    dismiss,
    restoreFromSession,
    hasPending,
    pending,
    isFresh,
    remainingMs
  };
})();
