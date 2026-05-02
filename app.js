// ============================================================
// BHX BIỆT KÍCH — app.js (Đã tích hợp toàn bộ Patch)
// Kiến trúc: Google Sheets (Apps Script) là source of truth duy nhất
// Không dùng IndexedDB. Mọi thao tác ghi → Apps Script ngay lập tức.
// Master data load từ Sheets sau khi login thành công.
// ============================================================

// ============================================================
// 1. CẤU HÌNH & TRẠNG THÁI TOÀN CỤC
// ============================================================

// --- Apps Script URL (lưu vào localStorage chỉ để admin không cần nhập lại) ---
let WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbz_THAY_BANG_LINK_CUA_BAN_O_DAY/exec';

// --- Mật khẩu admin (lưu local, admin có thể đổi) ---
const ADMIN_PASS_KEY = 'bhx_adminPass';
function getAdminPass() { return localStorage.getItem(ADMIN_PASS_KEY) || '24122004'; }
function setAdminPass(p) { localStorage.setItem(ADMIN_PASS_KEY, p); }

// --- State ---
let currentUser   = null;  // { code, name, role: 'qltp'|'admin' }
let masterData    = { qltpList: [], sieuthi: [], sanpham: [], nhanvien: [] };
let declarations  = [];    // Array of declaration objects (active only for display)
let activityLog   = [];    // Loaded from Sheets (sheet: activity_log)
let filteredDecls = [];
let selectedIds   = new Set();

// Form selections state
let selST = null;          // { code, name }
let selSP = [];            // [{ code, name }]
let selNV = [];            // [{ code, name }]
let editingId = null;      // null = create, string = edit

// Import state
let importRows = [];       // Parsed, validated rows ready to submit

// ============================================================
// 2. TIỆN ÍCH
// ============================================================

