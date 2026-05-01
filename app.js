// ============================================================
// BHX BIỆT KÍCH — app.js (Refactored)
// 
// THAY ĐỔI CHÍNH:
//   [1] Đồng bộ Google Sheets (thay localStorage)
//   [2] Chỉ còn 2 role: admin + qltp (bỏ nganhhang)
//   [3] Thời gian 24h (HH:mm)
//   [4] Format hiển thị "Mã - Tên" nhất quán
//   [5] Multi-product: nhiều SP trên 1 khai báo
// ============================================================

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function cap(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}
function showModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}
function toast(type, msg) {
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ============================================================
// DATABASE — IndexedDB (local cache) + Google Sheets (sync)
// ============================================================
const RAM_DB = {};

const DB = {
  get: k => {
    const val = RAM_DB['bhx_v5_' + k];
    return val !== undefined ? JSON.parse(JSON.stringify(val)) : null;
  },
  set: (k, v) => {
    RAM_DB['bhx_v5_' + k] = v;
    saveToIDB('bhx_v5_' + k, v);
  }
};

let idb;
const idbReq = window.indexedDB.open('BHX_v5', 1);
idbReq.onupgradeneeded = e => {
  const db = e.target.result;
  if (!db.objectStoreNames.contains('store')) db.createObjectStore('store');
};
idbReq.onsuccess = e => {
  idb = e.target.result;
  const tx = idb.transaction('store', 'readonly');
  const store = tx.objectStore('store');
  const reqAll = store.getAll();
  const reqKeys = store.getAllKeys();
  reqAll.onsuccess = () => {
    reqKeys.onsuccess = () => {
      reqKeys.result.forEach((key, i) => { RAM_DB[key] = reqAll.result[i]; });
      initSystem();
    };
  };
};
idbReq.onerror = () => initSystem();

function saveToIDB(key, value) {
  if (!idb) return;
  const tx = idb.transaction('store', 'readwrite');
  tx.objectStore('store').put(value, key);
}

// ============================================================
// [1] GOOGLE SHEETS SYNC
// Kiến trúc:
//   - ĐỌC: Gọi Sheets API v4 (GET, public, cần API Key)
//   - GHI/XÓA: Gọi Apps Script Web App (POST)
//   - Cache cục bộ: IndexedDB — fallback khi offline
// ============================================================

const SHEETS = {
  // Lấy config từ DB (admin nhập trong Master Data > Google Sheets tab)
  get cfg() {
    return DB.get('sheetsConfig') || {};
  },

  // Kiểm tra đã cấu hình đủ chưa
  get ready() {
    const c = this.cfg;
    return !!(c.sheetId && c.apiKey);
  },

  get canWrite() {
    return !!(this.cfg.webAppUrl);
  },

  // Cập nhật status badge
  setStatus(state, msg) {
    const dot = document.getElementById('syncDot');
    const txt = document.getElementById('syncText');
    if (!dot || !txt) return;
    dot.className = 'sync-dot' + (state === 'syncing' ? ' syncing' : state === 'error' ? ' error' : '');
    txt.textContent = msg;
  },

  // Đọc một sheet tab → trả về mảng object (dòng đầu là header)
  async read(tabName) {
    if (!this.ready) return null;
    const { sheetId, apiKey } = this.cfg;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}?key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Lỗi đọc sheet "${tabName}": ${res.status}`);
    const data = await res.json();
    const rows = data.values || [];
    if (rows.length < 2) return [];
    const headers = rows[0].map(h => String(h).trim());
    return rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? String(row[i]).trim() : ''; });
      return obj;
    });
  },

  // Ghi dữ liệu qua Apps Script
  async write(action, payload) {
    if (!this.canWrite) throw new Error('Chưa cấu hình Web App URL!');
    const res = await fetch(this.cfg.webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, // avoid CORS preflight
      body: JSON.stringify({ action, ...payload })
    });
    if (!res.ok) throw new Error(`Lỗi ghi: ${res.status}`);
    return await res.json();
  }
};

// ---- Hàm sync chính: kéo declarations từ Sheets ----
async function syncFromSheets() {
  if (!SHEETS.ready) {
    toast('warning', 'Chưa cấu hình Google Sheets. Vào Admin > Master Data > Google Sheets.');
    return;
  }
  SHEETS.setStatus('syncing', 'Đang sync...');
  try {
    const rows = await SHEETS.read('declarations');
    if (!rows) { SHEETS.setStatus('error', 'Lỗi sync'); return; }

    // Parse rows → declaration objects
    const decls = rows.map(r => ({
      id: r['id'] || '',
      authorCode: r['authorCode'] || '',
      authorName: r['authorName'] || '',
      sieuthiCode: r['sieuthiCode'] || '',
      sieuthiName: r['sieuthiName'] || '',
      isManualSieuthi: r['isManualSieuthi'] === 'true',
      ngay: r['ngay'] || '',
      // [3] Thời gian 24h — lưu HH:mm, đọc HH:mm
      tuGio: r['tuGio'] || '',
      denGio: r['denGio'] || '',
      // [5] Multi-product: lưu dạng JSON string trong sheet
      sanphamList: safeParseJson(r['sanphamList'], []),
      nhanvienList: safeParseJson(r['nhanvienList'], []),
      status: r['status'] || 'pending',
      rejectReason: r['rejectReason'] || '',
      createdAt: r['createdAt'] || '',
      updatedAt: r['updatedAt'] || ''
    })).filter(d => d.id);

    // Merge: ưu tiên Sheets, nhưng giữ local chưa upload (id bắt đầu bằng 'LOCAL_')
    const local = DB.get('declarations') || [];
    const localPending = local.filter(d => d.id.startsWith('LOCAL_'));
    const merged = [...decls, ...localPending];
    DB.set('declarations', merged);

    SHEETS.setStatus('ok', `Đã sync ${decls.length} đơn`);
    loadTable();
    toast('success', `✅ Đồng bộ ${decls.length} đơn từ Google Sheets`);
  } catch (err) {
    SHEETS.setStatus('error', 'Lỗi sync');
    toast('error', 'Lỗi sync: ' + err.message);
    console.error(err);
  }
}

// ---- Đẩy 1 declaration lên Sheets ----
async function pushDeclToSheets(decl) {
  if (!SHEETS.canWrite) return false;
  try {
    SHEETS.setStatus('syncing', 'Đang gửi...');
    await SHEETS.write('appendDeclaration', { row: serializeDecl(decl) });
    SHEETS.setStatus('ok', 'Đã gửi');
    return true;
  } catch (err) {
    SHEETS.setStatus('error', 'Lỗi ghi');
    console.error('pushDeclToSheets error:', err);
    return false;
  }
}

// ---- Cập nhật trạng thái 1 declaration ----
async function updateDeclStatusInSheets(id, status, reason) {
  if (!SHEETS.canWrite) return false;
  try {
    await SHEETS.write('updateStatus', { id, status, rejectReason: reason || '' });
    return true;
  } catch (err) {
    console.error('updateDeclStatusInSheets error:', err);
    return false;
  }
}

// Serialize declaration → Sheets row (flat)
function serializeDecl(d) {
  return {
    id: d.id,
    authorCode: d.authorCode,
    authorName: d.authorName,
    sieuthiCode: d.sieuthiCode || '',
    sieuthiName: d.sieuthiName || '',
    isManualSieuthi: String(d.isManualSieuthi || false),
    ngay: d.ngay,
    tuGio: d.tuGio || '',
    denGio: d.denGio || '',
    sanphamList: JSON.stringify(d.sanphamList || []),
    nhanvienList: JSON.stringify(d.nhanvienList || []),
    status: d.status,
    rejectReason: d.rejectReason || '',
    createdAt: d.createdAt || '',
    updatedAt: new Date().toISOString()
  };
}

function safeParseJson(str, fallback) {
  try { return JSON.parse(str) || fallback; }
  catch { return fallback; }
}

// ---- Test kết nối ----
async function testSheetConnection() {
  saveSheetConfig();
  const el = document.getElementById('sheetTestResult');
  if (!SHEETS.ready) { el.innerHTML = '<span style="color:red;">❌ Chưa đủ thông tin (cần Spreadsheet ID + API Key)</span>'; return; }
  el.innerHTML = '⏳ Đang kiểm tra...';
  try {
    const rows = await SHEETS.read('declarations');
    el.innerHTML = `<span style="color:green;">✅ Kết nối thành công! Tìm thấy ${rows ? rows.length : 0} dòng trong sheet "declarations".</span>`;
    SHEETS.setStatus('ok', 'Đã kết nối');
  } catch (err) {
    el.innerHTML = `<span style="color:red;">❌ Lỗi: ${err.message}</span>`;
    SHEETS.setStatus('error', 'Lỗi kết nối');
  }
}

function saveSheetConfig() {
  DB.set('sheetsConfig', {
    sheetId: document.getElementById('cfgSheetId').value.trim(),
    apiKey: document.getElementById('cfgApiKey').value.trim(),
    webAppUrl: document.getElementById('cfgWebAppUrl').value.trim()
  });
  toast('success', 'Đã lưu cấu hình Google Sheets!');
}

// ---- Copy Apps Script boilerplate ----
function copyAppsScriptCode() {
  const code = `// BHX Biệt Kích - Google Apps Script
// Deploy: Extensions > Apps Script > Deploy > Web App > Execute as Me > Anyone

const SS = SpreadsheetApp.getActiveSpreadsheet();

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;
    
    if (action === 'appendDeclaration') {
      return appendDeclaration(data.row);
    } else if (action === 'updateStatus') {
      return updateStatus(data.id, data.status, data.rejectReason);
    } else if (action === 'deleteDeclaration') {
      return deleteDeclaration(data.id);
    }
    return ok('Unknown action');
  } catch(err) {
    return err_(err.toString());
  }
}

