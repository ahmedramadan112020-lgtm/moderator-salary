/**
 * utils.js
 * -----------------------------------------------------------------------
 * Shared, dependency-free helper functions used across the application:
 *   - Name normalization & fuzzy matching (Arabic + Latin support)
 *   - Bonus calculation rules
 *   - Hourly salary calculation + legacy report-row accessors
 *   - Orders text/Excel parsing with per-line validation
 *   - Formatting helpers and debounce
 * -----------------------------------------------------------------------
 */

'use strict';

const Utils = (() => {

  /* ============================================================
   * NAME NORMALIZATION
   * ============================================================ */

  /**
   * Normalizes a moderator name so that "hind", "HIND", "Hind", "  Hind "
   * are all treated as the same person.
   * - Trims leading/trailing whitespace
   * - Collapses internal multiple spaces/tabs into a single space
   * - Lower-cases Latin characters (Arabic has no case, left as-is)
   * - Strips Arabic diacritics (tashkeel) so "رِيم" == "ريم"
   * - Normalizes Arabic Alef variants (أ إ آ -> ا) and Taa Marbuta (ة -> ه)
   *   so common spelling variants merge together
   */
  function normalizeName(rawName) {
    if (!rawName) return '';

    let name = String(rawName);

    // Collapse tabs/multiple spaces into single space, trim ends
    name = name.replace(/[\t\u00A0]+/g, ' ').replace(/\s+/g, ' ').trim();

    // Lowercase Latin letters
    name = name.toLowerCase();

    // Strip Arabic diacritics (tashkeel)
    name = name.replace(/[\u064B-\u0652\u0670\u0640]/g, '');

    // Normalize Alef variants and Taa Marbuta for comparison purposes
    name = name.replace(/[إأآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');

    return name;
  }

  /**
   * Produces a "display friendly" version of a name: trims/collapses spaces
   * but preserves original casing/characters (used for showing in UI after
   * the first time a moderator is created).
   */
  function cleanDisplayName(rawName) {
    if (!rawName) return '';
    return String(rawName).replace(/[\t\u00A0]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* ============================================================
   * FUZZY MATCHING (Levenshtein distance)
   * ============================================================ */

  /**
   * Classic iterative Levenshtein distance with O(min(m,n)) memory.
   */
  function levenshtein(a, b) {
    // Coerce first: moderator documents written by older versions of the app
    // may be missing `normalizedName`, and an undefined here would otherwise
    // throw mid-import and abort the whole batch.
    a = (a === null || a === undefined) ? '' : String(a);
    b = (b === null || b === undefined) ? '' : String(b);

    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Ensure "a" is the shorter string for less memory usage
    if (a.length > b.length) { const t = a; a = b; b = t; }

    let prevRow = new Array(a.length + 1);
    for (let i = 0; i <= a.length; i++) prevRow[i] = i;

    for (let j = 1; j <= b.length; j++) {
      const currRow = new Array(a.length + 1);
      currRow[0] = j;
      for (let i = 1; i <= a.length; i++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        currRow[i] = Math.min(
          prevRow[i] + 1,      // deletion
          currRow[i - 1] + 1,  // insertion
          prevRow[i - 1] + cost // substitution
        );
      }
      prevRow = currRow;
    }
    return prevRow[a.length];
  }

  /**
   * Returns a similarity ratio between 0 (completely different) and 1 (identical)
   * based on Levenshtein distance normalized by the longer string's length.
   */
  function similarityRatio(a, b) {
    const sa = (a === null || a === undefined) ? '' : String(a);
    const sb = (b === null || b === undefined) ? '' : String(b);
    const maxLen = Math.max(sa.length, sb.length);
    if (maxLen === 0) return 1;
    return 1 - levenshtein(sa, sb) / maxLen;
  }

  /**
   * Given a raw imported name and the list of known moderators
   * ({ id, name, normalizedName }), finds the closest existing match.
   * Uses a similarity threshold (default 0.82) tuned to catch small typos
   * (1-2 character difference on short/medium names) without merging
   * genuinely different names.
   *
   * Returns the matching moderator object, or null if no confident match.
   */
  function findBestModeratorMatch(rawName, moderators, threshold = 0.82) {
    const target = normalizeName(rawName);
    if (!target || !Array.isArray(moderators)) return null;

    // Tolerate moderator records that predate `normalizedName` by deriving it
    // from the display name on the fly, so matching never silently misses.
    const keyOf = (m) => m.normalizedName || normalizeName(m.name);

    // 1. Exact normalized match first (fast path, most common case)
    let best = moderators.find(m => keyOf(m) === target);
    if (best) return best;

    // 2. Fuzzy match by best similarity score
    let bestScore = 0;
    best = null;
    for (const mod of moderators) {
      const score = similarityRatio(target, keyOf(mod));
      if (score > bestScore) {
        bestScore = score;
        best = mod;
      }
    }

    return bestScore >= threshold ? best : null;
  }

  /* ============================================================
   * BONUS CALCULATION
   * ============================================================ */

  /**
   * Default bonus rule table (EGP per order, by package-count tier).
   * Used whenever the admin hasn't customized the rules yet (see
   * Settings -> "جدول البونص"). Kept as the fallback so existing
   * behavior never breaks if `settings/general.bonusRules` is missing.
   */
  const DEFAULT_BONUS_RULES = {
    '1': -3,
    '2': 0,
    '3': 0,
    '4': 2,
    '5': 3,
    '6_9': 5,
    '10+': 10
  };

  /**
   * Calculates the bonus (in EGP) for a single order based on its
   * package count, following an editable business rule table (see
   * DEFAULT_BONUS_RULES for the shape/tiers). Pass a custom `rules`
   * object (e.g. from Settings) to override any tier; missing tiers
   * fall back to the default value for that tier.
   */
  function calculateOrderBonus(packages, rules) {
    const p = Number(packages);
    if (!Number.isFinite(p) || p <= 0) return 0;
    const r = Object.assign({}, DEFAULT_BONUS_RULES, rules || {});
    if (p === 1) return Number(r['1']);
    if (p === 2) return Number(r['2']);
    if (p === 3) return Number(r['3']);
    if (p === 4) return Number(r['4']);
    if (p === 5) return Number(r['5']);
    if (p >= 6 && p <= 9) return Number(r['6_9']);
    return Number(r['10+']); // 10 or more
  }

  // Backward-compatible bonus resolver. Legacy callers keep the packages
  // table; optional sales tiers activate only when explicitly configured.
  function calculateBonus({ packages, saleValue, config } = {}) {
    if (!config || config.bonusType !== 'sales' || !Array.isArray(config.salesBonusRules)) return calculateOrderBonus(packages, config && config.bonusRules ? config.bonusRules : config);
    const value = Number(saleValue || 0);
    const tier = config.salesBonusRules.find(row => value >= Number(row.from || 0) && value <= Number(row.to == null ? Infinity : row.to));
    return tier ? Number(tier.bonus || 0) : 0;
  }

  /**
   * Returns the distribution bucket key (1..9, '10+') for a package count.
   * Used to build the "Orders Distribution" breakdown in moderator details.
   */
  function packageBucket(packages) {
    const p = Number(packages);
    if (p >= 10) return '10+';
    if (p >= 1 && p <= 9) return String(p);
    return 'invalid';
  }

  /* ============================================================
   * SALARY (الراتب الشهري الثابت بالتناسب حسب تاريخ التعيين)
   * ============================================================ */

  /**
   * Converts a value to a finite number, or null when the value is
   * missing/blank/non-numeric. Returning null (rather than 0) lets callers
   * tell "nothing recorded" apart from a legitimate zero — which is what
   * makes legacy report rows renderable as "—" instead of a misleading 0.
   */
  function toFiniteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Base salary for a month, computed from the employee's fixed monthly
   * salary and their hire date:
   *
   *   - Hired before this report month (or no hire date at all): full
   *     `fixedSalaryAmount`.
   *   - Hired in a month AFTER this report month: 0 (hasn't started yet).
   *   - Hired DURING this report month: prorated —
   *       (fixedSalaryAmount / daysInMonth) * daysFromHireDateToMonthEnd
   *     counting the hire day itself as a worked day.
   *
   * @param {number} fixedSalaryAmount the employee's fixed monthly salary
   * @param {string?} hireDate  "YYYY-MM-DD", or falsy for "always employed"
   * @param {string} monthId   the report's month id, "YYYY-MM"
   */
  function calculateBaseSalary(fixedSalaryAmount, hireDate, monthId) {
    const amount = toFiniteNumber(fixedSalaryAmount) || 0;
    if (amount <= 0) return 0;
    if (!hireDate || !isValidMonthId(monthId)) return round2(amount);

    const hireMonthId = String(hireDate).slice(0, 7);
    if (!isValidMonthId(hireMonthId)) return round2(amount);

    if (hireMonthId < monthId) return round2(amount); // hired before this month
    if (hireMonthId > monthId) return 0;               // not yet hired this month

    // Hired within this exact month: prorate from the hire day (inclusive)
    // to the end of the month.
    const [y, m] = monthId.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const hireDay = Number(String(hireDate).slice(8, 10)) || 1;
    const clampedDay = Math.min(Math.max(hireDay, 1), daysInMonth);
    const daysWorked = daysInMonth - clampedDay + 1;
    return round2((amount / daysInMonth) * daysWorked);
  }

  /** Rounds a monetary/hours value to 2 decimal places. */
  function round2(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  /** Reads the base (prorated) salary out of a report row. */
  function rowSalary(row) {
    if (!row) return 0;
    return toFiniteNumber(row.salary) || 0;
  }

  /**
   * Reference "worked hours per day" for a report row — an informational
   * snapshot of the employee's own `dailyWorkHours` field, taken at
   * calculation time. Never used in any salary math. Returns null for
   * rows that don't have it (including legacy rows from the old
   * hourly-salary system), rendered as "—".
   */
  function rowDailyHours(row) {
    if (!row) return null;
    return toFiniteNumber(row.dailyWorkHours);
  }

  /* ============================================================
   * DEPARTMENTS - BONUS RESOLUTION
   * ------------------------------------------------------------
   * Salary is:
   *   base salary (fixed, prorated by hire date)
   *   + bonus (BONUS-type departments only) + manual adjustments
   *   - advances - previous debt
   * ============================================================ */

  /**
   * Bonus rules for a department, falling back to the month's global
   * table. Same precedence chain as the rate: month snapshot, then the
   * department's live override, then the month's global rules.
   * Partial overrides are merged over the global table so a department
   * can override a single tier without restating all seven.
   */
  function resolveDepartmentBonusRules(departmentId, monthDeptRules, globalRules, liveRules) {
    const base = Object.assign({}, DEFAULT_BONUS_RULES, globalRules || {});

    if (departmentId && monthDeptRules && typeof monthDeptRules === 'object') {
      const snapshot = monthDeptRules[departmentId];
      if (snapshot && typeof snapshot === 'object') return Object.assign(base, snapshot);
    }
    if (liveRules && typeof liveRules === 'object') return Object.assign(base, liveRules);

    return base;
  }

  /**
   * The departmentId a report row belongs to. Rows written before the
   * departments feature have none - they are attributed to the
   * Moderators department, which is exactly where their employees were
   * migrated, so historical totals stay consistent with live data.
   */
  function rowDepartmentId(row, fallbackId) {
    if (!row) return fallbackId || null;
    return row.departmentId || fallbackId || null;
  }

  /**
   * The department NAME to show for a report row.
   *
   * Reads the row's own snapshot first and never falls back to the live
   * department list when one exists. This is the single rule that keeps
   * historical reports frozen: rename a department today and every past
   * report still prints the name it had when it was calculated.
   */
  function rowDepartmentName(row, fallbackName) {
    if (row && row.departmentName) return row.departmentName;
    return fallbackName || 'بدون قسم';
  }

  /* ============================================================
   * DEBT CARRY-OVER (ترحيل الديون)
   * ------------------------------------------------------------
   * When a moderator's advances (السلف) exceed what they earned in a
   * month, the shortfall must not be paid out as a negative salary.
   * Instead the month settles at zero and the remainder becomes a debt
   * that is deducted from the FOLLOWING month's salary.
   *
   * Each report row therefore carries two debt figures:
   *   previousDebt - debt inherited from the previous month (deducted)
   *   carriedDebt  - what this month could not cover, owed next month
   * ============================================================ */

  /**
   * Whether debt carry-over is enabled by default. Turning it off (in
   * Settings) reproduces the pre-carry-over behavior exactly: a month may
   * simply settle at a negative net salary and nothing is carried forward.
   */
  const DEFAULT_CARRY_DEBT = true;

  /**
   * Settles one moderator's month.
   *
   * net = salary + bonus + adjustments - advances - previousDebt
   *
   * `previousDebt` is ALWAYS deducted (it is recorded data, not a policy),
   * while `carryDebt` only governs whether a negative net turns into a new
   * debt for next month or is simply paid out as-is.
   *
   * Returns { finalSalary, carriedDebt } - both rounded to 2 decimals.
   */
  function settleSalary({ salary, totalBonus, totalAdjustments, totalAdvances,
                          previousDebt, carryDebt = DEFAULT_CARRY_DEBT } = {}) {
    const n = (v) => toFiniteNumber(v) || 0;

    const net = round2(
      n(salary) + n(totalBonus) + n(totalAdjustments) - n(totalAdvances) - n(previousDebt)
    );

    if (carryDebt === false) {
      return { finalSalary: net, carriedDebt: 0 };
    }
    if (net < 0) {
      return { finalSalary: 0, carriedDebt: round2(-net) };
    }
    return { finalSalary: net, carriedDebt: 0 };
  }

  /**
   * Debt figures for a report row, defaulting to 0 for legacy rows saved
   * before the carry-over system existed (they simply had no debt).
   */
  function rowPreviousDebt(row) {
    return row ? (toFiniteNumber(row.previousDebt) || 0) : 0;
  }

  function rowCarriedDebt(row) {
    return row ? (toFiniteNumber(row.carriedDebt) || 0) : 0;
  }

  /**
   * Builds a { moderatorId: carriedDebt } map from a stored monthly report,
   * skipping zero values so the map stays small. This is what the next
   * month reads as its `previousDebt`.
   */
  function carriedDebtMap(report) {
    const map = {};
    (report || []).forEach(r => {
      const d = rowCarriedDebt(r);
      if (r && r.moderatorId && d > 0) map[r.moderatorId] = d;
    });
    return map;
  }

  /* ============================================================
   * ORDERS PARSING - TEXT AREA (Method 1)
   * ============================================================ */

  /**
   * Parses raw multi-line text into orders.
   * Expected format per line: Name <whitespace/tab> Packages <whitespace/tab> Price
   * Supports multiple spaces and tabs as separators.
   *
   * Returns { orders: [{name, packages, price, lineNumber}], errors: [{lineNumber, message, raw}] }
   */
  function parseOrdersText(text) {
    const orders = [];
    const errors = [];

    if (!text || !text.trim()) {
      return { orders, errors };
    }

    const lines = text.split(/\r\n|\r|\n/);

    lines.forEach((rawLine, idx) => {
      const lineNumber = idx + 1;
      const line = rawLine.replace(/[\t\u00A0]+/g, ' ').trim();

      if (!line) return; // skip empty lines silently

      // Split on any run of whitespace
      const parts = line.split(/\s+/);

      if (parts.length < 3) {
        errors.push({
          lineNumber,
          message: 'بيانات ناقصة (يجب أن يحتوي السطر على: الاسم، عدد الطرود، السعر)',
          raw: rawLine
        });
        return;
      }

      // Price and packages are the last two tokens; everything before is the name
      // (handles names that contain spaces, e.g. "Ahmed Ali")
      const price = parts[parts.length - 1];
      const packages = parts[parts.length - 2];
      const name = parts.slice(0, parts.length - 2).join(' ');

      if (!name) {
        errors.push({ lineNumber, message: 'اسم المشرف مفقود', raw: rawLine });
        return;
      }

      const packagesNum = Number(packages);
      if (!Number.isFinite(packagesNum) || packagesNum <= 0 || !Number.isInteger(packagesNum)) {
        errors.push({ lineNumber, message: `عدد الطرود غير صالح: "${packages}"`, raw: rawLine });
        return;
      }

      const priceNum = Number(price);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        errors.push({ lineNumber, message: `السعر غير صالح: "${price}"`, raw: rawLine });
        return;
      }

      orders.push({
        name: cleanDisplayName(name),
        packages: packagesNum,
        price: priceNum,
        lineNumber
      });
    });

    return { orders, errors };
  }

  /* ============================================================
   * ORDERS PARSING - EXCEL (Method 2, requires SheetJS loaded globally as XLSX)
   * ============================================================
   * Two-step pipeline:
   *   1. analyzeExcelFile()   - reads the workbook, guesses which column is
   *      which field ("Smart Column Mapping"), and produces a full preview
   *      (orders + validation errors) using its best guess.
   *   2. applyManualMapping() - re-runs step 1's row validation against a
   *      mapping the user corrected by hand in the preview modal.
   * Both share buildOrdersFromMappedRows() for the actual per-row checks,
   * so "auto-detected" and "manually chosen" columns are validated
   * identically.
   */

  // Recognized aliases per field, matched after normalizeHeaderText(). Order
  // doesn't matter - detectColumnMapping() scores every alias and keeps the
  // best one.
  const IMPORT_COLUMN_ALIASES = {
    name: [
      'name', 'employee', 'employeename', 'moderator', 'moderatorname',
      'الاسم', 'اسم', 'اسمالمشرف', 'اسمالموظف', 'الموظف', 'المشرف', 'اسمالمستخدم'
    ],
    packages: [
      'packages', 'package', 'qty', 'quantity', 'count', 'orders', 'orderscount',
      'عدد', 'الطرود', 'طرود', 'عددالطرود', 'العبوات', 'عددالعبوات', 'الكمية', 'كمية',
      'عددالاوردرات', 'الاوردرات', 'اوردرات', 'عددالطلبات', 'الطلبات'
    ],
    price: [
      'price', 'unitprice', 'rate', 'cost',
      'السعر', 'سعر', 'سعرالطرد', 'سعرالطلب', 'سعرالوحدة'
    ],
    orderDate: ['date', 'orderdate', 'التاريخ', 'تاريخالطلب'],
    externalOrderNumber: ['ordernumber', 'orderno', 'orderid', 'رقمالطلب', 'رقمالاوردر', 'رقمالطلب'],
    customerName: ['customer', 'customername', 'client', 'clientname', 'اسمالعميل', 'العميل'],
    customerPhone: ['phone', 'mobile', 'telephone', 'customerphone', 'رقمالهاتف', 'الهاتف', 'الموبايل'],
    notes: ['notes', 'note', 'remarks', 'ملاحظات', 'ملاحظة'],
    fullAddress: ['address', 'fulladdress', 'العنوان', 'العنوانبالكامل'],
    productName: ['product', 'productname', 'item', 'اسممنتج', 'اسمالمنتج', 'المنتج'],
    waybillNumber: ['waybill', 'waybillnumber', 'tracking', 'trackingnumber', 'رقمالبوليصة', 'البوليصة'],
    governorate: ['governorate', 'governorate', 'province', 'المحافظة']
  };

  const IMPORT_MAPPING_CONFIDENCE_THRESHOLD = 0.55;

  /**
   * Normalizes a header cell for comparison against IMPORT_COLUMN_ALIASES:
   * lower-cases Latin letters, strips Arabic diacritics/Alef-Taa variants
   * (reusing normalizeName), then strips everything that isn't a letter or
   * digit so "عدد الطرود", "عدد-الطرود" and "Order Qty" all reduce to a
   * comparable token.
   */
  function normalizeHeaderText(rawHeader) {
    const base = normalizeName(rawHeader);
    return base.replace(/[^a-z0-9\u0600-\u06FF]/g, '');
  }

  /**
   * Scores how well a single (already-normalized) header token matches a
   * field's alias list. 1 = exact match, ~0.85 = one contains the other,
   * otherwise the best fuzzy similarity ratio found (0-1).
   */
  function scoreHeaderAgainstField(normalizedHeader, field) {
    if (!normalizedHeader) return 0;
    const aliases = IMPORT_COLUMN_ALIASES[field] || [];
    let best = 0;
    for (const alias of aliases) {
      if (normalizedHeader === alias) return 1;
      if (normalizedHeader.includes(alias) || alias.includes(normalizedHeader)) {
        best = Math.max(best, 0.85);
        continue;
      }
      best = Math.max(best, similarityRatio(normalizedHeader, alias));
    }
    return best;
  }

  /**
   * Given a header row (array of cell values), guesses which column index
   * holds each of name/packages/price. Greedily assigns the single best
   * remaining (column, field) score above the confidence threshold, so the
   * same column is never assigned to two fields.
   *
   * Returns { mapping: {name, packages, price} (col index or null),
   *           confidence: {name, packages, price} (0-1) }.
   */
  function detectColumnMapping(headerRow) {
    const fields = Object.keys(IMPORT_COLUMN_ALIASES);
    const mapping = Object.fromEntries(fields.map(field => [field, null]));
    const confidence = Object.fromEntries(fields.map(field => [field, 0]));

    const normalizedHeaders = (headerRow || []).map(normalizeHeaderText);

    // Build every (column, field) candidate score, then greedily take the
    // highest-scoring pairs first so a strong match "wins" its column
    // before a weaker one can claim it.
    const candidates = [];
    normalizedHeaders.forEach((h, colIdx) => {
      fields.forEach(field => {
        const score = scoreHeaderAgainstField(h, field);
        if (score >= IMPORT_MAPPING_CONFIDENCE_THRESHOLD) {
          candidates.push({ colIdx, field, score });
        }
      });
    });
    candidates.sort((a, b) => b.score - a.score);

    const usedCols = new Set();
    const usedFields = new Set();
    for (const c of candidates) {
      if (usedCols.has(c.colIdx) || usedFields.has(c.field)) continue;
      mapping[c.field] = c.colIdx;
      confidence[c.field] = c.score;
      usedCols.add(c.colIdx);
      usedFields.add(c.field);
    }

    return { mapping, confidence };
  }

  /**
   * Validates and converts already-mapped rows into orders, exactly like
   * the previous fixed-column parser did - just reading each value through
   * `mapping` instead of a hardcoded [0,1,2] position.
   */
  function buildOrdersFromMappedRows(dataRows, mapping, lineNumberOffset) {
    const orders = [];
    const errors = [];

    (dataRows || []).forEach((row, i) => {
      const lineNumber = lineNumberOffset + i;

      const isRowEmpty = !row || row.every(cell => String(cell).trim() === '');
      if (isRowEmpty) return; // skip silently, same as before

      const name = cleanDisplayName(row[mapping.name]);
      const packagesRaw = row[mapping.packages];
      const priceRaw = row[mapping.price];
      const packagesNum = Number(packagesRaw);
      const priceNum = Number(priceRaw);

      if (!name) {
        errors.push({ lineNumber, column: 'اسم المشرف', message: 'القيمة مفقودة', raw: JSON.stringify(row) });
        return;
      }
      if (!Number.isFinite(packagesNum) || packagesNum <= 0 || !Number.isInteger(packagesNum)) {
        errors.push({ lineNumber, column: 'عدد العبوات', message: `قيمة غير صحيحة: "${packagesRaw}"`, raw: JSON.stringify(row) });
        return;
      }
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        errors.push({ lineNumber, column: 'السعر', message: `قيمة غير صحيحة: "${priceRaw}"`, raw: JSON.stringify(row) });
        return;
      }

      const optional = (field) => mapping[field] === null || mapping[field] === undefined
        ? '' : cleanDisplayName(row[mapping[field]]);
      orders.push({
        name, packages: packagesNum, price: priceNum, lineNumber,
        orderDate: optional('orderDate'), externalOrderNumber: optional('externalOrderNumber'),
        customerName: optional('customerName'), customerPhone: optional('customerPhone'),
        notes: optional('notes'), fullAddress: optional('fullAddress'), productName: optional('productName'),
        waybillNumber: optional('waybillNumber'), governorate: optional('governorate'),
        shipmentStatus: 'لم يتم التحديث'
      });
    });

    return { orders, errors };
  }

  /**
   * Full analysis of an uploaded Excel file for the import-preview modal.
   * Reads the workbook, decides whether row 0 is a header (and maps its
   * columns) or plain data (falls back to the historical name/packages/price
   * column order with a lower confidence, so the preview still flags it for
   * review), then validates every data row against that mapping.
   *
   * Returns:
   *   { parseError: string } on an unreadable file, OR
   *   {
   *     headers: string[],              // display labels for the mapping dropdowns
   *     hasHeaderRow: boolean,
   *     rawDataRows: any[][],           // rows after the header (for re-mapping later)
   *     lineNumberOffset: number,       // first data row's 1-based line number
   *     mapping: {name, packages, price},
   *     confidence: {name, packages, price},
   *     needsManualMapping: boolean,
   *     orders: [...], errors: [...]
   *   }
   */
  function analyzeExcelFile(arrayBuffer) {
    const parseError = (error) => {
      const detail = error && typeof error.message === 'string' && error.message.trim()
        ? error.message.trim()
        : 'صيغة ملف Excel غير صالحة أو غير مدعومة';
      return { parseError: `تعذر قراءة ملف Excel: ${detail}` };
    };

    // Read exclusively through SheetJS's public workbook API. In
    // particular, never derive or address an internal ZIP entry such as
    // `xl/worksheets/sheet*.xml`: the workbook itself owns that mapping.
    if (typeof XLSX === 'undefined' || typeof XLSX.read !== 'function' ||
        !XLSX.utils || typeof XLSX.utils.sheet_to_json !== 'function') {
      return { parseError: 'تعذر قراءة ملف Excel: مكتبة Excel غير متاحة حاليًا' };
    }

    let workbook;
    let sheetName;
    let sheet;
    let rows;
    try {
      workbook = XLSX.read(arrayBuffer, { type: 'array' });
      sheetName = Array.isArray(workbook.SheetNames) ? workbook.SheetNames[0] : null;
      if (!sheetName || !workbook.Sheets || !workbook.Sheets[sheetName]) {
        return { parseError: 'تعذر قراءة ملف Excel: لا توجد ورقة عمل قابلة للقراءة' };
      }
      sheet = workbook.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    } catch (e) {
      // Preserve SheetJS's diagnostic (for example a missing ZIP worksheet)
      // so an Excel-reading failure can never be mistaken for Firestore
      // permissions by the administrator.
      return parseError(e);
    }

    if (!rows || rows.length === 0) {
      return { parseError: 'الملف فارغ ولا يحتوي على أي بيانات' };
    }

    const firstRow = rows[0];
    let { mapping, confidence } = detectColumnMapping(firstRow);
    const hasHeaderRow = mapping.name !== null || mapping.packages !== null || mapping.price !== null;

    let headers;
    let dataRows;
    let lineNumberOffset;

    if (hasHeaderRow) {
      headers = firstRow.map(h => cleanDisplayName(h) || '(بدون عنوان)');
      dataRows = rows.slice(1);
      lineNumberOffset = 2; // row 1 is the header, data starts at spreadsheet row 2
    } else {
      // No recognizable header - assume the historical fixed column order
      // (name, packages, price) and label columns positionally so the
      // mapping dropdowns still make sense to the user.
      const maxCols = rows.reduce((m, r) => Math.max(m, (r || []).length), 0);
      headers = Array.from({ length: Math.max(maxCols, 3) }, (_, i) => `العمود ${i + 1}`);
      mapping = { name: 0, packages: 1, price: 2 };
      confidence = { name: 0.4, packages: 0.4, price: 0.4 };
      dataRows = rows;
      lineNumberOffset = 1;
    }

    const needsManualMapping = ['name', 'packages', 'price'].some(
      f => mapping[f] === null || confidence[f] < IMPORT_MAPPING_CONFIDENCE_THRESHOLD
    );

    const { orders, errors } = buildOrdersFromMappedRows(dataRows, mapping, lineNumberOffset);

    return {
      headers, hasHeaderRow, rawDataRows: dataRows, lineNumberOffset,
      mapping, confidence, needsManualMapping, orders, errors
    };
  }

  /**
   * Re-validates the same raw data rows against a mapping the user picked
   * by hand in the preview modal (used by the "تحديث المعاينة" button).
   */
  function applyManualMapping(rawDataRows, mapping, lineNumberOffset) {
    return buildOrdersFromMappedRows(rawDataRows, mapping, lineNumberOffset);
  }

  /* ============================================================
   * SAVED EXCEL COLUMN MAPPING
   * ============================================================ */

  const SAVED_IMPORT_MAPPING_STORAGE_KEY = 'moderatorSalary.lastImportColumnMapping.v1';
  const IMPORT_MAPPING_FIELDS = ['name', 'packages', 'price'];

  /** Saves the most recently successful Excel mapping together with the
   * exact column labels it belongs to. Storage failures (for example private
   * browsing restrictions) are deliberately non-blocking for an import. */
  function saveLastImportColumnMapping(headers, mapping) {
    const savedHeaders = Array.isArray(headers) ? headers.map(header => String(header)) : [];
    const savedMapping = {};
    for (const field of IMPORT_MAPPING_FIELDS) {
      const index = mapping && mapping[field];
      if (!Number.isInteger(index) || index < 0 || index >= savedHeaders.length) return false;
      savedMapping[field] = index;
    }

    try {
      localStorage.setItem(SAVED_IMPORT_MAPPING_STORAGE_KEY, JSON.stringify({
        headers: savedHeaders,
        mapping: savedMapping
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Returns a validated saved mapping, or null when none is available. */
  function loadLastImportColumnMapping() {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVED_IMPORT_MAPPING_STORAGE_KEY));
      if (!saved || !Array.isArray(saved.headers) || !saved.mapping) return null;
      const headers = saved.headers.map(header => String(header));
      const mapping = {};
      for (const field of IMPORT_MAPPING_FIELDS) {
        const index = saved.mapping[field];
        if (!Number.isInteger(index) || index < 0 || index >= headers.length) return null;
        mapping[field] = index;
      }
      return { headers, mapping };
    } catch (_) {
      return null;
    }
  }

  /** Column labels must match in both content and order before an old mapping
   * can be trusted. A different layout intentionally falls back to Smart
   * Mapping instead of guessing from stale column indexes. */
  function importHeadersMatch(headers, savedHeaders) {
    if (!Array.isArray(headers) || !Array.isArray(savedHeaders) || headers.length !== savedHeaders.length) {
      return false;
    }
    return headers.every((header, index) => String(header) === String(savedHeaders[index]));
  }

  /* ============================================================
   * FORMATTING HELPERS
   * ============================================================ */

  function formatCurrency(value) {
    const n = Number(value) || 0;
    return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ج.م';
  }

  function formatNumber(value) {
    const n = Number(value) || 0;
    return n.toLocaleString('en-US');
  }

  /**
   * Formats an hours value (decimals preserved, up to 2 places).
   * Missing/blank values render as an em dash, which is how legacy report
   * rows from before the hours system are displayed.
   */
  function formatHours(value) {
    const n = toFiniteNumber(value);
    if (n === null) return '—';
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' س';
  }

  function formatDate(date) {
    const d = (date instanceof Date) ? date : new Date(date);
    return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  /**
   * Formats an approximate byte count for display: "512 بايت", "48.2 ك.ب",
   * "1.4 م.ب".
   *
   * Used for backup sizes, which are ESTIMATES computed client-side (see
   * ServiceCommon.estimateSize) - Firestore's real storage accounting isn't
   * reproducible in the browser. The UI labels them as approximate wherever
   * they appear rather than presenting a precise-looking figure that would
   * be quietly wrong.
   */
  function formatBytes(bytes) {
    const n = toFiniteNumber(bytes);
    if (n === null || n < 0) return '—';
    if (n < 1024) return `${Math.round(n)} بايت`;
    if (n < 1024 * 1024) return `${round2(n / 1024).toLocaleString('en-US')} ك.ب`;
    return `${round2(n / (1024 * 1024)).toLocaleString('en-US')} م.ب`;
  }

  /**
   * Coerces the many shapes a "moment" arrives in into a real Date:
   * a Firestore Timestamp ({toDate()}), a Date, an ISO string, or epoch ms.
   * Returns null for anything unusable - including a Timestamp field that
   * is still null because `serverTimestamp()` hasn't resolved yet, which
   * is exactly what a local write looks like for a few milliseconds.
   */
  function toDateSafe(value) {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value.toDate === 'function') {
      try {
        const d = value.toDate();
        return (d instanceof Date && !isNaN(d.getTime())) ? d : null;
      } catch (err) {
        return null;
      }
    }
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  /** Date + time, for audit-log rows and "closed at" labels. */
  function formatDateTime(value) {
    const d = toDateSafe(value);
    if (!d) return '—';
    return d.toLocaleString('ar-EG', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  /** Converts a JS Date to a Firestore-friendly month id, e.g. "2026-08" */
  function monthIdFromDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  const ARABIC_MONTHS = [
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
  ];

  /** True for a well-formed month id such as "2026-08". */
  function isValidMonthId(monthId) {
    return typeof monthId === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthId);
  }

  /** Converts month id "2026-08" to Arabic label "أغسطس 2026" */
  function monthLabelFromId(monthId) {
    if (!isValidMonthId(monthId)) return String(monthId || '-');
    const [y, m] = monthId.split('-').map(Number);
    return `${ARABIC_MONTHS[m - 1]} ${y}`;
  }

  /**
   * The calendar month immediately before `monthId` ("2026-01" -> "2025-12").
   * Used by the debt carry-over engine to find where a moderator's
   * `previousDebt` comes from. Returns null for a malformed id.
   */
  function previousMonthId(monthId) {
    if (!isValidMonthId(monthId)) return null;
    let [y, m] = monthId.split('-').map(Number);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
    return `${y}-${String(m).padStart(2, '0')}`;
  }

  /** The calendar month immediately after `monthId`. */
  function nextMonthId(monthId) {
    if (!isValidMonthId(monthId)) return null;
    let [y, m] = monthId.split('-').map(Number);
    m += 1;
    if (m === 13) { m = 1; y += 1; }
    return `${y}-${String(m).padStart(2, '0')}`;
  }

  /**
   * Compares two month ids chronologically: negative when `a` is earlier,
   * positive when later, 0 when equal or either is malformed.
   *
   * A plain string comparison already sorts "YYYY-MM" correctly, so this
   * is really about intent: callers that mean "is this month before that
   * one" read better - and can't accidentally compare a month id against
   * a full date string - going through here.
   */
  function compareMonthIds(a, b) {
    if (!isValidMonthId(a) || !isValidMonthId(b)) return 0;
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  /* ============================================================
   * MISC
   * ============================================================ */

  function debounce(fn, delay = 250) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function uid() {
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  return {
    normalizeName,
    cleanDisplayName,
    levenshtein,
    similarityRatio,
    findBestModeratorMatch,
    calculateOrderBonus,
    calculateBonus,
    DEFAULT_BONUS_RULES,
    packageBucket,
    toFiniteNumber,
    round2,
    calculateBaseSalary,
    rowSalary,
    rowDailyHours,
    resolveDepartmentBonusRules,
    rowDepartmentId,
    rowDepartmentName,
    DEFAULT_CARRY_DEBT,
    settleSalary,
    rowPreviousDebt,
    rowCarriedDebt,
    carriedDebtMap,
    parseOrdersText,
    analyzeExcelFile,
    applyManualMapping,
    saveLastImportColumnMapping,
    loadLastImportColumnMapping,
    importHeadersMatch,
    formatCurrency,
    formatNumber,
    formatHours,
    formatBytes,
    formatDate,
    toDateSafe,
    formatDateTime,
    monthIdFromDate,
    monthLabelFromId,
    isValidMonthId,
    previousMonthId,
    nextMonthId,
    compareMonthIds,
    debounce,
    escapeHtml,
    uid
  };
})();