function toast(type, msg) {
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', warning: '⚠', info: 'ℹ' };
  el.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function showLoading(msg = 'Đang xử lý...') {
  document.getElementById('loadingOverlay').classList.add('show');
  document.getElementById('loadingText').textContent = msg;
}
function hideLoading() {
  document.getElementById('loadingOverlay').classList.remove('show');
}

function setSyncStatus(state, msg) {
  const dot = document.getElementById('syncDot');
  const txt = document.getElementById('syncText');
  dot.className = 'sync-dot' + (state === 'syncing' ? ' syncing' : state === 'error' ? ' error' : '');
  txt.textContent = msg;
}

function showModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function fDate(iso) {
  if (!iso) return '';
  const s = iso.includes('T') ? iso.split('T')[0] : iso;
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

// ── FIX #2: Chuẩn hóa hiển thị giờ HH:MM ───────────
function fTime(t) {
  if (!t) return '--';
  const s = String(t).trim();
  // Xử lý cả "8:0", "08:00", "8:00", "800" nếu có
  const parts = s.split(':');
  if (parts.length >= 2) {
    return String(parts[0]).padStart(2, '0') + ':' + String(parts[1]).padStart(2, '0');
  }
  // Nếu dạng số (800 → 08:00)
  if (/^\d{3,4}$/.test(s)) {
    const h = s.slice(0, s.length - 2);
    const m = s.slice(-2);
    return h.padStart(2, '0') + ':' + m;
  }
  return s;
}

// ── FIX #3 Helper: Chuẩn hóa giờ khi import Excel ───
function normalizeTime(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // Đã đúng HH:MM
  if (/^\d{2}:\d{2}$/.test(s)) return s;
  // H:MM hoặc HH:M
  if (/^\d{1,2}:\d{1,2}$/.test(s)) {
    const [h, m] = s.split(':');
    return h.padStart(2, '0') + ':' + m.padStart(2, '0');
  }
  // Số Excel (0.333... = 8:00)
  if (!isNaN(s) && s !== '') {
    const totalMin = Math.round(parseFloat(s) * 24 * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }
  return s;
}

function genId() {
  return 'BK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();
}

function nowISO() { return new Date().toISOString(); }

// Debounce
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ============================================================
// 3. APPS SCRIPT — GATEWAY DUY NHẤT
// ============================================================

async function gasGet(params) {
  if (!WEB_APP_URL) throw new Error('Chưa cấu hình Web App URL!');
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${WEB_APP_URL}?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function gasPost(payload) {
  if (!WEB_APP_URL) throw new Error('Chưa cấu hình Web App URL!');
  const res = await fetch(WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ============================================================
// 4. LOGIN
// ============================================================

let loginRole = 'qltp';

function switchLoginRole(role) {
  loginRole = role;
  document.getElementById('tabQLTP').classList.toggle('active', role === 'qltp');
  document.getElementById('tabAdmin').classList.toggle('active', role === 'admin');
  document.getElementById('loginFieldQLTP').style.display  = role === 'qltp'  ? '' : 'none';
  document.getElementById('loginFieldAdmin').style.display = role === 'admin' ? '' : 'none';
  document.getElementById('loginError').style.display = 'none';
}

// Gợi ý QLTP khi gõ — CHỈ gọi Sheets nếu có URL, fallback local nếu có
const onQLTPInput = debounce(async function(val) {
  const suggest = document.getElementById('qltpSuggest');
  const preview = document.getElementById('qltpPreview');
  preview.style.display = 'none';
  const q = val.trim();
  if (!q) { suggest.classList.add('hidden'); return; }

  // Tìm trong masterData nếu đã có (admin đã push lên Sheets và đã load)
  let list = masterData.qltpList;

  // Nếu chưa có, thử load từ Sheets (trường hợp user chưa đăng nhập lần nào)
  if (!list.length && WEB_APP_URL) {
    try {
      const r = await gasGet({ action: 'getQltpList' });
      if (r.ok) {
        list = r.data || [];
        masterData.qltpList = list;
      }
    } catch (_) { /* offline ok */ }
  }

  const filtered = list.filter(x => String(x.code).startsWith(q)).slice(0, 10);
  if (!filtered.length) { suggest.classList.add('hidden'); return; }

  suggest.innerHTML = filtered.map(x =>
    `<div class="suggest-item" onclick="selectQLTP('${x.code}','${x.name.replace(/'/g,"\\'")}')">
      <span class="code">${x.code}</span>
      <span class="name">${x.name}</span>
    </div>`
  ).join('');
  suggest.classList.remove('hidden');
}, 250);

function selectQLTP(code, name) {
  document.getElementById('inpQLTPCode').value = code;
  document.getElementById('qltpSuggest').classList.add('hidden');
  document.getElementById('qltpPreviewText').textContent = `${code} — ${name}`;
  document.getElementById('qltpPreview').style.display = '';
}

async function doLogin() {
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';

  if (loginRole === 'admin') {
    const pass = document.getElementById('inpAdminPass').value;
    if (pass !== getAdminPass()) {
      errEl.textContent = '❌ Sai mật khẩu Admin!';
      errEl.style.display = '';
      return;
    }
    currentUser = { code: 'admin', name: 'Admin BHX', role: 'admin' };
    await afterLogin();
    return;
  }

  // QLTP
  const code = document.getElementById('inpQLTPCode').value.trim();
  if (!code) { errEl.textContent = '❌ Vui lòng nhập mã QLTP!'; errEl.style.display = ''; return; }

  showLoading('Đang xác thực...');
  try {
    // Xác thực qua Sheets
    const r = await gasGet({ action: 'loginQLTP', code });
    if (!r.ok) {
      hideLoading();
      errEl.textContent = `❌ ${r.msg || 'Mã QLTP không tồn tại trong hệ thống!'}`;
      errEl.style.display = '';
      return;
    }
    currentUser = { code: r.data.code, name: r.data.name, role: 'qltp' };
    await afterLogin();
  } catch (err) {
    hideLoading();
    errEl.textContent = '❌ Lỗi kết nối: ' + err.message;
    errEl.style.display = '';
  }
}

// ── FIX #1: afterLogin — Admin vào được dù chưa có URL ──────
async function afterLogin() {
  const isAdmin = currentUser.role === 'admin';

  // Admin không có URL → vào thẳng, mở config ngay
  if (isAdmin && !WEB_APP_URL) {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').classList.add('show');
    setupUI();
    setSyncStatus('error', 'Chưa có URL');
    toast('warning', '⚠ Chưa có Web App URL — Vui lòng cấu hình trước');
    // Mở thẳng Master Data → tab Sheets Config
    openMasterModal();
    switchTab('sheets');
    return;
  }

  showLoading('Đang tải dữ liệu...');
  try {
    await loadAllData();
    hideLoading();
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').classList.add('show');
    setupUI();
    applyFilter();
    setSyncStatus('ok', 'Đã kết nối');
    logActivity('ĐĂNG NHẬP', null, '');
  } catch (err) {
    hideLoading();
    document.getElementById('loginError').textContent = '❌ Lỗi tải dữ liệu: ' + err.message;
    document.getElementById('loginError').style.display = '';
  }
}

// ============================================================
// 5. LOAD DỮ LIỆU TỪ SHEETS
// ============================================================

async function loadAllData() {
  setSyncStatus('syncing', 'Đang tải...');
  const r = await gasGet({ action: 'getAllData', role: currentUser.role, code: currentUser.code });
  if (!r.ok) throw new Error(r.msg || 'Lỗi tải dữ liệu');

  const d = r.data;
  masterData.qltpList  = d.qltpList  || [];
  masterData.sieuthi   = d.sieuthi   || [];
  masterData.sanpham   = d.sanpham   || [];
  masterData.nhanvien  = d.nhanvien  || [];
  declarations         = (d.declarations || []).filter(x => x.rowStatus !== 'deleted');
  activityLog          = d.activityLog || [];

  // QLTP chỉ thấy đơn của mình
  if (currentUser.role === 'qltp') {
    declarations = declarations.filter(x => x.authorCode === currentUser.code);
  }

  updateMasterChips();
  setSyncStatus('ok', `Đã sync — ${declarations.length} đơn`);
}

async function refreshData() {
  showLoading('Đang đồng bộ...');
  try {
    await loadAllData();
    applyFilter();
    toast('success', `✅ Đã đồng bộ ${declarations.length} khai báo`);
  } catch (err) {
    toast('error', 'Lỗi sync: ' + err.message);
    setSyncStatus('error', 'Lỗi sync');
  } finally { hideLoading(); }
}

// ============================================================
// 6. SETUP UI SAU LOGIN
// ============================================================

function setupUI() {
  const isAdmin = currentUser.role === 'admin';
  const isQL    = currentUser.role === 'qltp';

  // Header
  document.getElementById('headerUserName').textContent = `${currentUser.name}`;
  document.getElementById('headerSub').textContent = ` / ${isAdmin ? 'ADMIN' : 'QLTP'}`;

  // Role bar
  const pill = document.getElementById('rolePill');
  pill.textContent = isAdmin ? '🔐 ADMIN' : '👤 QLTP';
  pill.className = `role-pill ${isAdmin ? 'admin' : 'qltp'}`;
  document.getElementById('roleUserText').textContent = `${currentUser.name} — ${currentUser.code}`;
  document.getElementById('adminObserverBadge').style.display = isAdmin ? '' : 'none';

  // Buttons
  document.getElementById('adminActionsWrap').style.display = isAdmin ? '' : 'none';
  document.getElementById('btnCreate').style.display  = (isQL || isAdmin) ? '' : 'none';
  document.getElementById('btnImport').style.display  = (isQL || isAdmin) ? '' : 'none';

  // Filter defaults
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('fltFrom').value = today;
  document.getElementById('fltTo').value   = today;
}

function onHeaderUserClick() {
  if (currentUser.role === 'admin') openMasterModal();
}

function doLogout() {
  currentUser  = null;
  declarations = [];
  activityLog  = [];
  masterData   = { qltpList: [], sieuthi: [], sanpham: [], nhanvien: [] };
  selectedIds.clear();

  document.getElementById('appShell').classList.remove('show');
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('inpQLTPCode').value  = '';
  document.getElementById('inpAdminPass').value = '';
  document.getElementById('qltpPreview').style.display = 'none';
  document.getElementById('loginError').style.display  = 'none';
  switchLoginRole('qltp');
  setSyncStatus('error', 'Offline');
}

// ============================================================
// 7. FILTER & TABLE
// ============================================================

function applyFilter() {
  const fST   = document.getElementById('fltST').value.trim().toUpperCase();
  const fFrom = document.getElementById('fltFrom').value;
  const fTo   = document.getElementById('fltTo').value;

  filteredDecls = declarations.filter(d => {
    if (fST && !String(d.sieuthiCode).toUpperCase().includes(fST)) return false;
    if (fFrom && d.ngay < fFrom) return false;
    if (fTo   && d.ngay > fTo)   return false;
    return true;
  });

  document.getElementById('recordCount').textContent = `Tổng: ${filteredDecls.length} bản ghi`;
  renderTable();
}

function renderTable() {
  const tbody = document.getElementById('tableBody');
  if (!filteredDecls.length) {
    tbody.innerHTML = `<tr><td colspan="10">
      <div class="empty-state"><div class="icon">📋</div><p>Không có dữ liệu phù hợp</p></div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = filteredDecls.map((d, i) => {
    const checked = selectedIds.has(d.id) ? 'checked' : '';
    const spStr = (d.sanphamList || []).map(x => `${x.code}`).join('; ');
    const nvStr = (d.nhanvienList || []).map(x => `${x.code}`).join('; ');

    // Hiển thị tên đầy đủ bên dưới (tooltip style)
    const spFull = (d.sanphamList || []).map(x => `${x.code} - ${x.name}`).join('\n');
    const nvFull = (d.nhanvienList || []).map(x => `${x.code} - ${x.name}`).join('\n');

    let actions = `<button class="btn btn-sm btn-gray" onclick="openDetail('${d.id}')">👁 Xem</button> `;
    if (currentUser.role === 'qltp' && d.authorCode === currentUser.code) {
      actions += `<button class="btn btn-sm btn-blue" onclick="openEdit('${d.id}')">✏ Sửa</button> `;
      actions += `<button class="btn btn-sm btn-red" onclick="softDelete('${d.id}')">🗑</button>`;
    }
    if (currentUser.role === 'admin') {
      actions += `<button class="btn btn-sm btn-blue" onclick="openEdit('${d.id}')">✏ Sửa</button> `;
      actions += `<button class="btn btn-sm btn-red" onclick="softDelete('${d.id}')">🗑</button>`;
    }

    return `<tr>
      <td><input type="checkbox" ${checked} onchange="toggleSelect('${d.id}',this.checked)"></td>
      <td class="idx-cell">${i+1}</td>
      <td style="font-size:12px;"><b style="color:var(--green);">${d.authorCode}</b><br><span style="color:var(--gray-600);">${d.authorName}</span></td>
      <td style="font-size:12px;"><b>${d.sieuthiCode}</b><br><span style="color:var(--gray-600);font-size:11px;">${d.sieuthiName}</span></td>
      <td style="font-weight:700;color:var(--blue);white-space:nowrap;">${fDate(d.ngay)}</td>
      <td style="white-space:nowrap;font-size:12px;">${fTime(d.tuGio)} → ${fTime(d.denGio)}</td>
      <td style="font-size:11px;max-width:180px;" title="${spFull}">${spStr || '--'}</td>
      <td style="font-size:11px;max-width:160px;" title="${nvFull}">${nvStr || '--'}</td>
      <td style="font-size:11px;color:var(--gray-600);">${fDate(d.createdAt)}</td>
      <td style="white-space:nowrap;">${actions}</td>
    </tr>`;
  }).join('');
}

function toggleSelect(id, checked) {
  checked ? selectedIds.add(id) : selectedIds.delete(id);
  updateSelectionUI();
}

function toggleSelectAll(checked) {
  filteredDecls.forEach(d => checked ? selectedIds.add(d.id) : selectedIds.delete(d.id));
  document.querySelectorAll('#tableBody input[type=checkbox]').forEach(cb => cb.checked = checked);
  updateSelectionUI();
}

function updateSelectionUI() {
  const n = selectedIds.size;
  document.getElementById('selectedInfo').textContent = n > 0 ? `Đã chọn ${n}` : '';
  const showDel = n > 0 && currentUser.role === 'admin';
  document.getElementById('btnBulkDel').style.display = showDel ? '' : 'none';
}

// ============================================================
// 8. MULTI-SELECT DROPDOWN (Siêu thị / Sản phẩm / Nhân viên)
// ============================================================

// Chỉ tìm theo mã (code), hiển thị Mã - Tên
const msSearchDebounced = debounce(function(field, q) {
  _msRender(field, q);
}, 200);

function msSearch(field, q) {
  msSearchDebounced(field, q);
}

function _msRender(field, q) {
  const key = field === 'st' ? 'sieuthi' : field === 'sp' ? 'sanpham' : 'nhanvien';
  const ddId = field === 'st' ? 'ddST' : field === 'sp' ? 'ddSP' : 'ddNV';
  const dd = document.getElementById(ddId);
  if (!dd) return;

  let items = masterData[key] || [];

  // QLTP chỉ thấy ST của mình
  if (field === 'st' && currentUser.role === 'qltp') {
    items = items.filter(s => s.qltpCode === currentUser.code);
  }
  // QLTP chỉ thấy NV thuộc ST của mình
  if (field === 'nv' && currentUser.role === 'qltp' && selST) {
    items = items.filter(n => !n.sieuthiCode || n.sieuthiCode === selST.code);
  }

  const upper = q.trim().toUpperCase();
  // Chỉ tìm theo mã
  const filtered = upper
    ? items.filter(x => String(x.code).toUpperCase().includes(upper)).slice(0, 30)
    : items.slice(0, 30);

  if (!filtered.length) {
    dd.innerHTML = `<div class="ms-no-result">Không tìm thấy mã "${q}" — Liên hệ Hải Phú 268789</div>`;
    dd.classList.remove('hidden');
    return;
  }

  // Đánh dấu đã chọn
  const selectedCodes = field === 'st'
    ? (selST ? [selST.code] : [])
    : field === 'sp' ? selSP.map(x => x.code) : selNV.map(x => x.code);

  dd.innerHTML = filtered.map(item => {
    const isSel = selectedCodes.includes(item.code);
    return `<div class="ms-option ${isSel ? 'selected' : ''}"
      onmousedown="msSelect('${field}','${item.code}','${item.name.replace(/'/g,"\\'")}')">
      <span class="opt-code">${item.code}</span>
      <span class="opt-name">${item.name}</span>
      ${isSel ? '<span style="color:var(--green);font-weight:700;">✓</span>' : ''}
    </div>`;
  }).join('');
  dd.classList.remove('hidden');
}

function msSelect(field, code, name) {
  if (field === 'st') {
    selST = { code, name };
    document.getElementById('inpST').value = `${code} - ${name}`;
    document.getElementById('ddST').classList.add('hidden');
    renderTags('st');
    // Sau khi chọn ST, cập nhật lại NV dropdown
    document.getElementById('inpNV').value = '';
    selNV = [];
    renderTags('nv');
    return;
  }
  if (field === 'sp') {
    if (!selSP.find(x => x.code === code)) {
      selSP.push({ code, name });
      renderTags('sp');
    }
    document.getElementById('inpSP').value = '';
    document.getElementById('ddSP').classList.add('hidden');
    return;
  }
  if (field === 'nv') {
    if (!selNV.find(x => x.code === code)) {
      selNV.push({ code, name });
      renderTags('nv');
    }
    document.getElementById('inpNV').value = '';
    document.getElementById('ddNV').classList.add('hidden');
    return;
  }
}

function renderTags(field) {
  if (field === 'st') {
    const c = document.getElementById('tagsST');
    c.innerHTML = selST
      ? `<div class="tag-chip">${selST.code} - ${selST.name}<span class="rm" onmousedown="removeTag('st',null)">×</span></div>`
      : '';
  }
  if (field === 'sp') {
    document.getElementById('tagsSP').innerHTML = selSP.map((x, i) =>
      `<div class="tag-chip">${x.code} - ${x.name}<span class="rm" onmousedown="removeTag('sp',${i})">×</span></div>`
    ).join('');
  }
  if (field === 'nv') {
    document.getElementById('tagsNV').innerHTML = selNV.map((x, i) =>
      `<div class="tag-chip">${x.code} - ${x.name}<span class="rm" onmousedown="removeTag('nv',${i})">×</span></div>`
    ).join('');
  }
}

function removeTag(field, idx) {
  if (field === 'st') { selST = null; document.getElementById('inpST').value = ''; }
  if (field === 'sp') selSP.splice(idx, 1);
  if (field === 'nv') selNV.splice(idx, 1);
  renderTags(field);
}

// Đóng dropdown khi click ra ngoài
document.addEventListener('click', e => {
  ['ddST','ddSP','ddNV'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.parentElement?.contains(e.target)) el.classList.add('hidden');
  });
  document.getElementById('qltpSuggest')?.classList.add('hidden');
});

// ============================================================
// 9. TẠO / SỬA KHAI BÁO
// ============================================================

function openCreateModal() {
  editingId = null;
  selST = null; selSP = []; selNV = [];
  document.getElementById('inpST').value    = '';
  document.getElementById('inpSP').value    = '';
  document.getElementById('inpNV').value    = '';
  document.getElementById('inpNgay').value  = '';
  document.getElementById('inpTuGio').value = '';
  document.getElementById('inpDenGio').value= '';
  document.getElementById('tagsST').innerHTML = '';
  document.getElementById('tagsSP').innerHTML = '';
  document.getElementById('tagsNV').innerHTML = '';
  document.getElementById('createTitle').textContent = '➕ Tạo Khai Báo Biệt Kích';
  showModal('modalCreate');
}

function openEdit(id) {
  const d = declarations.find(x => x.id === id);
  if (!d) return;
  editingId = id;

  selST = { code: d.sieuthiCode, name: d.sieuthiName };
  selSP = [...(d.sanphamList  || [])];
  selNV = [...(d.nhanvienList || [])];

  document.getElementById('inpST').value    = `${d.sieuthiCode} - ${d.sieuthiName}`;
  document.getElementById('inpSP').value    = '';
  document.getElementById('inpNV').value    = '';
  document.getElementById('inpNgay').value  = d.ngay;
  document.getElementById('inpTuGio').value = d.tuGio  || '';
  document.getElementById('inpDenGio').value= d.denGio || '';

  renderTags('st');
  renderTags('sp');
  renderTags('nv');

  document.getElementById('createTitle').textContent = '✏ Sửa Khai Báo Biệt Kích';
  showModal('modalCreate');
}

async function submitCreate() {
  // Validate
  if (!selST)            return toast('error', 'Chọn Siêu Thị!');
  if (!selSP.length)     return toast('error', 'Chọn ít nhất 1 Sản Phẩm!');
  if (!selNV.length)     return toast('error', 'Chọn ít nhất 1 Nhân Viên!');
  const ngay  = document.getElementById('inpNgay').value;
  const tuGio = document.getElementById('inpTuGio').value;
  const denGio= document.getElementById('inpDenGio').value;
  if (!ngay)  return toast('error', 'Chọn Ngày!');
  if (!tuGio || !denGio) return toast('error', 'Nhập đủ Từ giờ và Đến giờ!');
  if (tuGio < '05:00' || tuGio > '22:00' || denGio < '05:00' || denGio > '22:00')
    return toast('error', 'Giờ phải trong khoảng 05:00 – 22:00!');
  if (tuGio >= denGio) return toast('error', 'Từ giờ phải nhỏ hơn Đến giờ!');

  const isEdit = !!editingId;
  const id = editingId || genId();

  const payload = {
    id,
    authorCode:   currentUser.code,
    authorName:   currentUser.name,
    sieuthiCode:  selST.code,
    sieuthiName:  selST.name,
    ngay,
    tuGio,
    denGio,
    // Lưu dạng "mã1;mã2" trong Sheets, parse khi đọc
    sanphamList:  JSON.stringify(selSP),
    nhanvienList: JSON.stringify(selNV),
    rowStatus:    'active',
    createdAt:    isEdit ? (declarations.find(x=>x.id===id)?.createdAt || nowISO()) : nowISO(),
    updatedAt:    nowISO()
  };

  showLoading(isEdit ? 'Đang cập nhật...' : 'Đang lưu...');
  try {
    const action = isEdit ? 'updateDeclaration' : 'createDeclaration';
    const r = await gasPost({ action, row: payload });
    if (!r.ok) { hideLoading(); return toast('error', r.msg || 'Lỗi lưu!'); }

    // Cập nhật local state
    const localObj = {
      ...payload,
      sanphamList:  selSP,
      nhanvienList: selNV
    };
    if (isEdit) {
      const idx = declarations.findIndex(x => x.id === id);
      if (idx >= 0) declarations[idx] = localObj;
    } else {
      declarations.unshift(localObj);
    }

    // Log activity
    await logActivity(isEdit ? 'SỬA ĐƠN' : 'TẠO ĐƠN', id,
      `ST: ${selST.code} | SP: ${selSP.map(x=>x.code).join(';')} | NV: ${selNV.map(x=>x.code).join(';')}`);

    closeModal('modalCreate');
    applyFilter();
    toast('success', isEdit ? '✅ Cập nhật thành công!' : '✅ Khai báo thành công!');
  } catch (err) {
    toast('error', 'Lỗi: ' + err.message);
  } finally { hideLoading(); }
}

// ============================================================
// 10. SOFT DELETE
// ============================================================

async function softDelete(id) {
  if (!confirm('Xóa khai báo này?\n(Dữ liệu trên Google Sheets vẫn được giữ lại với trạng thái "đã xóa")')) return;
  showLoading('Đang xóa...');
  try {
    const r = await gasPost({ action: 'softDeleteDeclaration', id, deletedBy: currentUser.code, deletedAt: nowISO() });
    if (!r.ok) { hideLoading(); return toast('error', r.msg || 'Lỗi xóa!'); }

    declarations = declarations.filter(x => x.id !== id);
    selectedIds.delete(id);

    await logActivity('XÓA ĐƠN', id, '(soft delete — vẫn còn trên Sheets)');
    applyFilter();
    toast('success', '🗑 Đã xóa (có thể khôi phục trên Google Sheets)');
  } catch (err) {
    toast('error', 'Lỗi: ' + err.message);
  } finally { hideLoading(); }
}

async function bulkDelete() {
  if (!selectedIds.size) return;
  if (!confirm(`Xóa ${selectedIds.size} khai báo đã chọn?`)) return;
  showLoading('Đang xóa...');
  const ids = [...selectedIds];
  try {
    for (const id of ids) {
      await gasPost({ action: 'softDeleteDeclaration', id, deletedBy: currentUser.code, deletedAt: nowISO() });
    }
    declarations = declarations.filter(x => !selectedIds.has(x.id));
    selectedIds.clear();
    await logActivity('XÓA NHIỀU', ids.join(','), `${ids.length} bản ghi`);
    updateSelectionUI();
    applyFilter();
    toast('success', `🗑 Đã xóa ${ids.length} khai báo`);
  } catch (err) {
    toast('error', 'Lỗi: ' + err.message);
  } finally { hideLoading(); }
}

// ============================================================
// 11. DETAIL VIEW
// ============================================================

function openDetail(id) {
  const d = declarations.find(x => x.id === id);
  if (!d) return;

  const spHtml = (d.sanphamList || []).map(x =>
    `<span class="tag" style="margin:2px;">${x.code} - ${x.name}</span>`).join('');
  const nvHtml = (d.nhanvienList || []).map(x =>
    `<span class="tag" style="margin:2px;background:var(--blue-light);color:var(--blue);">${x.code} - ${x.name}</span>`).join('');

  document.getElementById('detailBody').innerHTML = `
    <div class="detail-grid" style="margin-bottom:16px;">
      <div class="detail-item"><label>Mã Khai Báo</label><div class="val">${d.id}</div></div>
      <div class="detail-item"><label>Ngày Tạo</label><div class="val">${fDate(d.createdAt)}</div></div>
      <div class="detail-item"><label>QLTP</label><div class="val">${d.authorCode} - ${d.authorName}</div></div>
      <div class="detail-item"><label>Siêu Thị</label><div class="val">${d.sieuthiCode} - ${d.sieuthiName}</div></div>
      <div class="detail-item"><label>Ngày BK</label><div class="val" style="color:var(--blue);font-size:15px;">${fDate(d.ngay)}</div></div>
      <div class="detail-item"><label>Giờ BK</label><div class="val">${fTime(d.tuGio)} → ${fTime(d.denGio)}</div></div>
    </div>
    <div style="margin-bottom:14px;">
      <div class="detail-item"><label>Sản Phẩm</label></div>
      <div style="margin-top:6px;">${spHtml || '<span style="color:var(--gray-400);">Chưa có</span>'}</div>
    </div>
    <div>
      <div class="detail-item"><label>Nhân Viên</label></div>
      <div style="margin-top:6px;">${nvHtml || '<span style="color:var(--gray-400);">Chưa có</span>'}</div>
    </div>
    ${d.updatedAt && d.updatedAt !== d.createdAt ? `
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--gray-600);">
      Cập nhật lần cuối: ${fDate(d.updatedAt)}
    </div>` : ''}
  `;
  showModal('modalDetail');
}

// ============================================================
// 12. ACTIVITY LOG
// ============================================================

async function logActivity(action, declId, detail) {
  const entry = {
    time:     nowISO(),
    userCode: currentUser.code,
    userName: currentUser.name,
    action,
    declId:   declId || '',
    detail:   detail || ''
  };
  activityLog.unshift(entry);
  // Ghi lên Sheets (fire and forget)
  gasPost({ action: 'appendLog', row: entry }).catch(console.warn);
}

function openHistoryModal() {
  document.getElementById('adminHistBtn').style.display =
    currentUser.role === 'admin' ? '' : 'none';
  document.getElementById('histSearch').value = '';
  renderHistory();
  showModal('modalHistory');
}

function renderHistory() {
  const q   = document.getElementById('histSearch').value.toLowerCase().trim();
  const role = currentUser.role;

  let log = role === 'admin'
    ? activityLog
    : activityLog.filter(h => h.userCode === currentUser.code);

  if (q) {
    log = log.filter(h =>
      String(h.declId).toLowerCase().includes(q) ||
      String(h.userCode).toLowerCase().includes(q) ||
      String(h.action).toLowerCase().includes(q)
    );
  }

  const tbody = document.getElementById('histBody');
  tbody.innerHTML = log.length ? log.slice(0, 200).map(h => `<tr>
    <td style="white-space:nowrap;">${new Date(h.time).toLocaleString('vi-VN')}</td>
    <td><b style="color:var(--green);">${h.userCode}</b><br><span style="font-size:11px;color:var(--gray-600);">${h.userName}</span></td>
    <td><b>${h.action}</b></td>
    <td style="font-size:11px;">${h.declId || '--'}</td>
    <td style="font-size:11px;color:var(--gray-600);">${h.detail || ''}</td>
  </tr>`).join('')
  : `<tr><td colspan="5" align="center" style="padding:20px;color:var(--gray-400);">Chưa có lịch sử</td></tr>`;
}

async function clearHistory() {
  if (!confirm('Xóa toàn bộ lịch sử local? (Sheets vẫn giữ)')) return;
  activityLog = [];
  renderHistory();
  toast('success', 'Đã xóa lịch sử local');
}

// ============================================================
// 13. EXPORT EXCEL
// ============================================================

function exportExcel() {
  if (!filteredDecls.length) return toast('warning', 'Không có dữ liệu để export!');

  const header = ['Mã Khai Báo','QLTP Mã','QLTP Tên','Mã ST','Tên ST','Ngày','Từ Giờ','Đến Giờ','Mã SP','Tên SP','Mã NV','Tên NV','Ngày Tạo'];
  const rows = filteredDecls.map(d => [
    d.id,
    d.authorCode, d.authorName,
    d.sieuthiCode, d.sieuthiName,
    fDate(d.ngay),
    fTime(d.tuGio), fTime(d.denGio),
    (d.sanphamList||[]).map(x=>x.code).join(';'),
    (d.sanphamList||[]).map(x=>x.name).join(';'),
    (d.nhanvienList||[]).map(x=>x.code).join(';'),
    (d.nhanvienList||[]).map(x=>x.name).join(';'),
    fDate(d.createdAt)
  ]);

  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'KhaiBao');
  XLSX.writeFile(wb, `BietKich_${new Date().toISOString().split('T')[0]}.xlsx`);
  toast('success', `✅ Đã export ${rows.length} dòng`);
  logActivity('EXPORT', null, `${rows.length} dòng`);
}

function downloadTemplate() {
  const rows = [
    ['Mã ST','Ngày (DD/MM/YYYY)','Từ giờ (HH:MM)','Đến giờ (HH:MM)','Mã SP (cách nhau ;)','Mã NV (cách nhau ;)'],
    ['BHX001','25/04/2026','08:00','20:00','SP001;SP002','NV001;NV002']
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  XLSX.writeFile(wb, 'Template_KhaiBao.xlsx');
  toast('success', '✅ Đã tải file mẫu');
}

// ============================================================
// 14. IMPORT EXCEL
// ============================================================

function openImportModal() {
  document.getElementById('fileImport').value  = '';
  document.getElementById('importPreview').innerHTML = '';
  document.getElementById('btnDoImport').disabled = true;
  importRows = [];
  showModal('modalImport');
}

function onFileImport(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = evt => {
    const wb   = XLSX.read(new Uint8Array(evt.target.result), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    parseImport(rows.slice(1).filter(r => r.some(c => c)));
  };
  reader.readAsArrayBuffer(file);
}

function parseImport(rawRows) {
  importRows = [];
  let html = '';
  let okCount = 0, errCount = 0;

  rawRows.forEach((r, i) => {
    const stCode  = String(r[0] || '').trim();
    const dateRaw = String(r[1] || '').trim();
    // ── FIX #3: Áp dụng normalizeTime cho giờ ──
    const tuGio   = normalizeTime(r[2]);
    const denGio  = normalizeTime(r[3]);
    const spCodes = String(r[4] || '').split(';').map(x=>x.trim()).filter(Boolean);
    const nvCodes = String(r[5] || '').split(';').map(x=>x.trim()).filter(Boolean);

    const errs = [];

    // Validate ST
    const stObj = masterData.sieuthi.find(s => s.code === stCode);
    if (!stObj) errs.push(`Không tìm thấy mã ST "${stCode}"`);
    if (stObj && currentUser.role === 'qltp' && stObj.qltpCode !== currentUser.code)
      errs.push('ST ngoài phạm vi QLTP');

    // Parse date
    let ngay = '';
    if (dateRaw.includes('/')) {
      const parts = dateRaw.split('/');
      ngay = parts[0].length === 4
        ? `${parts[0]}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`
        : `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
    } else { ngay = dateRaw; }
    if (!ngay || ngay.length < 8) errs.push('Sai định dạng ngày');

    // Validate time
    const timeRgx = /^\d{2}:\d{2}$/;
    if (!timeRgx.test(tuGio) || !timeRgx.test(denGio)) errs.push('Giờ phải định dạng HH:MM');
    else if (tuGio < '05:00' || denGio > '22:00') errs.push('Giờ ngoài 05:00–22:00');
    else if (tuGio >= denGio) errs.push('Từ giờ ≥ Đến giờ');

    // Resolve SP
    const sanphamList = [];
    spCodes.forEach(code => {
      const sp = masterData.sanpham.find(x => x.code === code);
      if (sp) sanphamList.push({ code: sp.code, name: sp.name });
      else errs.push(`Không tìm thấy mã SP "${code}"`);
    });
    if (!sanphamList.length && !errs.some(e=>e.includes('SP'))) errs.push('Thiếu mã SP');

    // Resolve NV
    const nhanvienList = [];
    nvCodes.forEach(code => {
      const nv = masterData.nhanvien.find(x => x.code === code);
      if (nv) nhanvienList.push({ code: nv.code, name: nv.name });
      else errs.push(`Không tìm thấy mã NV "${code}"`);
    });
    if (!nhanvienList.length && !errs.some(e=>e.includes('NV'))) errs.push('Thiếu mã NV');

    const hasErr = errs.length > 0;
    hasErr ? errCount++ : okCount++;

    if (!hasErr) {
      importRows.push({ stCode, stName: stObj.name, ngay, tuGio, denGio, sanphamList, nhanvienList });
    }

    html += `<div class="preview-row ${hasErr ? 'err' : 'ok'}">
      <span style="width:28px;color:var(--gray-400);">#${i+2}</span>
      <span>${hasErr ? '❌' : '✅'} ${stCode} | ${dateRaw} | ${tuGio}–${denGio}</span>
      ${errs.length ? `<span style="margin-left:auto;color:var(--red);font-size:11px;">${errs.join(', ')}</span>` : ''}
    </div>`;
  });

  document.getElementById('importPreview').innerHTML =
    `<div style="padding:8px 12px;font-weight:700;border-bottom:1px solid var(--border);font-size:12.5px;">
      Hợp lệ: <span style="color:var(--green);">${okCount}</span> &nbsp;|&nbsp; Lỗi: <span style="color:var(--red);">${errCount}</span>
    </div>${html}`;
  document.getElementById('btnDoImport').disabled = okCount === 0;
}

// ── FIX #4: doImport — dùng setValues thay appendRow (Batch Update) ──────
async function doImport() {
  if (!importRows.length) return;
  showLoading(`Đang import ${importRows.length} dòng...`);
  try {
    const newDecls = importRows.map(r => ({
      id:            genId(),
      authorCode:    currentUser.code,
      authorName:    currentUser.name,
      sieuthiCode:   r.stCode,
      sieuthiName:   r.stName,
      ngay:          r.ngay,
      tuGio:         r.tuGio,
      denGio:        r.denGio,
      sanphamList:   JSON.stringify(r.sanphamList),
      nhanvienList:  JSON.stringify(r.nhanvienList),
      rowStatus:     'active',
      createdAt:     nowISO(),
      updatedAt:     nowISO()
    }));

    const r = await gasPost({ action: 'batchCreateDeclarations', rows: newDecls });
    if (!r.ok) { hideLoading(); return toast('error', r.msg || 'Lỗi import!'); }

    const done = r.data?.count || newDecls.length;

    // Cập nhật local state — map đúng sanphamList/nhanvienList object
    newDecls.forEach((d, idx) => {
      declarations.unshift({
        ...d,
        sanphamList:  importRows[idx].sanphamList,
        nhanvienList: importRows[idx].nhanvienList
      });
    });

    await logActivity('IMPORT', null, `${done} dòng`);
    closeModal('modalImport');
    applyFilter();
    toast('success', `✅ Import thành công ${done} khai báo!`);
  } catch (err) {
    toast('error', 'Lỗi import: ' + err.message);
  } finally {
    hideLoading();
  }
}

// ============================================================
// 15. MASTER DATA
// ============================================================

function openMasterModal() {
  updateMasterChips();
  loadCfgToForm();
  switchTab('import');
  showModal('modalMaster');
}

function updateMasterChips() {
  const ql = masterData.qltpList  || [];
  const st = masterData.sieuthi   || [];
  const sp = masterData.sanpham   || [];
  const nv = masterData.nhanvien  || [];
  setSafe('chipQLTP',  `QLTP: ${ql.length}`);
  setSafe('chipST',    `Siêu thị: ${st.length}`);
  setSafe('chipFMCG',  `FMCG: ${sp.filter(x=>x.type==='fmcg').length}`);
  setSafe('chipFresh', `Fresh: ${sp.filter(x=>x.type==='fresh').length}`);
  setSafe('chipNV',    `NV: ${nv.length}`);
  setSafe('cntQLTP',  ql.length);
  setSafe('cntST',    st.length);
  setSafe('cntSP',    sp.length);
  setSafe('cntNV',    nv.length);
}
function setSafe(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }

function switchTab(name) {
  const tabs = ['import','sheets','users','sieuthi','sanpham','nhanvien','pass'];
  tabs.forEach(t => {
    const c = document.getElementById(`tab${t.charAt(0).toUpperCase()+t.slice(1)}`);
    if (c) c.classList.remove('active');
  });
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const target = document.getElementById(`tab${name.charAt(0).toUpperCase()+name.slice(1)}`);
  if (target) target.classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.getAttribute('onclick')?.includes(`'${name}'`)) b.classList.add('active');
  });
  if (!['import','sheets','pass'].includes(name)) renderMasterList(name);
}