function appendDeclaration(row) {
  const sh = SS.getSheetByName('declarations') || SS.insertSheet('declarations');
  // Tạo header nếu chưa có
  if (sh.getLastRow() === 0) {
    sh.appendRow(['id','authorCode','authorName','sieuthiCode','sieuthiName','isManualSieuthi',
      'ngay','tuGio','denGio','sanphamList','nhanvienList','status','rejectReason','createdAt','updatedAt']);
  }
  sh.appendRow([row.id, row.authorCode, row.authorName, row.sieuthiCode, row.sieuthiName,
    row.isManualSieuthi, row.ngay, row.tuGio, row.denGio, row.sanphamList, row.nhanvienList,
    row.status, row.rejectReason, row.createdAt, row.updatedAt]);
  return ok('appended');
}

function updateStatus(id, status, rejectReason) {
  const sh = SS.getSheetByName('declarations');
  if (!sh) return err_('Sheet not found');
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  const statusCol = headers.indexOf('status');
  const rejectCol = headers.indexOf('rejectReason');
  const updatedCol = headers.indexOf('updatedAt');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(id)) {
      if (statusCol >= 0) sh.getRange(i+1, statusCol+1).setValue(status);
      if (rejectCol >= 0) sh.getRange(i+1, rejectCol+1).setValue(rejectReason || '');
      if (updatedCol >= 0) sh.getRange(i+1, updatedCol+1).setValue(new Date().toISOString());
      return ok('updated');
    }
  }
  return err_('ID not found');
}

function deleteDeclaration(id) {
  const sh = SS.getSheetByName('declarations');
  if (!sh) return err_('Sheet not found');
  const data = sh.getDataRange().getValues();
  const idCol = data[0].indexOf('id');
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][idCol]) === String(id)) {
      sh.deleteRow(i+1);
      return ok('deleted');
    }
  }
  return err_('ID not found');
}

