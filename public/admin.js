const $ = id => document.getElementById(id);
let key = '', offset = 0, busy = false;
function status(message) { $('status').textContent = message; }
async function api(path, options = {}) {
  const response = await fetch('/admin/api/' + path, {...options, headers:{'Content-Type':'application/json', Authorization:'Bearer ' + key}});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
async function load() {
  const params = new URLSearchParams({q:$('query').value, pending:String($('pending').checked), offset:String(offset)});
  const data = await api('brands?' + params);
  $('rows').replaceChildren();
  for (const brand of data.brands) {
    const row = document.createElement('tr');
    for (const value of [brand.name, brand.trustworthy, brand.fake, brand.decision || 'Awaiting review']) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    const actions = document.createElement('td');
    for (const [label,decision,style] of [['Approve','trustworthy',''],['Block','fake','danger'],['Reset',null,'secondary']]) {
      const button = document.createElement('button'); button.textContent = label; button.className = style;
      button.addEventListener('click', () => work(async () => {
        await api('decision',{method:'PUT',body:JSON.stringify({brand:brand.name,decision})});
        await load(); status(`Saved decision for ${brand.name}.`);
      }));
      actions.append(button);
    }
    row.append(actions); $('rows').append(row);
  }
  if (!data.brands.length) { const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=5;cell.textContent='No brands to show.';row.append(cell);$('rows').append(row); }
  $('previous').disabled = offset === 0; $('next').disabled = !data.more;
  $('page').textContent = 'Page ' + (offset / 100 + 1);
}
async function work(action) {
  if (busy) return;
  busy = true;
  try { await action(); } catch(error) { status(error.message); } finally { busy = false; }
}
$('login').addEventListener('submit', event => {
  event.preventDefault();
  work(async () => { key=$('key').value; await load(); $('key').value=''; $('login').hidden=true; $('dashboard').hidden=false; status('Dashboard open.'); });
});
$('search').addEventListener('submit', event => { event.preventDefault(); offset=0; work(load); });
$('previous').addEventListener('click', () => work(async () => { offset=Math.max(0,offset-100); await load(); }));
$('next').addEventListener('click', () => work(async () => { offset+=100; await load(); }));
$('logout').addEventListener('click', () => { key='';$('key').value='';$('rows').replaceChildren();$('dashboard').hidden=true;$('login').hidden=false;status('Dashboard locked.'); });
$('manual').addEventListener('submit', event => {
  event.preventDefault(); work(async () => {
    await api('brand',{method:'POST',body:JSON.stringify({brand:$('brand').value})});
    $('query').value=$('brand').value; $('pending').checked=false; $('brand').value=''; offset=0; await load(); status('Brand ready for review.');
  });
});
