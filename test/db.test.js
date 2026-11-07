'use strict';
// Business-rule tests: run with `npm test` (Node 22.5+ has node:sqlite built in).
const test = require('node:test');
const assert = require('node:assert/strict');
const DB = require('../src/main/db');

let now = new Date(2026, 10, 2, 10, 0, 0);
DB.setClock(() => now);
const day = (y, m, d) => { now = new Date(y, m - 1, d, 10, 0, 0); };

function fresh() {
  DB.close();
  DB.open(':memory:');
  day(2026, 11, 2);
  DB.exec('setup.complete', { company: { name: 'ტესტ კომპანია' }, whName: 'მთავარი' });
  DB.exec('location.bulkAdd', { wh: 1, codes: 'A-01-01\nA-01-02' });
  const sup = DB.exec('supplier.save', { name: 'მომწოდებელი' });
  const pid = DB.exec('product.save', { art: 'OF-1', name: 'ზეთის ფილტრი', uom: 'ცალი', min: 2, locs: { 1: 'A-01-01' } });
  const vid = DB.exec('vehicle.save', { plate: 'AA-001-AA', vin: 'MR0HA3CD1M0512345', make: 'Toyota', model: 'Hilux', year: 2021, km: 1000 });
  return { sup, pid, vid };
}
const prod = (st, id) => st.products.find(p => p.id === id);
const so = (st, id) => st.sos.find(o => o.id === id);

test('purchase order adds stock and keeps a weighted average cost', () => {
  const { sup, pid } = fresh();
  DB.exec('po.create', { sup, wh: 1, lines: [{ pid, qty: 10, price: 20 }] });
  DB.exec('po.create', { sup, wh: 1, lines: [{ pid, qty: 10, price: 30 }] });
  const p = prod(DB.getState(), pid);
  assert.equal(p.stock[1].q, 20);
  assert.equal(p.cost, 25);
});

test('document numbers are sequential per year', () => {
  const { sup, pid } = fresh();
  const a = DB.exec('po.create', { sup, lines: [{ pid, qty: 1, price: 1 }] });
  const b = DB.exec('po.create', { sup, lines: [{ pid, qty: 1, price: 1 }] });
  assert.equal(a, 'PO-2026-0001');
  assert.equal(b, 'PO-2026-0002');
  assert.equal(pid, 'P-00001');
});

test('issuing more than in stock is refused and nothing changes', () => {
  const { sup, pid, vid } = fresh();
  DB.exec('po.create', { sup, lines: [{ pid, qty: 2, price: 10 }] });
  const id = DB.exec('so.create', { vid, resp: 'ნ. ბერიძე' });
  assert.throws(() => DB.exec('so.issue', { id, pid, qty: 3 }), /არასაკმარისი ნაშთი/);
  const st = DB.getState();
  assert.equal(prod(st, pid).stock[1].q, 2);
  assert.equal(so(st, id).parts.length, 0);
});

test('issue and return move stock and price parts at average cost', () => {
  const { sup, pid, vid } = fresh();
  DB.exec('po.create', { sup, lines: [{ pid, qty: 5, price: 12 }] });
  const id = DB.exec('so.create', { vid, resp: 'ნ. ბერიძე' });
  DB.exec('so.issue', { id, pid, qty: 2 });
  let st = DB.getState();
  const lid = so(st, id).parts[0].lid;
  assert.equal(prod(st, pid).stock[1].q, 3);
  assert.equal(so(st, id).parts[0].price, 12);
  assert.throws(() => DB.exec('so.return', { id, lid, qty: 3 }), /დასაბრუნებელი/);
  DB.exec('so.return', { id, lid, qty: 1, reason: 'არ დასჭირდა' });
  st = DB.getState();
  assert.equal(prod(st, pid).stock[1].q, 4);
  assert.equal(so(st, id).parts[0].ret, 1);
});