function ok(msg) { return ContentService.createTextOutput(JSON.stringify({ok:true,msg})).setMimeType(ContentService.MimeType.JSON); }
function err_(msg) { return ContentService.createTextOutput(JSON.stringify({ok:false,msg})).setMimeType(ContentService.MimeType.JSON); }
`;
  navigator.clipboard.writeText(code).then(() => toast('success', '✅ Đã copy Apps Script code! Dán vào Extensions > Apps Script'));
}

// ============================================================
// GLOBAL STATE
// ============================================================
let currentUser = null, currentRole = null;
let filteredDeclarations = [];
let selectedIds = new Set();
let parsedBulkRows = [];
let rejectTargetId = null;
let currentEditId = null;
// [4] dropSel: sieuthi (single), nhanvien (multi)
// [5] productRows: array cho multi-product
let dropSel = { sieuthi: null, nhanvien: [] };
let productRows = []; // [{ sanpham: null|{id,code,name,isManual}, dropId: 'pr_0' }, ...]
let hasManualEntry = false;

// ============================================================
// FORMAT — [3] 24h time / [4] "Mã - Tên"
// ============================================================

// [3] Hiển thị giờ 24h: HH:mm
function fTime(t) {
  if (!t) return '--';
  // Đảm bảo luôn HH:mm, loại bỏ seconds nếu có
  const parts = String(t).split(':');
  return `${String(parts[0]).padStart(2,'0')}:${String(parts[1] || '00').padStart(2,'0')}`;
}

// [4] Format "Mã - Tên"
function fCodeName(code, name) {
  if (code && name) return `${code} - ${name}`;
  return name || code || '--';
}

function fDate(isoDate) {
  if (!isoDate) return '';
  if (isoDate.includes('T')) isoDate = isoDate.split('T')[0];
  const parts = isoDate.split('-');
  if (parts.length === 3 && parts[0].length === 4) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return isoDate;
}

// ============================================================
// INIT
// ============================================================
function initSystem() {
  initSeedData();
  loadSheetConfigToForm();
  updateStatChips();
}

function initSeedData() {
  if (!DB.get('declarations')) DB.set('declarations', []);
  if (!DB.get('historyLog')) DB.set('historyLog', []);
  if (!DB.get('adminPass')) DB.set('adminPass', '24122004');
  if (!DB.get('sieuthi')) DB.set('sieuthi', []);
  if (!DB.get('sanpham')) DB.set('sanpham', []);
  if (!DB.get('nhanvien')) DB.set('nhanvien', []);
  if (!DB.get('qltpList')) DB.set('qltpList', []);
  // [2] Bỏ nhUsers hoàn toàn
}

function loadSheetConfigToForm() {
  const cfg = DB.get('sheetsConfig') || {};
  const el1 = document.getElementById('cfgSheetId');
  const el2 = document.getElementById('cfgApiKey');
  const el3 = document.getElementById('cfgWebAppUrl');
  if (el1) el1.value = cfg.sheetId || '';
  if (el2) el2.value = cfg.apiKey || '';
  if (el3) el3.value = cfg.webAppUrl || '';
}

function updateStatChips() {
  const st = DB.get('sieuthi') || [];
  const sp = DB.get('sanpham') || [];
  const nv = DB.get('nhanvien') || [];
  const ql = DB.get('qltpList') || [];
  setSafe('statQLTP', `QLTP: ${ql.length}`);
  setSafe('statST', `Siêu thị: ${st.length}`);
  setSafe('statFMCG', `SP FMCG: ${sp.filter(x => x.type === 'fmcg').length}`);
  setSafe('statNV', `NV: ${nv.length}`);
  setSafe('countSieuthi', st.length);
  setSafe('countSanpham', sp.length);
  setSafe('countNhanvien', nv.length);
  // [2] Chỉ còn admin + qltp
  setSafe('countUsers', ql.length + 1);
}

function setSafe(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function logAction(action, detail) {
  let hist = DB.get('historyLog') || [];
  hist.unshift({
    time: new Date().toLocaleString('vi-VN'),
    user: currentUser ? fCodeName(currentUser.code, currentUser.name) : '?',
    role: currentRole || '?',
    action, detail
  });
  if (hist.length > 300) hist.pop();
  DB.set('historyLog', hist);
}

// [3] Validate thời gian 24h
function validateTime(t1, t2) {
  if (!t1 || !t2) return 'Vui lòng nhập đủ Từ giờ và Đến giờ!';
  if (t1 < '05:00' || t1 > '22:00' || t2 < '05:00' || t2 > '22:00')
    return 'Giờ hoạt động chỉ từ 05:00 đến 22:00!';
  if (t1 >= t2) return "Từ giờ phải nhỏ hơn Đến giờ!";
  return null;
}

// ============================================================
// [1] MASTER DATA IMPORT
// ============================================================
function importMasterFile(type, input) {
  const file = input.files[0]; if (!file) return;
  const keyMap = { phanbo: 'PhanBo', fmcg: 'FMCG', nhanvien: 'NV' };
  const statusEl = document.getElementById('status' + (keyMap[type] || ''));
  if (statusEl) statusEl.textContent = '⏳ Đang đọc...';
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      if (type === 'phanbo') parsePhanBo(rows);
      else if (type === 'fmcg') parseSanPham(rows, 'fmcg');
      else if (type === 'nhanvien') parseNhanVien(rows);
      updateStatChips();
      if (statusEl) statusEl.textContent = '✅ OK!';
      input.value = '';
    } catch (err) {
      if (statusEl) statusEl.textContent = '❌ ' + err.message;
      toast('error', 'Lỗi đọc file: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function parsePhanBo(rows) {
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].some(c => String(c).toUpperCase().includes('MST') || String(c).includes('Tên ST'))) { headerIdx = i; break; }
  }
  const headers = rows[headerIdx].map(h => String(h).trim());
  const idxMST = headers.findIndex(h => h.toUpperCase() === 'MST' || h.includes('MST'));
  const idxTen = headers.findIndex(h => h.includes('Tên ST') || h.includes('TEN ST'));
  const idxQLTP = headers.findIndex(h => h.includes('tên rút gọn') || h.includes('rút gọn') || (h.includes('QLTP') && h.includes('4')));
  let sieuthi = [], qltpMap = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const mst = String(r[idxMST] || '').trim();
    const tenST = String(r[idxTen] || '').trim();
    const qltpRaw = String(r[idxQLTP] || '').trim();
    if (!mst || !tenST) continue;
    let qltpCode = '', qltpName = '';
    const di = qltpRaw.indexOf(' - ');
    if (di > 0) { qltpCode = qltpRaw.substring(0, di).trim(); qltpName = qltpRaw.substring(di + 3).trim(); }
    else { qltpCode = qltpRaw; }
    sieuthi.push({ id: mst, code: mst, name: tenST, qltpCode, qltpName });
    if (qltpCode && !qltpMap[qltpCode]) qltpMap[qltpCode] = { code: qltpCode, name: qltpName };
  }
  DB.set('sieuthi', sieuthi);
  DB.set('qltpList', Object.values(qltpMap));
  toast('success', `✅ Import ${sieuthi.length} siêu thị, ${Object.keys(qltpMap).length} QLTP`);
  logAction('IMPORT PHÂN BỔ', `${sieuthi.length} ST`);
}

function parseSanPham(rows, type) {
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].some(c => String(c).toLowerCase().includes('mã') || String(c).toLowerCase().includes('ma'))) { headerIdx = i; break; }
  }
  const headers = rows[headerIdx].map(h => String(h).trim().toLowerCase());
  const idxMa = headers.findIndex(h => h.includes('mã') || h.includes('ma'));
  const idxTen = headers.findIndex(h => (h.includes('tên') || h.includes('ten')) && !h.includes('tắt'));
  let existing = (DB.get('sanpham') || []).filter(s => s.type !== type);
  let newItems = [], seen = new Set(existing.map(s => s.code));
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const ma = String(r[idxMa] || '').trim();
    const ten = String(r[idxTen] || '').trim();
    if (!ma || !ten || seen.has(ma)) continue;
    seen.add(ma);
    newItems.push({ id: ma, code: ma, name: ten, type });
  }
  DB.set('sanpham', [...existing, ...newItems]);
  toast('success', `✅ Import ${newItems.length} sản phẩm`);
}

function parseNhanVien(rows) {
  let headerIdx = 3;
  for (let i = 0; i < Math.min(6, rows.length); i++) {
    if (rows[i].some(c => String(c).toLowerCase().includes('mã nhân viên') || String(c).toLowerCase().includes('ma nhan vien'))) { headerIdx = i; break; }
  }
  const headers = rows[headerIdx].map(h => String(h).trim().toLowerCase());
  const idxMa = headers.findIndex(h => h.includes('mã nhân viên') || h.includes('ma nhan vien'));
  const idxTen = headers.findIndex(h => h.includes('tên nhân viên') || h.includes('ten nhan vien'));
  const idxST = headers.findIndex(h => h.includes('mã siêu thị') || h.includes('ma sieu thi'));
  let items = [], seen = new Set();
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const ma = String(r[idxMa] || '').trim();
    const ten = String(r[idxTen] || '').trim();
    const st = idxST >= 0 ? String(r[idxST] || '').trim() : '';
    if (!ma || !ten || seen.has(ma)) continue;
    seen.add(ma);
    items.push({ id: ma, code: ma, name: ten, sieuthiCode: st });
  }
  DB.set('nhanvien', items);
  toast('success', `✅ Import ${items.length} nhân viên`);
}

function dlMasterTpl(type) {
  let d, name;
  if (type === 'phanbo') {
    d = [['MST','Tên ST','QLTP tháng 4.2026 (tên rút gọn)','Cụm miền'],['12345','BHX_HCM_001','27506 - Bá Thành','HCM']];
    name = 'Template_PhanBo.xlsx';
  } else if (type === 'fmcg') {
    d = [['Mã sản phẩm','Tên sản phẩm'],['1053090000397','BÁNH DD AFC VỊ LÚA MÌ']];
    name = 'Template_FMCG.xlsx';
  } else if (type === 'nhanvien') {
    d = [[],[],[],['Mã Nhân Viên','Tên Nhân Viên','Mã Siêu Thị'],['268789','Nguyễn Hải Phú','12345']];
    name = 'Template_NhanVien.xlsx';
  }
  const ws = XLSX.utils.aoa_to_sheet(d);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  XLSX.writeFile(wb, name, { bookType: 'xlsx', type: 'binary' });
  toast('success', '✅ Đã tải ' + name);
}

// ============================================================
// [2] LOGIN — chỉ còn Admin + QLTP
// ============================================================
function toggleLoginFields() {
  const r = document.getElementById('loginRole').value;
  document.getElementById('grpQLTP').style.display = r === 'qltp' ? 'block' : 'none';
  document.getElementById('grpAdmin').style.display = r === 'admin' ? 'block' : 'none';
  const hints = {
    qltp: '📌 Nhập mã QLTP của bạn (VD: 27506). Hệ thống sẽ tự xác nhận và lọc dữ liệu theo phạm vi của bạn.',
    admin: '🔐 Chỉ dành cho Admin BHX. Có quyền hạn toàn bộ hệ thống.'
  };
  const hint = document.getElementById('loginHint');
  if (r && hints[r]) { hint.style.display = 'block'; hint.textContent = hints[r]; }
  else hint.style.display = 'none';
}

function suggestQLTP(val) {
  const suggest = document.getElementById('qltpSuggest');
  const qltps = DB.get('qltpList') || [];
  const q = String(val).trim().toLowerCase();
  if (!q) { suggest.classList.add('hidden'); document.getElementById('qltpConfirm').style.display = 'none'; return; }
  const filtered = qltps.filter(x => String(x.code).toLowerCase().includes(q) || String(x.name).toLowerCase().includes(q)).slice(0, 10);
  if (!filtered.length) { suggest.classList.add('hidden'); document.getElementById('qltpConfirm').style.display = 'none'; return; }
  // [4] Format "Mã - Tên" trong gợi ý
  suggest.innerHTML = filtered.map(x =>
    `<div class="login-suggest-item" onclick="selectQLTPLogin('${x.code}','${x.name.replace(/'/g, "\\'")}')">
      <span class="mst">${x.code}</span>
      <span class="name">${x.name}</span>
    </div>`
  ).join('');
  suggest.classList.remove('hidden');
}

function selectQLTPLogin(code, name) {
  document.getElementById('loginCodeQLTP').value = code;
  document.getElementById('qltpSuggest').classList.add('hidden');
  document.getElementById('qltpConfirm').style.display = 'block';
  // [4] Format Mã - Tên
  document.getElementById('qltpConfirmText').textContent = fCodeName(code, name);
  handleLogin();
}

function handleLogin() {
  const r = document.getElementById('loginRole').value;
  if (!r) return toast('error', 'Chọn phân hệ!');

  if (r === 'admin') {
    const p = document.getElementById('loginPassAdmin').value;
    if (p !== DB.get('adminPass')) return toast('error', 'Sai mật khẩu Admin!');
    currentUser = { code: 'admin', name: 'Admin BHX', role: 'admin' };
    currentRole = 'admin';
  } else if (r === 'qltp') {
    const code = document.getElementById('loginCodeQLTP').value.trim();
    if (!code) return toast('error', 'Nhập mã QLTP!');
    const qltps = DB.get('qltpList') || [];
    const found = qltps.find(x => String(x.code) === code);
    if (!found) return toast('error', `Mã QLTP [${code}] không tồn tại trong hệ thống.`);
    currentUser = { code: found.code, name: found.name, role: 'qltp' };
    currentRole = 'qltp';
  }

  finishLogin();
}

function finishLogin() {
  document.getElementById('loginOverlay').style.display = 'none';
  document.getElementById('appContainer').classList.remove('blurred');
  // [4] Format Mã - Tên ở header
  const roleLabel = { admin: 'ADMIN', qltp: 'QLTP' }[currentRole];
  document.getElementById('headerUserName').textContent = `${currentUser.name} (${currentUser.code} — ${roleLabel})`;
  updateRoleUI();

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('filterTuNgay').value = today;
  document.getElementById('filterDenNgay').value = today;
  logAction('ĐĂNG NHẬP', roleLabel);

  // Auto sync khi login nếu đã cấu hình Sheets
  if (SHEETS.ready) {
    syncFromSheets();
  } else {
    SHEETS.setStatus('error', 'Chưa cấu hình');
    loadTable();
  }
}

function logout() {
  currentUser = null; currentRole = null;
  document.getElementById('appContainer').classList.add('blurred');
  document.getElementById('loginOverlay').style.display = 'flex';
  document.getElementById('loginRole').value = '';
  document.getElementById('grpQLTP').style.display = 'none';
  document.getElementById('grpAdmin').style.display = 'none';
  document.getElementById('loginHint').style.display = 'none';
  document.getElementById('qltpConfirm').style.display = 'none';
  document.getElementById('loginCodeQLTP').value = '';
}

// [2] updateRoleUI: chỉ còn 2 role, bỏ ngành hàng
function updateRoleUI() {
  const isAd = currentRole === 'admin';
  const isQL = currentRole === 'qltp';
  document.getElementById('adminButtons').style.display = isAd ? 'flex' : 'none';
  document.getElementById('btnTaoMoi').style.display = (isQL || isAd) ? 'inline-flex' : 'none';
  document.getElementById('btnImportKhaiBao').style.display = (isQL || isAd) ? 'inline-flex' : 'none';
  // Status bar
  document.getElementById('roleStatusText').innerHTML =
    `Phân hệ: ${currentRole === 'admin' ? 'ADMIN' : 'QLTP'} | ${currentUser.name} (${currentUser.code})`;
}

function openChangePassModal() {
  if (currentRole !== 'admin') return;
  document.getElementById('cpOld').value = '';
  document.getElementById('cpNew').value = '';
  showModal('changePassModal');
}
function submitChangePass() {
  const o = document.getElementById('cpOld').value;
  const n = document.getElementById('cpNew').value;
  if (o !== DB.get('adminPass')) return toast('error', 'Sai mật khẩu cũ!');
  if (!n || n.length < 4) return toast('error', 'Mật khẩu mới quá ngắn!');
  DB.set('adminPass', n);
  toast('success', 'Đổi mật khẩu thành công!');
  closeModal('changePassModal');
}

// ============================================================
// TABLE LOAD & RENDER
// ============================================================
function loadTable() {
  let all = DB.get('declarations') || [];
  // [2] QLTP chỉ xem đơn của mình
  if (currentRole === 'qltp') all = all.filter(d => d.authorCode === currentUser.code);
  // Admin xem tất cả

  const fST = document.getElementById('filterSieuthi').value.toLowerCase();
  const fFr = document.getElementById('filterTuNgay').value;
  const fTo = document.getElementById('filterDenNgay').value;
  const fSt = document.getElementById('filterStatus').value;

  filteredDeclarations = all.filter(d => {
    const chuoi = ((d.sieuthiCode || '') + ' ' + (d.sieuthiName || '')).toLowerCase();
    if (fST && !chuoi.includes(fST)) return false;
    if (fFr && d.ngay < fFr) return false;
    if (fTo && d.ngay > fTo) return false;
    if (fSt && d.status !== fSt) return false;
    return true;
  });

  document.getElementById('totalCount').textContent = `Tổng: ${filteredDeclarations.length} bản ghi`;
  renderTable();
}

function renderTable() {
  const tbody = document.getElementById('tableBody');
  if (!filteredDeclarations.length) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><div class="icon">📋</div>Không có dữ liệu phù hợp</div></td></tr>`;
    return;
  }

  tbody.innerHTML = filteredDeclarations.map((d, i) => {
    const checked = selectedIds.has(d.id) ? 'checked' : '';

    // [4] Siêu thị: Mã - Tên
    const stTag = d.isManualSieuthi
      ? `<span class="manual-tag">⚠ ${d.sieuthiName}</span>`
      : `<b style="color:var(--green)">${fCodeName(d.sieuthiCode, d.sieuthiName)}</b>`;

    // [5] Multi-product list
    const spList = (d.sanphamList || []);
    const spTags = spList.map(sp =>
      sp.isManual
        ? `<span class="manual-tag">⚠ ${sp.name}</span>`
        // [4] Format Mã - Tên
        : `<div style="font-size:11px;"><b style="color:var(--green)">${fCodeName(sp.code, sp.name)}</b></div>`
    ).join('');

    const nvTags = (d.nhanvienList || []).map(n =>
      n.isManual
        ? `<span class="manual-tag">⚠ ${n.name}</span>`
        // [4] Format Mã - Tên
        : fCodeName(n.code, n.name)
    ).join(', ');

    const stat = {
      pending: '<span class="badge badge-pending">Chờ duyệt</span>',
      approved: '<span class="badge badge-approved">Đã duyệt</span>',
      rejected: '<span class="badge badge-rejected">Từ chối</span>'
    }[d.status] || '';

    // [2] Chỉ admin mới duyệt/từ chối; QLTP chỉ sửa/xóa đơn của mình
    let acts = `<button class="btn btn-sm btn-secondary" onclick="openDetail('${d.id}')">👁</button> `;
    if ((currentRole === 'qltp' || currentRole === 'admin') && (d.status === 'rejected' || d.status === 'draft')) {
      acts += `<button class="btn btn-sm btn-primary" onclick="openEditModal('${d.id}')">✏</button> `;
    }
    if (currentRole === 'admin' && d.status === 'pending') {
      acts += `<button class="btn btn-sm btn-success" onclick="approveOne('${d.id}')">✅</button> `;
      acts += `<button class="btn btn-sm btn-danger" onclick="openRejectModal('${d.id}')">❌</button> `;
    }
    if (currentRole === 'admin' || (currentRole === 'qltp' && d.authorCode === currentUser.code)) {
      acts += `<button class="btn btn-sm btn-danger" onclick="deleteRecord('${d.id}')">🗑</button>`;
    }

    return `<tr>
      <td style="text-align:center;"><input type="checkbox" ${checked} onchange="toggleSelect('${d.id}')"></td>
      <td style="color:#999;font-size:11px;">${i + 1}</td>
      <td style="font-weight:600;color:var(--green);font-size:12px;">${d.authorCode}<br><span style="font-weight:400;color:#555;">${d.authorName}</span></td>
      <td style="font-size:12px;">${stTag}</td>
      <td style="font-weight:bold;color:var(--blue);white-space:nowrap;">${fDate(d.ngay)}</td>
      <!-- [3] Hiển thị giờ 24h -->
      <td style="font-size:12px;white-space:nowrap;">${fTime(d.tuGio)} - ${fTime(d.denGio)}</td>
      <!-- [5] DS sản phẩm -->
      <td style="font-size:11px;max-width:200px;">${spTags || '--'}</td>
      <td style="font-size:11px;max-width:160px;">${nvTags}</td>
      <td>${stat}</td>
      <td style="white-space:nowrap;">${acts}</td>
    </tr>`;
  }).join('');
}