function renderMasterList(type) {
  const map = { users:'listUsers', sieuthi:'listSieuthi', sanpham:'listSanpham', nhanvien:'listNhanvien' };
  const searchMap = { users:'searchUsers', sieuthi:'searchST', sanpham:'searchSP', nhanvien:'searchNV' };
  const el = document.getElementById(map[type]);
  if (!el) return;
  const q = (document.getElementById(searchMap[type])?.value || '').trim().toUpperCase();

  let items = type === 'users' ? masterData.qltpList : masterData[type === 'sieuthi' ? 'sieuthi' : type === 'sanpham' ? 'sanpham' : 'nhanvien'];
  // Filter by code only
  const filtered = q ? items.filter(x => String(x.code).toUpperCase().includes(q)) : items;
  const shown = filtered.slice(0, 150);

  const rows = shown.map(x => `<tr>
    <td style="padding:6px;font-weight:700;color:var(--green);">${x.code}</td>
    <td style="padding:6px;">${x.name}</td>
    <td style="padding:6px;font-size:11px;color:var(--gray-600);">
      ${type==='sieuthi' ? (x.qltpCode||'--') : type==='nhanvien' ? (x.sieuthiCode||'--') : (x.type||'')}
    </td>
    <td style="padding:6px;">
      <button class="btn btn-sm btn-red" onclick="deleteMasterItem('${type}','${x.code}')">Xóa</button>
    </td>
  </tr>`).join('');

  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px;">
    <thead><tr style="background:var(--gray-100);">
      <th style="padding:6px;text-align:left;">Mã</th>
      <th style="padding:6px;text-align:left;">Tên</th>
      <th style="padding:6px;text-align:left;">${type==='sieuthi'?'QLTP':type==='nhanvien'?'Mã ST':'Loại'}</th>
      <th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${filtered.length > 150 ? `<p style="font-size:11px;color:var(--orange);padding:6px;">... và ${filtered.length-150} kết quả khác</p>` : ''}`;
}

function deleteMasterItem(type, code) {
  if (!confirm('Xóa mục này khỏi master data local?')) return;
  const key = type === 'users' ? 'qltpList' : type;
  masterData[key] = (masterData[key] || []).filter(x => x.code !== code);
  updateMasterChips();
  renderMasterList(type);
}

function addUser() {
  const code = document.getElementById('newUserCode').value.trim();
  const name = document.getElementById('newUserName').value.trim();
  if (!code || !name) return toast('error', 'Nhập đủ Mã và Tên!');
  if (masterData.qltpList.find(x => x.code === code)) return toast('error', 'Mã đã tồn tại!');
  masterData.qltpList.push({ code, name });
  updateMasterChips();
  renderMasterList('users');
  document.getElementById('newUserCode').value = '';
  document.getElementById('newUserName').value = '';
  toast('success', 'Đã thêm QLTP');
}

// ============================================================
// 16. IMPORT MASTER DATA TỪ FILE
// ============================================================

function importMaster(type, input) {
  const file = input.files[0]; if (!file) return;
  const statusEl = document.getElementById({phanbo:'stPhanBoStatus',fmcg:'stFMCGStatus',fresh:'stFreshStatus',nhanvien:'stNVStatus'}[type]);
  if (statusEl) statusEl.textContent = '⏳ Đang đọc...';
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb   = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      if (type === 'phanbo')    parseMasterPhanBo(rows);
      else if (type === 'fmcg')    parseMasterSP(rows, 'fmcg');
      else if (type === 'fresh')   parseMasterSP(rows, 'fresh');
      else if (type === 'nhanvien')parseMasterNV(rows);
      updateMasterChips();
      if (statusEl) statusEl.textContent = '✅ OK!';
      input.value = '';
    } catch (err) {
      if (statusEl) statusEl.textContent = '❌ ' + err.message;
      toast('error', 'Lỗi đọc file: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function parseMasterPhanBo(rows) {
  let hIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].some(c => String(c).toUpperCase().includes('MST'))) { hIdx = i; break; }
  }
  const headers = rows[hIdx].map(h => String(h).trim());
  const iMST  = headers.findIndex(h => h.toUpperCase() === 'MST' || h.includes('MST'));
  const iTen  = headers.findIndex(h => h.includes('Tên ST') || h.includes('TEN ST'));
  const iQLTP = headers.findIndex(h => h.includes('rút gọn') || (h.includes('QLTP') && h.includes('4')));

  const sieuthi = []; const qltpMap = {};
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const mst = String(r[iMST]||'').trim();
    const ten = String(r[iTen]||'').trim();
    const raw = String(r[iQLTP]||'').trim();
    if (!mst || !ten) continue;
    let qCode = '', qName = '';
    const di = raw.indexOf(' - ');
    if (di > 0) { qCode = raw.slice(0, di).trim(); qName = raw.slice(di+3).trim(); }
    else qCode = raw;
    sieuthi.push({ code: mst, id: mst, name: ten, qltpCode: qCode, qltpName: qName });
    if (qCode && !qltpMap[qCode]) qltpMap[qCode] = { code: qCode, name: qName };
  }
  masterData.sieuthi  = sieuthi;
  masterData.qltpList = Object.values(qltpMap);
  toast('success', `✅ Import ${sieuthi.length} ST, ${Object.keys(qltpMap).length} QLTP`);
}

function parseMasterSP(rows, type) {
  let hIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].some(c => /mã|ma/i.test(String(c)))) { hIdx = i; break; }
  }
  const headers = rows[hIdx].map(h => String(h).trim().toLowerCase());
  const iMa  = headers.findIndex(h => /mã|ma/.test(h));
  const iTen = headers.findIndex(h => /tên|ten/.test(h) && !/tắt/.test(h));
  const existing = masterData.sanpham.filter(s => s.type !== type);
  const seen = new Set(existing.map(s => s.code));
  const added = [];
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const ma  = String(r[iMa] ||'').trim();
    const ten = String(r[iTen]||'').trim();
    if (!ma || !ten || seen.has(ma)) continue;
    seen.add(ma); added.push({ code: ma, id: ma, name: ten, type });
  }
  masterData.sanpham = [...existing, ...added];
  toast('success', `✅ Import ${added.length} SP ${type.toUpperCase()}`);
}

function parseMasterNV(rows) {
  let hIdx = 3;
  for (let i = 0; i < Math.min(6, rows.length); i++) {
    if (rows[i].some(c => /mã nhân viên/i.test(String(c)))) { hIdx = i; break; }
  }
  const headers = rows[hIdx].map(h => String(h).trim().toLowerCase());
  const iMa = headers.findIndex(h => /mã nhân viên/.test(h));
  const iTen= headers.findIndex(h => /tên nhân viên/.test(h));
  const iST = headers.findIndex(h => /mã siêu thị/.test(h));
  const seen = new Set(); const items = [];
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const ma  = String(r[iMa]||'').trim();
    const ten = String(r[iTen]||'').trim();
    const st  = iST>=0 ? String(r[iST]||'').trim() : '';
    if (!ma||!ten||seen.has(ma)) continue;
    seen.add(ma); items.push({ code: ma, id: ma, name: ten, sieuthiCode: st });
  }
  masterData.nhanvien = items;
  toast('success', `✅ Import ${items.length} nhân viên`);
}

// ============================================================
// 17. PUSH MASTER DATA LÊN SHEETS
// ============================================================

async function pushMasterToSheets() {
  if (!WEB_APP_URL) return toast('error', 'Chưa cấu hình Web App URL!');
  showLoading('Đang đẩy Master Data lên Sheets...');
  try {
    const r = await gasPost({
      action: 'syncMasterData',
      qltpList:  masterData.qltpList,
      sieuthi:   masterData.sieuthi,
      sanpham:   masterData.sanpham,
      nhanvien:  masterData.nhanvien
    });
    if (!r.ok) { hideLoading(); return toast('error', r.msg || 'Lỗi đẩy dữ liệu!'); }
    toast('success', '✅ Đã đẩy Master Data lên Google Sheets!');
  } catch (err) {
    toast('error', 'Lỗi: ' + err.message);
  } finally { hideLoading(); }
}

// ============================================================
// 18. GOOGLE SHEETS CONFIG
// ============================================================

function loadCfgToForm() {
  document.getElementById('cfgWebUrl').value = WEB_APP_URL;
}

function saveWebUrl() {
  const url = document.getElementById('cfgWebUrl').value.trim();
  if (!url) return toast('error', 'Nhập URL!');
  WEB_APP_URL = url;
  localStorage.setItem('bhx_webAppUrl', url);
  toast('success', '✅ Đã lưu URL!');
}

async function testConnection() {
  saveWebUrl();
  const el = document.getElementById('connTestResult');
  el.innerHTML = '⏳ Đang kiểm tra...';
  try {
    const r = await gasGet({ action: 'ping' });
    el.innerHTML = r.ok
      ? `<span style="color:var(--green);">✅ Kết nối thành công! Server: ${r.msg||'OK'}</span>`
      : `<span style="color:var(--red);">❌ ${r.msg}</span>`;
  } catch (err) {
    el.innerHTML = `<span style="color:var(--red);">❌ Lỗi: ${err.message}</span>`;
  }
}

// ============================================================
// 19. ĐỔI MẬT KHẨU ADMIN
// ============================================================

function changePass() {
  const old = document.getElementById('cpOld').value;
  const nw  = document.getElementById('cpNew').value;
  if (old !== getAdminPass()) return toast('error', 'Sai mật khẩu cũ!');
  if (!nw || nw.length < 4)   return toast('error', 'Mật khẩu mới tối thiểu 4 ký tự!');
  setAdminPass(nw);
  document.getElementById('cpOld').value = '';
  document.getElementById('cpNew').value = '';
  toast('success', '✅ Đổi mật khẩu thành công!');
}

// ============================================================
// 20. COPY APPS SCRIPT CODE
// ============================================================

function copyGASCode() {
  const code = `// ============================================================
// BHX BIỆT KÍCH — Google Apps Script
// Deploy: Extensions → Apps Script → Deploy → New Deployment
//   Execute as: Me | Who has access: Anyone
// ============================================================

const SS = SpreadsheetApp.getActiveSpreadsheet();

// Tên các sheet tab
const SHEET = {
  QLTP:         'qltp_list',
  SIEUTHI:      'sieuthi',
  SANPHAM:      'sanpham',
  NHANVIEN:     'nhanvien',
  DECLARATIONS: 'declarations',
  ACTIVITY_LOG: 'activity_log'
};

// Headers cho từng sheet
const HEADERS = {
  [SHEET.QLTP]:         ['code','name'],
  [SHEET.SIEUTHI]:      ['code','name','qltpCode','qltpName'],
  [SHEET.SANPHAM]:      ['code','name','type'],
  [SHEET.NHANVIEN]:     ['code','name','sieuthiCode'],
  [SHEET.DECLARATIONS]: ['id','authorCode','authorName','sieuthiCode','sieuthiName',
                         'ngay','tuGio','denGio','sanphamList','nhanvienList',
                         'rowStatus','createdAt','updatedAt','deletedBy','deletedAt'],
  [SHEET.ACTIVITY_LOG]: ['time','userCode','userName','action','declId','detail']
};

// ── Helpers ──
function getSheet(name) {
  let sh = SS.getSheetByName(name);
  if (!sh) {
    sh = SS.insertSheet(name);
    sh.appendRow(HEADERS[name]);
  }
  return sh;
}

function sheetToObjects(sheetName) {
  const sh = getSheet(sheetName);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0].map(h => String(h).trim());
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? String(row[i]).trim() : ''; });
    return obj;
  }).filter(obj => obj[headers[0]]); // bỏ dòng trống
}