test('service orders auto-close N days after the last change, not after opening', () => {
  const { vid } = fresh();
  day(2026, 11, 1);
  const id = DB.exec('so.create', { vid, resp: 'ა' });
  day(2026, 11, 6);
  DB.exec('so.addService', { id, name: 'დიაგნოსტიკა', price: '' });
  day(2026, 11, 10);
  assert.equal(so(DB.getState(), id).status, 'open');
  day(2026, 11, 13);
  const o = so(DB.getState(), id);
  assert.equal(o.status, 'auto');
  assert.equal(o.closedAt, '2026-11-13');
  assert.throws(() => DB.exec('so.addService', { id, name: 'x' }), /დახურულია/);
  DB.exec('so.reopen', { id });
  assert.equal(so(DB.getState(), id).status, 'open');
});

test('services accept an empty price', () => {
  const { vid } = fresh();
  const id = DB.exec('so.create', { vid, resp: 'ა' });
  DB.exec('so.addService', { id, name: 'ზეთის შეცვლა', price: '' });
  assert.equal(so(DB.getState(), id).svcs[0].price, null);
});

test('transfers need the second warehouse and enough stock', () => {
  const { sup, pid } = fresh();
  DB.exec('po.create', { sup, lines: [{ pid, qty: 5, price: 1 }] });
  assert.throws(() => DB.exec('transfer.create', { pid, from: 1, qty: 1 }), /მეორე საწყობი/);
  DB.exec('settings.set', { key: 'wh2', value: true });
  DB.exec('location.save', { wh: 2, code: 'B-01-01' });
  assert.throws(() => DB.exec('transfer.create', { pid, from: 1, qty: 6 }), /არასაკმარისი/);
  assert.throws(() => DB.exec('transfer.create', { pid, from: 1, qty: 1, loc: 'A-01-01' }), /არ არის სიაში/);
  DB.exec('transfer.create', { pid, from: 1, qty: 2, loc: 'B-01-01' });
  const p = prod(DB.getState(), pid);
  assert.deepEqual([p.stock[1].q, p.stock[2].q, p.stock[2].loc], [3, 2, 'B-01-01']);
  assert.throws(() => DB.exec('settings.set', { key: 'wh2', value: false }), /მეორე საწყობში ნაშთია/);
});

test('validation: duplicate article, bad VIN, unknown location', () => {
  fresh();
  assert.throws(() => DB.exec('product.save', { art: 'of-1', name: 'x' }), /უკვე არსებობს/);
  assert.throws(() => DB.exec('vehicle.save', { plate: 'X', vin: 'SHORT', make: 'a', model: 'b' }), /VIN/);
  assert.throws(() => DB.exec('product.save', { art: 'Z', name: 'z', locs: { 1: 'shelf 3' } }), /არ არის სიაში/);
});

test('locations: free codes, case-insensitive, rename moves products, delete only when empty', () => {
  const { pid } = fresh();
  DB.exec('location.save', { wh: 1, code: 'გარე საწყობი', note: 'ეზოში' });
  assert.throws(() => DB.exec('location.save', { wh: 1, code: 'a-01-01' }), /უკვე არსებობს/);
  assert.equal(DB.exec('location.bulkAdd', { wh: 1, codes: 'ZONE-3\na-01-02\n\nZONE-4' }), 2);
  DB.exec('product.save', { id: pid, art: 'OF-1', name: 'ზეთის ფილტრი', uom: 'ცალი', locs: { 1: 'zone-3' } });
  assert.equal(prod(DB.getState(), pid).stock[1].loc, 'ZONE-3');
  DB.exec('location.save', { wh: 1, oldCode: 'ZONE-3', code: 'ZONE-03' });
  assert.equal(prod(DB.getState(), pid).stock[1].loc, 'ZONE-03');
  assert.throws(() => DB.exec('location.delete', { wh: 1, code: 'ZONE-03' }), /პროდუქტია/);
  DB.exec('location.delete', { wh: 1, code: 'ZONE-4' });
  DB.exec('location.save', { wh: 1, oldCode: 'A-01-02', code: 'A-01-02', active: false });
  assert.throws(() => DB.exec('location.assign', { pid, wh: 1, loc: 'A-01-02' }), /გამორთულია/);
  const st = DB.getState();
  assert.deepEqual(st.locations.map(l => l.code).sort(), ['A-01-01', 'A-01-02', 'ZONE-03', 'გარე საწყობი']);
});

