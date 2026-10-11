const normalize = value => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[™®]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (data, status = 200) => Response.json(data, {status, headers});
function fail(status, message) { throw Object.assign(new Error(message), {status}); }
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function body(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, 'Use application/json.');
  // Bound the stream itself, including chunked requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Missing request body.');
  const chunks = []; let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32768) { await reader.cancel(); fail(413, 'Request too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'Invalid JSON.'); }
}
function token(request) {
  const value = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!value) fail(401, 'An installation token is required.');
  return value;
}
async function admin(request, env) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) fail(503, 'Set the ADMIN_TOKEN secret first (at least 32 characters).');
  const supplied = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  const [a,b] = await Promise.all([digest(supplied), digest(env.ADMIN_TOKEN)]);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  if (mismatch) fail(401, 'Incorrect dashboard key.');
}
function brandName(value) {
  if (typeof value !== 'string' || value.length > 100) fail(400, 'Invalid brand name.');
  const name = normalize(value);
  if (!name || name.length > 100) fail(400, 'Invalid brand name.');
  return name;
}
const totals = `SELECT b.name, b.decision, b.reviewed_at,
  (SELECT count(*) FROM votes v WHERE v.brand=b.name AND v.vote='trustworthy') AS trustworthy,
  (SELECT count(*) FROM votes v WHERE v.brand=b.name AND v.vote='fake') AS fake FROM brands b`;
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (path === '/api/brands' && request.method === 'GET') {
        const {results} = await env.DB.prepare(`${totals} WHERE b.decision IS NOT NULL ORDER BY b.name LIMIT 20001`).all();
        if (results.length > 20000) fail(503, 'Published list exceeds the supported size.');
        return json({brands: results.map(({name, decision, trustworthy, fake}) => ({name, decision, trustworthy, fake}))});
      }
      if (path === '/api/votes' && request.method === 'PUT') {
        const voter = await digest(token(request)), data = await body(request);
        if (!Array.isArray(data?.changes) || data.changes.length > 20) fail(400, 'Send at most 20 vote changes.');
        const changes = data.changes.map(entry => {
          const name = brandName(entry?.brand);
          if (![null, 'trustworthy', 'fake'].includes(entry.vote)) fail(400, 'Invalid vote.');
          return {name, vote: entry.vote};
        });
        if (new Set(changes.map(c => c.name)).size !== changes.length) fail(400, 'Duplicate brand in batch.');
        // Basic per-installation throttle; deliberately permits multiple installations.
        const now = Date.now();
        const allowed = await env.DB.prepare(`INSERT INTO voters(id,last_upload) VALUES(?,?)
          ON CONFLICT(id) DO UPDATE SET last_upload=excluded.last_upload
          WHERE voters.last_upload <= ? RETURNING id`).bind(voter, now, now - 1000).first();
        if (!allowed) return new Response(JSON.stringify({error:'Please retry shortly.'}), {status:429, headers:{...headers, 'Content-Type':'application/json', 'Retry-After':'2'}});
        const statements = [];
        for (const {name, vote} of changes) {
          if (vote === null) statements.push(env.DB.prepare('DELETE FROM votes WHERE voter=? AND brand=?').bind(voter, name));
          else {
            statements.push(env.DB.prepare('INSERT INTO brands(name) VALUES(?) ON CONFLICT(name) DO NOTHING').bind(name));
            statements.push(env.DB.prepare(`INSERT INTO votes(voter,brand,vote) VALUES(?,?,?)
              ON CONFLICT(voter,brand) DO UPDATE SET vote=excluded.vote WHERE votes.vote != excluded.vote`).bind(voter, name, vote));
          }
        }
        // D1 batch is transactional: retries cannot count a vote twice.
        if (statements.length) await env.DB.batch(statements);
        return json({ok:true});
      }
      if (path === '/api/votes' && request.method === 'DELETE') {
        const voter = await digest(token(request));
        await env.DB.prepare('DELETE FROM voters WHERE id=?').bind(voter).run();
        return json({ok:true});
      }
      if (path.startsWith('/admin/api/')) {
        await admin(request, env);
        if (path === '/admin/api/brands' && request.method === 'GET') {
          const q = (url.searchParams.get('q') || '').slice(0,100);
          const offset = Math.max(0, Math.min(1000000, Number(url.searchParams.get('offset')) || 0));
          const pending = url.searchParams.get('pending') === 'true';
          const {results} = await env.DB.prepare(`${totals} WHERE instr(b.name,?)>0
            AND (?=0 OR b.decision IS NULL) ORDER BY b.name LIMIT 101 OFFSET ?`).bind(normalize(q), pending ? 1 : 0, Math.floor(offset)).all();
          return json({brands:results.slice(0,100), more:results.length>100});
        }
        if (path === '/admin/api/decision' && request.method === 'PUT') {
          const data = await body(request), name = brandName(data?.brand);
          if (![null, 'trustworthy', 'fake'].includes(data.decision)) fail(400, 'Invalid decision.');
          await env.DB.prepare(`INSERT INTO brands(name,decision,reviewed_at) VALUES(?,?,?)
            ON CONFLICT(name) DO UPDATE SET decision=excluded.decision,reviewed_at=excluded.reviewed_at`)
            .bind(name, data.decision, new Date().toISOString()).run();
          return json({ok:true});
        }
        if (path === '/admin/api/brand' && request.method === 'POST') {
          const data = await body(request), name = brandName(data?.brand);
          await env.DB.prepare('INSERT INTO brands(name) VALUES(?) ON CONFLICT(name) DO NOTHING').bind(name).run();
          return json({ok:true});
        }
        return json({error:'Not found.'},404);
      }
      if (path === '/health' && request.method === 'GET') {
        await env.DB.prepare('SELECT name FROM brands LIMIT 1').first();
        return json({ok:true});
      }
      if (path.startsWith('/api/')) return json({error:'Not found.'},404);
      if (!['GET', 'HEAD'].includes(request.method)) return json({error:'Method not allowed.'},405);
      const response = await env.ASSETS.fetch(request);
      const secured = new Response(response.body, response);
      for (const [name,value] of Object.entries(headers)) secured.headers.set(name,value);
      secured.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return secured;
    } catch (error) {
      return json({error:error.status ? error.message : 'Service unavailable. Please try again later.'}, error.status || 503);
    }
  }
};