// Approve 1 đơn (Admin)
async function approveOne(id) {
  let decls = DB.get('declarations') || [];
  const idx = decls.findIndex(x => x.id === id);
  if (idx < 0) return;
  decls[idx].status = 'approved';
  decls[idx].updatedAt = new Date().toISOString();
  DB.set('declarations', decls);
  logAction('DUYỆT', id);
  await updateDeclStatusInSheets(id, 'approved', '');
  toast('success', 'Đã duyệt!');
  loadTable();
}

function toggleSelectAll() {
  const isC = document.getElementById('selectAll').checked;
  document.querySelectorAll('#tableBody input[type=checkbox]').forEach(cb => {
    cb.checked = isC;
    const id = cb.getAttribute('onchange').match(/'([^']+)'/)[1];
    isC ? selectedIds.add(id) : selectedIds.delete(id);
  });
  updateSelectedCount();
}
function toggleSelect(id) { selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id); updateSelectedCount(); }
function updateSelectedCount() {
  document.getElementById('selectedCount').textContent = selectedIds.size > 0 ? `(Đã chọn ${selectedIds.size})` : '';
  document.getElementById('btnBulkDelete').style.display = (selectedIds.size > 0 && currentRole === 'admin') ? 'inline-flex' : 'none';
}
function bulkDeleteRecords() {
  if (!confirm(`Xóa ${selectedIds.size} đơn đã chọn?`)) return;
  let d = DB.get('declarations') || [];
  const toDelete = [...selectedIds];
  DB.set('declarations', d.filter(x => !selectedIds.has(x.id)));
  // Xóa trên Sheets (nếu có)
  toDelete.forEach(id => {
    if (!id.startsWith('LOCAL_')) SHEETS.write('deleteDeclaration', { id }).catch(console.error);
  });
  logAction('XÓA NHIỀU', selectedIds.size + ' bản ghi');
  selectedIds.clear(); updateSelectedCount();
  toast('success', 'Đã xóa'); loadTable();
}