test('serial numbers: optional, one per unit, never on two vehicles at once', () => {
  const { sup, pid, vid } = fresh();
  DB.exec('po.create', { sup, lines: [{ pid, qty: 5, price: 10 }] });
  const a = DB.exec('so.create', { vid, resp: 'ა' });
  DB.exec('so.issue', { id: a, pid, qty: 1 });
  assert.throws(() => DB.exec('so.issue', { id: a, pid, qty: 1, serials: 'SN1, SN2' }), /მეტია რაოდენობაზე/);
  DB.exec('so.issue', { id: a, pid, qty: 2, serials: 'SN1, SN2' });
  const b = DB.exec('so.create', { vid, resp: 'ბ' });
  assert.throws(() => DB.exec('so.issue', { id: b, pid, qty: 1, serials: 'sn2' }), /SN2.*გაცემულია|უკვე გაცემულია/);
  let line = so(DB.getState(), a).parts[1];
  assert.deepEqual(line.serials, ['SN1', 'SN2']);
  DB.exec('so.return', { id: a, lid: line.lid, qty: 1, serials: ['SN2'] });
  DB.exec('so.issue', { id: b, pid, qty: 1, serials: 'SN2' });
  const first = so(DB.getState(), a).parts[0];
  DB.exec('so.setSerials', { id: a, lid: first.lid, serials: 'SN9' });
  assert.deepEqual(so(DB.getState(), a).parts[0].serials, ['SN9']);
  line = so(DB.getState(), a).parts[1];
  assert.deepEqual([line.retSerials, line.ret], [['SN2'], 1]);
});

test('catalog learns products used twice on the same model', () => {
  const { sup, pid, vid } = fresh();
  DB.exec('po.create', { sup, lines: [{ pid, qty: 5, price: 1 }] });
  for (let i = 0; i < 2; i++) { const id = DB.exec('so.create', { vid, resp: 'ა' }); DB.exec('so.issue', { id, pid, qty: 1 }); }
  assert.equal(DB.exec('catalog.learn'), 1);
  assert.deepEqual(DB.getState().catalog, [{ model: 'Toyota Hilux', pid }]);
  assert.equal(DB.exec('catalog.toggle', { model: 'Toyota Hilux', pid }), false);
});

test('CSV import checks rows and applies only valid ones', () => {
  fresh();
  const rows = [['OF-1', 'ზეთის ფილტრი', 'ცალი', '3', '', '', 'A-01-02'], ['BP-1', 'ხუნდები', 'კომპლექტი', '1', '140,5', '4', 'A-02-01'], ['', '', 'ცალი', '', 'abc', '', '']];
  assert.deepEqual(DB.exec('import.check', { type: 'products', rows }).map(r => r.st), ['upd', 'new', 'err']);
  assert.deepEqual(DB.exec('import.apply', { type: 'products', rows }), { n: 1, u: 1, skipped: 1 });
  const st = DB.getState(), bp = st.products.find(p => p.art === 'BP-1');
  assert.deepEqual([bp.stock[1].q, bp.cost, bp.stock[1].loc], [4, 140.5, 'A-02-01']);
  assert.deepEqual(DB.exec('import.apply', { type: 'stock', rows: [['BP-1', '2', '', '', '1']] }), { n: 0, u: 1, skipped: 0 });
  assert.equal(DB.getState().products.find(p => p.art === 'BP-1').stock[1].q, 2);
});

