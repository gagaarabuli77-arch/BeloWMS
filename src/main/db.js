'use strict';
// Local SQLite database and every business rule of Belo WMS.
// The renderer never writes data itself: it calls exec(name, args) through IPC, and each command runs in one transaction.
const { DatabaseSync } = require('node:sqlite');

class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };

let db = null;
let clock = () => new Date();
const pad = (n, w = 2) => String(n).padStart(w, '0');
function today() { const d = clock(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function nowTs() { const d = clock(); return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

/* ---------- schema ---------- */
// Each entry is one migration; never edit an entry that has shipped, append a new one instead.
const MIGRATIONS = [`
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE warehouses(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE uoms(name TEXT PRIMARY KEY, sort INTEGER NOT NULL DEFAULT 99);
CREATE TABLE suppliers(id TEXT PRIMARY KEY, name TEXT NOT NULL, tin TEXT, phone TEXT, contact TEXT);
CREATE TABLE products(id TEXT PRIMARY KEY, art TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, uom TEXT NOT NULL,
  min_qty REAL NOT NULL DEFAULT 0, avg_cost REAL NOT NULL DEFAULT 0, created_at TEXT);
CREATE TABLE stock(product_id TEXT NOT NULL REFERENCES products(id), wh_id INTEGER NOT NULL REFERENCES warehouses(id),
  qty REAL NOT NULL DEFAULT 0 CHECK(qty >= 0), loc TEXT NOT NULL DEFAULT '', PRIMARY KEY(product_id, wh_id));
CREATE TABLE vehicles(id TEXT PRIMARY KEY, plate TEXT NOT NULL, vin TEXT NOT NULL UNIQUE, make TEXT NOT NULL, model TEXT NOT NULL,
  year INTEGER, km INTEGER NOT NULL DEFAULT 0, dept TEXT);
CREATE TABLE purchase_orders(id TEXT PRIMARY KEY, date TEXT NOT NULL, supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  wh_id INTEGER NOT NULL REFERENCES warehouses(id), note TEXT, created_at TEXT);
CREATE TABLE po_lines(id INTEGER PRIMARY KEY, po_id TEXT NOT NULL REFERENCES purchase_orders(id), product_id TEXT NOT NULL REFERENCES products(id),
  qty REAL NOT NULL CHECK(qty > 0), price REAL NOT NULL CHECK(price >= 0));
CREATE TABLE service_orders(id TEXT PRIMARY KEY, date TEXT NOT NULL, vehicle_id TEXT NOT NULL REFERENCES vehicles(id), resp TEXT NOT NULL,
  km INTEGER, status TEXT NOT NULL CHECK(status IN ('open','closed','auto')), closed_at TEXT, last_change TEXT NOT NULL);
CREATE TABLE so_parts(id INTEGER PRIMARY KEY, so_id TEXT NOT NULL REFERENCES service_orders(id), product_id TEXT NOT NULL REFERENCES products(id),
  wh_id INTEGER NOT NULL, qty REAL NOT NULL CHECK(qty > 0), ret REAL NOT NULL DEFAULT 0, price REAL NOT NULL, CHECK(ret >= 0 AND ret <= qty));
CREATE TABLE so_services(id INTEGER PRIMARY KEY, so_id TEXT NOT NULL REFERENCES service_orders(id), name TEXT NOT NULL, price REAL);
CREATE TABLE catalog(model TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES products(id), PRIMARY KEY(model, product_id));
CREATE TABLE moves(id INTEGER PRIMARY KEY, ts TEXT NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL, ref TEXT NOT NULL,
  product_id TEXT NOT NULL, qty REAL NOT NULL, wh_id INTEGER NOT NULL, to_wh INTEGER, note TEXT);
CREATE TABLE transfers(id TEXT PRIMARY KEY, date TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES products(id),
  from_wh INTEGER NOT NULL, to_wh INTEGER NOT NULL, qty REAL NOT NULL CHECK(qty > 0));
CREATE INDEX ix_moves_product ON moves(product_id);
CREATE INDEX ix_so_vehicle ON service_orders(vehicle_id);
CREATE INDEX ix_parts_so ON so_parts(so_id);
CREATE INDEX ix_lines_po ON po_lines(po_id);
INSERT INTO warehouses VALUES (1,'მთავარი საწყობი'),(2,'საწყობი №2');
INSERT INTO uoms VALUES ('ცალი',1),('ლიტრი',2),('კომპლექტი',3),('მეტრი',4),('კგ',5);
INSERT INTO settings VALUES ('autoClose','7'),('wh2','0'),('backupSchedule','close'),('backupDir',''),('lastBackup',''),
  ('company','{}'),('racks','{}'),('setupDone','0');
`, `
CREATE TABLE locations(wh_id INTEGER NOT NULL REFERENCES warehouses(id), code TEXT NOT NULL COLLATE NOCASE,
  note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(wh_id, code));
INSERT OR IGNORE INTO locations(wh_id, code) SELECT DISTINCT wh_id, loc FROM stock WHERE loc <> '';
ALTER TABLE so_parts ADD COLUMN serials TEXT NOT NULL DEFAULT '[]';
ALTER TABLE so_parts ADD COLUMN ret_serials TEXT NOT NULL DEFAULT '[]';
`, `
-- Service orders can be canceled. SQLite cannot change a CHECK rule in place, so the table is rebuilt
-- with the same rows; parts and services keep pointing at it by name.
CREATE TABLE service_orders_new(id TEXT PRIMARY KEY, date TEXT NOT NULL, vehicle_id TEXT NOT NULL REFERENCES vehicles(id), resp TEXT NOT NULL,
  km INTEGER, status TEXT NOT NULL CHECK(status IN ('open','closed','auto','canceled')), closed_at TEXT, last_change TEXT NOT NULL, canceled_at TEXT);
INSERT INTO service_orders_new(id,date,vehicle_id,resp,km,status,closed_at,last_change)
  SELECT id,date,vehicle_id,resp,km,status,closed_at,last_change FROM service_orders;
DROP TABLE service_orders;
ALTER TABLE service_orders_new RENAME TO service_orders;
CREATE INDEX ix_so_vehicle ON service_orders(vehicle_id);
`];

/* ---------- low-level helpers ---------- */
const run = (sql, ...a) => db.prepare(sql).run(...a);
const get = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const groupBy = (rows, key) => { const m = new Map(); rows.forEach(r => { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); }); return m; };

function open(file) {
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
  db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)');
  const v = +(get("SELECT value FROM meta WHERE key='schema'")?.value || 0);
  if (v > MIGRATIONS.length) fail('ბაზა შექმნილია პროგრამის უფრო ახალი ვერსიით — განაახლეთ Belo WMS');
  // Foreign keys are switched off while upgrading so a table can be rebuilt; each step is checked before it is saved.
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    MIGRATIONS.slice(v).forEach((sql, i) => tx(() => {
      db.exec(sql);
      if (all('PRAGMA foreign_key_check').length) fail('ბაზის განახლება ვერ მოხერხდა (კავშირების შემოწმება)');
      run("INSERT OR REPLACE INTO meta VALUES('schema',?)", String(v + i + 1));
    }));
  } finally { db.exec('PRAGMA foreign_keys=ON'); }
  return db;
}
function close() { if (db) { db.close(); db = null; } soCache = null; pendingSO.clear(); }
const handle = () => db;