// ============================================================
// [4] DROPDOWN SEARCH — format "Mã - Tên"
// ============================================================
function filterDrop(field, query) {
  const q = String(query).toLowerCase().trim();
  let items = [];

  if (field === 'sieuthi' || field === 'filterST') {
    let all = DB.get('sieuthi') || [];
    if (currentRole === 'qltp') all = all.filter(s => s.qltpCode === currentUser.code);
    items = all.filter(s => !q || String(s.name).toLowerCase().includes(q) || String(s.code).toLowerCase().includes(q))
      .slice(0, 25)
      .map(s => ({ id: s.id, code: s.code, name: s.name }));
  } else if (field.startsWith('sanpham')) {
    // [5] field có thể là 'sanpham_0', 'sanpham_1', ...
    const all = DB.get('sanpham') || [];
    items = all.filter(s => !q || String(s.name).toLowerCase().includes(q) || String(s.code).toLowerCase().includes(q))
      .slice(0, 25)
      .map(s => ({ id: s.id, code: s.code, name: s.name }));
  } else if (field === 'nhanvien') {
    let all = DB.get('nhanvien') || [];
    if (currentRole === 'qltp') {
      const mySTs = (DB.get('sieuthi') || []).filter(s => s.qltpCode === currentUser.code).map(s => s.code);
      all = all.filter(n => !n.sieuthiCode || mySTs.includes(n.sieuthiCode));
    }
    items = all.filter(n => !q || String(n.name).toLowerCase().includes(q) || String(n.code).toLowerCase().includes(q))
      .slice(0, 25)
      .map(n => ({ id: n.id, code: n.code, name: n.name, sub: n.sieuthiCode ? `ST: ${n.sieuthiCode}` : '' }));
  }

  const listId = field === 'filterST' ? 'dropFilterst-list' :
    field.startsWith('sanpham') ? `drop-${field}-list` :
    `drop${cap(field)}-list`;
  const listEl = document.getElementById(listId);
  if (!listEl) return;

  // [4] Format "Mã - Tên" trong dropdown
  let html = items.map(it => {
    const safeItem = JSON.stringify(it).replace(/"/g, '&quot;');
    return `<div class="dropdown-item" onmousedown="selectDropItem('${field}', ${safeItem})">
      <span><b style="color:var(--green)">${it.code}</b> - ${it.name}</span>
    </div>`;
  }).join('');

  if (q) {
    html += `<div class="dropdown-item-manual" onmousedown="selectManualItem('${field}','${query.replace(/'/g, "\\'")}')">
      ✍ Nhập tay: "<strong>${query}</strong>"
    </div>`;
  }
  if (!html) html = `<div style="padding:10px;color:#999;font-size:12px;">Không tìm thấy</div>`;

  listEl.innerHTML = html;
  listEl.classList.remove('hidden');
}

function selectDropItem(field, item) {
  if (field === 'filterST') {
    // [4] Format Mã - Tên trong filter
    document.getElementById('filterSieuthi').value = fCodeName(item.code, item.name);
    document.getElementById('dropFilterst-list').classList.add('hidden');
    loadTable();
    return;
  }
  if (field === 'sieuthi') {
    dropSel.sieuthi = { ...item, isManual: false };
    document.getElementById('inputSieuthi').value = fCodeName(item.code, item.name);
    renderTags('sieuthi');
    document.getElementById('dropSieuthi-list').classList.add('hidden');
    checkManualEntries();
    return;
  }
  if (field === 'nhanvien') {
    if (!dropSel.nhanvien.find(n => n.id === item.id)) dropSel.nhanvien.push({ ...item, isManual: false });
    document.getElementById('inputNhanvien').value = '';
    renderTags('nhanvien');
    document.getElementById('dropNhanvien-list').classList.add('hidden');
    checkManualEntries();
    return;
  }
  // [5] Sanpham field: 'sanpham_0', 'sanpham_1', ...
  if (field.startsWith('sanpham_')) {
    const rowIdx = parseInt(field.split('_')[1]);
    if (productRows[rowIdx] !== undefined) {
      productRows[rowIdx].sanpham = { ...item, isManual: false };
      renderProductRowTag(rowIdx);
      const inputEl = document.getElementById(`inputSanpham_${rowIdx}`);
      if (inputEl) inputEl.value = fCodeName(item.code, item.name);
      const listEl = document.getElementById(`drop-sanpham_${rowIdx}-list`);
      if (listEl) listEl.classList.add('hidden');
      checkManualEntries();
    }
  }
}

function selectManualItem(field, txt) {
  if (!txt.trim()) return;
  if (field === 'filterST') {
    document.getElementById('filterSieuthi').value = txt;
    document.getElementById('dropFilterst-list').classList.add('hidden');
    loadTable();
    return;
  }
  if (field === 'sieuthi') {
    dropSel.sieuthi = { id: null, code: '', name: txt, isManual: true };
    document.getElementById('inputSieuthi').value = txt;
    renderTags('sieuthi');
    document.getElementById('dropSieuthi-list').classList.add('hidden');
    checkManualEntries();
    return;
  }
  if (field === 'nhanvien') {
    dropSel.nhanvien.push({ id: null, code: '', name: txt, isManual: true });
    document.getElementById('inputNhanvien').value = '';
    renderTags('nhanvien');
    document.getElementById('dropNhanvien-list').classList.add('hidden');
    checkManualEntries();
    return;
  }
  if (field.startsWith('sanpham_')) {
    const rowIdx = parseInt(field.split('_')[1]);
    if (productRows[rowIdx] !== undefined) {
      productRows[rowIdx].sanpham = { id: null, code: '', name: txt, isManual: true };
      const inputEl = document.getElementById(`inputSanpham_${rowIdx}`);
      if (inputEl) inputEl.value = txt;
      renderProductRowTag(rowIdx);
      const listEl = document.getElementById(`drop-sanpham_${rowIdx}-list`);
      if (listEl) listEl.classList.add('hidden');
      checkManualEntries();
    }
  }
}

function removeTag(field, idx) {
  if (field === 'nhanvien') dropSel.nhanvien.splice(idx, 1);
  else if (field === 'sieuthi') { dropSel.sieuthi = null; document.getElementById('inputSieuthi').value = ''; }
  renderTags(field);
  checkManualEntries();
}

function renderTags(field) {
  if (field === 'sieuthi') {
    const c = document.getElementById('sieuthiSelected');
    const sel = dropSel.sieuthi;
    c.innerHTML = sel ? `<span class="tag-item ${sel.isManual ? 'manual' : ''}">
      ${sel.isManual ? '⚠' : ''}
      <!-- [4] Mã - Tên trong tag -->
      ${sel.isManual ? sel.name : fCodeName(sel.code, sel.name)}
      <span class="remove" onmousedown="removeTag('sieuthi')">×</span>
    </span>` : '';
  } else if (field === 'nhanvien') {
    const c = document.getElementById('nhanvienSelected');
    c.innerHTML = dropSel.nhanvien.map((n, i) =>
      `<span class="tag-item ${n.isManual ? 'manual' : ''}">
        ${n.isManual ? '⚠' : ''}
        <!-- [4] Mã - Tên trong tag -->
        ${n.isManual ? n.name : fCodeName(n.code, n.name)}
        <span class="remove" onmousedown="removeTag('nhanvien',${i})">×</span>
      </span>`
    ).join('');
  }
}

// [5] Render tag cho 1 product row
function renderProductRowTag(rowIdx) {
  const c = document.getElementById(`spTag_${rowIdx}`);
  if (!c) return;
  const sp = productRows[rowIdx]?.sanpham;
  c.innerHTML = sp ? `<span class="tag-item ${sp.isManual ? 'manual' : ''}">
    ${sp.isManual ? '⚠' : ''} ${sp.isManual ? sp.name : fCodeName(sp.code, sp.name)}
    <span class="remove" onmousedown="removeSanpham(${rowIdx})">×</span>
  </span>` : '';
}

function checkManualEntries() {
  const hasMnST = dropSel.sieuthi?.isManual;
  const hasMnNV = dropSel.nhanvien.some(n => n.isManual);
  const hasMnSP = productRows.some(r => r.sanpham?.isManual);
  hasManualEntry = hasMnST || hasMnNV || hasMnSP;
  const notice = document.getElementById('manualNotice');
  if (notice) notice.classList.toggle('show', hasManualEntry);
}

document.addEventListener('click', e => {
  document.querySelectorAll('.dropdown-list').forEach(l => {
    if (!l.parentElement?.contains(e.target)) l.classList.add('hidden');
  });
});

// ============================================================
// [5] MULTI-PRODUCT ROWS
// ============================================================
function addProductRow() {
  const rowIdx = productRows.length;
  productRows.push({ sanpham: null });
  renderProductRows();
}

function removeSanpham(rowIdx) {
  productRows[rowIdx].sanpham = null;
  renderProductRowTag(rowIdx);
  checkManualEntries();
}

function removeProductRow(rowIdx) {
  productRows.splice(rowIdx, 1);
  renderProductRows();
  checkManualEntries();
}

function renderProductRows() {
  const container = document.getElementById('productRowsContainer');
  if (!container) return;

  if (productRows.length === 0) {
    container.innerHTML = `<div style="color:#aaa;font-size:12px;padding:8px;">Nhấn "➕ Thêm sản phẩm" để thêm.</div>`;
    return;
  }

  container.innerHTML = productRows.map((row, i) => `
    <div class="product-row" id="productRow_${i}">
      <div class="product-row-header">
        <span>📦 Sản phẩm #${i + 1}</span>
        <button class="btn btn-danger btn-sm" type="button" onclick="removeProductRow(${i})">Xóa</button>
      </div>
      <div class="product-row-body">
        <div class="form-group" style="margin:0;">
          <div class="search-drop-wrap">
            <!-- [4] Placeholder gợi ý format Mã - Tên -->
            <input class="search-drop-input" id="inputSanpham_${i}" type="text"
              placeholder="Gõ Mã hoặc Tên sản phẩm (VD: SP01 - Coca Cola)..." autocomplete="off"
              oninput="filterDrop('sanpham_${i}',this.value)"
              onfocus="filterDrop('sanpham_${i}',this.value)"
              value="${row.sanpham ? (row.sanpham.isManual ? row.sanpham.name : fCodeName(row.sanpham.code, row.sanpham.name)) : ''}">
            <div class="dropdown-list hidden" id="drop-sanpham_${i}-list"></div>
            <div class="selected-tags" id="spTag_${i}"></div>
          </div>
        </div>
      </div>
    </div>
  `).join('');

  // Re-render tags cho các row đã có sanpham
  productRows.forEach((row, i) => { if (row.sanpham) renderProductRowTag(i); });
}

// ============================================================
// TẠO / SỬA KHAI BÁO
// ============================================================
function openCreateModal() {
  currentEditId = null;
  dropSel = { sieuthi: null, nhanvien: [] };
  productRows = []; // Reset multi-product
  document.getElementById('inputSieuthi').value = '';
  document.getElementById('sieuthiSelected').innerHTML = '';
  document.getElementById('inputNhanvien').value = '';
  document.getElementById('nhanvienSelected').innerHTML = '';
  document.getElementById('formNgay').value = '';
  document.getElementById('formTuGio').value = '';
  document.getElementById('formDenGio').value = '';
  document.getElementById('manualNotice').classList.remove('show');
  document.getElementById('createModalTitle').textContent = '➕ Tạo Khai báo Biệt Kích';
  addProductRow(); // Khởi tạo 1 dòng SP mặc định
  showModal('createModal');
}

function openEditModal(id) {
  const d = (DB.get('declarations') || []).find(x => x.id === id);
  if (!d) return;
  currentEditId = id;
  dropSel.sieuthi = { id: d.sieuthiCode, code: d.sieuthiCode || '', name: d.sieuthiName, isManual: d.isManualSieuthi };
  dropSel.nhanvien = [...(d.nhanvienList || [])];

  // [5] Restore multi-product
  productRows = (d.sanphamList || []).map(sp => ({ sanpham: { ...sp } }));

  document.getElementById('inputSieuthi').value = d.isManualSieuthi ? d.sieuthiName : fCodeName(d.sieuthiCode, d.sieuthiName);
  document.getElementById('inputNhanvien').value = '';
  document.getElementById('formNgay').value = d.ngay;
  document.getElementById('formTuGio').value = d.tuGio || '';
  document.getElementById('formDenGio').value = d.denGio || '';

  renderTags('sieuthi');
  renderTags('nhanvien');
  renderProductRows();
  checkManualEntries();
  document.getElementById('createModalTitle').textContent = '✏ Sửa Khai báo Biệt Kích';
  showModal('createModal');
}

async function submitForm() {
  const st = dropSel.sieuthi;
  const nv = dropSel.nhanvien;
  const ngay = document.getElementById('formNgay').value;
  const tG = document.getElementById('formTuGio').value;
  const dG = document.getElementById('formDenGio').value;

  if (!st) return toast('error', 'Chọn Siêu thị!');
  if (productRows.length === 0) return toast('error', 'Thêm ít nhất 1 sản phẩm!');
  // [5] Kiểm tra tất cả SP đã chọn
  for (let i = 0; i < productRows.length; i++) {
    if (!productRows[i].sanpham) return toast('error', `Sản phẩm #${i + 1} chưa được chọn!`);
  }
  if (!ngay) return toast('error', 'Chọn Ngày!');
  if (nv.length === 0) return toast('error', 'Chọn ít nhất 1 Nhân viên!');
  const timeErr = validateTime(tG, dG);
  if (timeErr) return toast('error', timeErr);

  // [5] Build sanphamList từ productRows
  const sanphamList = productRows.map(r => ({
    id: r.sanpham.id || null,
    code: r.sanpham.code || '',
    name: r.sanpham.name,
    isManual: r.sanpham.isManual || false
  }));

  let decls = DB.get('declarations') || [];

  if (currentEditId) {
    const idx = decls.findIndex(x => x.id === currentEditId);
    decls[idx] = {
      ...decls[idx],
      sieuthiCode: st.code, sieuthiName: st.name, isManualSieuthi: st.isManual,
      ngay, tuGio: tG, denGio: dG,
      sanphamList,
      nhanvienList: nv,
      status: 'pending', updatedAt: new Date().toISOString()
    };
    DB.set('declarations', decls);
    logAction('SỬA ĐƠN', currentEditId);
    // Đẩy lên Sheets
    if (!decls[idx].id.startsWith('LOCAL_')) {
      await SHEETS.write('updateStatus', { id: decls[idx].id, status: 'pending', rejectReason: '' }).catch(console.error);
    }
    toast('success', 'Cập nhật thành công!');
  } else {
    // Tạo ID — nếu chưa có Sheets thì dùng LOCAL_ prefix
    const newId = SHEETS.canWrite
      ? 'BK' + Date.now().toString().slice(-8)
      : 'LOCAL_' + Date.now().toString().slice(-8);

    const newDecl = {
      id: newId,
      authorCode: currentUser.code, authorName: currentUser.name,
      sieuthiCode: st.code || '', sieuthiName: st.name, isManualSieuthi: st.isManual || false,
      ngay, tuGio: tG, denGio: dG,
      sanphamList,
      nhanvienList: nv,
      status: 'pending',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      rejectReason: ''
    };
    decls.unshift(newDecl);
    DB.set('declarations', decls);

    // Đẩy lên Sheets ngay
    const pushed = await pushDeclToSheets(newDecl);
    if (pushed) {
      // Cập nhật ID (không còn LOCAL_)
      toast('success', '✅ Tạo mới và đã đồng bộ lên Google Sheets!');
    } else {
      toast('warning', '⚠ Tạo mới thành công (lưu local). Sync khi có mạng.');
    }
    logAction('TẠO ĐƠN', newId);
  }

  closeModal('createModal');
  loadTable();
}

// ============================================================
// DUYỆT / TỪ CHỐI (chỉ Admin)
// ============================================================
function openRejectModal(id) {
  rejectTargetId = id;
  document.getElementById('rejectReasonInput').value = '';
  showModal('rejectModal');
}

async function confirmReject() {
  const rs = document.getElementById('rejectReasonInput').value;
  if (!rs) return toast('error', 'Nhập lý do!');
  let decls = DB.get('declarations') || [];
  const ids = rejectTargetId === '__bulk__' ? [...selectedIds] : [rejectTargetId];
  decls.forEach(d => {
    if (ids.includes(d.id) && d.status === 'pending') {
      d.status = 'rejected'; d.rejectReason = rs;
    }
  });
  DB.set('declarations', decls);
  // Sync lên Sheets
  for (const id of ids) {
    await updateDeclStatusInSheets(id, 'rejected', rs).catch(console.error);
  }
  if (rejectTargetId === '__bulk__') selectedIds.clear();
  logAction('TỪ CHỐI', rs);
  closeModal('rejectModal');
  loadTable();
  toast('warning', 'Đã từ chối');
}

async function deleteRecord(id) {
  if (!confirm('Xóa bản ghi này?')) return;
  let d = DB.get('declarations') || [];
  DB.set('declarations', d.filter(x => x.id !== id));
  if (!id.startsWith('LOCAL_')) {
    await SHEETS.write('deleteDeclaration', { id }).catch(console.error);
  }
  logAction('XÓA', id);
  loadTable();
  toast('success', 'Đã xóa');
}

// ============================================================
// DETAIL VIEW
// ============================================================
function openDetail(id) {
  const d = (DB.get('declarations') || []).find(x => x.id === id);
  if (!d) return;

  // [5] Multi-product display
  const spHtml = (d.sanphamList || []).map((sp, i) =>
    `<div style="padding:4px 8px;background:#f0fff4;border-radius:4px;margin-bottom:4px;font-size:12px;">
      #${i + 1}: ${sp.isManual ? `<span class="manual-tag">⚠ ${sp.name}</span>` : `<b>${fCodeName(sp.code, sp.name)}</b>`}
    </div>`
  ).join('');

  const manuals = [];
  if (d.isManualSieuthi) manuals.push(`⚠ Siêu thị nhập tay: ${d.sieuthiName}`);
  (d.sanphamList || []).filter(s => s.isManual).forEach(s => manuals.push(`⚠ SP nhập tay: ${s.name}`));
  (d.nhanvienList || []).filter(n => n.isManual).forEach(n => manuals.push(`⚠ NV nhập tay: ${n.name}`));
  const manualHtml = manuals.length
    ? `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:8px;margin-top:10px;font-size:12px;"><b>⚠ Dữ liệu nhập tay — cần gửi Admin:</b><br>${manuals.join('<br>')}</div>`
    : '';

  document.getElementById('detailModalBody').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px;">
      <div><b>Mã đơn:</b> ${d.id}</div>
      <div><b>Trạng thái:</b> ${{ pending:'Chờ duyệt', approved:'Đã duyệt', rejected:'Từ chối' }[d.status]}</div>
      <div><b>Người tạo:</b> ${fCodeName(d.authorCode, d.authorName)}</div>
      <div><b>Ngày tạo:</b> ${fDate(d.createdAt)}</div>
      <div><b>Siêu thị:</b> ${fCodeName(d.sieuthiCode, d.sieuthiName)}</div>
      <div><b>Ngày BK:</b> ${fDate(d.ngay)}</div>
      <!-- [3] Giờ 24h -->
      <div style="grid-column:span 2;"><b>Giờ:</b> ${fTime(d.tuGio)} → ${fTime(d.denGio)}</div>
    </div>
    <!-- [5] Multi-product -->
    <div style="margin-top:12px;"><b>Danh sách Sản phẩm:</b><div style="margin-top:6px;">${spHtml || '<i style="color:#aaa">Chưa có</i>'}</div></div>
    <div style="margin-top:10px;"><b>Nhân viên:</b> ${(d.nhanvienList || []).map(n => n.isManual ? `<span class="manual-tag">⚠ ${n.name}</span>` : fCodeName(n.code, n.name)).join(', ')}</div>
    ${d.rejectReason ? `<div style="margin-top:10px;background:#ffebee;padding:8px;border-radius:4px;font-size:12px;"><b>Lý do từ chối:</b> ${d.rejectReason}</div>` : ''}
    ${manualHtml}`;

  document.getElementById('detailModalFooter').innerHTML = `<button class="btn btn-secondary" onclick="closeModal('detailModal')">Đóng</button>`;
  showModal('detailModal');
}

// ============================================================
// MANUAL LIST
// ============================================================
function openManualListModal() {
  const decls = DB.get('declarations') || [];
  let stManual = [], spManual = [], nvManual = [];
  decls.forEach(d => {
    if (d.isManualSieuthi) stManual.push({ from: fCodeName(d.authorCode, d.authorName), value: d.sieuthiName, id: d.id });
    (d.sanphamList || []).filter(s => s.isManual).forEach(s => spManual.push({ from: fCodeName(d.authorCode, d.authorName), value: s.name, id: d.id }));
    (d.nhanvienList || []).filter(n => n.isManual).forEach(n => nvManual.push({ from: fCodeName(d.authorCode, d.authorName), value: n.name, id: d.id }));
  });
  const makeTable = (title, items) => {
    if (!items.length) return '';
    return `<div style="margin-bottom:14px;"><h4 style="color:#e65100;margin-bottom:6px;">${title} (${items.length})</h4>
      <table class="manual-list-table"><thead><tr><th>Mã đơn</th><th>Người tạo</th><th>Giá trị nhập tay</th></tr></thead>
      <tbody>${items.map(x => `<tr><td>${x.id}</td><td>${x.from}</td><td>${x.value}</td></tr>`).join('')}</tbody></table></div>`;
  };
  const total = stManual.length + spManual.length + nvManual.length;
  document.getElementById('manualListContent').innerHTML = total
    ? makeTable('🏪 Siêu thị nhập tay', stManual) + makeTable('📦 Sản phẩm nhập tay', spManual) + makeTable('👥 Nhân viên nhập tay', nvManual)
    : `<div class="empty-state"><div class="icon">✅</div>Không có dữ liệu nhập tay</div>`;
  showModal('manualListModal');
}
function copyManualList() {
  navigator.clipboard.writeText(document.getElementById('manualListContent').innerText)
    .then(() => toast('success', 'Đã copy! Gửi cho Hải Phú qua BCNB'));
}

// ============================================================
// EXPORT & IMPORT
// ============================================================
function exportExcel() {
  // [5] Flatten sanphamList thành cột SP1, SP2, ...
  const maxSP = Math.max(1, ...filteredDeclarations.map(d => (d.sanphamList || []).length));
  const spHeaders = [];
  for (let i = 1; i <= maxSP; i++) { spHeaders.push(`Mã SP${i}`, `Tên SP${i}`); }

  const header = ['Mã Đơn', 'QLTP Mã', 'QLTP Tên', 'Siêu thị Mã', 'Siêu thị Tên', 'Ngày', 'Từ giờ', 'Đến giờ', ...spHeaders, 'DS NV', 'Trạng thái', 'Ngày tạo'];
  const data = filteredDeclarations.map(d => {
    const spCols = [];
    for (let i = 0; i < maxSP; i++) {
      const sp = (d.sanphamList || [])[i];
      spCols.push(sp ? sp.code : '', sp ? sp.name : '');
    }
    return [
      d.id, d.authorCode, d.authorName,
      d.sieuthiCode, d.sieuthiName,
      fDate(d.ngay),
      // [3] Format 24h khi export
      fTime(d.tuGio), fTime(d.denGio),
      ...spCols,
      (d.nhanvienList || []).map(n => fCodeName(n.code, n.name)).join('; '),
      d.status, fDate(d.createdAt)
    ];
  });
  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'KhaiBao');
  XLSX.writeFile(wb, `BietKich_${new Date().toISOString().split('T')[0]}.xlsx`);
  logAction('EXPORT', filteredDeclarations.length + ' dòng');
}

function downloadTemplateExcel() {
  const d = [
    // [5] Hỗ trợ nhiều SP — dùng dấu ; phân cách
    ['Siêu thị (Mã hoặc Tên)', 'Ngày (DD/MM/YYYY)', 'Từ giờ (HH:MM 24h)', 'Đến giờ (HH:MM 24h)', 'Mã SP (nhiều SP cách nhau ;)', 'Tên SP (nhiều SP cách nhau ;)', 'DS NV (cách nhau ;)'],
    ['BHX_HCM_001', '25/04/2026', '08:00', '20:00', '1053090000397;9876543210', 'BÁNH DD AFC;Nước suối', '268789 - Nguyễn Hải Phú; 27506 - Bá Thành']
  ];
  const ws = XLSX.utils.aoa_to_sheet(d);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  XLSX.writeFile(wb, 'Template_KhaiBao.xlsx');
  toast('success', '✅ Đã tải file mẫu!');
}

function openImportModal() {
  document.getElementById('fileImportInput').value = '';
  document.getElementById('bulkPreview').innerHTML = '';
  document.getElementById('btnImportSubmit').disabled = true;
  showModal('importModal');
}

function handleExcelUpload(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = evt => {
    const wb = XLSX.read(new Uint8Array(evt.target.result), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    if (rows.length < 2) return toast('error', 'File rỗng!');
    parseImportKB(rows.slice(1));
  };
  r.readAsArrayBuffer(f);
}

function parseImportKB(rows) {
  parsedBulkRows = [];
  const mstST = DB.get('sieuthi') || [];
  const mstSP = DB.get('sanpham') || [];
  const mstNV = DB.get('nhanvien') || [];
  let html = '', valid = 0, errors = 0;

  rows.forEach((r, i) => {
    if (!r[0] && !r[1]) return;
    const st = String(r[0] || '').trim();
    const dt = String(r[1] || '').trim();
    const t1 = String(r[2] || '').trim();
    const t2 = String(r[3] || '').trim();
    // [5] Nhiều SP cách nhau dấu ;
    const spCodes = String(r[4] || '').split(';').map(x => x.trim()).filter(Boolean);
    const spNames = String(r[5] || '').split(';').map(x => x.trim()).filter(Boolean);
    const nvRaw = String(r[6] || '').trim();

    let errs = [], isWarn = false;
    let stObj = mstST.find(s => String(s.name).toLowerCase() === st.toLowerCase() || String(s.code) === st);
    if (!stObj) isWarn = true;
    if (currentRole === 'qltp' && stObj && stObj.qltpCode !== currentUser.code) errs.push('ST ngoài quyền');

    let pDt = dt;
    if (dt.includes('/')) {
      try {
        const parts = dt.split('/');
        pDt = parts[0].length === 4
          ? `${parts[0]}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`
          : `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
      } catch {}
    }
    if (!pDt || pDt.includes('undefined')) errs.push('Sai ngày');
    if (t1 && t2) { const tErr = validateTime(t1, t2); if (tErr) errs.push('Giờ sai'); }
    else errs.push('Thiếu giờ');

    // [5] Parse danh sách SP
    const sanphamList = spCodes.map((code, idx) => {
      const name = spNames[idx] || code;
      const found = mstSP.find(s => String(s.code) === code || String(s.name).toLowerCase() === name.toLowerCase());
      return found
        ? { id: found.id, code: found.code, name: found.name, isManual: false }
        : { id: null, code: code || '', name: name, isManual: true };
    });
    if (sanphamList.length === 0) errs.push('Thiếu SP');

    // [4] Parse NV với format "Mã - Tên" hoặc "Mã Tên"
    let nvs = nvRaw.split(';').filter(x => x.trim()).map(n => {
      n = n.trim();
      // Hỗ trợ "268789 - Nguyễn Hải Phú" và "268789"
      let code = '', name = n;
      const dashIdx = n.indexOf(' - ');
      if (dashIdx > 0) { code = n.substring(0, dashIdx).trim(); name = n.substring(dashIdx + 3).trim(); }
      else { const m = n.match(/^(\d+)\s+(.+)/); if (m) { code = m[1]; name = m[2]; } }
      const fN = mstNV.find(x => String(x.code) === code || String(x.name).toLowerCase() === name.toLowerCase());
      return fN ? { id: fN.id, code: fN.code, name: fN.name, isManual: false } : { id: null, code, name, isManual: true };
    });

    const blocked = errs.length > 0;
    if (blocked) errors++;
    else {
      valid++;
      parsedBulkRows.push({ stName: st, stCode: stObj?.code || '', stId: stObj?.id || null, isManualST: !stObj, ngay: pDt, tuGio: t1, denGio: t2, sanphamList, nvParsed: nvs });
    }

    html += `<div class="bulk-row ${blocked ? 'error' : isWarn || sanphamList.some(s => s.isManual) ? 'manual' : 'valid'}">
      <span style="width:30px;color:#999;">#${i + 2}</span>
      <span>${blocked ? '❌' : isWarn ? '⚠' : '✅'} ${st} | ${spCodes.join(',')} | ${dt} | ${t1}-${t2}</span>
      ${errs.length ? `<span style="margin-left:auto;color:red;font-size:11px;">${errs.join(', ')}</span>` : ''}
    </div>`;
  });

  document.getElementById('bulkPreview').innerHTML =
    `<div style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Hợp lệ: <span style="color:green">${valid}</span> | Lỗi: <span style="color:red">${errors}</span></div>${html}`;
  document.getElementById('btnImportSubmit').disabled = valid === 0;
}