test('company name is required to finish setup', () => {
  DB.close(); DB.open(':memory:');
  assert.equal(DB.getState().settings.setupDone, false);
  assert.throws(() => DB.exec('setup.complete', { company: { name: ' ' } }), /კომპანიის/);
});

test('after a command only changed service orders are sent, and they match a full reload', () => {
  const { sup, pid, vid } = fresh();
  DB.exec('po.create', { sup, lines: [{ pid, qty: 5, price: 10 }] });
  const a = DB.exec('so.create', { vid, resp: 'ა' });
  DB.exec('so.create', { vid, resp: 'ბ' });
  DB.getState();
  DB.exec('so.issue', { id: a, pid, qty: 1 });
  const d = DB.getState({ delta: true });
  assert.equal(d.sos, undefined);
  assert.deepEqual(d.sosUpsert.map(o => o.id), [a]);
  assert.equal(d.sosUpsert[0].parts.length, 1);
  assert.equal(DB.getState({ delta: true }).sosUpsert.length, 0);
  day(2026, 11, 20);
  assert.equal(DB.getState({ delta: true }).sosUpsert.length, 2, 'auto-closed orders are sent as changes');
  const full = DB.getState();
  DB.close(); DB.open(':memory:');
  assert.equal(full.sos.every(o => o.status === 'auto'), true);
});

test('catalog recommendation can be switched off and on; negative stock stays forbidden', () => {
  fresh();
  assert.equal(DB.getState().settings.catalogRec, true);
  DB.exec('settings.set', { key: 'catalogRec', value: false });
  assert.equal(DB.getState().settings.catalogRec, false);
  DB.exec('settings.set', { key: 'catalogRec', value: true });
  assert.equal(DB.getState().settings.catalogRec, true);
  assert.throws(() => DB.exec('settings.set', { key: 'negativeStock', value: true }), /უცნობი პარამეტრი/);
});

test('cancel returns every part to stock and hides services; undo cancel brings everything back', () => {
  const { sup, pid, vid } = fresh();
  DB.exec('po.create', { sup, lines: [{ pid, qty: 10, price: 20 }] });
  const a = DB.exec('so.create', { vid, resp: 'ა' });
  DB.exec('so.issue', { id: a, pid, qty: 3, serials: 'SN1, SN2' });
  DB.exec('so.addService', { id: a, name: 'ზეთის შეცვლა', price: 50 });
  let lid = so(DB.getState(), a).parts[0].lid;
  DB.exec('so.return', { id: a, lid, qty: 1, serials: ['SN2'] });
  assert.equal(prod(DB.getState(), pid).stock[1].q, 8);

  DB.exec('so.cancel', { id: a });
  let st = DB.getState(), o = so(st, a);
  assert.equal(o.status, 'canceled');
  assert.equal(o.canceledAt, '2026-11-02');
  assert.equal(prod(st, pid).stock[1].q, 10, 'the 2 parts still on the order went back');
  assert.deepEqual(o.svcs, [], 'services are gone while canceled');
  assert.equal(o.parts.length, 1, 'parts lines stay visible, crossed out');
  assert.match(st.moves.find(m => m.type === 'ret' && /გაუქმება/.test(m.note || '')).note, /SN1/);
  assert.throws(() => DB.exec('so.issue', { id: a, pid, qty: 1 }), /გაუქმებულია/);
  assert.throws(() => DB.exec('so.close', { id: a }), /გაუქმებულია/);
  assert.throws(() => DB.exec('so.reopen', { id: a }), /გაუქმების გაუქმება/);
  assert.throws(() => DB.exec('so.cancel', { id: a }), /გაუქმებულია/);

  DB.exec('so.uncancel', { id: a });
  st = DB.getState(); o = so(st, a);
  assert.equal(o.status, 'open');
  assert.equal(o.canceledAt, null);
  assert.equal(prod(st, pid).stock[1].q, 8, 'the same 2 parts are issued again');
  assert.deepEqual(o.svcs.map(s => [s.name, s.price]), [['ზეთის შეცვლა', 50]]);
  assert.deepEqual([o.parts[0].qty, o.parts[0].ret, o.parts[0].serials, o.parts[0].retSerials], [3, 1, ['SN1', 'SN2'], ['SN2']]);
  assert.throws(() => DB.exec('so.uncancel', { id: a }), /გაუქმებული არ არის/);
});

