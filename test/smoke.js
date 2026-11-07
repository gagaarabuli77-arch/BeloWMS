'use strict';
// End-to-end smoke test: drives the real window through the main flows and saves screenshots.
// Run: BELO_SMOKE=1 BELO_DATA=/tmp/x BELO_OUT=/tmp/shots npx electron .
const fs = require('node:fs');
const path = require('node:path');

module.exports = function smoke(win, { app }) {
  const out = process.env.BELO_OUT || path.join(app.getPath('temp'), 'belo-smoke');
  fs.mkdirSync(out, { recursive: true });
  const log = [];
  const note = m => { log.push(m); fs.writeFileSync(path.join(out, 'smoke.log'), log.join('\n')); };
  win.webContents.on('console-message', e => note(`console[${e.level}] ${e.message}`));
  win.webContents.on('render-process-gone', (e, d) => note('RENDERER GONE ' + d.reason));
  const js = code => win.webContents.executeJavaScript(`(async()=>{${code}})()`);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { await wait(250); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const check = async (label, code) => { const v = await js(code); note(`${label}: ${JSON.stringify(v)}`); return v; };

  win.webContents.once('did-finish-load', async () => {
    try {
      win.setSize(1440, 900);
      await wait(400);
      await shot('01-setup');
      await js(`$('#cn').value='შპს „ბელო“';$('#ct').value='405000000';$('#ca').value='თბილისი';await finishSetup();`);
      const csvP = ['არტიკული;დასახელება;ზომის ერთეული;მინ. ნაშთი;ღირებულება;რაოდენობა;ლოკაცია',
        '04152-YZZA1;ზეთის ფილტრი (Toyota);ცალი;5;28;14;A-01-01', 'OIL-5W30;ძრავის ზეთი 5W-30;ლიტრი;40;22;86;B-01-01',
        '04465-0K240;სამუხრუჭე ხუნდები, წინა;კომპლექტი;2;160;1;A-02-01', 'BAD;;ცალი;x;;;'].join('\n');
      const csvV = ['სახ. ნომერი;VIN;მარკა;მოდელი;წელი;გარბენი;განყოფილება', 'TB-482-AK;MR0HA3CD1M0512345;Toyota;Hilux;2021;86400;ლოგისტიკა',
        'AB-777-CD;WF0XXXTTGXLA12345;Ford;Transit;2020;98700;მიწოდება'].join('\n');
      await js(`openImport('products');await impParse(${JSON.stringify(csvP)},'products.csv');`);
      await shot('02-import-preview');
      await js(`await doImport();openImport('vehicles');await impParse(${JSON.stringify(csvV)},'vehicles.csv');await doImport();`);
      await check('after import', `return {products:S.products.length,vehicles:S.vehicles.length,oilStock:S.products.find(p=>p.art==='OIL-5W30').stock[1].q}`);
      await js(`go('dashboard')`); await shot('03-dashboard');
      await js(`await call('supplier.save',{name:'შპს „ოილ მარკეტი“'});openPO();po.sup=S.suppliers[0].id;po.lines=[{pid:S.products[0].id,qty:10,price:30}];await savePO();`);
      await check('after PO', `return {stock:S.products[0].stock[1].q,cost:S.products[0].cost}`);
      await js(`newSO(S.vehicles[0].id);$('#nsr').value='ნ. ბერიძე';await createSO();`);
      await js(`const o=S.sos[0];$('#sop').value=S.products[1].id;$('#soqty').value=6;await addPart(o.id);await addPart(o.id,S.products[0].id);$('#svn').value='ზეთის შეცვლა';await addSvc(o.id);`);
      await js(`const o=S.sos[0];$('#sop').value=S.products[2].id;$('#soqty').value=5;soWarn(o.id);await addPart(o.id);`);
      await check('after issue', `return {parts:S.sos[0].parts.length,svcs:S.sos[0].svcs.length,oil:S.products[1].stock[1].q,toasts:[...document.querySelectorAll('.toast')].map(t=>t.textContent)}`);
      await js(`const o=S.sos[0];$('#sop').value=S.products[0].id;$('#soqty').value=2;$('#sosn').value='BAT-001, BAT-002';await addPart(o.id);`);
      await check('serials issued', `return S.sos[0].parts.map(l=>l.serials)`);
      await js(`const o=S.sos[0];const l=o.parts[o.parts.length-1];retPart(o.id,l.lid);document.querySelector('.rsn[value="BAT-002"]').click();await doRet(o.id,l.lid);`);
      await check('serial returned', `const l=S.sos[0].parts[S.sos[0].parts.length-1];return {ret:l.ret,retSerials:l.retSerials}`);
      await js(`const o=S.sos[0];editSerials(o.id,o.parts[1].lid);$('#snl').value='FLT-77';await saveSerials(o.id,o.parts[1].lid);`);
      await shot('04-service-order');
      await js(`$('#gs').value='BAT-00';gSearch();`); await shot('04b-serial-search');
      await check('serial search', `return [...document.querySelectorAll('#gsr button')].map(b=>b.textContent).slice(0,3)`);
      await js(`$('#gsr').hidden=true;$('#gs').value='';`);
      await js(`retPart(S.sos[0].id,S.sos[0].parts[0].lid);$('#rq').value=1;await doRet(S.sos[0].id,S.sos[0].parts[0].lid);`);
      await check('after return', `return {ret:S.sos[0].parts[0].ret,oil:S.products[1].stock[1].q}`);
      await js(`printSO(S.sos[0].id)`); await wait(300);
      fs.writeFileSync(path.join(out, 'service-order.pdf'), await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' } }));
      await shot('05-pdf-preview');
      await js(`closePrint();go('stock');await call('location.bulkAdd',{wh:1,codes:'ZONE-3\\nგარე საწყობი\\nA-01-01'});stSel='A-01-01';render();`);
      await js(`openLocation('ZONE-3');$('#lcode').value='ZONE-03';$('#lnote').value='ეზო, ფარდული';await saveLocation('ZONE-3');`);
      await check('locations', `return locsOf(1).map(l=>l.code+(l.note?' ('+l.note+')':''))`);
      await js(`openProduct(S.products[2].id);$('#pl1').value='ZONE-04';await saveProduct(S.products[2].id,false);`);
      await check('unknown location refused', `return [...document.querySelectorAll('.toast.err')].pop()?.textContent`);
      await js(`closeModal();stSel='A-01-01';render();`); await shot('06-stock');
      await js(`go('catalog')`); await shot('07-catalog');
      await js(`go('reports')`); await shot('08-reports');
      await js(`go('vehicle',S.vehicles[0].id)`); await shot('09-vehicle');
      const bdir = path.join(out, 'usb-backup');
      fs.mkdirSync(bdir, { recursive: true });
      require('../src/main/db').setSetting('backupDir', bdir);
      await js(`const r=await window.api.invoke('state');apply(r.state);go('settings');await runBackup();`);
      await check('backups', `const r=await window.api.invoke('backup.list');return r.result.map(b=>b.name)`);
      await shot('10-settings');
      await js(`await call('settings.set',{key:'wh2',value:true});openTransfer(S.products[1].id);$('#trq').value=10;await doTransfer();`);
      await check('after transfer', `return S.products[1].stock`);
      const file = (await js(`const r=await window.api.invoke('backup.list');return r.result[0].file`));
      await js(`await call('so.addService',{id:S.sos[0].id,name:'დროებითი'});`);
      await check('before restore svcs', `return S.sos[0].svcs.length`);
      await check('restore', `const r=await window.api.invoke('backup.restore',${JSON.stringify(file)});apply(r.state);render();return {ok:r.ok,svcs:S.sos[0].svcs.length,wh2:S.settings.wh2}`);
      // Cancel a service order and undo the cancel.
      await js(`go('sos');newSO(S.vehicles[1].id);$('#nsr').value='გ. კაპანაძე';await createSO();`);
      await js(`const o=S.sos[0];$('#sop').value=S.products[1].id;$('#soqty').value=4;await addPart(o.id);$('#svn').value='დიაგნოსტიკა';$('#svp').value=40;await addSvc(o.id);`);
      await check('before cancel', `const o=S.sos[0];return {id:o.id,status:o.status,oil:S.products[1].stock[1].q,svcs:o.svcs.length}`);
      await js(`askCancel(S.sos[0].id)`); await shot('11-cancel-confirm');
      await js(`document.querySelector('#mfoot .btn.danger').click()`); await wait(300);
      await check('after cancel', `const o=S.sos[0];return {status:o.status,oil:S.products[1].stock[1].q,svcs:o.svcs.length}`);
      await shot('12-canceled-order');
      await js(`soFilter='canceled';go('sos')`); await shot('13-canceled-list');
      await js(`soFilter='all';printSO(S.sos[0].id)`); await shot('14-canceled-pdf');
      await js(`closePrint();go('so',S.sos[0].id);askUncancel(S.sos[0].id)`); await shot('15-undo-confirm');
      await js(`document.querySelector('#mfoot .btn.primary').click()`); await wait(300);
      await check('after undo cancel', `const o=S.sos[0];return {status:o.status,oil:S.products[1].stock[1].q,svcs:o.svcs.length}`);
      await shot('16-restored');
      note('DONE');
    } catch (e) {
      note('SMOKE FAILED ' + (e.stack || e.message));
    }
    app.quit();
  });
};