async function submitBulkImport() {
  let d = DB.get('declarations') || [];
  const newDecls = parsedBulkRows.map(r => ({
    id: SHEETS.canWrite ? 'BK' + Date.now().toString().slice(-8) + Math.random().toString(36).slice(-3) : 'LOCAL_' + Date.now().toString().slice(-8) + Math.random().toString(36).slice(-3),
    authorCode: currentUser.code, authorName: currentUser.name,
    sieuthiCode: r.stCode, sieuthiName: r.stName, isManualSieuthi: r.isManualST,
    ngay: r.ngay, tuGio: r.tuGio, denGio: r.denGio,
    sanphamList: r.sanphamList,
    nhanvienList: r.nvParsed,
    status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rejectReason: ''
  }));
  d.unshift(...newDecls);
  DB.set('declarations', d);

  // Đẩy lên Sheets
  let pushed = 0;
  for (const decl of newDecls) {
    const ok = await pushDeclToSheets(decl);
    if (ok) pushed++;
  }

  logAction('IMPORT KHAI BÁO', parsedBulkRows.length + ' dòng');
  closeModal('importModal');
  toast('success', `✅ Import ${parsedBulkRows.length} đơn${pushed > 0 ? `, đã sync ${pushed} lên Sheets` : ' (local)'}`);
  loadTable();
}