function ok(data, msg) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data, msg: msg||'OK' }))
    .setMimeType(ContentService.MimeType.JSON);
}
function err(msg) {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, msg }))
    .setMimeType(ContentService.MimeType.JSON);
}
function safeJson(str, fb) {
  try { return JSON.parse(str) || fb; } catch { return fb; }
}

// ── GET ──
function doGet(e) {
  const action = e.parameter.action;
  try {
    if (action === 'ping') return ok(null, 'BHX Biệt Kích API — OK');

    if (action === 'getQltpList') {
      return ok(sheetToObjects(SHEET.QLTP));
    }

    if (action === 'loginQLTP') {
      const code = e.parameter.code;
      const list = sheetToObjects(SHEET.QLTP);
      const found = list.find(x => x.code === code);
      if (!found) return err('Mã QLTP không tồn tại!');
      return ok(found);
    }

    if (action === 'getAllData') {
      const role = e.parameter.role;
      const code = e.parameter.code;

      const qltpList   = sheetToObjects(SHEET.QLTP);
      const sieuthi    = sheetToObjects(SHEET.SIEUTHI);
      const sanpham    = sheetToObjects(SHEET.SANPHAM);
      const nhanvien   = sheetToObjects(SHEET.NHANVIEN);
      let   declRaw    = sheetToObjects(SHEET.DECLARATIONS);
      const actLog     = sheetToObjects(SHEET.ACTIVITY_LOG).reverse().slice(0, 500);

      // Parse JSON fields trong declarations
      const declarations = declRaw.map(d => ({
        ...d,
        sanphamList:  safeJson(d.sanphamList,  []),
        nhanvienList: safeJson(d.nhanvienList, [])
      }));

      // Admin thấy tất cả; QLTP chỉ thấy của mình
      const filteredDecl = role === 'admin'
        ? declarations
        : declarations.filter(d => d.authorCode === code);

      return ok({ qltpList, sieuthi, sanpham, nhanvien, declarations: filteredDecl, activityLog: actLog });
    }

    return err('Unknown GET action: ' + action);
  } catch(e) {
    return err('Server error: ' + e.toString());
  }
}

