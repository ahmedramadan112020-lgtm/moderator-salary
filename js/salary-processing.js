'use strict';

/* Snapshot-only review, approval, and payment layer. */
const SalaryProcessing = (() => {
  const collection='salary_processing', $=id=>document.getElementById(id); let snapshot=null, periodId=null, drawerId=null, charts=[];
  const val=(row,keys)=>Number(keys.map(k=>row[k]).find(v=>v!==undefined)||0), money=v=>Utils.formatCurrency(v||0), name=row=>row.name||row.moderatorName||'—', employeeId=row=>row.moderatorId||row.employeeId||name(row);
  function aggregate(rows, manual={}){
    const totals={employees:rows.length,salary:0,bonus:0,commission:0,deductions:0,additions:0,net:0},depts=new Map();
    rows.forEach(row=>{const m=manual[employeeId(row)]||{},salary=val(row,['baseSalary','salary']),bonus=val(row,['bonus','totalBonus']),commission=val(row,['commission','totalCommission']),deductions=val(row,['deductions','totalDeductions'])+Number(m.deduction||0),additions=val(row,['additions','adjustments'])+Number(m.addition||0),net=val(row,['netSalary','netPay','finalSalary'])+Number(m.addition||0)-Number(m.deduction||0);Object.assign(totals,{salary:totals.salary+salary,bonus:totals.bonus+bonus,commission:totals.commission+commission,deductions:totals.deductions+deductions,additions:totals.additions+additions,net:totals.net+net});const key=row.departmentName||row.departmentId||'غير محدد',d=depts.get(key)||{name:key,employees:0,salary:0,bonus:0,commission:0,sales:0,orders:0};d.employees++;d.salary+=salary;d.bonus+=bonus;d.commission+=commission;d.sales+=val(row,['totalSales','sales']);d.orders+=val(row,['ordersCount','orders']);depts.set(key,d);});
    return{totals,depts:Array.from(depts.values())};
  }
  function card(label,value){return `<button type="button" class="stat-card" data-salary-drill="${label}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></button>`;}
  function drawSnapshotChart(canvasId, emptyId, labels, values, label, onDrill) {
    const canvas=$(canvasId), empty=$(emptyId); if(!canvas||!empty)return;
    const old=charts.find(c=>c.canvas&&c.canvas.id===canvasId); if(old){old.destroy();charts=charts.filter(c=>c!==old);}
    const valid=labels.length && values.some(value=>Number(value)!==0); canvas.classList.toggle('hidden',!valid); empty.classList.toggle('hidden',valid);
    if(!valid)return;
    if(typeof Chart==='undefined'){ canvas.classList.add('hidden'); empty.textContent='No data available yet'; empty.classList.remove('hidden'); return; }
    const chart=new Chart(canvas,{type:'bar',data:{labels,datasets:[{label,data:values,backgroundColor:'#73a7ff',borderRadius:6}]},options:{responsive:true,onClick:(event,elements)=>{const item=elements&&elements[0];if(item&&typeof onDrill==='function')onDrill(labels[item.index]);},plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}}); charts=charts.filter(c=>!(c.canvas&&c.canvas.id===canvasId)); charts.push(chart);
  }
  function renderSnapshotCharts(rows, summary) {
    const departments=summary.depts||[];
    drawSnapshotChart('salaryChartDepartments','salaryChartDepartmentsEmpty',departments.map(d=>d.name),departments.map(d=>d.salary),'الرواتب',label=>drillChartGroup('department',label,['baseSalary','salary'],'الرواتب'));
    drawSnapshotChart('salaryChartBonus','salaryChartBonusEmpty',departments.map(d=>d.name),departments.map(d=>d.bonus),'البونص',label=>drillChartGroup('department',label,['bonus','totalBonus'],'البونص'));
    drawSnapshotChart('salaryChartCommission','salaryChartCommissionEmpty',departments.map(d=>d.name),departments.map(d=>d.commission),'العمولات',label=>drillChartGroup('department',label,['commission','totalCommission'],'العمولات'));
    const types=new Map(); rows.forEach(row=>{const key=row.salaryType||'غير محدد';types.set(key,(types.get(key)||0)+1);});
    drawSnapshotChart('salaryChartTypes','salaryChartTypesEmpty',Array.from(types.keys()),Array.from(types.values()),'الموظفون',label=>drillChartGroup('salaryType',label,null,'الموظفون'));
    drawSnapshotChart('salaryChartHeadcount','salaryChartHeadcountEmpty',departments.map(d=>d.name),departments.map(d=>d.employees),'الموظفون',label=>drillChartGroup('department',label,null,'الموظفون'));
  }  function drillKpi(label) {
    const map={'إجمالي الرواتب':['baseSalary','salary'],'إجمالي البونص':['bonus','totalBonus'],'إجمالي العمولات':['commission','totalCommission'],'إجمالي الخصومات':['deductions','totalDeductions'],'إجمالي الإضافات':['additions','adjustments'],'صافي المستحقات':['netSalary','netPay','finalSalary']};
    const manual=snapshot?.employeeManualEntries||{},employeeCount=label==='عدد الموظفين', keys=map[label]; if(!employeeCount&&!keys)return; const value=row=>{const m=manual[employeeId(row)]||{},base=val(row,keys);if(label==='إجمالي الإضافات')return base+Number(m.addition||0);if(label==='إجمالي الخصومات')return base+Number(m.deduction||0);if(label==='صافي المستحقات')return base+Number(m.addition||0)-Number(m.deduction||0);return base;}; const rows=employeeCount?(snapshot?.report||[]):(snapshot?.report||[]).filter(row=>value(row)!==0);
    $('salaryDrawerTitle').textContent=label;
    $('salaryDrawerBody').innerHTML=rows.length ? `<div class="table-wrap"><table><thead><tr><th>الموظف</th><th>القسم</th><th>القيمة</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${Utils.escapeHtml(name(row))}</td><td>${Utils.escapeHtml(row.departmentName||'—')}</td><td>${employeeCount?1:money(value(row))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="widget-empty">No data available yet</div>';
    $('salaryEmployeeDrawer').classList.add('open');
  }  function drillDepartment(departmentName){
    const rows=(snapshot?.report||[]).filter(row=>(row.departmentName||row.departmentId||'غير محدد')===departmentName), manual=snapshot?.employeeManualEntries||{};
    const totals=rows.reduce((sum,row)=>{const m=manual[employeeId(row)]||{},addition=val(row,['additions','adjustments'])+Number(m.addition||0),deduction=val(row,['deductions','totalDeductions'])+Number(m.deduction||0),net=val(row,['netSalary','netPay','finalSalary'])+Number(m.addition||0)-Number(m.deduction||0);sum.salary+=val(row,['baseSalary','salary']);sum.bonus+=val(row,['bonus','totalBonus']);sum.commission+=val(row,['commission','totalCommission']);sum.additions+=addition;sum.deductions+=deduction;sum.net+=net;return sum;},{salary:0,bonus:0,commission:0,additions:0,deductions:0,net:0});
    $('salaryDrawerTitle').textContent=departmentName;
    $('salaryDrawerBody').innerHTML=`<section class="details-grid"><div>عدد الموظفين: ${rows.length}</div><div>إجمالي الرواتب: ${money(totals.salary)}</div><div>إجمالي البونص: ${money(totals.bonus)}</div><div>إجمالي العمولات: ${money(totals.commission)}</div><div>إجمالي الخصومات: ${money(totals.deductions)}</div><div>إجمالي الإضافات: ${money(totals.additions)}</div><div>صافي المستحقات: ${money(totals.net)}</div></section>${rows.length?`<div class="table-wrap"><table><thead><tr><th>الاسم</th><th>الوظيفة</th><th>الراتب الأساسي</th><th>البونص</th><th>العمولة</th><th>الإضافات</th><th>الخصومات</th><th>الصافي النهائي</th></tr></thead><tbody>${rows.map(row=>{const m=manual[employeeId(row)]||{},addition=val(row,['additions','adjustments'])+Number(m.addition||0),deduction=val(row,['deductions','totalDeductions'])+Number(m.deduction||0),net=val(row,['netSalary','netPay','finalSalary'])+Number(m.addition||0)-Number(m.deduction||0);return `<tr><td>${Utils.escapeHtml(name(row))}</td><td>${Utils.escapeHtml(row.jobTitle||row.position||row.role||'—')}</td><td>${money(val(row,['baseSalary','salary']))}</td><td>${money(val(row,['bonus','totalBonus']))}</td><td>${money(val(row,['commission','totalCommission']))}</td><td>${money(addition)}</td><td>${money(deduction)}</td><td>${money(net)}</td></tr>`;}).join('')}</tbody></table></div>`:'<div class="widget-empty">No data available yet</div>'}`;
    $('salaryEmployeeDrawer').classList.add('open');
  }  function drillChartGroup(group,label,metricKeys,title){
    let rows=(snapshot?.report||[]).filter(row=>group==='department'?(row.departmentName||row.departmentId||'غير محدد')===label:(row.salaryType||'غير محدد')===label);
    if(metricKeys)rows=rows.filter(row=>val(row,metricKeys)!==0);
    $('salaryDrawerTitle').textContent=`${title}: ${label}`;
    const table=rows.length?`<div class="table-wrap"><table><thead><tr><th>الموظف</th><th>القسم</th><th>نوع الراتب</th>${metricKeys?'<th>القيمة</th>':''}</tr></thead><tbody>${rows.map(row=>`<tr><td>${Utils.escapeHtml(name(row))}</td><td>${Utils.escapeHtml(row.departmentName||row.departmentId||'—')}</td><td>${Utils.escapeHtml(row.salaryType||'—')}</td>${metricKeys?`<td>${money(val(row,metricKeys))}</td>`:''}</tr>`).join('')}</tbody></table></div>`:'<div class="widget-empty">No data available yet</div>';
    $('salaryDrawerBody').innerHTML=table;
    $('salaryEmployeeDrawer').classList.add('open');
  }  function renderRanking(rows,manual){
    const metric=$('salaryRankingMetric')?.value||'net', direction=$('salaryRankingDirection')?.value||'desc';
    const config={net:{label:'صافي المستحق',keys:['netSalary','netPay','finalSalary'],currency:true},sales:{label:'إجمالي المبيعات',keys:['totalSales','sales'],currency:true},orders:{label:'عدد الطلبات',keys:['ordersCount','orders'],currency:false},packages:{label:'عدد العبوات',keys:['totalPackages','packages'],currency:false},bonus:{label:'قيمة البونص',keys:['bonus','totalBonus'],currency:true},commission:{label:'قيمة العمولة',keys:['commission','totalCommission'],currency:true}}[metric];
    if(!config)return; const value=row=>{const base=val(row,config.keys),m=manual[employeeId(row)]||{};return metric==='net'?base+Number(m.addition||0)-Number(m.deduction||0):base;};
    const sorted=rows.slice().sort((left,right)=>(value(right)-value(left))*(direction==='asc'?-1:1));
    const body=$('salaryRankingBody'),head=$('salaryRankingValueHeader'); if(!body||!head)return; head.textContent=config.label;
    body.innerHTML=sorted.length?sorted.map((row,index)=>`<tr data-details="${Utils.escapeHtml(employeeId(row))}" tabindex="0"><td>${index+1}</td><td>${Utils.escapeHtml(name(row))}</td><td>${Utils.escapeHtml(row.departmentName||row.departmentId||'—')}</td><td>${Utils.escapeHtml(row.salaryType||'—')}</td><td>${config.currency?money(value(row)):value(row)}</td></tr>`).join(''):'<tr><td colspan="5"><div class="widget-empty">No data available yet</div></td></tr>';
  }  function render(){const panel=$('salarySnapshotDashboard');if(!snapshot){panel.classList.add('hidden');return;}const rows=snapshot.report||[],payments=snapshot.employeePayments||{},manual=snapshot.employeeManualEntries||{},a=aggregate(rows,manual);panel.classList.remove('hidden');renderSnapshotCharts(rows,a);renderRanking(rows,manual);$('salaryWorkflow').innerHTML=['① اختيار الفترة','② إنشاء التقرير','③ مراجعة الرواتب','④ اعتماد التقرير','⑤ صرف الرواتب','⑥ أرشفة التقرير'].map((x,i)=>`<span class="${snapshot.status==='approved'?(i<4?'done':''):''} ${snapshot.status==='paid'&&i<5?'done':''}">${x}</span>`).join('');$('salaryExecutiveSummary').innerHTML=[['عدد الموظفين',a.totals.employees],['إجمالي الرواتب',money(a.totals.salary)],['إجمالي البونص',money(a.totals.bonus)],['إجمالي العمولات',money(a.totals.commission)],['إجمالي الخصومات',money(a.totals.deductions)],['إجمالي الإضافات',money(a.totals.additions)],['صافي المستحقات',money(a.totals.net)]].map(([l,v])=>card(l,v)).join('');const high=(keys)=>rows.slice().sort((x,y)=>val(y,keys)-val(x,keys))[0];$('salaryKpis').innerHTML=[['أعلى راتب',['baseSalary','salary']],['أعلى بونص',['bonus','totalBonus']],['أعلى عمولة',['commission','totalCommission']],['أعلى مبيعات',['totalSales','sales']],['أعلى عدد طلبات',['ordersCount','orders']],['أعلى عدد عبوات',['totalPackages','packages']]].map(([l,k])=>{const r=high(k);return `<div class="dashboard-insight"><div><span class="dashboard-insight-label">${l}</span><span class="dashboard-insight-name">${r?Utils.escapeHtml(name(r)):'No data available yet'}</span></div><span class="dashboard-insight-value">${r?money(val(r,k)):'—'}</span></div>`;}).join('');$('salaryDepartmentSummary').innerHTML=a.depts.length?a.depts.map(d=>`<button type="button" class="dashboard-insight" data-salary-department="${Utils.escapeHtml(d.name)}"><div><span class="dashboard-insight-label">${Utils.escapeHtml(d.name)}</span><span class="dashboard-insight-name">${d.employees} موظف · ${d.orders} طلب</span></div><span class="dashboard-insight-value">${money(d.salary+d.bonus+d.commission)}</span></button>`).join(''):'No data available yet';$('salarySnapshotRows').innerHTML=rows.map(row=>{const id=employeeId(row),m=manual[id]||{},add=Number(m.addition||0),ded=Number(m.deduction||0),net=val(row,['netSalary','netPay','finalSalary'])+add-ded;return `<tr><td>${Utils.escapeHtml(name(row))}</td><td>${Utils.escapeHtml(row.departmentName||'—')}</td><td>${money(val(row,['baseSalary','salary']))}</td><td>${money(val(row,['bonus','totalBonus']))}</td><td>${money(val(row,['commission','totalCommission']))}</td><td>${money(add)}</td><td>${money(ded)}</td><td>${money(net)}</td><td><button class="btn btn-sm" data-adjust="${Utils.escapeHtml(id)}">Adjust</button><button class="btn btn-sm" data-details="${Utils.escapeHtml(id)}">Details</button></td></tr>`;}).join('');$('salaryPaymentBody').innerHTML=rows.map(row=>{const p=payments[employeeId(row)]||{};return `<tr><td>${Utils.escapeHtml(name(row))}</td><td>${Utils.escapeHtml(row.departmentName||'—')}</td><td>${money(val(row,['netSalary','netPay','finalSalary'])+Number((manual[employeeId(row)]||{}).addition||0)-Number((manual[employeeId(row)]||{}).deduction||0))}</td><td>${p.status==='paid'?'Paid':'Unpaid'}</td><td>${p.paidAt||'—'}</td><td>${p.paidBy||'—'}</td><td>${p.status==='paid'?'—':`<button class="btn btn-sm" data-pay="${Utils.escapeHtml(employeeId(row))}">Mark as Paid</button>`}</td></tr>`;}).join('');}
  async function load(){
    if(!Permissions.can('salary_processing.read')){snapshot=null;render();return;}
    periodId=typeof App.getSelectedMonthId==='function'?App.getSelectedMonthId():null;
    if(!periodId)return;
    const doc=await db.collection(collection).doc(periodId).get();
    snapshot=doc.exists?doc.data():null;
    const node=$('salaryProcessingStatus');
    if(node){node.textContent=snapshot?.status==='approved'?'Approved':'Draft';node.className=`badge ${snapshot?.status==='approved'?'badge-approved':'badge-locked'}`;}
    render();
  }
  // The original snapshot UI predates the central permission service. Keep
  // these guards beside the financial writes so they cannot be bypassed by
  // a newly added button or a direct function call from the console.
  async function approve(){
    Permissions.require('salary_processing.approve');
    const c=App.getSalaryProcessingContext();
    if(!c.monthId||!c.rows.length)return Toast.show('أنشئ التقرير أولاً قبل الاعتماد','error');
    const warnings=c.rows.filter(r=>val(r,['deductions','totalDeductions'])&&!r.deductionReason);
    if(warnings.length&&!confirm(`يوجد ${warnings.length} خصم بلا سبب. هل تريد المتابعة؟`))return;
    await db.collection(collection).doc(c.monthId).set({version:1,period:{type:'month',monthId:c.monthId},status:'approved',approvedAt:firebase.firestore.FieldValue.serverTimestamp(),approvedBy:auth.currentUser?.email||null,report:c.rows,totals:c.totals,employeeManualEntries:{},employeePayments:{},payment:{status:'unpaid',paidAt:null,paidBy:null},createdAt:firebase.firestore.FieldValue.serverTimestamp(),updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:false});
    await AuditService.log('salary_processing.approved',{entity:'salary_processing',operation:AuditService.OPERATION.CREATE,documentId:c.monthId,documentLabel:`Payroll ${c.monthId}`,monthId:c.monthId,severity:AuditService.SEVERITY.WARNING,details:{period:c.monthId,status:'approved',employeeCount:c.rows.length}});
    await load();Toast.show('تم اعتماد وحفظ Snapshot الرواتب','success');
  }
  async function pay(ids){
    Permissions.require('salary_processing.pay');
    if(!snapshot||!periodId)return;
    if(snapshot.status!=='approved')throw new Error('لا يمكن الصرف قبل اعتماد Snapshot الرواتب.');
    const payments={...(snapshot.employeePayments||{})},actor=auth.currentUser?.email||null,when=new Date().toLocaleString('ar-EG');
    ids.forEach(id=>payments[id]={status:'paid',paidAt:when,paidBy:actor});
    const all=(snapshot.report||[]).every(r=>payments[employeeId(r)]?.status==='paid');
    await db.collection(collection).doc(periodId).update({employeePayments:payments,status:all?'paid':'approved',updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    await AuditService.log('salary_processing.paid',{entity:'salary_processing',operation:AuditService.OPERATION.UPDATE,documentId:periodId,documentLabel:`Payroll ${periodId}`,monthId:periodId,severity:AuditService.SEVERITY.INFO,details:{period:periodId,status:all?'paid':'approved',paidEmployeeIds:ids}});
    await load();
  }
  async function adjust(id){
    Permissions.require('salary_processing.write');
    if(!snapshot||snapshot.status==='paid')return Toast.show('لا يمكن تعديل Snapshot مدفوع','error');
    const old=(snapshot.employeeManualEntries||{})[id]||{},addition=Number(prompt('قيمة الإضافة المالية',old.addition||0)),deduction=Number(prompt('قيمة الخصم المالي',old.deduction||0));
    if(!Number.isFinite(addition)||!Number.isFinite(deduction))return;
    const note=prompt('ملاحظات / سبب الإضافة أو الخصم',old.note||'')||'';
    const entries={...(snapshot.employeeManualEntries||{}),[id]:{addition,deduction,note,updatedAt:new Date().toISOString(),updatedBy:auth.currentUser?.email||null}};
    await db.collection(collection).doc(periodId).update({employeeManualEntries:entries,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    await AuditService.log('salary_processing.manual_adjusted',{entity:'salary_processing',operation:AuditService.OPERATION.UPDATE,documentId:periodId,documentLabel:`Payroll ${periodId}`,monthId:periodId,severity:AuditService.SEVERITY.WARNING,details:{employeeId:id,previous:{addition:Number(old.addition||0),deduction:Number(old.deduction||0)},current:{addition,deduction},note}});
    await load();
  }
  function exportSnapshot(){
    Permissions.require('salary_processing.export');
    if(!snapshot)return;
    const manual=snapshot.employeeManualEntries||{};
    const rows=(snapshot.report||[]).map(r=>{const adjustment=manual[employeeId(r)]||{},addition=Number(adjustment.addition||0),deduction=Number(adjustment.deduction||0),net=val(r,['netSalary','netPay','finalSalary'])+addition-deduction;return {الموظف:name(r),القسم:r.departmentName||'',الراتب:val(r,['baseSalary','salary']),البونص:val(r,['bonus','totalBonus']),العمولة:val(r,['commission','totalCommission']),الإضافات_اليدوية:addition,الخصومات_اليدوية:deduction,الصافي_بعد_التعديل:net,ملاحظة_التعديل:adjustment.note||''};});
    if(typeof XLSX==='undefined')return Toast.show('Excel غير متاح','error');
    const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'Salary Snapshot');XLSX.writeFile(wb,`salary-snapshot-${periodId}.xlsx`);
    AuditService.log('salary_processing.exported',{entity:'salary_processing',operation:AuditService.OPERATION.UPDATE,documentId:periodId,documentLabel:`Payroll ${periodId}`,monthId:periodId,details:{format:'xlsx',employeeCount:rows.length}}).catch(()=>{});
  }
  let initialized=false;
  function init(){if(initialized)return;initialized=true;$('salaryExecutiveSummary').addEventListener('click',e=>{const b=e.target.closest('[data-salary-drill]');if(b)drillKpi(b.dataset.salaryDrill);});$('salaryDepartmentSummary').addEventListener('click',e=>{const b=e.target.closest('[data-salary-department]');if(b)drillDepartment(b.dataset.salaryDepartment);});$('salaryRankingBody').addEventListener('click',e=>{const row=e.target.closest('[data-details]');if(row)details(row.dataset.details);});['salaryRankingMetric','salaryRankingDirection'].forEach(id=>$(id).addEventListener('change',()=>{if(snapshot)renderRanking(snapshot.report||[],snapshot.employeeManualEntries||{});}));$('salarySnapshotApproveBtn').addEventListener('click',()=>approve().catch(e=>Toast.show('تعذر الاعتماد: '+e.message,'error')));$('salaryMarkAllPaidBtn').addEventListener('click',()=>pay((snapshot?.report||[]).map(employeeId)).catch(e=>Toast.show('تعذر تسجيل الدفع: '+e.message,'error')));$('salaryPaymentBody').addEventListener('click',e=>{const b=e.target.closest('[data-pay]');if(b)pay([b.dataset.pay]).catch(err=>Toast.show('تعذر تسجيل الدفع: '+err.message,'error'));});$('salarySnapshotRows').addEventListener('click',e=>{const b=e.target.closest('[data-adjust]');if(b)adjust(b.dataset.adjust).catch(err=>Toast.show('تعذر التعديل: '+err.message,'error'));const d=e.target.closest('[data-details]');if(d)details(d.dataset.details);});$('salaryDrawerCloseBtn').addEventListener('click',()=>$('salaryEmployeeDrawer').classList.remove('open'));$('salaryDrawerTabs').addEventListener('click',e=>{const b=e.target.closest('[data-salary-tab]');if(b&&drawerId)details(drawerId,b.dataset.salaryTab);});$('salarySnapshotExcelBtn').addEventListener('click',()=>{try{exportSnapshot();}catch(err){Toast.show('تعذر التصدير: '+err.message,'error');}});$('salarySnapshotPrintBtn').addEventListener('click',()=>window.print());load().catch(()=>{});}
  return{init,load,isInitialized:()=>initialized};
})();