// ============================================================
// HISTORY
// ============================================================
function openHistoryModal() {
  let hist = DB.get('historyLog') || [];
  if (currentRole !== 'admin') hist = hist.filter(h => h.user && String(h.user).includes(currentUser.code));
  const tbody = document.getElementById('historyBody');
  tbody.innerHTML = hist.length ? hist.map(h =>
    `<tr>
      <td style="padding:8px;white-space:nowrap;font-size:11px;">${h.time}</td>
      <td style="padding:8px;font-weight:bold;font-size:11px;">${h.user}</td>
      <td style="padding:8px;color:var(--blue);font-size:11px;">${h.action}</td>
      <td style="padding:8px;font-size:11px;">${h.detail}</td>
    </tr>`
  ).join('') : `<tr><td colspan="4" align="center" style="padding:20px;color:#999;">Chưa có lịch sử</td></tr>`;
  document.getElementById('btnClearHistory').style.display = currentRole === 'admin' ? 'block' : 'none';
  showModal('historyModal');
}
function clearHistory() {
  if (!confirm('Xóa sạch lịch sử?')) return;
  DB.set('historyLog', []);
  openHistoryModal();
}

// ============================================================
// MASTER DATA CONTROL
// ============================================================
function openMasterDataModal() {
  updateStatChips();
  loadSheetConfigToForm();
  switchMasterTab('importData');
  showModal('masterDataModal');
}