// ── POST ──
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action  = payload.action;

    if (action === 'createDeclaration')  return createDeclaration(payload.row);
    if (action === 'updateDeclaration')  return updateDeclaration(payload.row);
    if (action === 'softDeleteDeclaration') return softDelete(payload.id, payload.deletedBy, payload.deletedAt);
    if (action === 'batchCreateDeclarations') return batchCreate(payload.rows);
    if (action === 'appendLog')          return appendLog(payload.row);
    if (action === 'syncMasterData')     return syncMaster(payload);

    return err('Unknown POST action: ' + action);
  } catch(e) {
    return err('Server error: ' + e.toString());
  }
}

function createDeclaration(row) {
  const sh = getSheet(SHEET.DECLARATIONS);
  if (sh.getLastRow() <= 1) {
    // Đảm bảo header đúng
  }
  sh.appendRow(HEADERS[SHEET.DECLARATIONS].map(h => row[h] || ''));
  return ok(null, 'created');
}

function updateDeclaration(row) {
  const sh   = getSheet(SHEET.DECLARATIONS);
  const data = sh.getDataRange().getValues();
  const headers = data[0].map(String);
  const idCol   = headers.indexOf('id');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(row.id)) {
      HEADERS[SHEET.DECLARATIONS].forEach((h, j) => {
        if (row[h] !== undefined) sh.getRange(i+1, j+1).setValue(row[h]);
      });
      return ok(null, 'updated');
    }
  }
  return err('ID not found: ' + row.id);
}

