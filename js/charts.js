/**
 * charts.js
 * -----------------------------------------------------------------------
 * All Chart.js instances used on the Dashboard view:
 *   - Top Sales Employees       (horizontal bar)
 *   - Top Bonus Employees       (horizontal bar)
 *   - Packages Distribution     (doughnut, by bucket 1..9,10+)
 *   - Department Salaries       (doughnut in Company View) /
 *     Sales Distribution        (line/area in a single-department view)
 *
 * Every chart is filter-aware: `renderAllCharts` receives the rows already
 * scoped to the active department, plus the month's stored departmentTotals
 * for the company-wide breakdown chart.
 *
 * All charts share a common dark-theme palette so they read as one
 * consistent visual system, and are destroyed/recreated on every
 * `renderAllCharts` call so switching months or departments never leaves
 * stale data or duplicate canvases behind.
 * -----------------------------------------------------------------------
 */

'use strict';

const Charts = (() => {

  const PALETTE = {
    accent: '#38bdf8',
    accentSoft: 'rgba(56, 189, 248, 0.24)',
    green: '#34d399',
    greenSoft: 'rgba(52, 211, 153, 0.24)',
    amber: '#fbbf24',
    red: '#fb7185',
    grid: 'rgba(148,163,184,0.14)',
    text: '#94a3b8',
    textStrong: '#e2e8f0'
  };

  const BUCKET_COLORS = [
    '#fb7185', '#fbbf24', '#d9f99d', '#86efac', '#34d399',
    '#2dd4bf', '#22d3ee', '#38bdf8', '#818cf8', '#c084fc'
  ];

  let instances = {
    topSales: null,
    topBonus: null,
    packagesDist: null,
    salesDist: null,
    departmentBonus: null,
    departmentOrders: null
  };

  function destroyAll() {
    Object.keys(instances).forEach((key) => {
      if (instances[key]) {
        instances[key].destroy();
        instances[key] = null;
      }
    });
  }

  function setChartState(canvasId, message = '') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const empty = canvas.parentElement && canvas.parentElement.querySelector('.chart-empty');
    const isEmpty = Boolean(message);
    canvas.hidden = isEmpty;
    if (empty) {
      empty.hidden = !isEmpty;
      empty.textContent = message;
    }
    return isEmpty ? null : canvas;
  }

  function showAllEmpty(message) {
    ['chartTopSales', 'chartTopBonus', 'chartPackagesDist', 'chartSalesDist', 'chartDepartmentBonus', 'chartDepartmentOrders']
      .forEach(id => setChartState(id, message));
  }

  // Chart.js loads from an external CDN. On a slow connection or a blocked
  // request it may not be ready yet - guard every touch point instead of
  // crashing this whole module (and, with it, the "Calculate" flow that
  // calls renderAllCharts right after computing the report).
  function chartLibReady() {
    return typeof Chart !== 'undefined';
  }

  if (chartLibReady()) {
    Chart.defaults.font.family = "'Cairo', sans-serif";
    Chart.defaults.color = PALETTE.text;
  } else {
    console.warn('Chart.js لم يتم تحميلها بعد - الرسومات البيانية لن تظهر لكن باقي التطبيق يعمل بشكل طبيعي.');
  }

  /**
   * Renders every dashboard chart.
   *
   * @param {Array}  report  rows already filtered to the active department
   * @param {object} options
   *        - departmentTotals: the month's STORED department summaries
   *        - isCompanyView:    true for "All Departments"
   *        - colorOf:          (departmentId) => hex colour
   */
  function renderAllCharts(report, options = {}) {
    // Never let a missing/late chart library break report calculation or
    // any other caller - just skip drawing the charts this time.
    destroyAll();
    if (!chartLibReady()) {
      showAllEmpty('تعذر تحميل مكتبة الرسوم البيانية.');
      return;
    }
    const rows = Array.isArray(report) ? report : [];
    renderTopSales(rows);
    renderTopBonus(rows);
    renderPackagesDistribution(rows);

    const deptTotals = Array.isArray(options.departmentTotals) ? options.departmentTotals : [];
    // In Company View the useful fourth chart is the department split; in a
    // single-department view that would be one slice, so the original
    // per-employee sales curve is shown instead.
    if (options.isCompanyView && deptTotals.length > 0) {
      renderDepartmentSalaries(deptTotals, options.colorOf);
      renderDepartmentMetric('chartDepartmentBonus', 'departmentBonus', deptTotals,
        'إجمالي البونص', 'totalBonus', PALETTE.greenSoft, PALETTE.green);
      renderDepartmentMetric('chartDepartmentOrders', 'departmentOrders', deptTotals,
        'إجمالي الطلبات', 'ordersCount', PALETTE.accentSoft, PALETTE.accent);
    } else {
      renderSalesDistribution(rows);
      renderDepartmentMetric('chartDepartmentBonus', 'departmentBonus', [],
        'إجمالي البونص', 'totalBonus', PALETTE.greenSoft, PALETTE.green);
      renderDepartmentMetric('chartDepartmentOrders', 'departmentOrders', [],
        'إجمالي الطلبات', 'ordersCount', PALETTE.accentSoft, PALETTE.accent);
    }
  }

  /** Swaps the fourth chart's heading to match whichever chart is drawn. */
  function setFourthChartTitle(text) {
    const el = document.getElementById('chartSalesDistTitle');
    if (el) el.textContent = text;
  }

  function renderTopSales(report) {
    const top = [...report].sort((a, b) => b.totalSales - a.totalSales).slice(0, 8);
    const ctx = setChartState('chartTopSales', top.length ? '' : 'لا توجد بيانات تقرير محسوبة لعرضها.');
    if (!ctx) return;

    instances.topSales = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: top.map(r => r.name),
        datasets: [{
          label: 'إجمالي المبيعات',
          data: top.map(r => r.totalSales),
          backgroundColor: PALETTE.accentSoft,
          borderColor: PALETTE.accent,
          borderWidth: 1.5,
          borderRadius: 6,
          barThickness: 18
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: PALETTE.grid }, ticks: { color: PALETTE.text } },
          y: { grid: { display: false }, ticks: { color: PALETTE.textStrong } }
        }
      }
    });
  }

  function renderTopBonus(report) {
    const top = [...report].sort((a, b) => b.totalBonus - a.totalBonus).slice(0, 8);
    const ctx = setChartState('chartTopBonus', top.length ? '' : 'لا توجد بيانات تقرير محسوبة لعرضها.');
    if (!ctx) return;

    instances.topBonus = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: top.map(r => r.name),
        datasets: [{
          label: 'إجمالي البونص',
          data: top.map(r => r.totalBonus),
          backgroundColor: top.map(r => r.totalBonus >= 0 ? PALETTE.greenSoft : 'rgba(239,68,68,0.25)'),
          borderColor: top.map(r => r.totalBonus >= 0 ? PALETTE.green : PALETTE.red),
          borderWidth: 1.5,
          borderRadius: 6,
          barThickness: 18
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: PALETTE.grid }, ticks: { color: PALETTE.text } },
          y: { grid: { display: false }, ticks: { color: PALETTE.textStrong } }
        }
      }
    });
  }

  function renderPackagesDistribution(report) {
    const ctx = setChartState('chartPackagesDist', report.length ? '' : 'لا توجد بيانات طرود ضمن التقرير الحالي.');
    if (!ctx) return;

    // Aggregate distribution buckets across every employee in scope
    const buckets = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0, '9': 0, '10+': 0 };
    report.forEach(r => {
      Object.keys(buckets).forEach(k => { buckets[k] += (r.distribution && r.distribution[k]) || 0; });
    });

    instances.packagesDist = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: Object.keys(buckets).map(k => `${k} طرد`),
        datasets: [{
          data: Object.values(buckets),
          backgroundColor: BUCKET_COLORS,
          borderColor: '#171a21',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: PALETTE.text, boxWidth: 12, padding: 10 } }
        },
        cutout: '62%'
      }
    });
  }

  /**
   * Company View only: net salary per department, drawn from the month's
   * STORED departmentTotals. Slice labels use each department's own name
   * SNAPSHOT, so charting a historical month shows the names it was
   * calculated with, and each slice takes the department's colour.
   */
  function renderDepartmentSalaries(departmentTotals, colorOf) {
    const ctx = setChartState('chartSalesDist', departmentTotals.length ? '' : 'لا توجد بيانات أقسام محسوبة لعرضها.');
    if (!ctx) return;

    setFourthChartTitle('صافي الرواتب حسب القسم');

    const rows = [...departmentTotals].sort((a, b) => (b.finalSalary || 0) - (a.finalSalary || 0));
    const colors = rows.map((d, i) =>
      (typeof colorOf === 'function' && colorOf(d.departmentId)) || BUCKET_COLORS[i % BUCKET_COLORS.length]
    );

    instances.salesDist = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: rows.map(d => d.departmentName),
        datasets: [{
          data: rows.map(d => Number(d.finalSalary) || 0),
          backgroundColor: colors,
          borderColor: '#171a21',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: PALETTE.text, boxWidth: 12, padding: 10 } }
        },
        cutout: '58%'
      }
    });
  }

  function renderSalesDistribution(report) {
    const ctx = setChartState('chartSalesDist', report.length ? '' : 'لا توجد بيانات تقرير محسوبة لعرضها.');
    if (!ctx) return;

    setFourthChartTitle('توزيع المبيعات بين الموظفين');

    const sorted = [...report].sort((a, b) => b.totalSales - a.totalSales);

    instances.salesDist = new Chart(ctx, {
      type: 'line',
      data: {
        labels: sorted.map(r => r.name),
        datasets: [{
          label: 'المبيعات',
          data: sorted.map(r => r.totalSales),
          borderColor: PALETTE.accent,
          backgroundColor: PALETTE.accentSoft,
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointBackgroundColor: PALETTE.accent
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: PALETTE.text, maxRotation: 45, minRotation: 45 } },
          y: { grid: { color: PALETTE.grid }, ticks: { color: PALETTE.text } }
        }
      }
    });
  }

  /** Compact company-view bars for any stored department aggregate. */
  function renderDepartmentMetric(canvasId, instanceKey, departmentTotals, label, field, backgroundColor, borderColor) {
    const rows = [...(departmentTotals || [])]
      .filter(d => (Number(d[field]) || 0) !== 0)
      .sort((a, b) => (Number(b[field]) || 0) - (Number(a[field]) || 0));
    const ctx = setChartState(canvasId, rows.length ? '' : 'لا توجد بيانات محسوبة لعرضها.');
    if (!ctx) return;

    instances[instanceKey] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: rows.map(d => d.departmentName),
        datasets: [{
          label,
          data: rows.map(d => Number(d[field]) || 0),
          backgroundColor,
          borderColor,
          borderWidth: 1.5,
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: PALETTE.text } },
          y: { grid: { color: PALETTE.grid }, ticks: { color: PALETTE.text } }
        }
      }
    });
  }

  return { renderAllCharts, destroyAll };
})();