function setting(k) { return get('SELECT value FROM settings WHERE key=?', k)?.value ?? null; }
function setSetting(k, v) { run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v)); }

// Next document number such as SO-2026-0001; ordering by length keeps 10000 after 9999.
function nextNo(table, prefix, width = 4) {
  const r = get(`SELECT id FROM ${table} WHERE id LIKE ? ORDER BY length(id) DESC, id DESC LIMIT 1`, prefix + '%');
  return prefix + pad(r ? +r.id.slice(prefix.length) + 1 : 1, width);
}

/* ---------- validation helpers ---------- */
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const num = v => (typeof v === 'number' ? v : String(v ?? '').trim() === '' ? NaN : +String(v).trim().replace(',', '.'));
const r4 = n => Math.round(n * 1e4) / 1e4;
// Location codes are free text from the managed list (locations table), compared case-insensitively.
const locCode = v => str(v, 30).replace(/\s+/g, ' ');
const findLoc = (wh, code) => get('SELECT * FROM locations WHERE wh_id=? AND code=?', wh, code);
// Returns the stored spelling of an active location, '' for none; `current` is allowed even if deactivated since.
function locCheck(wh, v, current = '') {
  const c = locCode(v);
  if (!c) return '';
  const l = findLoc(wh, c);
  if (!l) fail(`ლოკაცია „${c}“ არ არის სიაში — დაამატეთ „საწყობი და ლოკაციები“ გვერდზე`);
  if (!l.active && l.code.toLowerCase() !== String(current).toLowerCase()) fail(`ლოკაცია „${l.code}“ გამორთულია`);
  return l.code;
}
// CSV import may name locations that are not in the list yet; they are added.
function ensureLoc(wh, v) {
  const c = locCode(v);
  if (!c) return '';
  if (!findLoc(wh, c)) run('INSERT INTO locations(wh_id,code) VALUES(?,?)', wh, c);
  return findLoc(wh, c).code;
}
const setLoc = (pid, wh, code) => { ensureStock(pid, wh); run('UPDATE stock SET loc=? WHERE product_id=? AND wh_id=?', code, pid, wh); };

// Serial numbers: typed separated by commas, semicolons or new lines.
function serialList(v) {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(/[\n,;]+/);
  const out = [];
  raw.map(s => str(s, 60)).filter(Boolean).forEach(s => { if (!out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s); });
  return out;
}
const lineSerials = l => ({ all: JSON.parse(l.serials || '[]'), back: JSON.parse(l.ret_serials || '[]') });
const isBack = (back, s) => back.some(x => x.toLowerCase() === s.toLowerCase());
// Serials on a line that are still on the vehicle (issued and not returned).
const outLineSerials = l => { const { all: sn, back } = lineSerials(l); return sn.filter(s => !isBack(back, s)); };
// A serial may be on only one vehicle at a time: issued and not returned.
function serialFree(pid, serials, exceptLine = 0) {
  if (!serials.length) return;
  for (const l of all("SELECT p.*, o.id AS so FROM so_parts p JOIN service_orders o ON o.id=p.so_id WHERE p.product_id=? AND p.serials<>'[]' AND p.id<>? AND o.status<>'canceled'", pid, exceptLine)) {
    const { all: sn, back } = lineSerials(l);
    const clash = serials.find(s => sn.some(x => x.toLowerCase() === s.toLowerCase()) && !isBack(back, s));
    if (clash) fail(`სერიული № ${clash} უკვე გაცემულია (${l.so}) და არ დაბრუნებულა`);
  }
}
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
function whOk(w) {
  w = +w;
  if (w !== 1 && w !== 2) fail('უცნობი საწყობი');
  if (w === 2 && setting('wh2') !== '1') fail('მეორე საწყობი გამორთულია');
  return w;
}
function product(id) { return get('SELECT * FROM products WHERE id=?', id) || fail('პროდუქტი ვერ მოიძებნა'); }
function openSO(id) {
  const o = get('SELECT * FROM service_orders WHERE id=?', id) || fail('ორდერი ვერ მოიძებნა');
  if (o.status === 'canceled') fail('ორდერი გაუქმებულია — ცვლილებისთვის ჯერ აღადგინეთ');
  if (o.status !== 'open') fail('ორდერი დახურულია — ცვლილებისთვის ჯერ გახსენით ხელახლა');
  return o;
}
const touch = id => run('UPDATE service_orders SET last_change=? WHERE id=?', today(), id);
const ensureStock = (pid, wh) => run('INSERT OR IGNORE INTO stock(product_id,wh_id) VALUES(?,?)', pid, wh);
const stockQty = (pid, wh) => get('SELECT qty FROM stock WHERE product_id=? AND wh_id=?', pid, wh)?.qty || 0;
function addStock(pid, wh, delta) {
  ensureStock(pid, wh);
  const q = r4(stockQty(pid, wh) + delta);
  if (q < 0) { const p = product(pid); fail(`არასაკმარისი ნაშთი: ${p.name} — ხელმისაწვდომია ${r4(q - delta)} ${p.uom}. უარყოფითი ნაშთი დაუშვებელია.`); }
  run('UPDATE stock SET qty=? WHERE product_id=? AND wh_id=?', q, pid, wh);
  return q;
}
function move(type, ref, pid, qty, wh, to = null, note = null) {
  run('INSERT INTO moves(ts,date,type,ref,product_id,qty,wh_id,to_wh,note) VALUES(?,?,?,?,?,?,?,?,?)', nowTs(), today(), type, ref, pid, qty, wh, to, note);
}