function softDelete(id, deletedBy, deletedAt) {
  const sh   = getSheet(SHEET.DECLARATIONS);
  const data = sh.getDataRange().getValues();
  const headers  = data[0].map(String);
  const idCol    = headers.indexOf('id');
  const stCol    = headers.indexOf('rowStatus');
  const delByCol = headers.indexOf('deletedBy');
  const delAtCol = headers.indexOf('deletedAt');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(id)) {
      if (stCol    >= 0) sh.getRange(i+1, stCol+1).setValue('deleted');
      if (delByCol >= 0) sh.getRange(i+1, delByCol+1).setValue(deletedBy||'');
      if (delAtCol >= 0) sh.getRange(i+1, delAtCol+1).setValue(deletedAt||'');
      return ok(null, 'soft-deleted');
    }
  }
  return err('ID not found: ' + id);
}

function batchCreate(rows) {
  const sh = getSheet(SHEET.DECLARATIONS);
  rows.forEach(row => {
    sh.appendRow(HEADERS[SHEET.DECLARATIONS].map(h => row[h] || ''));
  });
  return ok({ count: rows.length }, 'batch created');
}

function appendLog(row) {
  const sh = getSheet(SHEET.ACTIVITY_LOG);
  sh.appendRow(HEADERS[SHEET.ACTIVITY_LOG].map(h => row[h] || ''));
  return ok(null, 'logged');
}