test('only open orders can be canceled; undo cancel is refused if the stock or serial was used meanwhile', () => {
  const { sup, pid, vid } = fresh();
  DB.exec('po.create', { sup, lines: [{ pid, qty: 2, price: 20 }] });
  const a = DB.exec('so.create', { vid, resp: 'ა' });
  DB.exec('so.issue', { id: a, pid, qty: 2, serials: 'SN1' });
  DB.exec('so.close', { id: a });
  assert.throws(() => DB.exec('so.cancel', { id: a }), /დახურულია/);
  DB.exec('so.reopen', { id: a });
  DB.exec('so.cancel', { id: a });

  // The serial went back with the cancel, so another order may now use it.
  const b = DB.exec('so.create', { vid, resp: 'ბ' });
  DB.exec('so.issue', { id: b, pid, qty: 1, serials: 'SN1' });
  assert.throws(() => DB.exec('so.uncancel', { id: a }), /SN1.*გაცემულია/);
  DB.exec('so.setSerials', { id: b, lid: so(DB.getState(), b).parts[0].lid, serials: '' });
  assert.throws(() => DB.exec('so.uncancel', { id: a }), /არასაკმარისი ნაშთი/);
  const st = DB.getState();
  assert.equal(so(st, a).status, 'canceled', 'a refused undo changes nothing');
  assert.equal(prod(st, pid).stock[1].q, 1);
});

test('canceled orders do not teach the catalog and never auto-close', () => {
  const { sup, pid, vid } = fresh();
  DB.exec('po.create', { sup, lines: [{ pid, qty: 5, price: 20 }] });
  for (let i = 0; i < 2; i++) { const o = DB.exec('so.create', { vid, resp: 'ა' }); DB.exec('so.issue', { id: o, pid, qty: 1 }); DB.exec('so.cancel', { id: o }); }
  assert.equal(DB.exec('catalog.learn'), 0);
  day(2026, 12, 30);
  assert.equal(DB.getState().sos.every(o => o.status === 'canceled'), true);
});

test('upgrading an existing database keeps its service orders, parts and services', () => {
  const { DatabaseSync } = require('node:sqlite');
  const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'belo-')), 'old.db');
  // Build a database as the previous version left it (first two upgrade steps only).
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)');
  DB.MIGRATIONS.slice(0, 2).forEach(sql => old.exec(sql));
  old.exec(`INSERT INTO meta VALUES('schema','2');
    INSERT INTO products(id,art,name,uom,avg_cost) VALUES('P-00001','OF-1','ფილტრი','ცალი',20);
    INSERT INTO vehicles(id,plate,vin,make,model,km) VALUES('V-1','AA-001-AA','MR0HA3CD1M0512345','Toyota','Hilux',1000);
    INSERT INTO service_orders VALUES('SO-2026-0001','2026-10-01','V-1','ა',1000,'closed','2026-10-02','2026-10-02');
    INSERT INTO so_parts(so_id,product_id,wh_id,qty,ret,price) VALUES('SO-2026-0001','P-00001',1,2,0,20);
    INSERT INTO so_services(so_id,name,price) VALUES('SO-2026-0001','შეცვლა',30);`);
  old.close();
  DB.close();
  DB.open(file);
  const o = so(DB.getState(), 'SO-2026-0001');
  assert.deepEqual([o.status, o.closedAt, o.parts.length, o.svcs.length, o.canceledAt], ['closed', '2026-10-02', 1, 1, null]);
  assert.deepEqual(DB.handle().prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(DB.handle().prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  DB.close();
});
