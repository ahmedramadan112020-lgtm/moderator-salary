/**
 * reports.js
 * -----------------------------------------------------------------------
 * Everything related to turning a computed report array into an
 * exportable/printable artifact:
 *   - Export to Excel (SheetJS)
 *   - Export to PDF (jsPDF, manual table drawing — no autotable dependency)
 *   - Copy report to clipboard (tab-separated, pastes cleanly into Excel)
 *   - A4 print view (company header, summary, table, signatures)
 * -----------------------------------------------------------------------
 */

'use strict';

const Reports = (() => {

  const HEADERS = ['اسم الموظف', 'القسم', 'ساعات العمل', 'الراتب الأساسي', 'إجمالي البونص',
                   'تسويات يدوية', 'السلف', 'دين سابق', 'صافي المستحق',
                   'مرحّل للشهر القادم', 'عدد الطلبات', 'عدد الطرود', 'إجمالي المبيعات'];

  const DEPT_HEADERS = ['القسم', 'عدد الموظفين', 'إجمالي الراتب الأساسي', 'إجمالي البونص',
                        'إجمالي التسويات', 'إجمالي الخصومات', 'ديون مرحّلة', 'صافي المستحقات'];

  /**
   * One row of raw (unformatted) values per report row, in HEADERS order.
   * Salary, hours and both debt figures are read through the Utils
   * accessors so reports saved before the hourly-salary / debt-carry-over
   * systems still export correctly (they simply read as 0 / "—").
   *
   * The department column reads the row's own NAME SNAPSHOT, so exporting
   * a historical month prints the department names as they were when it
   * was calculated - never today's names.
   */
  function rowsFromReport(report) {
    return (report || []).map(r => {
      const hours = Utils.rowDailyHours(r);
      return [
        r.name,
        Utils.rowDepartmentName(r, ''),
        hours === null ? '' : hours,
        Utils.rowSalary(r),
        Number(r.totalBonus) || 0,
        Number(r.totalAdjustments) || 0,
        Number(r.totalAdvances) || 0,
        Utils.rowPreviousDebt(r),
        Number(r.finalSalary) || 0,
        Utils.rowCarriedDebt(r),
        Number(r.ordersCount) || 0,
        Number(r.totalPackages) || 0,
        Number(r.totalSales) || 0
      ];
    });
  }

  /**
   * The single source of truth for the totals row, in HEADERS order.
   * Every export (Excel, PDF, clipboard, print) builds its footer from this
   * one function, so the columns can never drift out of alignment.
   */
  function totalsRow(totals, label = 'الإجمالي', scopeLabel = '') {
    return [
      label,
      scopeLabel,
      totals.workedHours,
      totals.salary,
      totals.totalBonus,
      totals.totalAdjustments,
      totals.totalAdvances,
      totals.previousDebt,
      totals.finalSalary,
      totals.carriedDebt,
      totals.ordersCount,
      totals.totalPackages,
      totals.totalSales
    ];
  }

  const MONEY_KEYS = ['workedHours', 'salary', 'totalSales', 'totalBonus',
                      'totalAdjustments', 'totalAdvances', 'previousDebt',
                      'carriedDebt', 'finalSalary'];

  function computeTotals(report) {
    const totals = (report || []).reduce((acc, r) => {
      acc.workedHours += Utils.rowDailyHours(r) || 0;
      acc.salary += Utils.rowSalary(r);
      acc.ordersCount += Number(r.ordersCount) || 0;
      acc.totalPackages += Number(r.totalPackages) || 0;
      acc.totalSales += Number(r.totalSales) || 0;
      acc.totalBonus += Number(r.totalBonus) || 0;
      acc.totalAdjustments += Number(r.totalAdjustments) || 0;
      acc.totalAdvances += Number(r.totalAdvances) || 0;
      acc.previousDebt += Utils.rowPreviousDebt(r);
      acc.carriedDebt += Utils.rowCarriedDebt(r);
      acc.finalSalary += Number(r.finalSalary) || 0;
      return acc;
    }, {
      workedHours: 0, salary: 0, ordersCount: 0, totalPackages: 0, totalSales: 0,
      totalBonus: 0, totalAdjustments: 0, totalAdvances: 0, previousDebt: 0,
      carriedDebt: 0, finalSalary: 0
    });

    // Fractional hours make float drift possible - round the accumulated
    // money/hours figures so exported totals are always clean.
    MONEY_KEYS.forEach(k => { totals[k] = Utils.round2(totals[k]); });
    return totals;
  }

  /* ============================================================
   * DEPARTMENT TOTALS  (Approved architecture: OPTION B)
   * ------------------------------------------------------------
   * Department summaries are computed ONCE, at calculation time, and
   * stored inside the monthly report document as `departmentTotals`.
   *
   * Why that makes history immutable:
   *   * `departmentName` is a SNAPSHOT taken at calculation time, so
   *     renaming a department later never rewrites an old report.
   *   * The summary is derived from the frozen report rows, not from the
   *     live employee list, so an employee changing department later
   *     cannot move historical money between departments.
   *   * Archiving a department doesn't remove it from anything: its
   *     summary is already inside every month it participated in.
   *
   * Reading side: the app renders the STORED array verbatim. This
   * function is only ever called again for a month that has no stored
   * array yet (i.e. calculated before this feature shipped), and even
   * then it derives from the immutable report rows.
   * ============================================================ */

  /**
   * @param {Array}  report  the month's report rows
   * @param {object} options fallbacks for rows with no departmentId
   *                 (reports calculated before departments existed)
   * @returns {Array} [{ departmentId, departmentName, employeeCount,
   *                     totalHours, totalSalary, totalBonus,
   *                     totalAdvances, totalAdjustments, previousDebt,
   *                     carriedDebt, finalSalary, ordersCount,
   *                     totalPackages, totalSales }]
   */
  function buildDepartmentTotals(report, options = {}) {
    const fallbackId = options.fallbackDepartmentId || 'dept-moderators';
    const fallbackName = options.fallbackDepartmentName || 'Moderators';

    const byDept = new Map();

    (report || []).forEach(r => {
      const departmentId = Utils.rowDepartmentId(r, fallbackId);
      const departmentName = Utils.rowDepartmentName(r, fallbackName);

      let d = byDept.get(departmentId);
      if (!d) {
        d = {
          departmentId,
          // First row wins the snapshot. Every row of the same department
          // in one calculation carries the identical name anyway.
          departmentName,
          employeeCount: 0,
          totalHours: 0,
          totalSalary: 0,
          totalBonus: 0,
          totalAdvances: 0,
          // Beyond the required six fields, these make the stored summary
          // sufficient on its own for per-department reporting without
          // ever re-reading the rows.
          totalAdjustments: 0,
          previousDebt: 0,
          carriedDebt: 0,
          finalSalary: 0,
          ordersCount: 0,
          totalPackages: 0,
          totalSales: 0
        };
        byDept.set(departmentId, d);
      }

      d.employeeCount += 1;
      d.totalHours += Utils.rowDailyHours(r) || 0;
      d.totalSalary += Utils.rowSalary(r);
      d.totalBonus += Number(r.totalBonus) || 0;
      d.totalAdvances += Number(r.totalAdvances) || 0;
      d.totalAdjustments += Number(r.totalAdjustments) || 0;
      d.previousDebt += Utils.rowPreviousDebt(r);
      d.carriedDebt += Utils.rowCarriedDebt(r);
      d.finalSalary += Number(r.finalSalary) || 0;
      d.ordersCount += Number(r.ordersCount) || 0;
      d.totalPackages += Number(r.totalPackages) || 0;
      d.totalSales += Number(r.totalSales) || 0;
    });

    const ROUND_KEYS = ['totalHours', 'totalSalary', 'totalBonus', 'totalAdvances',
                        'totalAdjustments', 'previousDebt', 'carriedDebt',
                        'finalSalary', 'totalSales'];

    return Array.from(byDept.values())
      .map(d => {
        ROUND_KEYS.forEach(k => { d[k] = Utils.round2(d[k]); });
        return d;
      })
      .sort((a, b) => String(a.departmentName).localeCompare(String(b.departmentName), 'ar'));
  }

  /** Rows for the department-summary block of an export, in DEPT_HEADERS order. */
  function departmentRows(departmentTotals) {
    return (departmentTotals || []).map(d => [
      d.departmentName,
      Number(d.employeeCount) || 0,
      Number(d.totalSalary) || 0,
      Number(d.totalBonus) || 0,
      Number(d.totalAdjustments) || 0,
      Utils.round2((Number(d.totalAdvances) || 0) + (Number(d.previousDebt) || 0)),
      Number(d.carriedDebt) || 0,
      Number(d.finalSalary) || 0
    ]);
  }

  /** Normalizes the optional export context passed in by app.js. */
  function normalizeContext(context) {
    const c = context || {};
    return {
      scopeLabel: c.scopeLabel || 'كل الأقسام',
      isCompanyView: c.isCompanyView !== false,
      departmentTotals: Array.isArray(c.departmentTotals) ? c.departmentTotals : []
    };
  }

  /* ============================================================
   * EXCEL EXPORT (SheetJS)
   * ============================================================ */

  /**
   * Two sheets: the employee-level report, plus a "الأقسام" sheet built
   * from the STORED departmentTotals (Company View only - a
   * single-department export doesn't need a one-row breakdown).
   */
  function exportExcel(report, monthLabel, context) {
    const ctx = normalizeContext(context);
    const totals = computeTotals(report);
    const data = [
      HEADERS,
      ...rowsFromReport(report),
      totalsRow(totals, 'الإجمالي', ctx.scopeLabel)
    ];

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 12 }, { wch: 16 }, { wch: 14 },
                   { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 18 },
                   { wch: 12 }, { wch: 12 }, { wch: 16 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'التقرير');

    if (ctx.isCompanyView && ctx.departmentTotals.length > 0) {
      const deptData = [DEPT_HEADERS, ...departmentRows(ctx.departmentTotals)];
      const deptWs = XLSX.utils.aoa_to_sheet(deptData);
      deptWs['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 18 }, { wch: 14 },
                         { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 18 }];
      XLSX.utils.book_append_sheet(wb, deptWs, 'الأقسام');
    }

    const scopeSuffix = ctx.isCompanyView ? '' : `-${ctx.scopeLabel}`;
    XLSX.writeFile(wb, `تقرير-الرواتب-${monthLabel}${scopeSuffix}.xlsx`);
  }

  /* ============================================================
   * PDF EXPORT (jsPDF)
   * ============================================================ */

  function exportPDF(report, monthLabel, companyName, context) {
    const ctx = normalizeContext(context);
    const { jsPDF } = window.jspdf;
    // Landscape: the report is 13 columns wide and does not fit A4 portrait
    // (portrait gives ~515pt of usable width, the table needs ~750pt).
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

    const pageWidth = doc.internal.pageSize.getWidth();    // 842pt
    const pageHeight = doc.internal.pageSize.getHeight();  // 595pt
    const marginX = 40;
    const bottomLimit = pageHeight - 50;

    // Table header (English labels used in the PDF for reliable font rendering,
    // since jsPDF's default fonts do not support Arabic glyphs without an
    // embedded custom font. The Excel export and on-screen/print report use
    // full Arabic; the PDF is the numeric-summary companion export.)
    // Widths total 762pt and fit the 762pt of usable landscape A4 width.
    const colWidths = [92, 74, 40, 62, 50, 52, 50, 52, 62, 72, 42, 52, 62];
    const headers = ['Employee', 'Department', 'Hours', 'Base Salary', 'Bonus', 'Adjust',
                     'Advance', 'PrevDebt', 'Net Payable', 'Carried', 'Orders',
                     'Packages', 'Sales'];

    /** Draws the dark header band and returns the y for the first data row. */
    function drawTableHeader(atY) {
      let x = marginX;
      doc.setFillColor(30, 33, 43);
      doc.rect(marginX, atY - 12, pageWidth - marginX * 2, 20, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(7.5);
      headers.forEach((h, i) => {
        doc.text(h, x + 3, atY + 2);
        x += colWidths[i];
      });
      doc.setTextColor(20, 20, 20);
      doc.setFontSize(7.5);
      return atY + 16;
    }

    /** Truncates a cell so long department/employee names can't overlap. */
    function fit(value, width) {
      const s = (value === '' || value === null || value === undefined) ? '-' : String(value);
      const max = Math.max(3, Math.floor((width - 6) / 3.6));
      return s.length > max ? s.slice(0, max - 1) + '…' : s;
    }

    let y = 44;
    doc.setFontSize(16);
    doc.text(companyName || 'Company Report', pageWidth / 2, y, { align: 'center' });
    y += 20;
    doc.setFontSize(11);
    doc.text(`Month: ${monthLabel}`, pageWidth / 2, y, { align: 'center' });
    y += 15;

    // Scope line: makes it unambiguous whether this is the whole company
    // or one department.
    doc.text(ctx.isCompanyView ? 'Scope: Entire Company' : `Department: ${ctx.scopeLabel}`,
             pageWidth / 2, y, { align: 'center' });
    y += 15;

    doc.text(`Generated: ${new Date().toLocaleDateString('en-GB')}`, pageWidth / 2, y, { align: 'center' });
    y += 26;

    y = drawTableHeader(y);

    const rows = rowsFromReport(report);
    rows.forEach((values, idx) => {
      if (y > bottomLimit) {
        doc.addPage();
        y = drawTableHeader(44);
      }
      if (idx % 2 === 0) {
        doc.setFillColor(245, 246, 248);
        doc.rect(marginX, y - 10, pageWidth - marginX * 2, 16, 'F');
      }
      let x = marginX;
      values.forEach((v, i) => {
        doc.text(fit(v, colWidths[i]), x + 3, y);
        x += colWidths[i];
      });
      y += 16;
    });

    // Totals row
    const totals = computeTotals(report);
    if (y > bottomLimit - 16) {
      doc.addPage();
      y = drawTableHeader(44);
    }
    y += 6;
    doc.setDrawColor(180, 180, 180);
    doc.line(marginX, y - 10, pageWidth - marginX, y - 10);
    doc.setFontSize(7.5);
    doc.setTextColor(20, 20, 20);
    let tx = marginX;
    totalsRow(totals, 'TOTAL', '').forEach((v, i) => {
      doc.text(fit(v, colWidths[i]), tx + 3, y);
      tx += colWidths[i];
    });
    y += 24;

    // Company-wide department breakdown, straight from the stored snapshot.
    if (ctx.isCompanyView && ctx.departmentTotals.length > 0) {
      const deptCols = [125, 70, 92, 75, 80, 90, 90, 120];
      const deptHeaders = ['Department', 'Employees', 'Base Salary', 'Bonus',
                           'Adjustments', 'Deductions', 'Carried', 'Net Payable'];

      if (y > bottomLimit - 60) { doc.addPage(); y = 50; }

      doc.setFontSize(11);
      doc.text('Department Summary', marginX, y);
      y += 12;

      let dx = marginX;
      doc.setFillColor(30, 33, 43);
      doc.rect(marginX, y - 10, deptCols.reduce((a, b) => a + b, 0), 18, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(8);
      deptHeaders.forEach((h, i) => { doc.text(h, dx + 3, y + 2); dx += deptCols[i]; });
      doc.setTextColor(20, 20, 20);
      y += 18;

      departmentRows(ctx.departmentTotals).forEach((values, idx) => {
        if (y > bottomLimit) { doc.addPage(); y = 50; }
        if (idx % 2 === 0) {
          doc.setFillColor(245, 246, 248);
          doc.rect(marginX, y - 10, deptCols.reduce((a, b) => a + b, 0), 16, 'F');
        }
        let cx = marginX;
        values.forEach((v, i) => { doc.text(fit(v, deptCols[i]), cx + 3, y); cx += deptCols[i]; });
        y += 16;
      });
    }

    const scopeSuffix = ctx.isCompanyView ? '' : '-department';
    doc.save(`salary-report-${monthLabel}${scopeSuffix}.pdf`);
  }

  /* ============================================================
   * COPY TO CLIPBOARD (tab-separated -> pastes as columns in Excel/Sheets)
   * ============================================================ */

  async function copyReport(report) {
    const totals = computeTotals(report);
    const lines = [
      HEADERS.join('\t'),
      ...rowsFromReport(report).map(r => r.join('\t')),
      totalsRow(totals).join('\t')
    ];
    const text = lines.join('\n');
    await navigator.clipboard.writeText(text);
  }

  /* ============================================================
   * PRINT VIEW (A4 professional report)
   * ============================================================ */

  function buildPrintHtml(report, monthLabel, settings, context) {
    const ctx = normalizeContext(context);
    const totals = computeTotals(report);
    const companyName = settings?.companyName || 'اسم الشركة';
    const today = Utils.formatDate(new Date());

    const rowsHtml = report.map(r => {
      const hours = Utils.rowDailyHours(r);
      const prevDebt = Utils.rowPreviousDebt(r);
      const carried = Utils.rowCarriedDebt(r);
      return `
      <tr>
        <td>${Utils.escapeHtml(r.name)}</td>
        <td>${Utils.escapeHtml(Utils.rowDepartmentName(r, '—'))}</td>
        <td>${hours === null ? '—' : Utils.formatNumber(hours)}</td>
        <td>${Utils.formatNumber(Utils.rowSalary(r))}</td>
        <td>${Utils.formatNumber(r.totalBonus)}</td>
        <td>${Utils.formatNumber(r.totalAdjustments || 0)}</td>
        <td>${Utils.formatNumber(r.totalAdvances || 0)}</td>
        <td${prevDebt > 0 ? ' class="debt"' : ''}>${Utils.formatNumber(prevDebt)}</td>
        <td>${Utils.formatNumber(r.finalSalary)}</td>
        <td${carried > 0 ? ' class="debt"' : ''}>${Utils.formatNumber(carried)}</td>
        <td>${Utils.formatNumber(r.ordersCount)}</td>
        <td>${Utils.formatNumber(r.totalPackages)}</td>
        <td>${Utils.formatNumber(r.totalSales)}</td>
      </tr>`;
    }).join('');

    // Department summary block, printed from the STORED snapshot so a
    // reprinted historical report always shows the original names/figures.
    const deptHtml = (ctx.isCompanyView && ctx.departmentTotals.length > 0) ? `
      <h2 class="section-title">ملخص الأقسام</h2>
      <table class="dept-table">
        <thead><tr>${DEPT_HEADERS.map(h => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>
          ${departmentRows(ctx.departmentTotals).map(v => `
            <tr>
              <td>${Utils.escapeHtml(v[0])}</td>
              <td>${Utils.formatNumber(v[1])}</td>
              <td>${Utils.formatNumber(v[2])}</td>
              <td>${Utils.formatNumber(v[3])}</td>
              <td>${Utils.formatNumber(v[4])}</td>
              <td>${Utils.formatNumber(v[5])}</td>
              <td>${Utils.formatNumber(v[6])}</td>
              <td>${Utils.formatNumber(v[7])}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : '';

    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>تقرير الرواتب - ${monthLabel}</title>
<style>
  /* Landscape: the report is 13 columns wide and is unreadable squeezed
     into A4 portrait. Same reasoning as the jsPDF export. */
  @page { size: A4 landscape; margin: 12mm 10mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Cairo', Arial, sans-serif; color: #111; direction: rtl; }
  .header { text-align: center; margin-bottom: 14px; border-bottom: 2px solid #222; padding-bottom: 10px; }
  .header h1 { margin: 0 0 6px; font-size: 19px; }
  .header p { margin: 2px 0; font-size: 11.5px; color: #444; }
  .scope { font-weight: 700; color: #111; }
  .summary { display: flex; flex-wrap: wrap; justify-content: space-around; gap: 8px; margin: 14px 0; }
  .summary div { text-align: center; }
  .summary .val { font-size: 15px; font-weight: 700; }
  .summary .lbl { font-size: 10.5px; color: #555; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 9px; table-layout: fixed; }
  th, td { border: 1px solid #999; padding: 4px 3px; text-align: center; word-wrap: break-word; }
  th:first-child, td:first-child { width: 11%; }
  th:nth-child(2), td:nth-child(2) { width: 10%; }
  th { background: #222; color: #fff; }
  td.debt { color: #b91c1c; font-weight: 700; }
  tfoot td { font-weight: 700; background: #eee; }
  tbody tr { page-break-inside: avoid; }
  thead { display: table-header-group; }
  .section-title { font-size: 14px; margin: 22px 0 4px; padding-bottom: 4px; border-bottom: 1px solid #333; }
  .dept-table { font-size: 10.5px; page-break-inside: avoid; }
  .dept-table th:first-child, .dept-table td:first-child { width: 22%; }
  .dept-table th:nth-child(2), .dept-table td:nth-child(2) { width: 13%; }
  .signatures { display: flex; justify-content: space-between; margin-top: 48px; }
  .signatures div { width: 34%; text-align: center; border-top: 1px solid #333; padding-top: 6px; font-size: 11.5px; }
</style>
</head>
<body>
  <div class="header">
    <h1>${Utils.escapeHtml(companyName)}</h1>
    <p>تقرير الرواتب والبونص - ${monthLabel}</p>
    <p class="scope">${ctx.isCompanyView
        ? 'النطاق: كل الشركة'
        : `القسم: ${Utils.escapeHtml(ctx.scopeLabel)}`}</p>
    <p>تاريخ الطباعة: ${today}</p>
  </div>

  <div class="summary">
    <div><div class="val">${Utils.formatNumber(report.length)}</div><div class="lbl">عدد الموظفين</div></div>
    <div><div class="val">${Utils.formatNumber(totals.workedHours)}</div><div class="lbl">إجمالي الساعات</div></div>
    <div><div class="val">${Utils.formatNumber(totals.salary)}</div><div class="lbl">إجمالي الراتب الأساسي</div></div>
    <div><div class="val">${Utils.formatNumber(totals.totalBonus)}</div><div class="lbl">إجمالي البونص</div></div>
    <div><div class="val">${Utils.formatNumber(totals.totalAdjustments)}</div><div class="lbl">إجمالي التسويات</div></div>
    <div><div class="val">${Utils.formatNumber(Utils.round2(totals.totalAdvances + totals.previousDebt))}</div><div class="lbl">إجمالي الخصومات</div></div>
    <div><div class="val">${Utils.formatNumber(totals.finalSalary)}</div><div class="lbl">صافي المستحقات</div></div>
  </div>

  <table>
    <thead>
      <tr>${HEADERS.map(h => `<th>${h}</th>`).join('')}</tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr>
        ${totalsRow(totals, 'الإجمالي', ctx.scopeLabel)
          .map((v, i) => `<td>${(i === 0 || i === 1) ? Utils.escapeHtml(v) : Utils.formatNumber(v)}</td>`)
          .join('')}
      </tr>
    </tfoot>
  </table>

  ${deptHtml}

  <div class="signatures">
    <div>توقيع المدير</div>
    <div>توقيع المحاسب</div>
  </div>
</body>
</html>`;
  }

  function printReport(report, monthLabel, settings, context) {
    const html = buildPrintHtml(report, monthLabel, settings, context);
    const win = window.open('', '_blank', 'width=900,height=1000');
    if (!win) {
      alert('الرجاء السماح بالنوافذ المنبثقة لطباعة التقرير');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.onload = () => {
      win.focus();
      win.print();
    };
  }

  return {
    exportExcel, exportPDF, copyReport, printReport,
    computeTotals, buildDepartmentTotals
  };
})();
