(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const LEGACY_KEY = "smartMoneyData_v1", USERS_KEY = "smartMoneyUsers_v1", SESSION_KEY = "smartMoneySession_v1";
  let STORAGE_KEY = null, currentUser = null;
  // ===== Konfigurasi cloud (Firebase) — diisi di firebase-config.js =====
  const FB_CFG = window.FIREBASE_CONFIG || {};
  const CLOUD_CONFIGURED = !!(FB_CFG.apiKey && FB_CFG.projectId && !/^ISI_/.test(FB_CFG.apiKey));
  let CLOUD = CLOUD_CONFIGURED && !!window.firebase;
  let fbAuth = null, fbDb = null, cloudDoc = null, unsubDoc = null;
  let pushTimer = null, retryTimer = null, salaryTimer = null, applyingRemote = false, lastPushed = "", lastRemoteJson = "", firstDone = false, pendingName = null, syncState = "saving";
  if (CLOUD) {
    try {
      firebase.initializeApp(FB_CFG);
      fbAuth = firebase.auth(); fbDb = firebase.firestore();
      fbDb.enablePersistence({synchronizeTabs: true}).catch(() => {});
    } catch (e) { console.error("Firebase gagal diinisialisasi:", e); CLOUD = false; }
  }
  const CLOUD_BROKEN = CLOUD_CONFIGURED && !CLOUD;
  const getUsers = () => { try { const u = JSON.parse(localStorage.getItem(USERS_KEY)); return Array.isArray(u) ? u : []; } catch (e) { return []; } };
  if (!CLOUD && !CLOUD_BROKEN) try { const su = getUsers().find(u => u.id === localStorage.getItem(SESSION_KEY)); if (su) { currentUser = su; STORAGE_KEY = LEGACY_KEY + "_" + su.id; } } catch (e) {}
  const categories = {
    income: ["Gaji", "Freelance", "Bisnis", "Bonus", "Pendapatan lainnya"],
    expense: ["Makan dan minum", "Transportasi", "Pendidikan", "Tagihan", "Belanja", "Hiburan", "Cicilan", "Keluarga", "Kesehatan", "Lainnya"]
  };
  const categoryIcons = {
    "Gaji":"💼","Freelance":"🧑‍💻","Bisnis":"🏪","Bonus":"🎁","Pendapatan lainnya":"＋",
    "Makan dan minum":"🍜","Transportasi":"🚌","Pendidikan":"📚","Tagihan":"🧾","Belanja":"🛍️",
    "Hiburan":"🎮","Cicilan":"💳","Keluarga":"🏡","Kesehatan":"🩺","Lainnya":"•",
    "Kebutuhan pokok":"🧺","Keinginan & hiburan":"🎮","Tabungan":"🎯","Dana cadangan/pengembangan":"🌱"
  };
  const colors = ["#173f5f", "#159a72", "#e4b354", "#8d9db1", "#db7474", "#9274c8", "#55a9c4", "#dc8e55"];
  const LOC = () => state.lang === "en" ? "en-US" : "id-ID";
  const rupiah = value => state.currency === "USD"
    ? (Number(value) < 0 ? "-$" : "$") + Math.abs((Number(value) || 0) / (state.rate || 16000)).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2})
    : "Rp" + Math.round(Number(value) || 0).toLocaleString("id-ID");
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  };
  const monthKey = (date) => String(date || "").slice(0,7);
  const currentMonth = () => todayISO().slice(0,7);
  const makeId = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const defaultState = () => ({ transactions: [], goals: [], budgets: {}, salaryPlan: null, salaryForm: null, demoBudgets: {}, currency: "IDR", lang: "id", rate: 16000, dark: false, hideBalance: false, customCategories: {income:[], expense:[]}, profilePhoto: "" });
  let state = loadState();
  let cashflowChart = null, categoryChart = null, reportChart = null;
  let toastTimer = null;

  function loadState() {
    try {
      if (!STORAGE_KEY) return defaultState();
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      try { return sanitizeState(JSON.parse(raw)); }
      catch (error) {
        try { localStorage.setItem(STORAGE_KEY + "_corrupt_backup", raw); } catch (e) {}
        console.warn("Data lokal rusak; salinan disimpan di " + STORAGE_KEY + "_corrupt_backup", error);
        return defaultState();
      }
    } catch (error) {
      console.warn("Penyimpanan lokal tidak tersedia:", error);
      return defaultState();
    }
  }
  function sanitizeState(p) {
    const d = defaultState();
    if (!p || typeof p !== "object") return d;
    const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    d.transactions = (Array.isArray(p.transactions) ? p.transactions : []).filter(t => t && (t.type === "income" || t.type === "expense") && num(t.amount) > 0 && iso.test(String(t.date)))
      .map(t => ({...t, id: String(t.id || makeId()), name: String(t.name || "Tanpa nama"), category: String(t.category || "Lainnya"), amount: num(t.amount)}));
    d.goals = (Array.isArray(p.goals) ? p.goals : []).filter(g => g && num(g.target) > 0).map(g => {
      const target = num(g.target);
      return {...g, id: String(g.id || makeId()), name: String(g.name || "Target"), target, saved: Math.min(target, Math.max(0, num(g.saved))), icon: String(g.icon || "🎯"), deadline: iso.test(String(g.deadline)) ? g.deadline : ""};
    });
    if (p.budgets && typeof p.budgets === "object" && !Array.isArray(p.budgets)) Object.entries(p.budgets).forEach(([k, v]) => { if (num(v) > 0) d.budgets[k] = num(v); });
    if (p.demoBudgets && typeof p.demoBudgets === "object" && !Array.isArray(p.demoBudgets)) d.demoBudgets = p.demoBudgets;
    d.salaryPlan = p.salaryPlan && typeof p.salaryPlan === "object" ? p.salaryPlan : null;
    d.salaryForm = p.salaryForm && typeof p.salaryForm === "object" ? p.salaryForm : null;
    d.currency = p.currency === "USD" ? "USD" : "IDR"; d.lang = p.lang === "en" ? "en" : "id"; d.rate = num(p.rate) > 0 ? num(p.rate) : 16000;
    d.dark = !!p.dark; d.hideBalance = !!p.hideBalance;
    d.profilePhoto = (typeof p.profilePhoto === "string" && p.profilePhoto.length < 400000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(p.profilePhoto)) ? p.profilePhoto : "";
    return d;
  }
  function saveState() {
    if (!STORAGE_KEY) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (error) { toast("Penyimpanan gagal. Ruang browser mungkin penuh."); }
    schedulePush();
  }
  function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), 2800);
  }
  function setSidebar(open) {
    $("#sidebar").classList.toggle("open", open);
    $("#sidebarBackdrop").classList.toggle("show", open);
    $("#mobileMenu").setAttribute("aria-expanded", String(open));
  }
  function showDialog(id) {
    const dialog = document.getElementById(id);
    if (dialog && typeof dialog.showModal === "function") dialog.showModal();
    else if (dialog) dialog.setAttribute("open", "");
  }
  function closeDialog(id) {
    const dialog = document.getElementById(id);
    if (dialog?.open) dialog.close();
    else dialog?.removeAttribute("open");
  }
  function getMonthTransactions(month = currentMonth()) {
    return state.transactions.filter(t => monthKey(t.date) === month);
  }
  function sumTransactions(list, type) {
    return list.filter(t => t.type === type).reduce((sum,t) => sum + Number(t.amount || 0), 0);
  }
  function allIncome() { return sumTransactions(state.transactions, "income"); }
  function allExpense() { return sumTransactions(state.transactions, "expense"); }
  function totalSaved() { return state.goals.reduce((sum,g) => sum + Number(g.saved || 0), 0); }
  function availableBalance() { return allIncome() - allExpense() - totalSaved(); }
  const validDate = v => { const d = new Date(`${v}T00:00:00`); return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(d) && d.getFullYear() >= 2000 && d.getFullYear() <= 2100; };
  const balanceFor = txs => sumTransactions(txs, "income") - sumTransactions(txs, "expense") - totalSaved();
  function guardBalance(nextTxs) {
    const nb = balanceFor(nextTxs);
    if (nb < 0 && nb < availableBalance()) { toast(`Perubahan ditolak: saldo tersedia akan menjadi ${rupiah(nb)}. Catat pemasukan/saldo awal dulu atau kurangi dana target tabungan.`); return false; }
    return true;
  }
  const pctLabel = (g, p) => g.saved >= g.target ? 100 : Math.floor(p);
  function percent(saved, target) { return target > 0 ? Math.min(100, Math.max(0, saved / target * 100)) : 0; }
  function displayMoney(element, value) {
    if (!element) return;
    element.textContent = state.hideBalance ? "••••••" : rupiah(value);
  }
  function renderSummary() {
    const monthTransactions = getMonthTransactions();
    const currentIncome = sumTransactions(monthTransactions, "income");
    const currentExpense = sumTransactions(monthTransactions, "expense");
    $$('[data-money="balance"]').forEach(el => displayMoney(el, availableBalance()));
    $$('[data-money="income"]').forEach(el => displayMoney(el, currentIncome));
    $$('[data-money="expense"]').forEach(el => displayMoney(el, currentExpense));
    $$('[data-money="savings"]').forEach(el => displayMoney(el, totalSaved()));
    $("#transactionCount").textContent = state.transactions.length.toLocaleString("id-ID");
    displayMoney($("#reportIncome"), allIncome());
    displayMoney($("#reportExpense"), allExpense());
    displayMoney($("#reportNet"), allIncome() - allExpense());
    displayMoney($("#goalsTotalTarget"), state.goals.reduce((s,g)=>s+Number(g.target||0),0));
    displayMoney($("#goalsTotalSaved"), totalSaved());
    $("#goalsActiveCount").textContent = state.goals.filter(g => Number(g.saved) < Number(g.target)).length;
    const today = new Date();
    $("#todayLabel").textContent = today.toLocaleDateString(LOC(), {day:"numeric",month:"short",year:"numeric"});
    $("#toggleBalance").textContent = state.hideBalance ? "⊘" : "◉";
    $("#themeToggle").textContent = state.dark ? "☀" : "☾";
  }
  function categoryOptions(type, selected = "") {
    const list = [...categories[type], ...(state.customCategories[type] || [])];
    return list.map(c => `<option value="${escapeHTML(c)}" ${c===selected?"selected":""}>${escapeHTML(c)}</option>`).join("");
  }
  function refreshCategorySelects() {
    const type = $("#transactionType").value || "expense";
    const current = $("#transactionCategory").value;
    $("#transactionCategory").innerHTML = categoryOptions(type, current);
    const all = [...new Set([...categories.income, ...categories.expense, ...(state.customCategories.income||[]), ...(state.customCategories.expense||[])])];
    const filterValue = $("#categoryFilter").value || "all";
    $("#categoryFilter").innerHTML = `<option value="all">Semua kategori</option>` + all.map(c=>`<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("");
    $("#categoryFilter").value = all.includes(filterValue) ? filterValue : "all";
  }
  function transactionRow(t, detailed = false) {
    const income = t.type === "income";
    const icon = categoryIcons[t.category] || (income ? "↙" : "•");
    return `<tr>
      <td><div class="transaction-name"><span class="transaction-icon">${icon}</span><span>${escapeHTML(t.name)}<small>${escapeHTML(t.method || "—")}</small></span></div></td>
      <td>${escapeHTML(t.category)}</td>
      ${detailed ? `<td><span class="type-pill ${income?"":"expense"}">${income?"Pemasukan":"Pengeluaran"}</span></td>` : ""}
      <td>${new Date(`${t.date}T00:00:00`).toLocaleDateString(LOC(),{day:"2-digit",month:"short",year:"numeric"})}</td>
      <td class="${income?"amount-income":"amount-expense"}">${income?"+":"−"}${rupiah(t.amount)}</td>
      ${detailed ? `<td><div class="action-buttons"><button class="tiny-button" data-edit-transaction="${escapeHTML(t.id)}">Edit</button><button class="tiny-button" data-delete-transaction="${escapeHTML(t.id)}">Hapus</button></div></td>` : ""}
    </tr>`;
  }
  function renderTransactions() {
    const sorted = [...state.transactions].sort((a,b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt||0)-(a.createdAt||0));
    $("#recentTransactions").innerHTML = sorted.slice(0,5).map(t=>transactionRow(t)).join("");
    $("#recentEmpty").classList.toggle("hidden", sorted.length > 0);
    const search = ($("#transactionSearch").value || "").toLowerCase().trim();
    const type = $("#typeFilter").value;
    const category = $("#categoryFilter").value;
    const month = $("#monthFilter").value;
    const filtered = sorted.filter(t =>
      (!search || `${t.name} ${t.category} ${t.note||""} ${t.method||""}`.toLowerCase().includes(search)) &&
      (type === "all" || t.type === type) &&
      (category === "all" || t.category === category) &&
      (!month || monthKey(t.date) === month)
    );
    $("#allTransactions").innerHTML = filtered.map(t=>transactionRow(t,true)).join("");
    $("#transactionsEmpty").classList.toggle("hidden", filtered.length > 0);
  }
  function renderGoals() {
    const goals = [...state.goals].sort((a,b) => (a.deadline||"9999").localeCompare(b.deadline||"9999"));
    const dashboardGoals = goals.slice(0,3);
    $("#dashboardGoals").innerHTML = dashboardGoals.map(g => {
      const p = percent(g.saved,g.target);
      return `<div class="goal-mini"><div class="goal-emoji">${escapeHTML(g.icon || "🎯")}</div><div class="goal-mini-main"><div class="goal-title-row"><span>${escapeHTML(g.name)}</span><span>${pctLabel(g,p)}%</span></div><small>${rupiah(g.saved)} dari ${rupiah(g.target)}</small><div class="progress-track"><div class="progress-fill" style="width:${p}%"></div></div></div></div>`;
    }).join("");
    $("#dashboardGoalsEmpty").classList.toggle("hidden", dashboardGoals.length > 0);
    $("#goalsGrid").innerHTML = goals.map(g => {
      const p = percent(g.saved,g.target);
      const deadline = g.deadline ? `Target ${new Date(`${g.deadline}T00:00:00`).toLocaleDateString(LOC(),{day:"numeric",month:"short",year:"numeric"})}` : "Tanpa tenggat";
      return `<article class="goal-card"><div class="goal-card-top"><div class="goal-emoji">${escapeHTML(g.icon||"🎯")}</div><div class="goal-actions"><button class="tiny-button" data-edit-goal="${escapeHTML(g.id)}">Edit</button><button class="tiny-button" data-delete-goal="${escapeHTML(g.id)}">Hapus</button></div></div><h3>${escapeHTML(g.name)}</h3><div class="goal-deadline">${deadline}</div><div class="goal-progress-row"><strong>${rupiah(g.saved)}</strong><span>${pctLabel(g,p)}% tercapai</span></div><div class="progress-track"><div class="progress-fill" style="width:${p}%"></div></div><div class="goal-subrow"><span>Target</span><strong>${rupiah(g.target)}</strong></div><div class="goal-subrow"><span>Sisa target</span><strong>${rupiah(Math.max(0,g.target-g.saved))}</strong></div><button class="primary-button deposit-button" data-deposit-goal="${escapeHTML(g.id)}" ${g.saved>=g.target?"disabled":""}>＋ Tambah setoran</button></article>`;
    }).join("");
    $("#goalsEmpty").classList.toggle("hidden", goals.length > 0);
  }
  function categorySpent(category) {
    return sumTransactions(getMonthTransactions(), "expense") === 0 ? 0 :
      getMonthTransactions().filter(t=>t.type==="expense" && t.category===category).reduce((s,t)=>s+Number(t.amount||0),0);
  }
  function renderBudget() {
    const entries = Object.entries(state.budgets).filter(([,amount])=>Number(amount)>0);
    const total = entries.reduce((s,[,amount])=>s+Number(amount),0);
    const spent = entries.reduce((s,[category])=>s+categorySpent(category),0);
    displayMoney($("#budgetTotal"),total);
    displayMoney($("#budgetSpent"),spent);
    displayMoney($("#budgetRemaining"),total-spent);
    $("#budgetCards").innerHTML = entries.map(([category,amount])=>{
      const used = categorySpent(category), p = amount > 0 ? used/amount*100 : 0, over = used > amount;
      return `<article class="budget-card"><div class="budget-card-head"><span class="goal-emoji">${categoryIcons[category]||"◷"}</span><strong>${escapeHTML(category)}</strong></div><div class="budget-amounts"><strong>${rupiah(used)}</strong><span>dari ${rupiah(amount)}</span></div><div class="progress-track"><div class="progress-fill" style="width:${Math.min(100,p)}%;background:${over?"var(--red)":"var(--green)"}"></div></div><div class="budget-meta"><span>${over?`Melebihi ${rupiah(used-amount)}`:`Sisa ${rupiah(amount-used)}`}</span><span class="${over?"over-budget":""}">${Math.round(p)}%</span></div></article>`;
    }).join("");
    $("#budgetEmpty").classList.toggle("hidden", entries.length > 0);
  }
  function allocationValues() {
    const totalIncome = Math.max(0, Number($("#salaryIncome").value)||0) + Math.max(0, Number($("#salaryExtra").value)||0);
    const rows = [
      {name:"Kebutuhan pokok",pct:Number($("#needsPct").value),color:colors[0]},
      {name:"Keinginan & hiburan",pct:Number($("#wantsPct").value),color:colors[2]},
      {name:"Tabungan",pct:Number($("#savingsPct").value),color:colors[1]},
      {name:"Dana cadangan/pengembangan",pct:Number($("#bufferPct").value),color:colors[3]}
    ];
    const totalPct=rows.reduce((s,r)=>s+r.pct,0);
    rows.forEach(r=>{r.raw=totalIncome*r.pct/100;r.amount=Math.floor(r.raw);});
    if(totalPct===100&&Number.isInteger(totalIncome)){let rest=totalIncome-rows.reduce((s,r)=>s+r.amount,0);[...rows].sort((a,b)=>(b.raw-b.amount)-(a.raw-a.amount)).forEach(r=>{if(rest>0&&r.pct>0){r.amount++;rest--;}});}
    return {totalIncome,rows,totalPct};
  }
  function renderSalary() {
    const {totalIncome,rows,totalPct}=allocationValues();
    displayMoney($("#salaryTotal"),totalIncome);
    ["needs","wants","savings","buffer"].forEach((key,i)=>{$(`#${key}PctLabel`).textContent=`${$(`#${key}Pct`).value}%`;});
    $("#allocationTotal").textContent = `${totalPct}%`;
    $("#allocationTotal").style.color = totalPct===100 ? "var(--green)" : "var(--red)";
    $("#allocationError").classList.toggle("hidden",totalPct===100);
    $("#salaryBar").innerHTML = rows.map(r=>`<span style="width:${r.pct}%;background:${r.color}" title="${escapeHTML(r.name)} ${r.pct}%"></span>`).join("");
    $("#allocationResults").innerHTML = rows.map(r=>`<div class="allocation-result"><div class="result-name"><span class="legend-dot" style="background:${r.color}"></span>${escapeHTML(r.name)}</div><strong>${rupiah(r.amount)}</strong><small>${r.pct}% dari total pendapatan</small></div>`).join("");
  }
  function renderReports() {
    const expenses = state.transactions.filter(t=>t.type==="expense");
    const total = allExpense();
    const byCategory = {};
    expenses.forEach(t=>byCategory[t.category]=(byCategory[t.category]||0)+Number(t.amount||0));
    const sorted = Object.entries(byCategory).sort((a,b)=>b[1]-a[1]);
    const insights = [];
    if (!state.transactions.length) insights.push(["＋","Mulai catat transaksi","Tambahkan pemasukan dan pengeluaran agar laporan serta analisis bisa dibuat."]);
    else {
      insights.push(["↗","Total arus kas",`Total pemasukan ${rupiah(allIncome())} dan total pengeluaran ${rupiah(total)} berdasarkan semua transaksi yang tercatat.`]);
      if (sorted[0]) insights.push(["◎","Kategori pengeluaran terbesar",`${sorted[0][0]} adalah kategori terbesar dengan total ${rupiah(sorted[0][1])}.`]);
      const monthExp = sumTransactions(getMonthTransactions(),"expense");
      const monthIncome = sumTransactions(getMonthTransactions(),"income");
      if (monthIncome>0) insights.push(["％","Rasio pengeluaran bulan ini",`Kamu menggunakan ${Math.round(monthExp/monthIncome*100)}% dari pemasukan bulan ini untuk pengeluaran yang dicatat.`]);
      if (monthExp>monthIncome && monthIncome>0) insights.push(["!","Pengeluaran lebih tinggi dari pemasukan bulan ini","Periksa kembali anggaran dan prioritaskan kebutuhan wajib sebelum pengeluaran tambahan."]);
      if (state.goals.length) insights.push(["✦","Target tabungan",`Kamu memiliki ${state.goals.length} target dengan total terkumpul ${rupiah(totalSaved())}.`]);
    }
    $("#reportInsights").innerHTML = insights.map(([symbol,title,desc])=>`<div class="insight-item"><span class="insight-symbol">${symbol}</span><div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(desc)}</p></div></div>`).join("");
  }
  function categoryEntries() {
    const map = {};
    getMonthTransactions().filter(t => t.type === "expense").forEach(t => map[t.category] = (map[t.category]||0) + Number(t.amount||0));
    const list = Object.entries(map).sort((a,b) => b[1]-a[1]);
    return list.length ? list : [["Belum ada data", 1]];
  }
  function renderCategorySummary() {
    const entries = categoryEntries();
    $("#donutTotal").textContent = state.hideBalance ? "••••" : rupiah(sumTransactions(getMonthTransactions(), "expense"));
    $("#categoryLegend").innerHTML = entries.slice(0,5).map(([name,val],i) => `<div class="legend-row"><span class="legend-dot" style="background:${name==="Belum ada data"?"#dfe5ea":colors[i%colors.length]}"></span><span>${escapeHTML(name)}</span><strong>${state.hideBalance?"••••":rupiah(name==="Belum ada data"?0:val)}</strong></div>`).join("");
  }
  function buildCharts() {
    renderCategorySummary();
    const offline = !window.Chart;
    $$(".chart-wrap,.donut-wrap").forEach(el => offline ? el.setAttribute("data-offline","1") : el.removeAttribute("data-offline"));
    if (offline) return;
    const cashCtx = $("#cashflowChart");
    const categoryCtx = $("#categoryChart");
    const reportCtx = $("#reportChart");
    if (!cashCtx || !categoryCtx || !reportCtx) return;
    const chartColors = {income:"#a7f3c8",expense:"#ffb4a8",grid:"rgba(255,255,255,.14)",text:"#d5ece2"};
    const labelsAndMonths = [];
    const now = new Date();
    const count = Number($("#cashflowPeriod").value)||6;
    for(let i=count-1;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);labelsAndMonths.push({label:d.toLocaleDateString(LOC(),{month:"short"}),key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`});}
    const repMonths=[];for(let i=5;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);repMonths.push({label:d.toLocaleDateString(LOC(),{month:"short"}),key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`});}
    const repIn=repMonths.map(m=>sumTransactions(getMonthTransactions(m.key),"income")),repOut=repMonths.map(m=>sumTransactions(getMonthTransactions(m.key),"expense"));
    const inData=labelsAndMonths.map(m=>sumTransactions(getMonthTransactions(m.key),"income"));
    const outData=labelsAndMonths.map(m=>sumTransactions(getMonthTransactions(m.key),"expense"));
    const lineOptions={responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{position:"bottom",labels:{usePointStyle:true,boxWidth:7,boxHeight:7,padding:18,font:{family:"DM Sans",size:10},color:chartColors.text}},tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${rupiah(ctx.raw)}`}}},scales:{x:{grid:{display:false},ticks:{color:chartColors.text,font:{size:10}},border:{display:false}},y:{beginAtZero:true,grid:{color:chartColors.grid},ticks:{color:chartColors.text,font:{size:9},callback:v=>v>=1000000?`${(v/1000000).toLocaleString("id-ID")} jt`:v>=1000?`${Math.round(v/1000)} rb`:v},border:{display:false}}}};
    if(cashflowChart)cashflowChart.destroy();
    cashflowChart=new Chart(cashCtx,{type:"line",data:{labels:labelsAndMonths.map(m=>m.label),datasets:[{label:"Pemasukan",data:inData,borderColor:chartColors.income,backgroundColor:"#a7f3c822",fill:true,tension:.35,borderWidth:2.5,pointRadius:3,pointBackgroundColor:chartColors.income},{label:"Pengeluaran",data:outData,borderColor:chartColors.expense,backgroundColor:"#ffb4a814",fill:true,tension:.35,borderWidth:2.5,pointRadius:3,pointBackgroundColor:chartColors.expense}]},options:lineOptions});
    const monthExp=getMonthTransactions().filter(t=>t.type==="expense");
    const catMap={};monthExp.forEach(t=>catMap[t.category]=(catMap[t.category]||0)+Number(t.amount||0));
    let catEntries=Object.entries(catMap).sort((a,b)=>b[1]-a[1]);
    if(!catEntries.length)catEntries=[["Belum ada data",1]];
    if(categoryChart)categoryChart.destroy();
    categoryChart=new Chart(categoryCtx,{type:"doughnut",data:{labels:catEntries.map(x=>x[0]),datasets:[{data:catEntries.map(x=>x[1]),backgroundColor:catEntries.map((e,i)=>e[0]==="Belum ada data"?"#dfe5ea":colors[i%colors.length]),borderWidth:0,hoverOffset:4}]},options:{responsive:true,maintainAspectRatio:false,cutout:"76%",plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.label==="Belum ada data"?"Belum ada pengeluaran":`${ctx.label}: ${rupiah(ctx.raw)}`}}}}});
    if(reportChart)reportChart.destroy();
    reportChart=new Chart(reportCtx,{type:"bar",data:{labels:repMonths.map(m=>m.label),datasets:[{label:"Pemasukan",data:repIn,backgroundColor:chartColors.income,borderRadius:4,maxBarThickness:18},{label:"Pengeluaran",data:repOut,backgroundColor:chartColors.expense,borderRadius:4,maxBarThickness:18}]},options:{...lineOptions,scales:{...lineOptions.scales,x:{...lineOptions.scales.x,stacked:false},y:{...lineOptions.scales.y,beginAtZero:true}}}});
  }
  const hasDemo = () => state.transactions.some(t=>t.demo) || state.goals.some(g=>g.demo) || Object.keys(state.demoBudgets||{}).length > 0;
  let renderAll = function () {
    saveState();
    $("#demoBanner").classList.toggle("hidden",!hasDemo());
    renderSummary();refreshCategorySelects();renderTransactions();renderGoals();renderBudget();renderSalary();renderReports();buildCharts();
    document.body.classList.toggle("dark",!!state.dark);
  }
  function openTransaction(id=null) {
    $("#transactionForm").reset();
    $("#transactionId").value="";
    $("#transactionDate").value=todayISO();
    $("#transactionType").value="expense";
    refreshCategorySelects();
    $("#transactionDialogTitle").textContent=id?"Edit transaksi":"Tambah transaksi";
    if(id) {
      const t=state.transactions.find(x=>x.id===id);if(!t)return;
      $("#transactionId").value=t.id;$("#transactionType").value=t.type;refreshCategorySelects();
      $("#transactionName").value=t.name;$("#transactionCategory").value=t.category;
      $("#transactionAmount").value=t.amount;$("#transactionDate").value=t.date;
      $("#transactionMethod").value=t.method||"Tunai";$("#transactionNote").value=t.note||"";
    }
    $("#transactionType").dispatchEvent(new Event("change"));
    showDialog("transactionDialog");
  }
  function saveTransaction(event) {
    event.preventDefault();
    const id=$("#transactionId").value;
    const amount=Number($("#transactionAmount").value);
    if(!Number.isInteger(amount)||amount<=0||amount>999999999999){toast("Nominal harus bilangan bulat lebih besar dari nol (tanpa desimal).");return;}
    const old=id?state.transactions.find(t=>t.id===id):null;
    const item={id:id||makeId(),type:$("#transactionType").value,name:$("#transactionName").value.trim(),category:$("#transactionCategory").value,amount,date:$("#transactionDate").value,method:$("#transactionMethod").value,note:$("#transactionNote").value.trim(),createdAt:old?.createdAt||Date.now()};
    if(!item.name||!validDate(item.date)){toast("Lengkapi nama dan tanggal transaksi yang valid.");return;}
    const next=id?state.transactions.map(t=>t.id===id?item:t):[...state.transactions,item];if(!guardBalance(next))return;state.transactions=next;
    closeDialog("transactionDialog");renderAll();toast(id?"Transaksi berhasil diperbarui.":"Transaksi berhasil ditambahkan.");
  }
  function deleteTransaction(id) {
    const item=state.transactions.find(t=>t.id===id);if(!item)return;
    if(!confirm(`Hapus transaksi "${item.name}"?`))return;
    const next=state.transactions.filter(t=>t.id!==id);if(!guardBalance(next))return;state.transactions=next;renderAll();toast("Transaksi dihapus.");
  }
  function openGoal(id=null) {
    $("#goalForm").reset();$("#goalId").value="";$("#goalInitial").value="0";
    $("#goalDialogTitle").textContent=id?"Edit target tabungan":"Buat target tabungan";$("#goalInitialLabel").textContent=id?"Dana terkumpul (Rp)":"Tabungan awal (Rp)";
    if(id){const g=state.goals.find(x=>x.id===id);if(!g)return;$("#goalId").value=g.id;$("#goalName").value=g.name;$("#goalTarget").value=g.target;$("#goalInitial").value=g.saved;$("#goalIcon").value=g.icon;$("#goalDeadline").value=g.deadline||"";}
    showDialog("goalDialog");
  }
  function saveGoal(event) {
    event.preventDefault();
    const id=$("#goalId").value,target=Number($("#goalTarget").value),saved=Number($("#goalInitial").value);
    if(!Number.isInteger(target)||target<=0||!Number.isInteger(saved)||saved<0){toast("Target dan tabungan harus bilangan bulat (tabungan boleh 0, target lebih dari 0).");return;}
    if(saved>target){toast("Dana terkumpul tidak boleh melebihi target.");return;}
    const old=id?state.goals.find(g=>g.id===id):null;
    if(!old && saved>Math.max(0,availableBalance())){toast("Tabungan awal melebihi saldo tersedia. Tambahkan pemasukan atau kurangi nominal awal.");return;}
    if(old && saved>old.saved && saved-old.saved>Math.max(0,availableBalance())){toast("Tambahan tabungan melebihi saldo tersedia.");return;}
    const item={id:id||makeId(),name:$("#goalName").value.trim(),target,saved,icon:$("#goalIcon").value,deadline:$("#goalDeadline").value||"",createdAt:old?.createdAt||Date.now()};
    if(!item.name){toast("Masukkan nama target.");return;}
    if(id)state.goals=state.goals.map(g=>g.id===id?item:g);else state.goals.push(item);
    closeDialog("goalDialog");renderAll();toast(id?"Target diperbarui.":"Target tabungan dibuat.");
  }
  function deleteGoal(id) {
    const g=state.goals.find(x=>x.id===id);if(!g)return;
    if(!confirm(`Hapus target "${g.name}"? Dana ${rupiah(g.saved)} yang dialokasikan akan kembali menjadi saldo tersedia. Lanjutkan?`))return;
    state.goals=state.goals.filter(x=>x.id!==id);renderAll();toast("Target dihapus; alokasi dana kembali ke saldo tersedia.");
  }
  function openDeposit(id) {
    const g=state.goals.find(x=>x.id===id);if(!g)return;
    $("#depositGoalId").value=id;$("#depositGoalLabel").textContent=`Target: ${g.name} · saldo tersedia ${rupiah(availableBalance())}`;$("#depositAmount").value="";
    showDialog("depositDialog");
  }
  function saveDeposit(event) {
    event.preventDefault();
    const id=$("#depositGoalId").value,g=state.goals.find(x=>x.id===id),amount=Number($("#depositAmount").value);
    if(!g)return;
    if(!Number.isInteger(amount)||amount<=0){toast("Setoran harus bilangan bulat lebih besar dari nol.");return;}
    if(amount>g.target-g.saved){toast(`Setoran melebihi sisa target (${rupiah(g.target-g.saved)}).`);return;}
    if(amount>Math.max(0,availableBalance())){toast("Saldo tersedia tidak cukup untuk setoran ini.");return;}
    g.saved=g.saved+amount;
    closeDialog("depositDialog");renderAll();toast(g.saved>=g.target?"Selamat! Target tabungan tercapai.":"Setoran berhasil ditambahkan.");
  }
  function renderBudgetInputs() {
    const defaultCats=["Makan dan minum","Transportasi","Pendidikan","Tagihan","Belanja","Hiburan","Cicilan","Keluarga","Kesehatan","Lainnya"];
    const cats=[...new Set([...defaultCats,...Object.keys(state.budgets)])];
    $("#budgetInputs").innerHTML=cats.map(c=>`<label class="budget-input-row"><span>${escapeHTML(c)}</span><input type="number" min="0" step="1" data-budget-category="${escapeHTML(c)}" value="${Number(state.budgets[c]||0)}" placeholder="0"></label>`).join("");
    showDialog("budgetDialog");
  }
  function saveBudget(event) {
    event.preventDefault();
    const next={...state.budgets};
    $$("[data-budget-category]").forEach(input=>{const value=Number(input.value)||0;if(value>0)next[input.dataset.budgetCategory]=value;else delete next[input.dataset.budgetCategory];});
    state.budgets=next;closeDialog("budgetDialog");renderAll();toast("Anggaran berhasil disimpan.");
  }
  function applySalaryPlan(event) {
    event.preventDefault();
    const {totalIncome,rows,totalPct}=allocationValues();
    if(totalIncome<=0||!Number.isInteger(totalIncome)){toast("Masukkan pendapatan berupa bilangan bulat lebih dari nol.");return;}
    if(totalPct!==100){$("#allocationError").classList.remove("hidden");toast("Total alokasi harus tepat 100%.");return;}
    const needs=rows.find(r=>r.name==="Kebutuhan pokok").amount;
    const wants=rows.find(r=>r.name==="Keinginan & hiburan").amount;
    const savings=rows.find(r=>r.name==="Tabungan").amount;
    const buffer=rows.find(r=>r.name==="Dana cadangan/pengembangan").amount;
    const proposed={...state.budgets};
    // Rencana kebutuhan dibagi ke kategori kebutuhan umum; nominal anggaran tetap bisa diedit.
    const parts=[.35,.18,.22,.10,.15].map(w=>Math.floor(needs*w));parts[0]+=needs-parts.reduce((s,v)=>s+v,0);proposed["Makan dan minum"]=parts[0];
    proposed["Transportasi"]=parts[1];
    proposed["Tagihan"]=parts[2];
    proposed["Pendidikan"]=parts[3];
    proposed["Keluarga"]=parts[4];
    proposed["Hiburan"]=wants;
    proposed["Lainnya"]=buffer;
    state.budgets=proposed;
    state.salaryPlan={income:totalIncome,rows,appliedAt:Date.now(),suggestedMonthlySavings:savings};
    state.salaryForm={income:$("#salaryIncome").value,extra:$("#salaryExtra").value,needs:$("#needsPct").value,wants:$("#wantsPct").value,savings:$("#savingsPct").value,buffer:$("#bufferPct").value};
    renderAll();
    toast(`Anggaran diterapkan. Rekomendasi tabungan: ${rupiah(savings)} per bulan.`);
  }
  function exportCSV() {
    const header=["Tanggal","Nama transaksi","Jenis","Kategori","Metode pembayaran","Nominal","Catatan"];
    const rows=state.transactions.map(t=>[t.date,t.name,t.type==="income"?"Pemasukan":"Pengeluaran",t.category,t.method||"",t.amount,t.note||""]);
    const csv=[header,...rows].map(row=>row.map(value=>{let s=String(value??"");if(/^[=+\-@\t\r]/.test(s)&&typeof value==="string")s="'"+s;return `"${s.replace(/"/g,'""')}"`;}).join(",")).join("\r\n");
    const blob=new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"});
    const url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download=`smart-money-transaksi-${todayISO()}.csv`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);toast("Laporan CSV berhasil dibuat.");
  }
  function loadDemo() {
    if(state.transactions.length||state.goals.length){if(!confirm("Data demo akan ditambahkan ke data yang sudah ada. Lanjutkan?"))return;}
    const month=todayISO().slice(0,7);
    const dateAt=day=>`${month}-${String(day).padStart(2,"0")}`;
    const demo=[
      {type:"income",name:"Gaji bulanan",category:"Gaji",amount:5000000,date:dateAt(1),method:"Transfer bank"},
      {type:"expense",name:"Belanja kebutuhan",category:"Makan dan minum",amount:420000,date:dateAt(3),method:"DANA"},
      {type:"expense",name:"Transportasi",category:"Transportasi",amount:180000,date:dateAt(5),method:"Tunai"},
      {type:"expense",name:"Internet bulanan",category:"Tagihan",amount:150000,date:dateAt(7),method:"Transfer bank"},
      {type:"expense",name:"Makan siang",category:"Makan dan minum",amount:35000,date:dateAt(9),method:"Tunai"},
      {type:"income",name:"Proyek freelance",category:"Freelance",amount:350000,date:dateAt(10),method:"Transfer bank"},
      {type:"expense",name:"Nonton dan hiburan",category:"Hiburan",amount:100000,date:dateAt(11),method:"GoPay"}
    ].map(t=>({...t,id:makeId(),createdAt:Date.now()+Math.random(),note:"Data demo",demo:true}));
    state.transactions.push(...demo);
    const demoB={"Makan dan minum":700000,"Transportasi":350000,"Tagihan":300000,"Pendidikan":250000,"Hiburan":250000,"Belanja":300000,"Keluarga":400000,"Lainnya":200000};
    Object.entries(demoB).forEach(([k,v])=>{if(!(k in state.budgets)){state.budgets[k]=v;state.demoBudgets[k]=v;}});
    if(!state.goals.length)state.goals.push({demo:true,id:makeId(),name:"Laptop baru",target:8000000,saved:500000,icon:"💻",deadline:"",createdAt:Date.now()},{demo:true,id:makeId(),name:"Dana darurat",target:3000000,saved:250000,icon:"🛟",deadline:"",createdAt:Date.now()+1});
    renderAll();toast("Data demo berhasil ditambahkan.");
  }
  function removeDemo() {
    if(!hasDemo()){toast("Tidak ada data demo.");return;}
    if(!confirm("Hapus hanya data demo (transaksi, target, dan anggaran contoh)? Data asli kamu tidak ikut terhapus."))return;
    state.transactions=state.transactions.filter(t=>!t.demo);state.goals=state.goals.filter(g=>!g.demo);
    Object.entries(state.demoBudgets||{}).forEach(([k,v])=>{if(state.budgets[k]===v)delete state.budgets[k];});
    state.demoBudgets={};renderAll();toast("Data demo dihapus.");
  }
  function clearAllData() {
    if(!confirm("Yakin ingin menghapus semua transaksi, target tabungan, dan anggaran"+(CLOUD?" di akun ini (termasuk di perangkat lain)":" yang tersimpan di browser ini")+"? Tindakan ini tidak dapat dibatalkan."))return;
    const keep={dark:state.dark,lang:state.lang,currency:state.currency,rate:state.rate,profilePhoto:state.profilePhoto};state=Object.assign(defaultState(),keep);restoreSalaryForm();renderAll();toast("Semua data keuangan telah dihapus.");
  }
  function showPage(page) {
    const valid=["dashboard","salary","transactions","budget","goals","reports","settings"];
    if(!valid.includes(page))page="dashboard";
    $$(".page").forEach(el=>el.classList.toggle("active",el.id===`page-${page}`));
    $$(".nav-item[data-page]").forEach(el=>{const on=el.dataset.page===page;el.classList.toggle("active",on);if(on)el.setAttribute("aria-current","page");else el.removeAttribute("aria-current");});
    const active=$(`.nav-item[data-page="${page}"]`);
    applyLang();
    setSidebar(false);
    window.scrollTo({top:0,behavior:"smooth"});
    if(page==="reports"||page==="dashboard")setTimeout(buildCharts,60);
  }

  document.addEventListener("click",event=>{
    const nav=event.target.closest("[data-page]");if(nav){event.preventDefault();showPage(nav.dataset.page);return;}
    const goto=event.target.closest("[data-goto]");if(goto){showPage(goto.dataset.goto);return;}
    const close=event.target.closest("[data-close]");if(close){closeDialog(close.dataset.close);return;}
    const editT=event.target.closest("[data-edit-transaction]");if(editT){openTransaction(editT.dataset.editTransaction);return;}
    const delT=event.target.closest("[data-delete-transaction]");if(delT){deleteTransaction(delT.dataset.deleteTransaction);return;}
    const editG=event.target.closest("[data-edit-goal]");if(editG){openGoal(editG.dataset.editGoal);return;}
    const delG=event.target.closest("[data-delete-goal]");if(delG){deleteGoal(delG.dataset.deleteGoal);return;}
    const dep=event.target.closest("[data-deposit-goal]");if(dep){openDeposit(dep.dataset.depositGoal);return;}
  });
  $("#mobileMenu").addEventListener("click",()=>setSidebar(!$("#sidebar").classList.contains("open")));
  $("#sidebarBackdrop").addEventListener("click",()=>setSidebar(false));
  $("#quickAdd").addEventListener("click",()=>openTransaction());
  $("#addTransaction").addEventListener("click",()=>openTransaction());
  $("#transactionType").addEventListener("change",refreshCategorySelects);
  $("#transactionForm").addEventListener("submit",saveTransaction);
  $("#addGoal").addEventListener("click",()=>openGoal());
  $("#goalForm").addEventListener("submit",saveGoal);
  $("#depositForm").addEventListener("submit",saveDeposit);
  $("#budgetForm").addEventListener("submit",saveBudget);
  $("#editBudgetButton").addEventListener("click",renderBudgetInputs);
  $("#salaryForm").addEventListener("submit",applySalaryPlan);
  ["needsPct","wantsPct","savingsPct","bufferPct","salaryIncome","salaryExtra"].forEach(id=>$("#"+id).addEventListener("input",renderSalary));
  ["transactionSearch","typeFilter","categoryFilter","monthFilter"].forEach(id=>$("#"+id).addEventListener(id==="transactionSearch"?"input":"change",renderTransactions));
  $("#cashflowPeriod").addEventListener("change",buildCharts);
  $("#toggleBalance").addEventListener("click",()=>{state.hideBalance=!state.hideBalance;renderAll();toast(state.hideBalance?"Nominal disembunyikan.":"Nominal ditampilkan.");});
  $("#themeToggle").addEventListener("click",()=>{state.dark=!state.dark;renderAll();});
  $("#loadDemo").addEventListener("click",loadDemo);
  $("#clearData").addEventListener("click",clearAllData);
  $("#removeDemo").addEventListener("click",removeDemo);
  $("#removeDemoBanner").addEventListener("click",removeDemo);
  $("#exportCsv").addEventListener("click",exportCSV);
  const tips=[
    "Catat pengeluaran segera setelah transaksi supaya laporan tetap akurat.",
    "Pisahkan kebutuhan wajib dari keinginan agar anggaran lebih realistis.",
    "Tentukan target tabungan dengan nominal dan tenggat yang jelas.",
    "Tinjau anggaran setiap akhir bulan dan sesuaikan dengan kondisi terbaru."
  ];
  $("#tipButton").addEventListener("click",()=>toast(tips[Math.floor(Math.random()*tips.length)]));
  document.addEventListener("keydown",event=>{if(event.key==="Escape")setSidebar(false);});
  function restoreSalaryForm(){const f=state.salaryForm||{income:"",extra:"0",needs:"50",wants:"20",savings:"20",buffer:"10"};[["salaryIncome","income"],["salaryExtra","extra"],["needsPct","needs"],["wantsPct","wants"],["savingsPct","savings"],["bufferPct","buffer"]].forEach(([id,k])=>{if(f[k]!==undefined&&f[k]!==null)$("#"+id).value=f[k];});}
  restoreSalaryForm();
  window.addEventListener("storage",e=>{if(!CLOUD&&STORAGE_KEY&&e.key===STORAGE_KEY){state=loadState();renderAll();}});
  const EN = Object.assign({"Masuk": "Log in", "Daftar": "Sign up", "Nama": "Name", "Nama kamu": "Your name", "Kata sandi": "Password", "Lihat/sembunyikan kata sandi": "Show/hide password", "Ulangi kata sandi": "Repeat password", "Minimal 8 karakter": "At least 8 characters", "Akun": "Account", "Keluar": "Log out", "Pengeluaran": "Expense", "Pemasukan": "Income", "Keluar dari akun ini?": "Log out of this account?", "Akun ini disimpan hanya di browser/perangkat ini (bukan cloud). Data tidak dienkripsi; siapa pun yang memakai browser ini dapat membukanya lewat alat pengembang. Tidak ada fitur lupa kata sandi.": "This account is stored only in this browser/device (not cloud). Data is not encrypted; anyone using this browser can read it via developer tools. There is no password recovery."}, {"Kalkulator Gaji": "Salary Calculator", "Transaksi": "Transactions", "Anggaran": "Budget", "Target Tabungan": "Savings Goals", "Laporan": "Reports", "Pengaturan": "Settings", "MENU UTAMA": "MAIN MENU", "Workspace": "Workspace", "RINGKASAN KEUANGAN": "FINANCIAL OVERVIEW", "Pantau kondisi keuanganmu dan capai tujuan berikutnya.": "Track your finances and reach your next goal.", "Tambah transaksi": "Add transaction", "Saldo tersedia": "Available balance", "Berdasarkan transaksi tercatat": "Based on recorded transactions", "Total pemasukan": "Total income", "Total pengeluaran": "Total expenses", "Total tabungan": "Total savings", "Bulan ini": "This month", "Dana dalam target tabungan": "Funds inside savings goals", "Arus kas": "Cash flow", "Perbandingan pemasukan dan pengeluaran": "Income vs expenses", "6 bulan terakhir": "Last 6 months", "3 bulan terakhir": "Last 3 months", "12 bulan terakhir": "Last 12 months", "Pengeluaran per kategori": "Spending by category", "Total keluar": "Total spent", "Transaksi terbaru": "Recent transactions", "Aktivitas keuangan terakhir": "Latest activity", "Lihat semua": "View all", "TRANSAKSI": "TRANSACTION", "KATEGORI": "CATEGORY", "TANGGAL": "DATE", "NOMINAL": "AMOUNT", "JENIS": "TYPE", "AKSI": "ACTIONS", "Target tabungan": "Savings goals", "Langkah kecil menuju tujuanmu": "Small steps toward your goal", "Belum ada transaksi. Tambahkan transaksi pertamamu.": "No transactions yet. Add your first one.", "Belum ada target tabungan.": "No savings goals yet.", "RENCANAKAN PENDAPATAN": "PLAN YOUR INCOME", "Kalkulator Gaji Pintar": "Smart Salary Calculator", "Buat rencana uang yang sesuai dengan kebutuhanmu.": "Build a money plan that fits your needs.", "Detail pendapatan": "Income details", "Masukkan pendapatan bersih bulanan.": "Enter your monthly net income.", "Gaji bulanan (Rp)": "Monthly salary (Rp)", "Pendapatan tambahan (Rp)": "Extra income (Rp)", "Rencana pembagian pendapatan": "Income allocation plan", "Kebutuhan pokok": "Essentials", "Keinginan & hiburan": "Wants & entertainment", "Tabungan": "Savings", "Dana cadangan/pengembangan": "Reserve fund", "Total alokasi": "Total allocation", "Total persentase harus 100% sebelum anggaran diterapkan.": "Total must be exactly 100% before applying.", "Hitung & terapkan anggaran": "Calculate & apply budget", "TOTAL PENDAPATAN": "TOTAL INCOME", "Perkiraan pembagian uang per bulan": "Estimated monthly split", "Rekomendasi anggaran": "Budget recommendation", "Nominal berdasarkan persentase pilihanmu": "Amounts based on your percentages", "CATAT SETIAP AKTIVITAS": "RECORD EVERY ACTIVITY", "Semua pemasukan dan pengeluaran di satu tempat.": "All income and expenses in one place.", "Pemasukan bulan ini": "Income this month", "Pengeluaran bulan ini": "Expenses this month", "Jumlah transaksi": "Transaction count", "Cari transaksi...": "Search transactions...", "Semua jenis": "All types", "Semua kategori": "All categories", "Pemasukan": "Income", "Pengeluaran": "Expense", "Tidak ada transaksi yang cocok. Tambahkan transaksi atau ubah filter.": "No matching transactions. Add one or change the filters.", "Edit": "Edit", "Hapus": "Delete", "KENDALIKAN PENGELUARAN": "CONTROL YOUR SPENDING", "Pantau penggunaan anggaran setiap kategori.": "Track budget usage per category.", "Atur anggaran": "Set budget", "Total anggaran": "Total budget", "Sudah digunakan": "Used", "Sisa anggaran": "Remaining budget", "Terapkan anggaran dari Kalkulator Gaji Pintar untuk mulai memantau pengeluaran.": "Apply a budget from the Smart Salary Calculator to start tracking.", "WUJUDKAN RENCANAMU": "MAKE IT HAPPEN", "Buat tujuan, sisihkan uang, dan pantau progresnya.": "Set goals, save money, track progress.", "Buat target": "New goal", "Total target": "Total targets", "Sudah terkumpul": "Saved so far", "Target aktif": "Active goals", "Belum ada target tabungan. Buat target pertamamu.": "No savings goals yet. Create your first one.", "＋ Tambah setoran": "＋ Add deposit", "Sisa target": "Remaining", "Target": "Target", "Tanpa tenggat": "No deadline", "PAHAMI KEBIASAANMU": "UNDERSTAND YOUR HABITS", "Laporan Keuangan": "Financial Reports", "Analisis berdasarkan transaksi yang kamu catat.": "Analysis based on your recorded transactions.", "Ekspor CSV": "Export CSV", "Pemasukan keseluruhan": "Total income (all time)", "Pengeluaran keseluruhan": "Total expenses (all time)", "Selisih": "Difference", "Tren arus kas": "Cash flow trend", "Analisis sederhana": "Simple insights", "Berdasarkan catatanmu": "Based on your records", "PREFERENSI APLIKASI": "APP PREFERENCES", "Atur pengalaman dan data Smart Money.": "Manage your Smart Money experience and data.", "Bahasa": "Language", "Pilih bahasa tampilan aplikasi.": "Choose the app display language.", "Mata uang tampilan": "Display currency", "Data tersimpan dalam Rupiah; USD hanya konversi tampilan memakai kurs manual (input nominal tetap dalam Rp).": "Data is stored in Rupiah; USD is a display conversion using a manual rate (amount inputs stay in Rp).", "Kurs USD (Rp per $1)": "USD rate (Rp per $1)", "Diisi manual, tidak diambil otomatis dari internet.": "Entered manually, not fetched from the internet.", "Data demo": "Demo data", "Muat data demo": "Load demo data", "Hapus data demo": "Remove demo data", "Hapus seluruh data": "Delete all data", "Hapus data": "Delete data", "Penyimpanan": "Storage", "Local storage (hanya browser ini)": "Local storage (this browser only)", "CATAT KEUANGAN": "RECORD FINANCES", "Edit transaksi": "Edit transaction", "Jenis transaksi": "Transaction type", "Nama transaksi": "Transaction name", "Kategori": "Category", "Nominal (Rp)": "Amount (Rp)", "Tanggal": "Date", "Metode pembayaran": "Payment method", "Catatan (opsional)": "Note (optional)", "Batal": "Cancel", "Simpan transaksi": "Save transaction", "Nama target": "Goal name", "Target (Rp)": "Target (Rp)", "Tabungan awal (Rp)": "Initial savings (Rp)", "Dana terkumpul (Rp)": "Saved amount (Rp)", "Ikon": "Icon", "Tenggat (opsional)": "Deadline (optional)", "Simpan target": "Save goal", "Buat target tabungan": "Create savings goal", "Edit target tabungan": "Edit savings goal", "Tambah setoran": "Add deposit", "Nominal setoran (Rp)": "Deposit amount (Rp)", "Konfirmasi setoran": "Confirm deposit", "Simpan anggaran": "Save budget", "ANGGARAN BULANAN": "MONTHLY BUDGET", "Makan dan minum": "Food & drinks", "Transportasi": "Transport", "Pendidikan": "Education", "Tagihan": "Bills", "Belanja": "Shopping", "Hiburan": "Entertainment", "Cicilan": "Installments", "Keluarga": "Family", "Kesehatan": "Health", "Lainnya": "Other", "Gaji": "Salary", "Bisnis": "Business", "Pendapatan lainnya": "Other income", "Belum ada data": "No data yet", "Tunai": "Cash", "Transfer bank": "Bank transfer", "Sembunyikan/tampilkan saldo": "Hide/show balance", "Tips keuangan": "Finance tip", "Pengguna": "User", "Keuangan pribadi": "Personal finance"});
  Object.assign(EN, {"Lanjutkan dengan Google": "Continue with Google", "atau dengan email": "or with email", "Lupa kata sandi?": "Forgot password?", "Memuat akun…": "Loading account…", "Foto profil": "Profile photo", "Ganti foto": "Change photo", "Hapus foto": "Remove photo", "Ketuk foto untuk menggantinya. Foto dipotong persegi dan tersimpan di akunmu.": "Tap the photo to change it. It is cropped square and saved to your account.", "Penyimpanan & sinkronisasi": "Storage & sync", "Akun & data tersimpan aman di cloud (Google Firebase) dan otomatis tersinkron ke semua perangkat yang masuk dengan akun yang sama. Kata sandi dikelola oleh Firebase Auth, bukan disimpan di aplikasi ini.": "Your account & data are stored in the cloud (Google Firebase) and sync automatically to every device signed in with the same account. Passwords are handled by Firebase Auth, not stored in this app."});
  const origText = new WeakMap(), origAttr = new WeakMap();
  const tr = s => { const t = s.trim(); return state.lang === "en" && EN[t] ? s.replace(t, EN[t]) : s; };
  function applyLang() {
    document.documentElement.lang = state.lang;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.nodeValue.trim() || n.parentNode.closest("script,style,#toast,#langToggle,#currencyToggle")) continue;
      if (!origText.has(n)) origText.set(n, n.nodeValue);
      n.nodeValue = tr(origText.get(n));
    }
    $$("[placeholder],[aria-label],[title]").forEach(el => ["placeholder","aria-label","title"].forEach(a => {
      if (!el.hasAttribute(a)) return; const m = origAttr.get(el) || {}; if (!(a in m)) { m[a] = el.getAttribute(a); origAttr.set(el, m); }
      el.setAttribute(a, tr(m[a]));
    }));
    const act = $(".nav-item.active[data-page]");
    $("#breadcrumbPage").textContent = act ? [...act.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join("").trim() : "Dashboard";
    $("#accountInfo").textContent = currentUser ? `${currentUser.name} · ${currentUser.email}` : "";
    $("#langToggle").textContent = state.lang === "en" ? "EN" : "ID";
    $("#currencyToggle").textContent = state.currency === "USD" ? "$" : "Rp";
    $("#langSelect").value = state.lang; $("#currencySelect").value = state.currency; $("#rateInput").value = state.rate;
  }
  // ===== Autentikasi lokal (per perangkat) =====
  const b64 = a => btoa(String.fromCharCode(...new Uint8Array(a)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function hashPw(pw, salt, it) {
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
    return b64(await crypto.subtle.deriveBits({name:"PBKDF2", hash:"SHA-256", salt, iterations: it}, k, 256));
  }
  let authMode = "login", fails = 0, lockUntil = 0;
  const authErr = m => { const e = $("#authError"); e.textContent = m; e.classList.toggle("hidden", !m); };
  function setAuthMode(m) {
    authMode = m; authErr("");
    $("#tabLogin").classList.toggle("on", m === "login"); $("#tabRegister").classList.toggle("on", m === "register");
    $("#nameRow").classList.toggle("hidden", m !== "register"); $("#confirmRow").classList.toggle("hidden", m !== "register");
    $("#authSubmit").textContent = m === "login" ? tr("Masuk") : tr("Daftar");
    $("#authPassword").autocomplete = m === "login" ? "current-password" : "new-password";
    $("#googleBtn").classList.toggle("hidden", !CLOUD); $("#authDivider").classList.toggle("hidden", !CLOUD);
    $("#forgotBtn").classList.toggle("hidden", !(CLOUD && m === "login"));
  }
  function resetPwToggles() { $$(".pw-toggle").forEach(b => { b.previousElementSibling.type = "password"; b.setAttribute("aria-pressed", "false"); b.textContent = "👁"; }); }
  $$(".pw-toggle").forEach(b => b.addEventListener("click", () => { const i = b.previousElementSibling, show = i.type === "password"; i.type = show ? "text" : "password"; b.setAttribute("aria-pressed", String(show)); b.textContent = show ? "🙈" : "👁"; }));
  function showAuth() { $("#authScreen").classList.remove("booting"); resetPwToggles(); document.body.classList.add("locked"); $("#authScreen").classList.remove("hidden"); $("#authForm").reset(); setAuthMode("login"); }
  function enterApp(user) {
    currentUser = user; STORAGE_KEY = LEGACY_KEY + "_" + user.id;
    try { localStorage.setItem(SESSION_KEY, user.id); } catch (e) {}
    state = loadState(); restoreSalaryForm();
    document.body.classList.remove("locked"); $("#authScreen").classList.add("hidden");
    renderAll(); showPage("dashboard");
  }
  function logout() {
    if (!confirm(tr("Keluar dari akun ini?"))) return;
    if (CLOUD) { cloudLogout(); return; }
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    STORAGE_KEY = null; currentUser = null; const lang = state.lang, cur = state.currency, rate = state.rate;
    state = defaultState(); state.lang = lang; state.currency = cur; state.rate = rate;
    $("#salaryIncome").value = ""; $("#salaryExtra").value = "0";
    renderAll(); showAuth();
  }
  async function submitAuth(e) {
    e.preventDefault(); authErr("");
    if (CLOUD_BROKEN) { authErr("Layanan sinkronisasi (Firebase) belum termuat. Periksa koneksi internet lalu muat ulang halaman."); return; }
    if (CLOUD) { submitCloudAuth(); return; }
    if (!window.crypto || !crypto.subtle) { authErr("Browser ini tidak mendukung penyimpanan kata sandi yang aman (WebCrypto). Gunakan browser modern."); return; }
    const email = $("#authEmail").value.trim().toLowerCase(), pw = $("#authPassword").value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { authErr("Masukkan email yang valid."); return; }
    if (pw.length < 8) { authErr("Kata sandi minimal 8 karakter."); return; }
    const users = getUsers();
    if (authMode === "register") {
      const name = $("#authName").value.trim();
      if (!name) { authErr("Masukkan nama."); return; }
      if (pw !== $("#authConfirm").value) { authErr("Konfirmasi kata sandi tidak sama."); return; }
      if (users.some(u => u.email === email)) { authErr("Email sudah terdaftar. Silakan masuk."); return; }
      const salt = crypto.getRandomValues(new Uint8Array(16)), iter = 150000;
      const user = {id: makeId(), name, email, salt: b64(salt), iter, hash: await hashPw(pw, salt, iter)};
      try {
        localStorage.setItem(USERS_KEY, JSON.stringify([...users, user]));
        const legacy = users.length === 0 ? localStorage.getItem(LEGACY_KEY) : null;
        if (legacy) { localStorage.setItem(LEGACY_KEY + "_" + user.id, legacy); localStorage.setItem(LEGACY_KEY + "_migrated_backup", legacy); localStorage.removeItem(LEGACY_KEY); }
      } catch (err) { authErr("Gagal menyimpan akun (penyimpanan browser penuh/diblokir)."); return; }
      enterApp(user); toast("Akun dibuat. Selamat datang, " + name + "!"); return;
    }
    if (Date.now() < lockUntil) { authErr("Terlalu banyak percobaan. Coba lagi dalam " + Math.ceil((lockUntil - Date.now()) / 1000) + " detik."); return; }
    const user = users.find(u => u.email === email);
    const ok = user && (await hashPw(pw, unb64(user.salt), user.iter)) === user.hash;
    if (!ok) { if (++fails >= 5) { lockUntil = Date.now() + 30000; fails = 0; } authErr("Email atau kata sandi salah."); return; }
    fails = 0; enterApp(user); toast("Selamat datang kembali, " + user.name + "!");
  }
  $("#tabLogin").addEventListener("click", () => setAuthMode("login"));
  $("#tabRegister").addEventListener("click", () => setAuthMode("register"));
  $("#authForm").addEventListener("submit", submitAuth);
  $("#logoutButton").addEventListener("click", logout);
  $("#logoutSetting").addEventListener("click", logout);
  $$(".seg[aria-label] button").forEach(btn => btn.addEventListener("click", () => { $("#transactionType").value = btn.dataset.type; $("#transactionType").dispatchEvent(new Event("change")); }));
  $("#transactionType").addEventListener("change", () => $$(".seg[aria-label] button").forEach(b => b.classList.toggle("on", b.dataset.type === $("#transactionType").value)));
  // ===== Profil: foto sendiri =====
  const t2 = (id, en) => state.lang === "en" ? en : id;
  const initials = n => { const p = String(n || "").trim().split(/\s+/).filter(Boolean); return ((p[0] ? p[0][0] : "S") + (p[1] ? p[1][0] : "")).toUpperCase(); };
  function paintAvatar(el) {
    if (state.profilePhoto) { el.style.backgroundImage = `url("${state.profilePhoto}")`; el.classList.add("has-photo"); el.textContent = ""; }
    else { el.style.backgroundImage = ""; el.classList.remove("has-photo"); el.textContent = initials(currentUser && currentUser.name); }
  }
  function updateProfileUI() {
    $$(".avatar,.top-avatar").forEach(paintAvatar);
    const name = currentUser ? currentUser.name : "", email = currentUser ? currentUser.email : "";
    $("#profileName").textContent = name || t2("Pengguna", "User");
    $("#profileEmail").textContent = email;
    if (currentUser) { $(".profile-copy strong").textContent = name; $(".profile-copy small").textContent = email; }
    $("#photoRemove").classList.toggle("hidden", !state.profilePhoto);
    paintSync();
  }
  function handlePhoto(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast(t2("File harus berupa gambar.", "The file must be an image.")); return; }
    if (file.size > 20 * 1024 * 1024) { toast(t2("Foto terlalu besar (maks. 20 MB).", "Photo too large (max 20 MB).")); return; }
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const S = 256, c = document.createElement("canvas"); c.width = c.height = S;
      const w = img.naturalWidth, h = img.naturalHeight, side = Math.min(w, h), ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, S, S);
      ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, S, S);
      URL.revokeObjectURL(url);
      state.profilePhoto = c.toDataURL("image/jpeg", 0.85);
      renderAll(); toast(t2("Foto profil diperbarui.", "Profile photo updated."));
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast(t2("Foto tidak bisa dibaca. Coba format JPG atau PNG.", "Could not read the photo. Try JPG or PNG.")); };
    img.src = url;
  }
  $("#photoUpload").addEventListener("click", () => $("#photoInput").click());
  $("#profileAvatarLg").addEventListener("click", () => $("#photoInput").click());
  $("#photoInput").addEventListener("change", e => { handlePhoto(e.target.files[0]); e.target.value = ""; });
  $("#photoRemove").addEventListener("click", () => { state.profilePhoto = ""; renderAll(); toast(t2("Foto profil dihapus.", "Profile photo removed.")); });

  // ===== Simpan otomatis pengaturan kalkulator gaji / tabungan =====
  function persistSalaryForm() {
    clearTimeout(salaryTimer);
    salaryTimer = setTimeout(() => {
      if (!STORAGE_KEY) return;
      state.salaryForm = {income:$("#salaryIncome").value, extra:$("#salaryExtra").value, needs:$("#needsPct").value, wants:$("#wantsPct").value, savings:$("#savingsPct").value, buffer:$("#bufferPct").value};
      saveState();
    }, 300);
  }
  ["needsPct","wantsPct","savingsPct","bufferPct","salaryIncome","salaryExtra"].forEach(id => $("#"+id).addEventListener("input", persistSalaryForm));

  // ===== Sinkronisasi cloud (Firebase Auth + Firestore) =====
  const dirtyKey = () => (STORAGE_KEY || "") + "_dirty";
  const isDirty = () => { try { return localStorage.getItem(dirtyKey()) === "1"; } catch (e) { return false; } };
  const markDirty = v => { try { if (STORAGE_KEY) localStorage.setItem(dirtyKey(), v ? "1" : "0"); } catch (e) {} };
  function paintSync() {
    const L = {
      local:   ["Hanya di browser ini", "This browser only"],
      saving:  ["Menyimpan…", "Saving…"],
      saved:   ["Tersinkron ✓", "Synced ✓"],
      offline: ["Offline — disinkron saat online", "Offline — syncs when back online"],
      error:   ["Gagal sinkron, dicoba lagi", "Sync failed, retrying"]
    };
    const st = CLOUD ? syncState : "local", label = L[st][state.lang === "en" ? 1 : 0];
    const pill = $("#syncPill"), info = $("#storageInfo"), dot = $("#syncDot");
    if (pill) pill.textContent = label;
    if (dot) { dot.dataset.state = st; dot.title = label; }
    if (info) info.textContent = CLOUD
      ? t2(`Otomatis tersimpan ke akun ${currentUser ? currentUser.email : ""} dan tersinkron ke semua perangkat yang masuk dengan akun yang sama.`, `Automatically saved to ${currentUser ? currentUser.email : "your account"} and synced to every device signed in with the same account.`)
      : t2("Firebase belum diatur, jadi data hanya tersimpan di browser perangkat ini. Ikuti PANDUAN-SETUP.md untuk sinkronisasi antar perangkat.", "Firebase is not set up, so data is only stored in this device's browser. Follow PANDUAN-SETUP.md to enable cross-device sync.");
  }
  function setSync(st) { if (syncState !== st) { syncState = st; paintSync(); } }
  function schedulePush() {
    if (!CLOUD || !cloudDoc || applyingRemote) return;
    markDirty(true);
    setSync(navigator.onLine === false ? "offline" : "saving");
    clearTimeout(pushTimer); pushTimer = setTimeout(() => pushNow(), 700);
  }
  async function pushNow(force) {
    clearTimeout(pushTimer); pushTimer = null;
    if (!CLOUD || !cloudDoc || !currentUser) return true;
    const json = JSON.stringify(state);
    if (!force && json === lastPushed) { markDirty(false); setSync("saved"); return true; }
    const prev = lastPushed; lastPushed = json;
    try {
      await cloudDoc.set({json, v: 1, updatedAt: firebase.firestore.FieldValue.serverTimestamp()});
      if (JSON.stringify(state) === json) { markDirty(false); setSync("saved"); }
      return true;
    } catch (e) {
      console.warn("Sinkronisasi gagal:", e);
      lastPushed = prev;
      setSync(navigator.onLine === false ? "offline" : "error");
      if (e && e.code === "permission-denied") toast("Akses ditolak oleh Firestore. Periksa Rules di Firebase Console (lihat PANDUAN-SETUP.md).");
      clearTimeout(retryTimer); retryTimer = setTimeout(() => { if (isDirty()) pushNow(true); }, 15000);
      return false;
    }
  }
  function applyRemote(json) {
    let s; try { s = sanitizeState(JSON.parse(json)); } catch (e) { return; }
    applyingRemote = true;
    try { state = s; restoreSalaryForm(); renderAll(); } finally { applyingRemote = false; }
    lastPushed = JSON.stringify(state); markDirty(false);
  }
  const hasUserData = st => !!(st.transactions.length || st.goals.length || Object.keys(st.budgets).length || st.salaryPlan || st.profilePhoto);
  function findLegacy() {
    let best = null, bestN = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!/^smartMoneyData_v1(_[0-9a-zA-Z-]+)?$/.test(k) || k === STORAGE_KEY) continue;
        let st; try { st = sanitizeState(JSON.parse(localStorage.getItem(k))); } catch (e) { continue; }
        const n = st.transactions.length + st.goals.length;
        if (n > bestN) { best = st; bestN = n; }
      }
    } catch (e) {}
    return best;
  }
  function firstTimeCloud() {
    if (firstDone) return; firstDone = true;
    if (!hasUserData(state)) {
      const old = findLegacy();
      if (old && confirm(t2(`Ditemukan data keuangan lama di browser ini (${old.transactions.length} transaksi, ${old.goals.length} target tabungan). Impor ke akunmu agar tersinkron ke semua perangkat?`, `Found older data in this browser (${old.transactions.length} transactions, ${old.goals.length} savings goals). Import it into your account so it syncs to all devices?`))) {
        state = old; restoreSalaryForm(); renderAll();
      }
    }
    pushNow(true);
  }
  function stopCloudSync() {
    if (unsubDoc) { try { unsubDoc(); } catch (e) {} }
    unsubDoc = null; cloudDoc = null;
    clearTimeout(pushTimer); pushTimer = null; clearTimeout(retryTimer);
  }
  function startCloudSync(user) {
    stopCloudSync();
    cloudDoc = fbDb.collection("users").doc(user.uid);
    firstDone = false; lastPushed = ""; lastRemoteJson = "";
    setSync(navigator.onLine === false ? "offline" : "saving");
    unsubDoc = cloudDoc.onSnapshot({includeMetadataChanges: true}, snap => {
      const m = snap.metadata, fresh = !m.fromCache;
      if (!snap.exists) { if (fresh) firstTimeCloud(); return; }
      if (m.hasPendingWrites) return;
      const json = snap.get("json");
      if (typeof json !== "string") return;
      if (json === lastPushed || json === lastRemoteJson) { if (fresh && !pushTimer) setSync("saved"); return; }
      if (isDirty()) { if (fresh) pushNow(true); return; }
      lastRemoteJson = json;
      if (fresh) setSync("saved");
      if (json !== JSON.stringify(state)) applyRemote(json);
    }, err => {
      console.warn("Listener Firestore error:", err);
      setSync(navigator.onLine === false ? "offline" : "error");
      if (err && err.code === "permission-denied") toast("Akses ditolak oleh Firestore. Periksa Rules di Firebase Console (lihat PANDUAN-SETUP.md).");
    });
  }
  function enterCloudUser(user) {
    const same = currentUser && currentUser.id === user.uid;
    currentUser = {id: user.uid, name: user.displayName || pendingName || (user.email || "").split("@")[0] || "Pengguna", email: user.email || ""};
    if (same) { renderAll(); return; }
    STORAGE_KEY = LEGACY_KEY + "_" + user.uid;
    state = loadState(); restoreSalaryForm();
    document.body.classList.remove("locked"); $("#authScreen").classList.add("hidden"); $("#authScreen").classList.remove("booting");
    renderAll(); showPage("dashboard");
    startCloudSync(user);
  }
  function leaveCloud() {
    stopCloudSync();
    STORAGE_KEY = null; currentUser = null;
    const keep = {lang: state.lang, currency: state.currency, rate: state.rate};
    state = Object.assign(defaultState(), keep);
    restoreSalaryForm(); renderAll(); showAuth();
  }
  async function cloudLogout() {
    toast(t2("Menyimpan perubahan…", "Saving changes…"));
    await Promise.race([pushNow(), new Promise(r => setTimeout(r, 4000))]);
    try { await fbAuth.signOut(); } catch (e) { toast(t2("Gagal keluar. Coba lagi.", "Could not log out. Try again.")); }
  }
  function authMsg(e) {
    const c = (e && e.code) || "";
    if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return "Email atau kata sandi salah.";
    if (c === "auth/email-already-in-use") return "Email sudah terdaftar. Silakan masuk.";
    if (c === "auth/weak-password") return "Kata sandi terlalu lemah.";
    if (c === "auth/invalid-email") return "Masukkan email yang valid.";
    if (c === "auth/too-many-requests") return "Terlalu banyak percobaan. Coba lagi beberapa saat.";
    if (c === "auth/network-request-failed") return "Tidak ada koneksi internet.";
    if (c === "auth/unauthorized-domain") return "Domain ini belum diizinkan. Tambahkan di Firebase Console → Authentication → Settings → Authorized domains.";
    if (c === "auth/operation-not-allowed") return "Metode masuk ini belum diaktifkan di Firebase Console (Authentication → Sign-in method).";
    return "Gagal masuk" + (c ? " (" + c + ")" : "") + ".";
  }
  async function submitCloudAuth() {
    const email = $("#authEmail").value.trim().toLowerCase(), pw = $("#authPassword").value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { authErr("Masukkan email yang valid."); return; }
    if (pw.length < 8) { authErr("Kata sandi minimal 8 karakter."); return; }
    const btn = $("#authSubmit"); btn.disabled = true;
    try {
      if (authMode === "register") {
        const name = $("#authName").value.trim();
        if (!name) { authErr("Masukkan nama."); return; }
        if (pw !== $("#authConfirm").value) { authErr("Konfirmasi kata sandi tidak sama."); return; }
        pendingName = name;
        const cred = await fbAuth.createUserWithEmailAndPassword(email, pw);
        await cred.user.updateProfile({displayName: name});
        if (currentUser && currentUser.id === cred.user.uid) { currentUser.name = name; renderAll(); }
        toast("Akun dibuat. Selamat datang, " + name + "!");
      } else {
        await fbAuth.signInWithEmailAndPassword(email, pw);
      }
    } catch (e) { authErr(authMsg(e)); }
    finally { btn.disabled = false; pendingName = null; }
  }
  async function googleSignIn() {
    authErr("");
    const provider = new firebase.auth.GoogleAuthProvider(); provider.setCustomParameters({prompt: "select_account"});
    try { await fbAuth.signInWithPopup(provider); }
    catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
        try { await fbAuth.signInWithRedirect(provider); } catch (e2) { authErr(authMsg(e2)); }
      } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") authErr(authMsg(e));
    }
  }
  async function forgotPassword() {
    const email = $("#authEmail").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { authErr("Isi email dulu, lalu klik “Lupa kata sandi?”."); return; }
    try { await fbAuth.sendPasswordResetEmail(email); authErr(""); toast("Jika email terdaftar, tautan reset kata sandi sudah dikirim."); }
    catch (e) { authErr(authMsg(e)); }
  }
  function startCloudAuth() {
    fbAuth.getRedirectResult().catch(e => authErr(authMsg(e)));
    fbAuth.onAuthStateChanged(user => { if (user) enterCloudUser(user); else leaveCloud(); });
    setTimeout(() => $("#authScreen").classList.remove("booting"), 8000);
  }
  $("#googleBtn").addEventListener("click", googleSignIn);
  $("#forgotBtn").addEventListener("click", forgotPassword);
  window.addEventListener("online", () => { if (CLOUD && cloudDoc) { if (isDirty()) pushNow(true); else setSync("saved"); } });
  window.addEventListener("offline", () => { if (CLOUD && cloudDoc) setSync("offline"); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && pushTimer) pushNow(); });
  window.addEventListener("pagehide", () => { if (pushTimer) pushNow(); });

  const baseRender = renderAll;
  renderAll = function () { baseRender(); applyLang(); updateProfileUI(); };
  $("#langToggle").addEventListener("click", () => { state.lang = state.lang === "en" ? "id" : "en"; renderAll(); });
  $("#currencyToggle").addEventListener("click", () => { state.currency = state.currency === "USD" ? "IDR" : "USD"; renderAll(); });
  $("#langSelect").addEventListener("change", e => { state.lang = e.target.value === "en" ? "en" : "id"; renderAll(); });
  $("#currencySelect").addEventListener("change", e => { state.currency = e.target.value === "USD" ? "USD" : "IDR"; renderAll(); });
  $("#rateInput").addEventListener("change", e => { const v = Number(e.target.value); if (!(v > 0)) { toast("Kurs harus lebih dari 0."); e.target.value = state.rate; return; } state.rate = v; renderAll(); });
  renderAll();
  if (CLOUD) {
    $("#authNote").textContent = "Akun & data tersimpan aman di cloud (Google Firebase) dan otomatis tersinkron ke semua perangkat yang masuk dengan akun yang sama. Kata sandi dikelola oleh Firebase Auth, bukan disimpan di aplikasi ini.";
    document.body.classList.add("locked"); $("#authScreen").classList.remove("hidden"); $("#authScreen").classList.add("booting");
    setAuthMode("login"); startCloudAuth();
  } else if (CLOUD_BROKEN) {
    showAuth(); authErr("Layanan sinkronisasi (Firebase) belum termuat. Periksa koneksi internet lalu muat ulang halaman.");
  } else if (!currentUser) showAuth();
})();