function syncMaster(payload) {
  // Ghi đè toàn bộ từng sheet master
  _overwriteSheet(SHEET.QLTP,    payload.qltpList  || [], HEADERS[SHEET.QLTP]);
  _overwriteSheet(SHEET.SIEUTHI, payload.sieuthi   || [], HEADERS[SHEET.SIEUTHI]);
  _overwriteSheet(SHEET.SANPHAM, payload.sanpham   || [], HEADERS[SHEET.SANPHAM]);
  _overwriteSheet(SHEET.NHANVIEN,payload.nhanvien  || [], HEADERS[SHEET.NHANVIEN]);
  return ok(null, 'master synced');
}

function _overwriteSheet(sheetName, items, headers) {
  const sh = getSheet(sheetName);
  // Xóa tất cả dữ liệu cũ (trừ header)
  const lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow-1, headers.length).clearContent();
  // Ghi dữ liệu mới
  if (items.length) {
    const rows = items.map(item => headers.map(h => item[h] || ''));
    sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}
`;

  navigator.clipboard.writeText(code)
    .then(() => toast('success', '✅ Đã copy Apps Script Code! Vào Extensions → Apps Script → Dán vào → Deploy'))
    .catch(() => toast('error', 'Trình duyệt không cho phép copy. Hãy copy thủ công.'));
}

// ============================================================
// 21. ONLINE / OFFLINE DETECTION
// ============================================================

window.addEventListener('online',  () => document.getElementById('offlineBanner').classList.remove('show'));
window.addEventListener('offline', () => document.getElementById('offlineBanner').classList.add('show'));
if (!navigator.onLine) document.getElementById('offlineBanner').classList.add('show');