/* ---------- auto-close and state ---------- */
// Open service orders close automatically N days after their last change.
function autoClose() {
  const n = +setting('autoClose') || 7;
  const ids = all(`UPDATE service_orders SET status='auto', closed_at=date(last_change, '+' || ? || ' days')
    WHERE status='open' AND julianday(?) - julianday(last_change) >= ? RETURNING id`, n, today(), n).map(r => r.id);
  ids.forEach(id => pendingSO.add(id));
  return ids.length;
}

// Service orders are most of the state, so they are cached and only the ones a command touched are rebuilt.
let soCache = null;            // Map id → service order as the screen sees it
const pendingSO = new Set();   // ids changed since the last getState
function soObject(o, parts, svcs) {
  return {
    id: o.id, date: o.date, vid: o.vehicle_id, resp: o.resp, km: o.km, status: o.status, closedAt: o.closed_at, lastChange: o.last_change, canceledAt: o.canceled_at || null,
    parts: parts.map(l => {
      const sn = l.serials === '[]' ? [] : JSON.parse(l.serials), back = l.ret_serials === '[]' ? [] : JSON.parse(l.ret_serials);
      return { lid: l.id, pid: l.product_id, wh: l.wh_id, qty: l.qty, ret: l.ret, price: l.price, serials: sn, retSerials: back };
    }),
    // A canceled order shows no services; they stay in the database so "undo cancel" can bring them back.
    svcs: o.status === 'canceled' ? [] : svcs.map(x => ({ sid: x.id, name: x.name, price: x.price }))
  };
}
function loadAllSOs() {
  const parts = groupBy(all('SELECT * FROM so_parts ORDER BY id'), 'so_id');
  const svcs = groupBy(all('SELECT * FROM so_services ORDER BY id'), 'so_id');
  soCache = new Map(all('SELECT * FROM service_orders').map(o => [o.id, soObject(o, parts.get(o.id) || [], svcs.get(o.id) || [])]));
}
function refreshSO(id) {
  const o = get('SELECT * FROM service_orders WHERE id=?', id);
  if (!o) { soCache.delete(id); return; }
  soCache.set(id, soObject(o, all('SELECT * FROM so_parts WHERE so_id=? ORDER BY id', id), all('SELECT * FROM so_services WHERE so_id=? ORDER BY id', id)));
}
const soOrder = (a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

// delta: true returns only the changed service orders (sosUpsert) instead of all of them (sos).
function getState({ delta = false } = {}) {
  autoClose();
  const fresh = !soCache;
  if (fresh) { loadAllSOs(); pendingSO.clear(); }
  const changed = [...pendingSO];
  changed.forEach(refreshSO);
  pendingSO.clear();
  const s = Object.fromEntries(all('SELECT key,value FROM settings').map(r => [r.key, r.value]));
  const st = {
    today: today(),
    settings: {
      wh2: s.wh2 === '1', autoClose: +s.autoClose || 7, backupDir: s.backupDir || '', backupSchedule: s.backupSchedule || 'close',
      lastBackup: s.lastBackup || '', setupDone: s.setupDone === '1', catalogRec: s.catalogRec !== '0', company: JSON.parse(s.company || '{}'), racks: JSON.parse(s.racks || '{}')
    },
    wh: Object.fromEntries(all('SELECT id,name FROM warehouses').map(r => [r.id, r.name])),
    uoms: all('SELECT name FROM uoms ORDER BY sort,name').map(r => r.name),
    suppliers: all('SELECT id,name,tin,phone,contact FROM suppliers ORDER BY id').map(r => ({ ...r })),
    vehicles: all('SELECT id,plate,vin,make,model,year,km,dept FROM vehicles ORDER BY id').map(r => ({ ...r }))
  };
  st.products = all('SELECT * FROM products ORDER BY id').map(p => ({
    id: p.id, art: p.art, name: p.name, uom: p.uom, min: p.min_qty, cost: p.avg_cost, stock: { 1: { q: 0, loc: '' }, 2: { q: 0, loc: '' } }
  }));
  const pm = new Map(st.products.map(p => [p.id, p]));
  all('SELECT * FROM stock').forEach(r => { const p = pm.get(r.product_id); if (p) p.stock[r.wh_id] = { q: r.qty, loc: r.loc }; });
  const lines = groupBy(all('SELECT * FROM po_lines ORDER BY id'), 'po_id');
  st.pos = all('SELECT * FROM purchase_orders ORDER BY date DESC, id DESC').map(o => ({
    id: o.id, date: o.date, sup: o.supplier_id, wh: o.wh_id, note: o.note,
    lines: (lines.get(o.id) || []).map(l => ({ pid: l.product_id, qty: l.qty, price: l.price }))
  }));
  if (delta && !fresh) st.sosUpsert = changed.map(id => soCache.get(id)).filter(Boolean);
  else st.sos = [...soCache.values()].sort(soOrder);
  st.locations = all('SELECT wh_id AS wh, code, note, active FROM locations').map(r => ({ ...r, active: !!r.active }));
  st.catalog = all('SELECT model, product_id AS pid FROM catalog').map(r => ({ ...r }));
  st.moves = all('SELECT date,type,ref,product_id AS pid,qty,wh_id AS wh,to_wh AS "to",note FROM moves ORDER BY id DESC LIMIT 500').map(r => ({ ...r }));
  st.transfers = all('SELECT id,date,product_id AS pid,from_wh AS "from",to_wh AS "to",qty FROM transfers ORDER BY rowid DESC LIMIT 50').map(r => ({ ...r }));
  return st;
}

/* ---------- CSV import rules (used for the preview and again when applying) ---------- */
const IMPORT_COLS = {
  products: ['art', 'name', 'uom', 'min', 'cost', 'qty', 'loc'],
  vehicles: ['plate', 'vin', 'make', 'model', 'year', 'km', 'dept'],
  stock: ['art', 'qty', 'cost', 'loc', 'wh']
};
const okNum = (v, min = 0) => str(v) === '' || num(v) >= min;
function importCheck(type, rows) {
  const seen = new Set();
  return rows.map(raw => {
    const c = IMPORT_COLS[type].map((_, i) => str(raw[i]));
    const e = []; let st = 'new';
    if (type === 'products') {
      const [art, name, uom, min, cost, qty, loc] = c;
      if (!art) e.push('არტიკული ცარიელია');
      if (!name) e.push('დასახელება ცარიელია');
      if (uom && !get('SELECT 1 FROM uoms WHERE name=?', uom)) e.push(`უცნობი ერთეული „${uom}“`);
      if (![min, cost, qty].every(v => okNum(v))) e.push('რიცხვი არასწორია');
      if (art && seen.has(art.toUpperCase())) e.push('არტიკული მეორდება ფაილში');
      seen.add(art.toUpperCase());
      if (art && get('SELECT 1 FROM products WHERE art=?', art)) st = 'upd';
    } else if (type === 'vehicles') {
      const [plate, vin, make, model, year, km] = c;
      const V = vin.toUpperCase();
      if (!plate) e.push('ნომერი ცარიელია');
      if (V.length !== 17 || /[IOQ]/.test(V)) e.push('VIN: 17 სიმბოლო, I/O/Q გარეშე');
      if (!make || !model) e.push('მარკა / მოდელი ცარიელია');
      if (![year, km].every(v => okNum(v))) e.push('რიცხვი არასწორია');
      if (V && seen.has(V)) e.push('VIN მეორდება ფაილში');
      seen.add(V);
      if (V && get('SELECT 1 FROM vehicles WHERE vin=?', V)) st = 'upd';
    } else if (type === 'stock') {
      const [art, qty, cost, loc, wh] = c;
      st = 'upd';
      if (!get('SELECT 1 FROM products WHERE art=?', art)) e.push('პროდუქტი ვერ მოიძებნა');
      if (qty === '' || !okNum(qty)) e.push('რაოდენობა არასწორია');
      if (!okNum(cost)) e.push('ღირებულება არასწორია');
      const w = wh === '' ? 1 : +wh;
      if (w !== 1 && w !== 2) e.push('საწყობი: 1 ან 2');
      else if (w === 2 && setting('wh2') !== '1') e.push('მეორე საწყობი გამორთულია');
    } else fail('უცნობი იმპორტის ტიპი');
    // Unknown locations are created on import; say so in the preview.
    const loc = type === 'products' ? c[6] : type === 'stock' ? c[3] : '';
    const lw = type === 'stock' && c[4] === '2' ? 2 : 1;
    const info = !e.length && locCode(loc) && !findLoc(lw, locCode(loc)) ? 'ახალი ლოკაცია: ' + locCode(loc) : '';
    return { c, st: e.length ? 'err' : st, msg: e.length ? e.join('; ') : info };
  });
}

/* ---------- commands ---------- */
const commands = {
  'setup.complete'({ company, whName }) {
    commands['company.save']({ company });
    if (str(whName)) run('UPDATE warehouses SET name=? WHERE id=1', str(whName, 80));
    setSetting('setupDone', '1');
  },
  'company.save'({ company = {} }) {
    const c = { name: str(company.name, 150), tin: str(company.tin, 30), address: str(company.address, 200), phone: str(company.phone, 50), logo: '' };
    if (!c.name) fail('შეიყვანეთ კომპანიის დასახელება');
    const logo = String(company.logo || '');
    if (logo) {
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(logo)) fail('ლოგო უნდა იყოს PNG, JPG ან WEBP');
      if (logo.length > 700000) fail('ლოგო ძალიან დიდია (მაქს. ~500 KB)');
      c.logo = logo;
    }
    setSetting('company', JSON.stringify(c));
  },
  'settings.set'({ key, value }) {
    switch (key) {
      case 'wh2':
        if (!value && get('SELECT 1 FROM stock WHERE wh_id=2 AND qty>0')) fail('მეორე საწყობში ნაშთია — გამორთვამდე გადაიტანეთ მთავარ საწყობში');
        setSetting('wh2', value ? '1' : '0'); break;
      case 'autoClose': {
        const n = Math.round(num(value));
        if (!(n >= 1 && n <= 365)) fail('ვადა უნდა იყოს 1–365 დღე');
        setSetting('autoClose', n); return autoClose();
      }
      case 'catalogRec':
        setSetting('catalogRec', value ? '1' : '0'); break;
      case 'backupSchedule':
        if (!['close', 'manual'].includes(value)) fail('უცნობი განრიგი');
        setSetting(key, value); break;
      case 'wh1Name': case 'wh2Name': {
        const n = str(value, 80);
        if (!n) fail('შეიყვანეთ საწყობის დასახელება');
        run('UPDATE warehouses SET name=? WHERE id=?', n, key === 'wh1Name' ? 1 : 2); break;
      }
      default: fail('უცნობი პარამეტრი');
    }
  },
  'uom.add'({ name }) {
    const n = str(name, 30);
    if (!n) fail('შეიყვანეთ ზომის ერთეული');
    if (get('SELECT 1 FROM uoms WHERE name=?', n)) fail('ასეთი ერთეული უკვე არსებობს');
    run('INSERT INTO uoms VALUES(?,99)', n);
  },
  'supplier.save'({ id, name, tin, phone, contact }) {
    const n = str(name, 150);
    if (!n) fail('შეიყვანეთ მომწოდებლის დასახელება');
    if (id) {
      if (!get('SELECT 1 FROM suppliers WHERE id=?', id)) fail('მომწოდებელი ვერ მოიძებნა');
      run('UPDATE suppliers SET name=?,tin=?,phone=?,contact=? WHERE id=?', n, str(tin, 30), str(phone, 50), str(contact, 100), id);
      return id;
    }
    const nid = nextNo('suppliers', 'S-', 3);
    run('INSERT INTO suppliers VALUES(?,?,?,?,?)', nid, n, str(tin, 30), str(phone, 50), str(contact, 100));
    return nid;
  },
  'product.save'({ id, art, name, uom, min, cost, locs }) {
    const a = str(art, 60), n = str(name), u = str(uom, 30) || 'ცალი', mn = str(min) === '' ? 0 : num(min);
    if (!a || !n) fail('შეავსეთ არტიკული და დასახელება');
    if (!get('SELECT 1 FROM uoms WHERE name=?', u)) fail('უცნობი ზომის ერთეული');
    if (!(mn >= 0)) fail('მინიმალური ნაშთი არასწორია');
    const dup = get('SELECT id FROM products WHERE art=? AND id<>?', a, id || '');
    if (dup) fail(`არტიკული ${a} უკვე არსებობს (${dup.id})`);
    let pid = id;
    if (id) {
      product(id);
      run('UPDATE products SET art=?,name=?,uom=?,min_qty=? WHERE id=?', a, n, u, mn, id);
    } else {
      const c = str(cost) === '' ? 0 : num(cost);
      if (!(c >= 0)) fail('ღირებულება არასწორია');
      pid = nextNo('products', 'P-', 5);
      run('INSERT INTO products(id,art,name,uom,min_qty,avg_cost,created_at) VALUES(?,?,?,?,?,?,?)', pid, a, n, u, mn, c, nowTs());
      ensureStock(pid, 1); ensureStock(pid, 2);
    }
    for (const [w, l] of Object.entries(locs || {})) {
      if (+w !== 1 && +w !== 2) continue;
      ensureStock(pid, +w);
      const cur = get('SELECT loc FROM stock WHERE product_id=? AND wh_id=?', pid, +w).loc;
      setLoc(pid, +w, locCheck(+w, l, cur));
    }
    return pid;
  },
  'vehicle.save'({ id, plate, vin, make, model, year, km, dept }) {
    const pl = str(plate, 20).toUpperCase(), v = str(vin, 30).toUpperCase(), mk = str(make, 60), md = str(model, 60);
    if (!pl || !mk || !md) fail('შეავსეთ სახელმწიფო ნომერი, მარკა და მოდელი');
    if (v.length !== 17 || /[IOQ]/.test(v)) fail('VIN კოდი უნდა იყოს 17 სიმბოლო (I, O, Q გარეშე)');
    const dup = get('SELECT id FROM vehicles WHERE vin=? AND id<>?', v, id || '');
    if (dup) fail('ეს VIN უკვე რეესტრშია (' + dup.id + ')');
    const y = str(year) === '' ? null : Math.round(num(year)), k = str(km) === '' ? 0 : Math.round(num(km));
    if (y !== null && !(y >= 1950 && y <= 2100)) fail('წელი არასწორია');
    if (!(k >= 0)) fail('გარბენი არასწორია');
    if (id) {
      if (!get('SELECT 1 FROM vehicles WHERE id=?', id)) fail('ტექნიკა ვერ მოიძებნა');
      run('UPDATE vehicles SET plate=?,vin=?,make=?,model=?,year=?,km=?,dept=? WHERE id=?', pl, v, mk, md, y, k, str(dept, 80), id);
      return id;
    }
    const nid = nextNo('vehicles', 'V-', 4);
    run('INSERT INTO vehicles VALUES(?,?,?,?,?,?,?,?)', nid, pl, v, mk, md, y, k, str(dept, 80));
    return nid;
  },
  // Saving a purchase order puts the goods in stock immediately and updates the weighted average cost.
  'po.create'({ sup, date, wh, note, lines }) {
    if (!get('SELECT 1 FROM suppliers WHERE id=?', sup)) fail('აირჩიეთ მომწოდებელი');
    const w = whOk(wh || 1), d = isDate(date) ? date : today();
    const ls = (lines || []).filter(l => l && l.pid);
    if (!ls.length) fail('დაამატეთ მინიმუმ ერთი პოზიცია');
    const id = nextNo('purchase_orders', `PO-${d.slice(0, 4)}-`);
    run('INSERT INTO purchase_orders VALUES(?,?,?,?,?,?)', id, d, sup, w, str(note, 500), nowTs());
    for (const l of ls) {
      const p = product(l.pid), q = num(l.qty), pr = num(l.price);
      if (!(q > 0)) fail(`რაოდენობა უნდა იყოს 0-ზე მეტი: ${p.name}`);
      if (!(pr >= 0)) fail(`მიუთითეთ ფასი: ${p.name}`);
      const cur = product(p.id), total = get('SELECT COALESCE(SUM(qty),0) AS t FROM stock WHERE product_id=?', p.id).t;
      run('UPDATE products SET avg_cost=? WHERE id=?', r4((cur.avg_cost * total + q * pr) / (total + q)), p.id);
      run('INSERT INTO po_lines(po_id,product_id,qty,price) VALUES(?,?,?,?)', id, p.id, q, pr);
      addStock(p.id, w, q);
      move('in', id, p.id, q, w);
    }
    return id;
  },
  'so.create'({ vid, resp, km }) {
    const v = get('SELECT * FROM vehicles WHERE id=?', vid) || fail('აირჩიეთ ტექნიკა');
    const r = str(resp, 120);
    if (!r) fail('შეიყვანეთ პასუხისმგებელი პირი');
    const k = str(km) === '' ? v.km : Math.round(num(km));
    if (!(k >= 0)) fail('გარბენი არასწორია');
    const t = today(), id = nextNo('service_orders', `SO-${t.slice(0, 4)}-`);
    run("INSERT INTO service_orders(id,date,vehicle_id,resp,km,status,last_change) VALUES(?,?,?,?,?,'open',?)", id, t, vid, r, k, t);
    if (k > v.km) run('UPDATE vehicles SET km=? WHERE id=?', k, vid);
    return id;
  },
  'so.update'({ id, resp, km }) {
    const o = openSO(id);
    if (resp !== undefined) { const r = str(resp, 120); if (!r) fail('შეიყვანეთ პასუხისმგებელი პირი'); run('UPDATE service_orders SET resp=? WHERE id=?', r, id); }
    if (km !== undefined) {
      const k = Math.round(num(km));
      if (!(k >= 0)) fail('გარბენი არასწორია');
      run('UPDATE service_orders SET km=? WHERE id=?', k, id);
      run('UPDATE vehicles SET km=MAX(km,?) WHERE id=?', k, o.vehicle_id);
    }
    touch(id);
  },
  // Serial numbers are optional for every product: at most one per issued unit.
  'so.issue'({ id, pid, wh, qty, serials }) {
    openSO(id);
    const p = product(pid), w = whOk(wh || 1), q = num(qty), sn = serialList(serials);
    if (!(q > 0)) fail('რაოდენობა უნდა იყოს 0-ზე მეტი');
    if (sn.length > q) fail(`სერიული ნომერი (${sn.length}) მეტია რაოდენობაზე (${q})`);
    serialFree(p.id, sn);
    addStock(p.id, w, -q);
    run('INSERT INTO so_parts(so_id,product_id,wh_id,qty,ret,price,serials) VALUES(?,?,?,?,0,?,?)', id, p.id, w, q, p.avg_cost, JSON.stringify(sn));
    move('out', id, p.id, q, w, null, sn.length ? 'S/N: ' + sn.join(', ') : null);
    touch(id);
  },
  'so.setSerials'({ id, lid, serials }) {
    openSO(id);
    const l = get('SELECT * FROM so_parts WHERE id=? AND so_id=?', lid, id) || fail('ხაზი ვერ მოიძებნა');
    const sn = serialList(serials), { back } = lineSerials(l);
    if (sn.length > l.qty) fail(`სერიული ნომერი (${sn.length}) მეტია გაცემულ რაოდენობაზე (${l.qty})`);
    serialFree(l.product_id, sn.filter(s => !isBack(back, s)), lid);
    run('UPDATE so_parts SET serials=?, ret_serials=? WHERE id=?', JSON.stringify(sn), JSON.stringify(back.filter(s => isBack(sn, s))), lid);
    touch(id);
  },
  'so.return'({ id, lid, qty, reason, serials }) {
    openSO(id);
    const l = get('SELECT * FROM so_parts WHERE id=? AND so_id=?', lid, id) || fail('ხაზი ვერ მოიძებნა');
    const q = num(qty), net = r4(l.qty - l.ret), { all: sn, back } = lineSerials(l), rs = serialList(serials);
    if (!(q > 0) || q > net) fail(`დასაბრუნებელი რაოდენობა: 0-დან ${net}-მდე`);
    const bad = rs.find(s => !sn.some(x => x.toLowerCase() === s.toLowerCase()) || isBack(back, s));
    if (bad) fail(`სერიული № ${bad} ამ ხაზზე გაცემული არ არის`);
    if (rs.length > q) fail('მონიშნული სერიული ნომრები მეტია დასაბრუნებელ რაოდენობაზე');
    run('UPDATE so_parts SET ret=?, ret_serials=? WHERE id=?', r4(l.ret + q), JSON.stringify([...back, ...rs]), lid);
    addStock(l.product_id, l.wh_id, q);
    move('ret', id, l.product_id, q, l.wh_id, null, [str(reason, 100), rs.length ? 'S/N: ' + rs.join(', ') : ''].filter(Boolean).join(' · ') || null);
    touch(id);
  },
  'so.addService'({ id, name, price }) {
    openSO(id);
    const n = str(name, 150), pr = str(price) === '' ? null : num(price);
    if (!n) fail('შეიყვანეთ მომსახურების დასახელება');
    if (pr !== null && !(pr >= 0)) fail('ფასი არასწორია');
    run('INSERT INTO so_services(so_id,name,price) VALUES(?,?,?)', id, n, pr);
    touch(id);
  },
  'so.delService'({ id, sid }) {
    openSO(id);
    run('DELETE FROM so_services WHERE id=? AND so_id=?', sid, id);
    touch(id);
  },
  'so.close'({ id }) {
    openSO(id);
    run("UPDATE service_orders SET status='closed', closed_at=?, last_change=? WHERE id=?", today(), today(), id);
  },
  'so.reopen'({ id }) {
    const o = get('SELECT * FROM service_orders WHERE id=?', id) || fail('ორდერი ვერ მოიძებნა');
    if (o.status === 'open') fail('ორდერი უკვე ღიაა');
    if (o.status === 'canceled') fail('ორდერი გაუქმებულია — გამოიყენეთ „გაუქმების გაუქმება“');
    run("UPDATE service_orders SET status='open', closed_at=NULL, last_change=? WHERE id=?", today(), id);
  },
  // Cancel: every part still on the order goes back to stock (like a 262 reversal) and the services disappear.
  // Only open orders can be canceled; a closed order must be reopened first.
  'so.cancel'({ id }) {
    openSO(id);
    for (const l of all('SELECT * FROM so_parts WHERE so_id=? ORDER BY id', id)) {
      const net = r4(l.qty - l.ret);
      if (net <= 0) continue;
      const sn = outLineSerials(l);
      addStock(l.product_id, l.wh_id, net);
      move('ret', id, l.product_id, net, l.wh_id, null, ['ორდერის გაუქმება', sn.length ? 'S/N: ' + sn.join(', ') : ''].filter(Boolean).join(' · '));
    }
    run("UPDATE service_orders SET status='canceled', canceled_at=?, last_change=? WHERE id=?", today(), today(), id);
  },
  // Undo cancel: the same parts are issued again and the services come back; the order is open again.
  // Refused (nothing changes) if the stock or a serial number has been used elsewhere in the meantime.
  'so.uncancel'({ id }) {
    const o = get('SELECT * FROM service_orders WHERE id=?', id) || fail('ორდერი ვერ მოიძებნა');
    if (o.status !== 'canceled') fail('ორდერი გაუქმებული არ არის');
    for (const l of all('SELECT * FROM so_parts WHERE so_id=? ORDER BY id', id)) {
      const net = r4(l.qty - l.ret);
      if (net <= 0) continue;
      const sn = outLineSerials(l);
      serialFree(l.product_id, sn, l.id);
      addStock(l.product_id, l.wh_id, -net);
      move('out', id, l.product_id, net, l.wh_id, null, ['გაუქმების გაუქმება', sn.length ? 'S/N: ' + sn.join(', ') : ''].filter(Boolean).join(' · '));
    }
    run("UPDATE service_orders SET status='open', canceled_at=NULL, closed_at=NULL, last_change=? WHERE id=?", today(), id);
  },
  'transfer.create'({ pid, from, qty, loc }) {
    if (setting('wh2') !== '1') fail('ჯერ ჩართეთ მეორე საწყობი პარამეტრებში');
    const p = product(pid), f = whOk(from), t = f === 1 ? 2 : 1, q = num(qty);
    if (!(q > 0)) fail('რაოდენობა უნდა იყოს 0-ზე მეტი');
    ensureStock(p.id, t);
    const l = locCheck(t, loc, get('SELECT loc FROM stock WHERE product_id=? AND wh_id=?', p.id, t).loc);
    addStock(p.id, f, -q);
    addStock(p.id, t, q);
    if (l) setLoc(p.id, t, l);
    const id = nextNo('transfers', `TR-${today().slice(0, 4)}-`);
    run('INSERT INTO transfers VALUES(?,?,?,?,?,?)', id, today(), p.id, f, t, q);
    move('tr', id, p.id, q, f, t);
    return id;
  },
  'location.assign'({ pid, wh, loc }) {
    product(pid);
    const w = +wh;
    if (w !== 1 && w !== 2) fail('უცნობი საწყობი');
    const l = locCheck(w, loc);
    if (!l) fail('მიუთითეთ ლოკაცია');
    setLoc(pid, w, l);
  },
  // Adds a location, or renames one (oldCode); a rename moves its products along.
  'location.save'({ wh, code, oldCode, note, active }) {
    const w = +wh, c = locCode(code);
    if (w !== 1 && w !== 2) fail('უცნობი საწყობი');
    if (!c) fail('შეიყვანეთ ლოკაციის კოდი');
    if (c.includes(' · ')) fail('კოდი არ უნდა შეიცავდეს „ · “-ს');
    const dup = findLoc(w, c);
    if (oldCode) {
      const old = findLoc(w, locCode(oldCode)) || fail('ლოკაცია ვერ მოიძებნა');
      if (dup && dup.code.toLowerCase() !== old.code.toLowerCase()) fail(`ლოკაცია „${dup.code}“ უკვე არსებობს`);
      run('UPDATE locations SET code=?, note=?, active=? WHERE wh_id=? AND code=?', c, str(note, 120), active === false ? 0 : 1, w, old.code);
      run('UPDATE stock SET loc=? WHERE wh_id=? AND loc=?', c, w, old.code);
    } else {
      if (dup) fail(`ლოკაცია „${dup.code}“ უკვე არსებობს`);
      run('INSERT INTO locations(wh_id,code,note,active) VALUES(?,?,?,?)', w, c, str(note, 120), active === false ? 0 : 1);
    }
    return c;
  },
  'location.bulkAdd'({ wh, codes }) {
    const w = +wh;
    if (w !== 1 && w !== 2) fail('უცნობი საწყობი');
    const list = String(codes || '').split(/\r?\n/).map(locCode).filter(Boolean);
    if (!list.length) fail('ჩაწერეთ კოდები — თითო სტრიქონზე ერთი');
    if (list.some(c => c.includes(' · '))) fail('კოდი არ უნდა შეიცავდეს „ · “-ს');
    let n = 0;
    list.forEach(c => { if (!findLoc(w, c)) { run('INSERT INTO locations(wh_id,code) VALUES(?,?)', w, c); n++; } });
    return n;
  },
  'location.delete'({ wh, code }) {
    const l = findLoc(+wh, locCode(code)) || fail('ლოკაცია ვერ მოიძებნა');
    const n = get('SELECT COUNT(*) AS n FROM stock WHERE wh_id=? AND loc=?', +wh, l.code).n;
    if (n) fail(`ლოკაციაზე ${n} პროდუქტია — წაშლამდე გადაიტანეთ სხვა ლოკაციაზე`);
    run('DELETE FROM locations WHERE wh_id=? AND code=?', +wh, l.code);
  },
  'catalog.toggle'({ model, pid }) {
    product(pid);
    const m = str(model, 130);
    if (!m) fail('მოდელი ცარიელია');
    if (get('SELECT 1 FROM catalog WHERE model=? AND product_id=?', m, pid)) { run('DELETE FROM catalog WHERE model=? AND product_id=?', m, pid); return false; }
    run('INSERT INTO catalog VALUES(?,?)', m, pid);
    return true;
  },
  // Confirms in the catalog every product issued on the same model in two or more service orders.
  'catalog.learn'() {
    return run(`INSERT OR IGNORE INTO catalog(model, product_id)
      SELECT v.make || ' ' || v.model, p.product_id FROM so_parts p
      JOIN service_orders o ON o.id = p.so_id JOIN vehicles v ON v.id = o.vehicle_id
      WHERE p.qty - p.ret > 0 AND o.status <> 'canceled' GROUP BY v.make || ' ' || v.model, p.product_id HAVING COUNT(DISTINCT o.id) >= 2`).changes;
  },
  'import.check'({ type, rows }) { return importCheck(type, rows || []); },
  'import.apply'({ type, rows }) {
    let n = 0, u = 0, skipped = 0;
    importCheck(type, rows || []).forEach(({ c, st }) => {
      if (st === 'err') { skipped++; return; }
      if (type === 'products') {
        const [art, name, uom, min, cost, qty, loc] = c;
        const p = get('SELECT * FROM products WHERE art=?', art);
        if (p) {
          run('UPDATE products SET name=?,uom=?,min_qty=? WHERE id=?', name, uom || p.uom, min === '' ? p.min_qty : num(min), p.id);
          if (loc) setLoc(p.id, 1, ensureLoc(1, loc));
          u++;
        } else {
          const pid = commands['product.save']({ art, name, uom: uom || 'ცალი', min, cost, locs: { 1: ensureLoc(1, loc) } });
          if (num(qty) > 0) { addStock(pid, 1, num(qty)); move('imp', 'იმპორტი', pid, num(qty), 1, null, 'CSV'); }
          n++;
        }
      } else if (type === 'vehicles') {
        const [plate, vin, make, model, year, km, dept] = c;
        const v = get('SELECT * FROM vehicles WHERE vin=?', vin.toUpperCase());
        if (v) { run('UPDATE vehicles SET plate=?,km=MAX(km,?),dept=? WHERE id=?', plate.toUpperCase(), str(km) === '' ? 0 : Math.round(num(km)), dept || v.dept, v.id); u++; }
        else { commands['vehicle.save']({ plate, vin, make, model, year, km, dept }); n++; }
      } else {
        const [art, qty, cost, loc, wh] = c;
        const p = get('SELECT * FROM products WHERE art=?', art), w = wh === '' ? 1 : +wh, q = num(qty);
        addStock(p.id, w, r4(q - stockQty(p.id, w)));
        if (cost !== '') run('UPDATE products SET avg_cost=? WHERE id=?', num(cost), p.id);
        if (loc) setLoc(p.id, w, ensureLoc(w, loc));
        move('imp', 'იმპორტი', p.id, q, w, null, 'საწყისი ნაშთი');
        u++;
      }
    });
    return { n, u, skipped };
  }
};

function exec(name, args) {
  const f = commands[name];
  if (!f) fail('უცნობი ბრძანება: ' + name);
  const result = tx(() => f(args || {}));
  if (name.startsWith('so.')) pendingSO.add(name === 'so.create' ? result : args.id);
  return result;
}

module.exports = { open, close, handle, exec, getState, setting, setSetting, today, nowTs, UserError, IMPORT_COLS, MIGRATIONS,
  setClock: fn => { clock = fn; } };