function switchMasterTab(t) {
  const tabs = ['importData', 'sheetsConfig', 'users', 'sieuthi', 'sanpham', 'nhanvien'];
  tabs.forEach(x => {
    const el = document.getElementById(`masterTab${cap(x)}`);
    if (el) el.classList.remove('active');
  });
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const target = document.getElementById(`masterTab${cap(t)}`);
  if (target) target.classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.getAttribute('onclick')?.includes(`'${t}'`)) btn.classList.add('active');
  });
  if (!['importData', 'sheetsConfig'].includes(t)) {
    const el = document.getElementById(`search${cap(t)}`);
    if (el) el.value = '';
    renderMasterList(t);
  }
}

function renderMasterList(type) {
  const el = document.getElementById(`master${cap(type)}List`);
  if (!el) return;
  let q = '';
  const searchEl = document.getElementById(`search${cap(type)}`);
  if (searchEl) q = searchEl.value.toLowerCase().trim();

  if (type === 'users') {
    const qltpList = DB.get('qltpList') || [];
    const filtered = qltpList.filter(u => !q || String(u.code).toLowerCase().includes(q) || String(u.name).toLowerCase().includes(q));
    let rows = `<tr style="background:#fff3cd;"><td style="padding:6px;">admin</td><td style="padding:6px;">Admin BHX</td><td style="padding:6px;color:#666;font-weight:600;">Admin</td><td></td></tr>`;
    filtered.forEach(u => {
      // [4] Format Mã - Tên trong table
      rows += `<tr><td style="padding:6px;">${u.code}</td><td style="padding:6px;">${u.name}</td><td style="padding:6px;color:var(--green);font-weight:600;">QLTP</td><td><button class="btn btn-sm btn-danger" onclick="delUser('${u.code}')">Xóa</button></td></tr>`;
    });
    el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:#eee;"><th style="padding:6px;">Mã</th><th style="padding:6px;">Tên</th><th style="padding:6px;">Phân hệ</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  } else {
    const items = DB.get(type) || [];
    const filtered = items.filter(s => !q || String(s.code).toLowerCase().includes(q) || String(s.name).toLowerCase().includes(q));
    const limit = filtered.slice(0, 100);
    let tbl = `<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:#eee;"><th style="padding:6px;">Mã</th><th style="padding:6px;">Tên</th><th style="padding:6px;">Thêm</th><th></th></tr></thead><tbody>`;
    tbl += limit.map(s => `<tr>
      <td style="padding:6px;">${s.code}</td>
      <!-- [4] Hiển thị Mã - Tên ở cột tên -->
      <td style="padding:6px;">${s.name}</td>
      <td style="padding:6px;color:#888;">${type === 'sieuthi' ? (s.qltpCode || '--') : (s.sieuthiCode || s.type || '')}</td>
      <td><button class="btn btn-sm btn-danger" onclick="delMaster('${type}','${s.id}')">Xóa</button></td>
    </tr>`).join('');
    tbl += `</tbody></table>`;
    if (filtered.length > 100) tbl += `<p style="font-size:11px;color:orange;padding:5px;">... và ${filtered.length - 100} kết quả khác.</p>`;
    el.innerHTML = tbl;
  }
}

// [2] addMasterUser chỉ còn thêm QLTP
function addMasterUser() {
  const c = document.getElementById('newUserCode').value.trim();
  const n = document.getElementById('newUserName').value.trim();
  if (!c || !n) return toast('error', 'Nhập đủ Mã và Tên!');
  let list = DB.get('qltpList') || [];
  if (list.find(x => String(x.code).toUpperCase() === c.toUpperCase())) return toast('error', 'Mã đã tồn tại!');
  list.push({ code: c, name: n });
  DB.set('qltpList', list);
  toast('success', 'Đã thêm QLTP!');
  updateStatChips();
  renderMasterList('users');
}

// [2] delUser chỉ xóa QLTP
function delUser(code) {
  if (!confirm('Xóa tài khoản QLTP này?')) return;
  DB.set('qltpList', (DB.get('qltpList') || []).filter(u => u.code !== code));
  updateStatChips();
  renderMasterList('users');
}

function addMasterItem(type) {
  const c = document.getElementById(`new${cap(type)}Code`).value.trim();
  const n = document.getElementById(`new${cap(type)}Name`).value.trim();
  if (!c || !n) return toast('error', 'Nhập đủ Mã và Tên!');
  let items = DB.get(type) || [];
  if (items.find(x => String(x.code) === c)) return toast('error', 'Trùng mã!');
  const obj = { id: c, code: c, name: n };
  if (type === 'sieuthi') obj.qltpCode = document.getElementById('newSieuthiQLTP').value.trim();
  if (type === 'nhanvien') obj.sieuthiCode = document.getElementById('newNhanvienST').value.trim();
  items.push(obj);
  DB.set(type, items);
  updateStatChips();
  toast('success', 'Đã thêm');
  renderMasterList(type);
}

function delMaster(type, id) {
  if (!confirm('Xóa?')) return;
  DB.set(type, (DB.get(type) || []).filter(x => x.id !== id));
  updateStatChips();
  renderMasterList(type);
}
