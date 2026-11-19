// Run against a local server pointed at fake-github.mjs and a disposable database.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const base = process.env.E2E_BASE || 'http://127.0.0.1:8099';
const github = process.env.E2E_FAKE_GH || 'http://127.0.0.1:8098';
const database = process.env.E2E_PG_URL;
const secret = process.env.E2E_JWT_SECRET;
assert(database && secret && [base, github, database].every((s) => new URL(s).hostname === '127.0.0.1'), 'Use a disposable local database and fake GitHub');
pg.types.setTypeParser(20, Number);
const db = new pg.Client({ connectionString: database, ssl: false });
await db.connect();
const login = 'auto-pull-test', repo = `${login}/sync`;
const { rows: [user] } = await db.query("INSERT INTO users (github_id, login, name) VALUES (-98201,$1,$1) ON CONFLICT (github_id) DO UPDATE SET login=EXCLUDED.login RETURNING id", [login]);
await db.query('DELETE FROM projects WHERE owner_id=$1', [user.id]);
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, login, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 })}`;
const token = `${unsigned}.${crypto.createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
const ctl = async (what: string, body: unknown) => {
  const r = await fetch(`${github}/__ctl/${what}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
  assert.equal(r.status,200); return r.json();
};
const api = async (path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method:body === undefined ? 'GET':'POST', headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}, body:body === undefined ? undefined:JSON.stringify(body) });
  assert.equal(r.status,200,await r.clone().text()); return r.json();
};
const board = (value: string) => `(kicad_pcb (version 20241229) (generator "pcbnew") (paper "${value}") (layers (0 "F.Cu" signal) (31 "B.Cu" signal)))\n`;
let projectId: string | undefined;
try {
  await ctl('user',{login,id:-98201});
  await ctl('repo',{fullName:repo,files:{'sync.kicad_pro':'{}','sync.kicad_pcb':board('A4')}});
  await ctl('browser',{login});
  let url = `${base}/auth/github/connect?next=/github`;
  for(let hop=0;hop<6;hop++) {
    const r=await fetch(url,{redirect:'manual',headers:url.startsWith(base)?{Cookie:`kc_session=${token}`}:{}});
    if(r.status<300 || r.status>=400) { assert.equal(r.status,200); break; }
    url=new URL(r.headers.get('location')!,url).toString();
  }
  const imported=await api('/api/github/import',{repo}); projectId=imported.projectId;
  const pull=() => api(`/api/projects/${projectId}/github/pull`,{automatic:true});
  const info=() => api(`/api/projects/${projectId}/info`);
  let docs=(await info()).docs;
  const boardId=docs.find((d: {path:string})=>d.path==='sync.kicad_pcb').docId;
  const content=async()=> (await fetch(`${base}/api/docs/${boardId}/content`,{headers:{authorization:`Bearer ${token}`}})).text();
  const save=async(text:string)=> {
    await db.query('INSERT INTO snapshots (doc_id,seq,content) SELECT $1,GREATEST(COALESCE((SELECT MAX(seq) FROM snapshots WHERE doc_id=$1),0),COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id=$1),0))+1,$2',[boardId,Buffer.from(text)]);
  };
  await ctl('commit',{fullName:repo,files:{'sync.kicad_pcb':board('A3')},author:login});
  assert((await pull()).updated.some((d: {path:string})=>d.path==='sync.kicad_pcb'));
  assert.equal(await content(),board('A3'));
  assert.equal((await pull()).updated.length,0);
  console.log('PASS remote board update and repeated checks');

  await save(board('A2'));
  await ctl('commit',{fullName:repo,files:{'sync.kicad_pcb':board('A1')},author:login});
  const conflict=await pull();
  assert(conflict.skipped.some((d: {reason:string})=>d.reason.includes('both sides')));
  assert.equal(await content(),board('A2'));
  const forced=await api(`/api/projects/${projectId}/github/pull`,{automatic:true,force:true,resolve:{'sync.kicad_pcb':'github'}});
  assert.equal(forced.updated.length,0);
  assert.equal(await content(),board('A2'));
  await api(`/api/projects/${projectId}/github/pull`,{resolve:{'sync.kicad_pcb':'github'}});
  console.log('PASS conflicting online edits stay intact');

  await ctl('commit',{fullName:repo,files:{'sync.kicad_pcb':board('A0')},author:login});
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',[boardId]);
  const concurrent=pull();
  let waiting=false;
  for(let n=0;n<100;n++) {
    const {rows:[r]}=await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND pid<>pg_backend_pid()) AS waiting");
    if(r.waiting) { waiting=true; break; }
    await new Promise((resolve)=>setTimeout(resolve,25));
  }
  assert(waiting,'pull reached the document lock');
  await save(board('A5'));
  await db.query('COMMIT');
  const changed=await concurrent;
  assert(changed.skipped.some((d:{reason:string})=>d.reason.includes('changed online')));
  assert.equal(await content(),board('A5'));
  await api(`/api/projects/${projectId}/github/pull`,{resolve:{'sync.kicad_pcb':'github'}});
  console.log('PASS edits accepted during a GitHub request are preserved');

  await ctl('commit',{fullName:repo,files:{'extra.kicad_pcb':board('A4')},author:login});
  assert((await pull()).updated.some((d:{action:string})=>d.action==='added'));
  await ctl('commit',{fullName:repo,files:{'extra.kicad_pcb':null},author:login});
  assert((await pull()).updated.some((d:{action:string})=>d.action==='removed'));
  assert(!(await info()).docs.some((d:{path:string})=>d.path==='extra.kicad_pcb'));
  console.log('PASS added and deleted GitHub files');

  if(process.env.KEEP_FIXTURE==='1') {
    const {writeFile}=await import('node:fs/promises');
    await writeFile('/private/tmp/junction-sync-fixture.json',JSON.stringify({projectId,boardId,repo,token,login,base,github}));
  }
} finally {
  await db.query('ROLLBACK');
  if(process.env.KEEP_FIXTURE!=='1') {
    if(projectId) await db.query('DELETE FROM projects WHERE id=$1',[projectId]);
    await db.query('DELETE FROM users WHERE id=$1',[user.id]);
  }
  await db.end();
}
