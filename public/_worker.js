// AVEC Manager Pro — Cloudflare Pages Advanced Mode.
// All secrets and cryptographic validation live on the server. Never embed credentials in the browser.
const encoder = new TextEncoder();
const j = (v,status=200,more={})=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...more}});
const id=()=>crypto.randomUUID();
const reference=(prefix)=>prefix+'-'+new Date().getUTCFullYear().toString().slice(-2)+'-'+Array.from(crypto.getRandomValues(new Uint8Array(6))).map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
// Références des motifs : quatre caractères hexadécimaux aléatoires, contrôlés dans D1.
async function newMotifReference(db){
 for(let attempts=0;attempts<100;attempts++){
  const bytes=crypto.getRandomValues(new Uint8Array(2));
  const code=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
  const used=await db.prepare('SELECT 1 FROM solidarity_motifs WHERE reference=? LIMIT 1').bind(code).first();
  if(!used)return code;
 }
 throw Error('Impossible de générer une référence unique, recommencez');
}
// L'incrément s'effectue atomiquement dans SQLite et ne réutilise pas les numéros supprimés.
async function nextMovementNumber(db,motifId){
 const row=await db.prepare(`INSERT INTO solidarity_movement_sequences(motif_id,last_number)
 VALUES(?,1) ON CONFLICT(motif_id) DO UPDATE SET last_number=last_number+1
 RETURNING last_number`).bind(motifId).first();
 return row.last_number;
}

const now=()=>Date.now();
const hex=a=>[...new Uint8Array(a)].map(b=>b.toString(16).padStart(2,'0')).join('');
const digest=async s=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(s)));
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
async function hashPassword(pass,salt){let key=await crypto.subtle.importKey('raw',encoder.encode(pass),'PBKDF2',false,['deriveBits']);return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:100000,hash:'SHA-256'},key,256));}
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;};
const fail=(message,status=400)=>j({ok:false,error:message},status);
const sessionCookie=(token,age)=>`avec_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const parseCookie=(s,name)=>s.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';
function validatePassword(p){return typeof p==='string'&&p.length>=12&&p.length<=128;}
async function audit(db,user,action,target='',details=''){await db.prepare('INSERT INTO audit_logs(id,org_id,user_id,action,target,details,created_at) VALUES(?,?,?,?,?,?,?)').bind(id(),user?.org_id||null,user?.id||null,action,target,details,now()).run();}
async function auth(req,env){let token=parseCookie(req.headers.get('cookie')||'','avec_session');if(!token||!env.SESSION_PEPPER) return null;let key=await digest(token+env.SESSION_PEPPER),t=now();let row=await env.avec_d1.prepare(`SELECT u.id,u.org_id,u.email,u.name,u.role,u.active,u.password_version,s.csrf_hash,s.password_version AS session_version,s.expires_at,o.status AS org_status,o.plan,o.plan_expires_at FROM sessions s JOIN users u ON s.user_id=u.id LEFT JOIN organizations o ON u.org_id=o.id WHERE s.token_hash=?`).bind(key).first();if(!row||!row.active||row.expires_at<t||row.session_version!==row.password_version||row.org_id&&row.org_status!=='active')return null;return row;}
async function initSuperadmin(env){if(!env.SUPERADMIN_INITIAL_PASSWORD||!env.SESSION_PEPPER)throw new Error('Secrets Cloudflare manquants');let exists=await env.avec_d1.prepare("SELECT id FROM users WHERE role='superadmin' LIMIT 1").first();if(exists)return;let p=env.SUPERADMIN_INITIAL_PASSWORD;if(!validatePassword(p))throw new Error('SUPERADMIN_INITIAL_PASSWORD doit avoir 12 caractères minimum');let salt=random(),h=await hashPassword(p,salt);await env.avec_d1.prepare('INSERT OR IGNORE INTO users(id,org_id,email,name,role,password_hash,password_salt,created_at) VALUES(?,NULL,?,?,?,?,?,?)').bind(id(),'mega@service.local','Super Administrateur','superadmin',h,salt,now()).run();}
async function attempts(db,key){let r=await db.prepare('SELECT count,window_start,blocked_until FROM login_attempts WHERE identifier=?').bind(key).first();return r&&r.blocked_until>now();}
async function badAttempt(db,key){let t=now();await db.prepare(`INSERT INTO login_attempts(identifier,count,window_start,blocked_until) VALUES(?,1,?,0) ON CONFLICT(identifier) DO UPDATE SET count=CASE WHEN ?-window_start>900000 THEN 1 ELSE count+1 END,window_start=CASE WHEN ?-window_start>900000 THEN ? ELSE window_start END,blocked_until=CASE WHEN ?-window_start>900000 THEN 0 WHEN count+1>=5 THEN ?+900000 ELSE blocked_until END`).bind(key,t,t,t,t,t,t).run();}
async function readBody(req){let ct=req.headers.get('content-type')||'';if(!ct.includes('application/json'))throw Error('JSON requis');let x=await req.text();if(x.length>50000)throw Error('Corps trop volumineux');return JSON.parse(x);}
const money=x=>Number.isSafeInteger(Number(x))&&Number(x)>=0&&Number(x)<=100000000000?Number(x):null;
const goodName=x=>typeof x==='string'&&x.trim().length>=2&&x.length<=150;
const need=(v,m)=>{if(!v)throw Error(m);};
async function validateScope(db,table,record,org){let allowed=['members','cycles','loans','meetings'];need(allowed.includes(table),'Ressource interdite');return db.prepare(`SELECT * FROM ${table} WHERE id=? AND org_id=?`).bind(record,org).first();}
function utcDate(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(s||'')))return null;let d=new Date(s+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s?d:null;}
function endOfCycle(start,months){let d=utcDate(start);if(!d)return null;let y=d.getUTCFullYear(),m=d.getUTCMonth()+months,day=d.getUTCDate(),first=new Date(Date.UTC(y,m,1)),lastDay=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();return new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),Math.min(day,lastDay))).toISOString().slice(0,10);}
function dateAllowed(c,date){let d=utcDate(date),start=new Date(c.start_at).toISOString().slice(0,10),end=c.end_date||endOfCycle(start,c.duration_months||12);return !!d&&date>=start&&date<end&&d.getUTCDay()===(c.weekday??0)&&Math.floor((Math.round((d-utcDate(start))/86400000)-((Number(c.weekday??0)-utcDate(start).getUTCDay()+7)%7))/7)%Math.max(1,Number(c.frequency_days||7)/7)===0;}
async function activeCycle(db,org,cycle){return db.prepare("SELECT * FROM cycles WHERE id=? AND org_id=? AND status='active'").bind(cycle,org).first();}
async function invalidateUser(db,u){await db.prepare('UPDATE users SET password_version=password_version+1 WHERE id=?').bind(u).run();await db.prepare('DELETE FROM sessions WHERE user_id=?').bind(u).run();}
function periodCount(from,to,frequency){if(to<=from)return 0;if(frequency==='daily')return Math.floor((to-from)/86400000);let f=new Date(from),t=new Date(to);let n=(t.getUTCFullYear()-f.getUTCFullYear())*12+t.getUTCMonth()-f.getUTCMonth();if(t.getUTCDate()<f.getUTCDate())n--;return Math.max(0,n)}
function loanSituation(loan, paid, at=now()) {let principal=Math.max(0,loan.principal-(paid.p||0)),interest=Math.max(0,loan.interest_total-(paid.i||0)),existing=Math.max(0,(loan.penalty_accrued||0)-(paid.f||0));let base=principal+interest;let start=Math.max(loan.due_at,loan.penalty_last_at||loan.due_at);let periods=base>0?periodCount(start,at,loan.penalty_frequency||'daily'):0;let newPenalty=Math.round(base*Number(loan.penalty_percent||0)*periods/100);return {principal,interest,penalty:existing+newPenalty,newPenalty,periods,total:principal+interest+existing+newPenalty};}
async function loanPaid(db,loanId){return db.prepare('SELECT COALESCE(SUM(principal_amount),0) AS p,COALESCE(SUM(interest_amount),0) AS i,COALESCE(SUM(penalty_amount),0) AS f,COALESCE(SUM(amount),0) AS paid FROM repayments WHERE loan_id=?').bind(loanId).first()}
async function summary(db,org){let q=async sql=>await db.prepare(sql).bind(org).first();let members=await q('SELECT count(*) AS n FROM members WHERE org_id=? AND active=1');let savings=await q('SELECT COALESCE(SUM(amount),0) AS n FROM savings WHERE org_id=?');let loans=await q('SELECT COALESCE(SUM(principal),0) AS n FROM loans WHERE org_id=?');let paid=await q('SELECT COALESCE(SUM(principal_amount),0) AS n FROM repayments WHERE org_id=?');let interest=await q('SELECT COALESCE(SUM(interest_amount),0) AS n FROM repayments WHERE org_id=?');let expenses=await q('SELECT COALESCE(SUM(amount),0) AS n FROM expenses WHERE org_id=?');let social=await q("SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount ELSE -amount END),0) AS n FROM solidarity WHERE org_id=?");return {members:members.n,savings:savings.n,loans:loans.n,principalDue:loans.n-paid.n,interest:interest.n,expenses:expenses.n,solidarity:social.n};}
async function api(req,env){const db=env.avec_d1;if(!db||!env.avec_kv)return fail('Liaisons D1/KV absentes',503);let url=new URL(req.url),path=url.pathname,method=req.method;const post=method==='POST';
// Public self-registration: short-lived one-time token plus origin and network/account rate limits.
if(path==='/api/register-token'&&method==='GET'){
 let token=random();await env.avec_kv.put('registration:'+await digest(token), '1',{expirationTtl:600});
 return j({ok:true,token});
}
if(path==='/api/register'&&post){
 try{
  let origin=req.headers.get('origin');if(!origin||origin!==url.origin)return fail('Origine non autorisée',403);
  let b=await readBody(req), token=String(b.registration_token||'');
  if(!/^[a-f0-9]{64}$/.test(token))return fail('Actualisez le formulaire d’inscription',403);
  let key='registration:'+await digest(token),valid=await env.avec_kv.get(key);
  if(valid!=='1')return fail('Formulaire expiré : recommencez',403);
  await env.avec_kv.delete(key);
  let ip=req.headers.get('CF-Connecting-IP')||'unknown',email=String(b.email||'').trim().toLowerCase(),pwd=String(b.password||'');
  if(await attempts(db,'register-ip:'+ip)||await attempts(db,'register-email:'+email))return fail('Trop de demandes. Réessayez dans 15 minutes',429);
  // Count registrations per account/IP without revealing whether an account exists.
  await Promise.all([badAttempt(db,'register-ip:'+ip),badAttempt(db,'register-email:'+email)]);
  let org=String(b.organization||'').trim(),locality=String(b.locality||'').trim(),name=String(b.name||'').trim();
  need(goodName(org)&&goodName(name),'Nom de l’AVEC et nom du responsable requis');
  need(locality.length<=100,'Localité trop longue');
  need(/^\S+@\S+\.\S+$/.test(email)&&email.length<=200,'Adresse e-mail invalide');
  need(validatePassword(pwd),'Mot de passe de 12 à 128 caractères requis');
  need(b.password_confirm===pwd,'Les mots de passe ne correspondent pas');
  let existing=await db.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if(existing)return fail('Adresse e-mail déjà utilisée. Connectez-vous ou demandez une réinitialisation.',409);
  let oid=id(),uid=id(),t=now(),salt=random(),hash=await hashPassword(pwd,salt);
  await db.batch([
   db.prepare('INSERT INTO organizations(id,name,locality,status,plan,plan_started_at,plan_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(oid,org,locality,'active','free',t,t+10*86400000,t),
   db.prepare('INSERT INTO users(id,org_id,email,name,role,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(uid,oid,email,name,'admin',hash,salt,t),
   db.prepare('INSERT INTO audit_logs(id,org_id,user_id,action,target,details,created_at) VALUES(?,?,?,?,?,?,?)').bind(id(),oid,uid,'self_registration',oid,'Free 10 jours',t)
  ]);
  return j({ok:true,message:'Votre AVEC et votre compte administrateur ont été créés. Votre essai Free de 10 jours est actif.'},201);
 }catch(e){return fail(e.message?.includes('UNIQUE constraint')?'Adresse e-mail déjà utilisée.':('Inscription impossible : '+(e.message||'Erreur')),400);}
}
if(path==='/api/login'&&post){try{await initSuperadmin(env);let b=await readBody(req),email=String(b.email||'').trim().toLowerCase(),pwd=String(b.password||'');let ip=req.headers.get('CF-Connecting-IP')||'unknown';if(await attempts(db,'ip:'+ip)||await attempts(db,'account:'+email))return fail('Trop de tentatives : réessayez dans 15 minutes',429);let u=await db.prepare('SELECT * FROM users WHERE email=?').bind(email).first();let ok=u&&u.active&&equal(await hashPassword(pwd,u.password_salt),u.password_hash);if(!ok){await Promise.all([badAttempt(db,'ip:'+ip),badAttempt(db,'account:'+email)]);return fail('Identifiants incorrects',401);}let token=random(),csrf=random(),t=now();await db.prepare('INSERT INTO sessions(token_hash,user_id,password_version,csrf_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)').bind(await digest(token+env.SESSION_PEPPER),u.id,u.password_version,await digest(csrf+env.SESSION_PEPPER),t+8*3600000,t).run();await db.prepare('DELETE FROM login_attempts WHERE identifier IN (?,?)').bind('ip:'+ip,'account:'+email).run();await audit(db,u,'login',u.id);return j({ok:true,csrf,user:{id:u.id,name:u.name,email:u.email,role:u.role}},200,{'Set-Cookie':sessionCookie(token,8*3600)});}catch(e){return fail('Connexion impossible : '+e.message,500);}}
if(path==='/api/public-reset'&&post){try{let b=await readBody(req),email=String(b.email||'').trim().toLowerCase(),ip=req.headers.get('CF-Connecting-IP')||'unknown';if(await attempts(db,'reset:'+ip))return fail('Trop de demandes. Réessayez dans 15 minutes',429);await badAttempt(db,'reset:'+ip);let account=await db.prepare("SELECT id,org_id FROM users WHERE email=? AND role IN ('admin','agent') AND active=1").bind(email).first();if(account){let existing=await db.prepare("SELECT id FROM reset_requests WHERE user_id=? AND status='pending'").bind(account.id).first();if(!existing)await db.prepare('INSERT INTO reset_requests(id,org_id,user_id,reason,created_at) VALUES(?,?,?,?,?)').bind(id(),account.org_id,account.id,'Demande depuis la connexion',now()).run();}return j({ok:true,message:'Si ce compte est reconnu, une demande a été enregistrée pour son responsable.'});}catch(e){return fail('Demande impossible',400);}}
const u=await auth(req,env);
if(!u)return fail('Session absente ou expirée',401);
if(path==='/api/session'&&method==='GET'){const freshCsrf=random(),token=parseCookie(req.headers.get('cookie')||'','avec_session');await db.prepare('UPDATE sessions SET csrf_hash=? WHERE token_hash=?').bind(await digest(freshCsrf+env.SESSION_PEPPER),await digest(token+env.SESSION_PEPPER)).run();return j({ok:true,csrf:freshCsrf,user:{id:u.id,name:u.name,email:u.email,role:u.role,org_id:u.org_id},plan:u.plan,expires:u.plan_expires_at});}
if(!['GET','HEAD'].includes(method)){let supplied=req.headers.get('x-csrf-token')||'';if(!equal(await digest(supplied+(env.SESSION_PEPPER||'')),u.csrf_hash))return fail('Jeton CSRF invalide',403);}
if(path==='/api/logout'&&post){let token=parseCookie(req.headers.get('cookie')||'','avec_session');await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token+env.SESSION_PEPPER)).run();return j({ok:true},200,{'Set-Cookie':sessionCookie('',0)});}
const admin=u.role==='admin'||u.role==='superadmin',staff=['admin','agent','superadmin'].includes(u.role),sa=u.role==='superadmin';
try{
if(path==='/api/change-password'&&post){let b=await readBody(req);need(validatePassword(b.newPassword),'Mot de passe : 12 caractères minimum');let account=await db.prepare('SELECT * FROM users WHERE id=?').bind(u.id).first();need(equal(await hashPassword(b.oldPassword||'',account.password_salt),account.password_hash),'Mot de passe actuel incorrect');let salt=random(),h=await hashPassword(b.newPassword,salt);await db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').bind(h,salt,u.id).run();await invalidateUser(db,u.id);await audit(db,u,'password_changed',u.id);return j({ok:true,message:'Mot de passe modifié. Reconnexion nécessaire.'},200,{'Set-Cookie':sessionCookie('',0)});}
if(path==='/api/request-reset'&&post){let b=await readBody(req);await db.prepare('INSERT INTO reset_requests(id,org_id,user_id,reason,created_at) VALUES(?,?,?,?,?)').bind(id(),u.org_id,u.id,String(b.reason||'').slice(0,250),now()).run();await audit(db,u,'reset_requested',u.id);return j({ok:true});}
if(path==='/api/load'&&method==='GET'){
let section=url.searchParams.get('section')||'summary';if(section==='profile')return j({ok:true,data:{user:{name:u.name,email:u.email,role:u.role},plan:u.plan,expires:u.plan_expires_at}});
if(section==='reset_requests'){need(admin,'Réservé aux administrateurs');let sql=sa?"SELECT r.*,u.name,u.email,u.role,o.name AS organization FROM reset_requests r JOIN users u ON r.user_id=u.id LEFT JOIN organizations o ON o.id=u.org_id WHERE r.status='pending' AND u.role='admin' ORDER BY r.created_at DESC LIMIT 100":"SELECT r.*,u.name,u.email,u.role FROM reset_requests r JOIN users u ON r.user_id=u.id WHERE r.org_id=? AND r.status='pending' AND u.role='agent' ORDER BY r.created_at DESC LIMIT 100";return j({ok:true,data:(await (sa?db.prepare(sql).all():db.prepare(sql).bind(u.org_id).all())).results});}
if(sa){let tables={organizations:'SELECT * FROM organizations ORDER BY created_at DESC LIMIT 150',users:'SELECT id,org_id,email,name,role,active,created_at FROM users ORDER BY created_at DESC LIMIT 250',audit:'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 150'};if(tables[section])return j({ok:true,data:(await db.prepare(tables[section]).all()).results});}
need(!!u.org_id,'Choisissez une association depuis la section Super Admin');if(section==='summary')return j({ok:true,data:await summary(db,u.org_id)});
if(section==='partage_bilan'){
 need(admin,'Réservé à l’administration');
 const cycleId=url.searchParams.get('cycle_id')||'';
 const cycle=await db.prepare('SELECT * FROM cycles WHERE org_id=? AND id=?').bind(u.org_id,cycleId).first();need(cycle,'Cycle introuvable');
 const oid=u.org_id;
 const all=async(sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
 const members=await all('SELECT id,code,name FROM members WHERE org_id=? ORDER BY name,id',oid);
 const savings=await all('SELECT member_id,COALESCE(SUM(shares),0) AS shares,COALESCE(SUM(amount),0) AS amount FROM savings WHERE org_id=? AND cycle_id=? GROUP BY member_id',oid,cycleId);
 const attendance=await all('SELECT member_id,COUNT(*) AS meetings,SUM(CASE WHEN present=1 THEN 1 ELSE 0 END) AS present_count,SUM(CASE WHEN present=0 THEN 1 ELSE 0 END) AS absent_count, SUM(CASE WHEN present=0 THEN fine_amount ELSE 0 END) AS fine_due,SUM(CASE WHEN present=0 AND fine_paid=1 THEN fine_amount ELSE 0 END) AS fine_paid FROM meeting_attendance WHERE org_id=? AND cycle_id=? GROUP BY member_id',oid,cycleId);
 const loans=await all('SELECT id,member_id,principal,interest_total,COALESCE(penalty_accrued,0) AS penalty_accrued,due_at,penalty_last_at,penalty_percent,penalty_frequency,status FROM loans WHERE org_id=? AND cycle_id=?',oid,cycleId);
 const repayments=await all('SELECT r.loan_id,r.principal_amount,r.interest_amount,r.penalty_amount FROM repayments r JOIN loans l ON l.id=r.loan_id WHERE r.org_id=? AND l.org_id=? AND l.cycle_id=?',oid,oid,cycleId);
 const expenses=await all('SELECT amount FROM expenses WHERE org_id=? AND cycle_id=?',oid,cycleId);
 const motifs=await all("SELECT id,reference,title,destination,contribution,frequency,start_date,end_date,status FROM solidarity_motifs WHERE org_id=? AND cycle_id=? AND destination='event' AND status='active' ORDER BY created_at",oid,cycleId);
 const contributions=await all('SELECT c.motif_id,c.member_id,c.amount FROM solidarity_contributions c JOIN solidarity_motifs m ON m.id=c.motif_id WHERE c.org_id=? AND m.org_id=? AND m.cycle_id=?',oid,oid,cycleId);
 const n=v=>Number(v||0), total=(arr,key)=>arr.reduce((a,x)=>a+n(x[key]),0);
 const by=(rows,key)=>new Map(rows.map(r=>[r[key],r]));let sv=by(savings,'member_id'),att=by(attendance,'member_id');
 let loanMembers=new Map(),loanPayments=new Map();
 for(const r of repayments){let pay=loanPayments.get(r.loan_id)||{capital:0,interest:0,penalty:0};pay.capital+=n(r.principal_amount);pay.interest+=n(r.interest_amount);pay.penalty+=n(r.penalty_amount);loanPayments.set(r.loan_id,pay)}
 let loanPenaltyDue=0, loanPenaltyPaid=0, loanInterestPaid=0;
 for(const l of loans){let p=loanPayments.get(l.id)||{capital:0,interest:0,penalty:0};let f=loanMembers.get(l.member_id)||{count:0,principal:0,interest:0,repaid:0,remaining:0,penaltyDue:0,penaltyPaid:0};let situation=loanSituation(l,{p:p.capital,i:p.interest,f:p.penalty});f.count++;f.principal+=n(l.principal);f.interest+=n(l.interest_total);f.repaid+=p.capital+p.interest;f.remaining+=situation.principal+situation.interest;f.penaltyDue+=situation.penalty;f.penaltyPaid+=p.penalty;loanPenaltyDue+=situation.penalty;loanPenaltyPaid+=p.penalty;loanInterestPaid+=p.interest;loanMembers.set(l.member_id,f)}
 let solidarityRows=[],solidDueByMember=new Map(),solidPaidByMember=new Map();
 for(const m of motifs){let dates=[],d=new Date(m.start_date+'T12:00:00Z'),end=new Date(m.end_date+'T12:00:00Z');for(let i=0;i<240&&d<=end;i++){dates.push(d.toISOString().slice(0,10));if(m.frequency==='weekly')d.setUTCDate(d.getUTCDate()+7);else{let day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+1);d.setUTCDate(Math.min(day,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()))}}let required=dates.length*n(m.contribution);let received=contributions.filter(x=>x.motif_id===m.id).reduce((a,x)=>a+n(x.amount),0);let estimated=required*members.length;solidarityRows.push({reference:m.reference,title:m.title,destination:'Évènement commun',members:members.length,contribution:n(m.contribution),periods:dates.length,estimated,received,unpaid:Math.max(0,estimated-received),status:'Non clôturé'});for(const member of members)solidDueByMember.set(member.id,(solidDueByMember.get(member.id)||0)+required)}
 for(const c of contributions)if(motifs.some(x=>x.id===c.motif_id))solidPaidByMember.set(c.member_id,(solidPaidByMember.get(c.member_id)||0)+n(c.amount));
 const shareValue=n(cycle.share_value),expensesTotal=total(expenses,'amount');const fineDue=total(attendance,'fine_due'),finePaid=total(attendance,'fine_paid'),fineUnpaid=Math.max(0,fineDue-finePaid),loansPrincipal=total(loans,'principal'),loansInterest=total(loans,'interest_total'),loanRepaid=[...loanPayments.values()].reduce((a,x)=>a+x.capital+x.interest,0),loansRemaining=Math.max(0,loansPrincipal+loansInterest-loanRepaid),solidEstimated=total(solidarityRows,'estimated'),solidReceived=total(solidarityRows,'received');
 const savingsTotal=total(savings,'amount'),sharesTotal=total(savings,'shares');const theoretical=fineDue+loansInterest+loanPenaltyDue+loanPenaltyPaid+solidEstimated;const realized=finePaid+loanInterestPaid+loanPenaltyPaid+solidReceived;const benefitNet=theoretical-expensesTotal;const availableNet=realized-expensesTotal;const count=members.length;
 const moneySplit=(value,denom,index)=>denom?Math.floor(value/denom)+(index<((value%denom)+denom)%denom?1:0):0;
 let rows=members.map((m,index)=>{let a=att.get(m.id)||{},svr=sv.get(m.id)||{},l=loanMembers.get(m.id)||{},solidExpected=solidDueByMember.get(m.id)||0,solidPaid=solidPaidByMember.get(m.id)||0;let share=moneySplit(theoretical,count,index)+n(svr.amount)-moneySplit(expensesTotal,count,index),dueFine=Math.max(0,n(a.fine_due)-n(a.fine_paid)),duePenalty=n(l.penaltyDue),dueCredit=n(l.remaining),dueSolid=Math.max(0,solidExpected-solidPaid);let final=share-dueFine-dueCredit-duePenalty-dueSolid;return {id:m.id,code:m.code,name:m.name,share,shares:n(svr.shares),savings:n(svr.amount),meetings:n(a.meetings),present:n(a.present_count),absent:n(a.absent_count),fineDue:n(a.fine_due),finePaid:n(a.fine_paid),fineUnpaid:dueFine,loanCount:n(l.count),loanPrincipal:n(l.principal),loanInterest:n(l.interest),loanRepaid:n(l.repaid),loanRemaining:dueCredit,penaltyUnpaid:duePenalty,solidDue:solidExpected,solidPaid,solidUnpaid:dueSolid,final}});
 const out={cycle:{id:cycle.id,name:cycle.name,share_value:shareValue},savings:{parts:sharesTotal,unit:shareValue,value:sharesTotal*shareValue,received:savingsTotal,inCash:savingsTotal},fines:{absences:total(attendance,'absent_count'),count:attendance.filter(a=>n(a.fine_due)>0).reduce((a,x)=>a+n(x.absent_count),0),unit:n(cycle.absence_fine),due:fineDue,received:finePaid,unpaid:fineUnpaid},loans:{count:loans.length,principal:loansPrincipal,interest:loansInterest,total:loansPrincipal+loansInterest,repaid:loanRepaid,remaining:loansRemaining,penaltyDue:loanPenaltyDue+loanPenaltyPaid,penaltyReceived:loanPenaltyPaid,penaltyUnpaid:loanPenaltyDue},solidarity:solidarityRows,recap:{savings:savingsTotal,expenses:expensesTotal,fines:fineDue,loanYield:loansInterest+loanPenaltyDue+loanPenaltyPaid,solidarity:solidEstimated,theoretical,available:realized,totalGeneral:savingsTotal-expensesTotal+theoretical,benefitTheoretical:benefitNet,benefitReceived:availableNet},rows,summary:{members:count,shares:sharesTotal,savings:savingsTotal,theoretical,allShares:rows.reduce((a,x)=>a+x.share,0),fineUnpaid:rows.reduce((a,x)=>a+x.fineUnpaid,0),loanRemaining:rows.reduce((a,x)=>a+x.loanRemaining,0),penaltyUnpaid:rows.reduce((a,x)=>a+x.penaltyUnpaid,0),solidUnpaid:rows.reduce((a,x)=>a+x.solidUnpaid,0),totalRetained:rows.reduce((a,x)=>a+x.fineUnpaid+x.loanRemaining+x.penaltyUnpaid+x.solidUnpaid,0),positive:rows.reduce((a,x)=>a+Math.max(0,x.final),0),negative:rows.reduce((a,x)=>a+Math.max(0,-x.final),0)}};
 out.summary.control=out.summary.allShares-(savingsTotal+theoretical-expensesTotal);return j({ok:true,data:out});
}
if(section==='member_reports'){
 need(staff,'Accès réservé au personnel');
 const cycleId=url.searchParams.get('cycle_id')||'';
 if(cycleId){const cycle=await db.prepare('SELECT id FROM cycles WHERE id=? AND org_id=?').bind(cycleId,u.org_id).first();need(cycle,'Cycle inconnu');}
 // Agrégats SQL isolés par association et éventuellement par cycle, sans charger tout l'historique au navigateur.
 const scope=cycleId?' AND cycle_id=?':'';
 const bindScope=(sql)=>cycleId?db.prepare(sql).bind(u.org_id,cycleId):db.prepare(sql).bind(u.org_id);
 const members=(await db.prepare('SELECT id,code,name,active FROM members WHERE org_id=? ORDER BY name,id').bind(u.org_id).all()).results;
 const savings=(await bindScope(`SELECT member_id,SUM(amount) AS value, SUM(shares) AS shares FROM savings WHERE org_id=?${scope} GROUP BY member_id`).all()).results;
 const loans=(await bindScope(`SELECT member_id,SUM(principal) AS principal,SUM(interest_total) AS interest,SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active_loans FROM loans WHERE org_id=?${scope} GROUP BY member_id`).all()).results;
 const repayments=(await (cycleId?db.prepare('SELECT l.member_id,SUM(r.amount) AS paid,SUM(r.principal_amount) AS capital_paid,SUM(r.interest_amount) AS interest_paid FROM repayments r JOIN loans l ON l.id=r.loan_id WHERE r.org_id=? AND l.org_id=? AND l.cycle_id=? GROUP BY l.member_id').bind(u.org_id,u.org_id,cycleId):db.prepare('SELECT l.member_id,SUM(r.amount) AS paid,SUM(r.principal_amount) AS capital_paid,SUM(r.interest_amount) AS interest_paid FROM repayments r JOIN loans l ON l.id=r.loan_id WHERE r.org_id=? AND l.org_id=? GROUP BY l.member_id').bind(u.org_id,u.org_id)).all()).results;
 const solidarity=(await bindScope(`SELECT member_id,SUM(CASE WHEN kind='income' THEN amount ELSE 0 END) AS contributed,SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END) AS received FROM solidarity WHERE org_id=?${scope} AND member_id IS NOT NULL GROUP BY member_id`).all()).results;
 const attend=(await bindScope(`SELECT member_id,SUM(CASE WHEN present=1 THEN 1 ELSE 0 END) AS present_count,SUM(CASE WHEN present=0 THEN 1 ELSE 0 END) AS absent_count,SUM(CASE WHEN present=0 AND fine_paid=1 THEN fine_amount ELSE 0 END) AS fines_paid,SUM(CASE WHEN present=0 AND fine_paid=0 THEN fine_amount ELSE 0 END) AS fines_unpaid FROM meeting_attendance WHERE org_id=?${scope} GROUP BY member_id`).all()).results;
 const index=rows=>new Map(rows.map(r=>[r.member_id,r]));const [sv,lo,rp,so,at]=[savings,loans,repayments,solidarity,attend].map(index);
 const n=x=>Number(x||0);
 const rows=members.map(m=>{const s=sv.get(m.id)||{},l=lo.get(m.id)||{},r=rp.get(m.id)||{},f=so.get(m.id)||{},a=at.get(m.id)||{};const principal_due=Math.max(0,n(l.principal)-n(r.capital_paid));const interest_due=Math.max(0,n(l.interest)-n(r.interest_paid));return {id:m.id,code:m.code,name:m.name,active:m.active,meetings_present:n(a.present_count),meetings_absent:n(a.absent_count),fines_paid:n(a.fines_paid),fines_unpaid:n(a.fines_unpaid),shares:n(s.shares),savings:n(s.value),credits:n(l.principal),interest_total:n(l.interest),repaid:n(r.paid),principal_due,interest_due,remaining:principal_due+interest_due,solidarity_paid:n(f.contributed),solidarity_received:n(f.received),balance:n(s.value)-principal_due-interest_due-n(a.fines_unpaid)};});
 return j({ok:true,data:{rows,scope:cycleId?'cycle':'all',cycle_id:cycleId}});
}
if(section==='meeting_unpaid_dates'){
 need(staff,'Accès réservé au personnel');
 const cid=url.searchParams.get('cycle_id');
 const cy=await db.prepare('SELECT id FROM cycles WHERE id=? AND org_id=?').bind(cid,u.org_id).first();
 need(cy,'Cycle introuvable');
 const result=await db.prepare('SELECT meeting_date FROM meeting_attendance WHERE org_id=? AND cycle_id=? AND present=0 AND fine_paid=0 AND fine_amount>0 GROUP BY meeting_date').bind(u.org_id,cid).all();
 return j({ok:true,data:result.results});
}
if(section==='meeting_detail'){need((url.searchParams.get('date')||'')<=new Date().toISOString().slice(0,10),'Réunion future verrouillée');need(staff,'Accès réservé au personnel');let cid=url.searchParams.get('cycle_id'),date=url.searchParams.get('date');let cy=await db.prepare('SELECT * FROM cycles WHERE id=? AND org_id=?').bind(cid,u.org_id).first();need(cy&&dateAllowed(cy,date),'Date hors calendrier');let members=(await db.prepare('SELECT id,name,code FROM members WHERE org_id=? AND active=1 ORDER BY name LIMIT 500').bind(u.org_id).all()).results;let attendance=(await db.prepare('SELECT member_id,present,fine_amount,fine_paid FROM meeting_attendance WHERE org_id=? AND cycle_id=? AND meeting_date=?').bind(u.org_id,cid,date).all()).results;let savings=(await db.prepare('SELECT member_id,amount,shares FROM savings WHERE org_id=? AND cycle_id=? AND meeting_id IN (SELECT id FROM meetings WHERE org_id=? AND cycle_id=? AND meeting_date=?)').bind(u.org_id,cid,u.org_id,cid,date).all()).results;return j({ok:true,data:{cycle:cy,members,attendance,savings}});}
if(section==='solidarity_motifs' || section==='solidarity_contributions' || section==='solidarity_report'){
 need(staff,'Accès réservé au personnel');const oid=u.org_id;
 if(section==='solidarity_motifs'){
  const motifs=(await db.prepare("SELECT x.*,m.name AS beneficiary_name,c.name AS cycle_name FROM solidarity_motifs x LEFT JOIN members m ON m.id=x.beneficiary_id AND m.org_id=x.org_id JOIN cycles c ON c.id=x.cycle_id WHERE x.org_id=? ORDER BY x.created_at DESC LIMIT 250").bind(oid).all()).results;
  const payments=(await db.prepare('SELECT motif_id,member_id,SUM(amount) AS paid FROM solidarity_contributions WHERE org_id=? GROUP BY motif_id,member_id').bind(oid).all()).results;
  const members=(await db.prepare('SELECT id,name,active FROM members WHERE org_id=? ORDER BY name LIMIT 500').bind(oid).all()).results;
  const cycles=(await db.prepare('SELECT id,name,status FROM cycles WHERE org_id=? ORDER BY start_at DESC LIMIT 100').bind(oid).all()).results;
  return j({ok:true,data:{motifs,payments,members,cycles}});
 }
 if(section==='solidarity_contributions'){
  const result=(await db.prepare('SELECT c.*,m.name AS member_name,x.title AS motif_name,x.contribution,x.status AS motif_status FROM solidarity_contributions c JOIN members m ON m.id=c.member_id AND m.org_id=c.org_id JOIN solidarity_motifs x ON x.id=c.motif_id AND x.org_id=c.org_id WHERE c.org_id=? ORDER BY c.payment_date DESC,c.created_at DESC LIMIT 400').bind(oid).all()).results;
  return j({ok:true,data:result});
 }
 let motif=await db.prepare('SELECT x.*,m.name AS beneficiary_name FROM solidarity_motifs x LEFT JOIN members m ON m.id=x.beneficiary_id WHERE x.id=? AND x.org_id=?').bind(url.searchParams.get('motif_id'),oid).first();need(motif,'Motif introuvable');
 const contributions=(await db.prepare('SELECT c.*,m.name AS member_name FROM solidarity_contributions c JOIN members m ON m.id=c.member_id WHERE c.motif_id=? AND c.org_id=? ORDER BY c.payment_date,c.created_at').bind(motif.id,oid).all()).results;
 return j({ok:true,data:{motif,contributions}});
}
if(section==='loan_history'){need(staff,'Accès personnel requis');let loan=await validateScope(db,'loans',url.searchParams.get('loan_id'),u.org_id);need(loan,'Crédit introuvable');let payments=(await db.prepare('SELECT amount,principal_amount,interest_amount,penalty_amount,created_at FROM repayments WHERE org_id=? AND loan_id=? ORDER BY created_at').bind(u.org_id,loan.id).all()).results;let situation=loanSituation(loan,await loanPaid(db,loan.id));return j({ok:true,data:{payments,situation}});}
if(section==='distributions'){return j({ok:true,data:(await db.prepare('SELECT d.*,c.name AS cycle_name FROM distributions d JOIN cycles c ON c.id=d.cycle_id WHERE d.org_id=? ORDER BY d.created_at DESC LIMIT 100').bind(u.org_id).all()).results});}
const queries={members:'SELECT * FROM members WHERE org_id=? ORDER BY created_at DESC LIMIT 200',cycles:'SELECT * FROM cycles WHERE org_id=? ORDER BY start_at DESC LIMIT 100',meetings:'SELECT * FROM meetings WHERE org_id=? ORDER BY created_at DESC LIMIT 150',savings:'SELECT s.*,m.name AS member_name,c.name AS cycle_name FROM savings s JOIN members m ON m.id=s.member_id JOIN cycles c ON c.id=s.cycle_id WHERE s.org_id=? ORDER BY s.created_at DESC LIMIT 200',loans:'SELECT l.*,m.name AS member_name,(SELECT COALESCE(SUM(r.amount),0) FROM repayments r WHERE r.loan_id=l.id) AS paid,(SELECT COALESCE(SUM(r.principal_amount),0) FROM repayments r WHERE r.loan_id=l.id) AS paid_principal,(SELECT COALESCE(SUM(r.interest_amount),0) FROM repayments r WHERE r.loan_id=l.id) AS paid_interest,(SELECT COALESCE(SUM(r.penalty_amount),0) FROM repayments r WHERE r.loan_id=l.id) AS paid_penalty FROM loans l JOIN members m ON m.id=l.member_id WHERE l.org_id=? ORDER BY l.created_at DESC LIMIT 150',repayments:'SELECT r.*,m.name AS member_name,l.principal AS loan_principal,l.interest_total AS loan_interest,l.penalty_accrued AS loan_penalties,l.status AS loan_status,l.due_at AS loan_due_at,l.disbursed_at AS loan_disbursed_at,l.rate_percent AS loan_rate_percent,(SELECT COALESCE(SUM(r2.principal_amount+r2.interest_amount+r2.penalty_amount),0) FROM repayments r2 WHERE r2.org_id=r.org_id AND r2.loan_id=r.loan_id AND (r2.created_at<r.created_at OR (r2.created_at=r.created_at AND r2.id<=r.id))) AS cumulative_paid FROM repayments r JOIN loans l ON l.id=r.loan_id AND l.org_id=r.org_id JOIN members m ON m.id=l.member_id AND m.org_id=r.org_id WHERE r.org_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 200',solidarity:'SELECT s.*,m.name AS member_name FROM solidarity s LEFT JOIN members m ON m.id=s.member_id WHERE s.org_id=? ORDER BY s.created_at DESC LIMIT 200',expenses:'SELECT * FROM expenses WHERE org_id=? ORDER BY created_at DESC LIMIT 200',users:"SELECT id,name,email,role,active,created_at FROM users WHERE org_id=? AND role IN ('agent','member') ORDER BY created_at DESC LIMIT 150",audit:'SELECT * FROM audit_logs WHERE org_id=? ORDER BY created_at DESC LIMIT 150'};
need(queries[section],'Section inconnue');if(['audit','users'].includes(section))need(admin,'Accès administrateur requis');return j({ok:true,data:(await db.prepare(queries[section]).bind(u.org_id).all()).results});}
if(path==='/api/save'&&post){need(staff,'Accès agent requis');let b=await readBody(req),section=b.section,data=b.data||{},t=now();need(typeof section==='string','Section obligatoire');
if(section.startsWith('solidarity_')){
 need(u.role==='admin','Administrateur requis');need(!!u.org_id,'Association requise');const oid=u.org_id;
 const motifId=String(data.motif_id||data.id||'');
 let motif=motifId?await db.prepare('SELECT * FROM solidarity_motifs WHERE id=? AND org_id=?').bind(motifId,oid).first():null;
 const passwordCheck=async()=>{const account=await db.prepare('SELECT password_hash,password_salt FROM users WHERE id=?').bind(u.id).first();need(account&&equal(await hashPassword(String(data.password||''),account.password_salt),account.password_hash),'Mot de passe administrateur incorrect');};
 const within=(date)=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&!Number.isNaN(Date.parse(date+'T12:00:00Z'));
 const active=async mid=>{let m=await db.prepare('SELECT x.*,c.status AS cycle_status FROM solidarity_motifs x JOIN cycles c ON c.id=x.cycle_id AND c.org_id=x.org_id WHERE x.id=? AND x.org_id=?').bind(mid,oid).first();need(m&&m.status==='active'&&m.cycle_status==='active','Motif ou cycle clôturé');return m;};
 if(section==='solidarity_motif_create' || section==='solidarity_motif_update'){
  if(section==='solidarity_motif_update'){need(motif,'Motif introuvable');await active(motifId);await passwordCheck();}
  const title=String(data.title||'').trim(),amount=money(data.contribution),destination=data.destination,frequency=data.frequency;
  need(title.length>=3&&title.length<=180,'Motif obligatoire (3 à 180 caractères)');need(amount>0,'Montant invalide');need(['member','event'].includes(destination),'Destination invalide');need(['weekly','monthly'].includes(frequency),'Fréquence invalide');
  need(within(data.start_date)&&within(data.end_date)&&data.end_date>=data.start_date,'Dates invalides');
  if(destination==='member'){let ben=await db.prepare('SELECT id FROM members WHERE id=? AND org_id=? AND active=1').bind(data.beneficiary_id,oid).first();need(ben,'Bénéficiaire invalide');}
  const ben=destination==='member'?data.beneficiary_id:null;
  if(section==='solidarity_motif_create'){
   const cy=await activeCycle(db,oid,data.cycle_id);need(cy,'Cycle actif requis');const newid=id(),number=await newMotifReference(db);await db.prepare('INSERT INTO solidarity_motifs(id,org_id,cycle_id,title,contribution,destination,beneficiary_id,frequency,start_date,end_date,created_at,reference) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(newid,oid,cy.id,title,amount,destination,ben,frequency,data.start_date,data.end_date,t,number).run();await audit(db,u,'solidarity_motif_created',newid);return j({ok:true,id:newid});
  }
  const n=(await db.prepare('SELECT COUNT(*) AS n FROM solidarity_contributions WHERE motif_id=? AND org_id=?').bind(motifId,oid).first()).n;
  need(!n,'Motif avec cotisations : modifications financières verrouillées');
  await db.prepare('UPDATE solidarity_motifs SET title=?,contribution=?,destination=?,beneficiary_id=?,frequency=?,start_date=?,end_date=? WHERE id=? AND org_id=?').bind(title,amount,destination,ben,frequency,data.start_date,data.end_date,motifId,oid).run();await audit(db,u,'solidarity_motif_updated',motifId);return j({ok:true});
 }
 if(section==='solidarity_motif_delete_closed'){
  need(motif&&motif.status==='closed','Suppression réservée aux motifs clôturés');
  await passwordCheck();
  need(data.confirm===true,'Confirmation explicite obligatoire');
  need(String(data.reference_confirmation||'')===String(motif.reference||''),'Numéro du motif incorrect');
  const countRow=await db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(amount),0) AS total FROM solidarity_contributions WHERE motif_id=? AND org_id=?').bind(motifId,oid).first();
  // Supprimer mouvements, compteur, motif et enregistrer la trace en un lot transactionnel D1.
  const details=`Motif ${motif.reference||motif.id}; ${countRow.n} mouvement(s); ${countRow.total} FCFA encaissés; retrait historique ${motif.withdrawn||0} FCFA; suppression définitive autorisée`;
  await db.batch([
   db.prepare('DELETE FROM solidarity_contributions WHERE motif_id=? AND org_id=?').bind(motifId,oid),
   db.prepare('DELETE FROM solidarity_movement_sequences WHERE motif_id=?').bind(motifId),
   db.prepare("DELETE FROM solidarity_motifs WHERE id=? AND org_id=? AND status='closed'").bind(motifId,oid),
   db.prepare('INSERT INTO audit_logs(id,org_id,user_id,action,target,details,created_at) VALUES(?,?,?,?,?,?,?)').bind(id(),oid,u.id,'solidarity_motif_closed_deleted',motifId,details,now())
  ]);
  return j({ok:true,deleted_movements:countRow.n});
 }
 if(section==='solidarity_motif_delete'){
  need(motif,'Motif introuvable');await active(motifId);await passwordCheck();const count=(await db.prepare('SELECT COUNT(*) AS n FROM solidarity_contributions WHERE motif_id=? AND org_id=?').bind(motifId,oid).first()).n;need(!count&&!motif.withdrawn,'Motif avec mouvements : suppression interdite');await db.prepare('DELETE FROM solidarity_motifs WHERE id=? AND org_id=?').bind(motifId,oid).run();await audit(db,u,'solidarity_motif_deleted',motifId);return j({ok:true});
 }
 if(section==='solidarity_contribution_create' || section==='solidarity_contribution_update' || section==='solidarity_contribution_delete'){
  if(section==='solidarity_contribution_delete' || section==='solidarity_contribution_update'){
   const row=await db.prepare('SELECT c.*,x.withdrawn,x.status AS motif_status FROM solidarity_contributions c JOIN solidarity_motifs x ON x.id=c.motif_id WHERE c.id=? AND c.org_id=?').bind(data.id,oid).first();need(row,'Mouvement introuvable');await passwordCheck();need(row.motif_status==='active'&&!row.withdrawn,'Motif clôturé ou fonds retirés');await active(row.motif_id);
   if(section==='solidarity_contribution_delete'){await db.prepare('DELETE FROM solidarity_contributions WHERE id=? AND org_id=?').bind(row.id,oid).run();await audit(db,u,'solidarity_contribution_deleted',row.id);return j({ok:true});}
   data.motif_id=row.motif_id;data.member_id=row.member_id;
  }
  const x=await active(data.motif_id);const member=await db.prepare('SELECT id FROM members WHERE id=? AND org_id=?').bind(data.member_id,oid).first();need(member,'Membre invalide');
  need(within(data.payment_date),'Date de paiement invalide');need(data.payment_date<=new Date().toISOString().slice(0,10),'Paiement futur interdit');
  let amt=money(data.amount);need(amt>0,'Montant reçu invalide');
  let dates=[],cur=new Date(x.start_date+'T12:00:00Z'),end=new Date(x.end_date+'T12:00:00Z');
  for(let i=0;i<240&&cur<=end;i++) {dates.push(cur.toISOString().slice(0,10));if(x.frequency==='weekly')cur.setUTCDate(cur.getUTCDate()+7);else {const day=cur.getUTCDate();cur.setUTCDate(1);cur.setUTCMonth(cur.getUTCMonth()+1);cur.setUTCDate(Math.min(day,new Date(Date.UTC(cur.getUTCFullYear(),cur.getUTCMonth()+1,0)).getUTCDate()));}}
  const expected=dates.filter(d=>d<=data.payment_date).length*x.contribution;
  need(expected>0,'Aucune cotisation exigible à cette date');
  const already=(await db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM solidarity_contributions WHERE motif_id=? AND member_id=? AND org_id=?').bind(x.id,data.member_id,oid).first()).n;
  const previous=section==='solidarity_contribution_update'?(await db.prepare('SELECT amount FROM solidarity_contributions WHERE id=? AND org_id=?').bind(data.id,oid).first()).amount:0;
  need(already-previous+amt<=expected,'Montant supérieur au reste exigible');
  if(section==='solidarity_contribution_update'){
   const row=await db.prepare('SELECT * FROM solidarity_contributions WHERE id=? AND org_id=?').bind(data.id,oid).first();need(row,'Mouvement introuvable');
   const received=(await db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM solidarity_contributions WHERE motif_id=? AND member_id=? AND org_id=? AND id<>?').bind(x.id,data.member_id,oid,row.id).first()).n;
   need(received+amt<=x.contribution*240,'Plafond de cotisation dépassé');await db.prepare('UPDATE solidarity_contributions SET amount=?,payment_date=? WHERE id=? AND org_id=?').bind(amt,data.payment_date,row.id,oid).run();await audit(db,u,'solidarity_contribution_updated',row.id);return j({ok:true});
  }
  let newid=id(),seq=await nextMovementNumber(db,x.id),number=x.reference+'-'+String(seq).padStart(3,'0');await db.prepare('INSERT INTO solidarity_contributions(id,org_id,motif_id,member_id,payment_date,amount,created_at,reference) VALUES(?,?,?,?,?,?,?,?)').bind(newid,oid,x.id,data.member_id,data.payment_date,amt,t,number).run();await audit(db,u,'solidarity_contribution_created',newid);return j({ok:true,id:newid});
 }
 if(section==='solidarity_motif_withdraw'){
  need(motif,'Motif introuvable');await active(motifId);await passwordCheck();need(data.confirm===true,'Confirmation obligatoire');
  const sum=(await db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM solidarity_contributions WHERE motif_id=? AND org_id=?').bind(motifId,oid).first()).n;
  let cur=new Date(motif.start_date+'T12:00:00Z'),end=new Date(motif.end_date+'T12:00:00Z'),periods=0;
  for(let i=0;i<240&&cur<=end;i++){periods++;if(motif.frequency==='weekly')cur.setUTCDate(cur.getUTCDate()+7);else {const d=cur.getUTCDate();cur.setUTCDate(1);cur.setUTCMonth(cur.getUTCMonth()+1);cur.setUTCDate(Math.min(d,new Date(Date.UTC(cur.getUTCFullYear(),cur.getUTCMonth()+1,0)).getUTCDate()));}}
  need(new Date().toISOString().slice(0,10)>=motif.end_date,'Clôture interdite avant la date de fin');
  const memberCount=(await db.prepare('SELECT COUNT(*) AS n FROM members WHERE org_id=? AND active=1').bind(oid).first()).n;
  const expected=periods*motif.contribution*memberCount;
  need(expected>0&&sum>=expected,'Cotisations incomplètes : '+Math.max(0,expected-sum)+' FCFA restent à encaisser');
  await db.prepare("UPDATE solidarity_motifs SET withdrawn=?,status='closed' WHERE id=? AND org_id=? AND status='active'").bind(sum,motifId,oid).run();await audit(db,u,'solidarity_motif_closed',motifId,'Retrait '+sum+' FCFA');return j({ok:true,withdrawn:sum});
 }
 return fail('Action de solidarité inconnue',400);
}
if(section==='organization'){need(sa,'Super Admin requis');need(goodName(data.name),'Nom requis');let oid=id();await db.prepare('INSERT INTO organizations(id,name,locality,plan_started_at,plan_expires_at,created_at) VALUES(?,?,?,?,?,?)').bind(oid,data.name.trim(),String(data.locality||'').slice(0,100),t,t+10*86400000,t).run();await audit(db,u,'organization_created',oid);return j({ok:true,id:oid});}
if(section==='organization_status'){need(sa,'Super Admin requis');need(['active','inactive','archived'].includes(data.status),'Statut invalide');await db.prepare('UPDATE organizations SET status=? WHERE id=?').bind(data.status,data.id).run();await audit(db,u,'organization_status',data.id,data.status);return j({ok:true});}
if(section==='organization_plan'){need(sa,'Super Admin requis');let days={free:10,standard:30,business:365};need(days[data.plan],'Plan invalide');await db.prepare('UPDATE organizations SET plan=?,plan_started_at=?,plan_expires_at=? WHERE id=?').bind(data.plan,t,t+days[data.plan]*86400000,data.id).run();await audit(db,u,'organization_plan',data.id,data.plan);return j({ok:true});}
if(section==='user_create'){need(admin,'Administrateur requis');let role=data.role;need(['admin','agent','member'].includes(role),'Rôle invalide');need(goodName(data.name)&&/^\S+@\S+\.\S+$/.test(data.email||'')&&validatePassword(data.password),'Nom, email et mot de passe (12 caractères minimum) requis');let oid=sa?data.org_id:u.org_id;need(!!oid,'Association requise');if(!sa)need(role==='agent'||role==='member','Seuls agents et membres peuvent être créés');let salt=random(),h=await hashPassword(data.password,salt),uid=id();await db.prepare('INSERT INTO users(id,org_id,email,name,role,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(uid,oid,data.email.toLowerCase().trim(),data.name.trim(),role,h,salt,t).run();await audit(db,u,'user_created',uid);return j({ok:true,id:uid});}
if(section==='user_status'||section==='user_reset'||section==='user_delete'){need(admin,'Administrateur requis');let target=await db.prepare('SELECT * FROM users WHERE id=?').bind(data.id).first();need(target&&target.role!=='superadmin'&&(sa?['admin','agent','member'].includes(target.role):target.org_id===u.org_id&&['agent','member'].includes(target.role)),'Utilisateur hors périmètre');if(section==='user_status'){need([0,1].includes(data.active),'État invalide');await db.prepare('UPDATE users SET active=? WHERE id=?').bind(data.active,target.id).run();await invalidateUser(db,target.id);}else if(section==='user_reset'){need(validatePassword(data.password),'Nouveau mot de passe : 12 caractères minimum');let salt=random(),h=await hashPassword(data.password,salt);await db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').bind(h,salt,target.id).run();await invalidateUser(db,target.id);if(data.request_id)await db.prepare("UPDATE reset_requests SET status='handled',handled_at=? WHERE id=? AND user_id=?").bind(t,data.request_id,target.id).run();}else{await db.prepare('UPDATE users SET active=0 WHERE id=?').bind(target.id).run();await invalidateUser(db,target.id);}await audit(db,u,section,target.id);return j({ok:true});}
need(!!u.org_id,'Association manquante');if(u.plan_expires_at<=t)return fail('Abonnement expiré : contactez le Super Administrateur',403);
let oid=u.org_id,cid=data.cycle_id;
if(section==='member_update'){
 need(u.role==='admin','Seul l’administrateur peut modifier un membre');
 const member=await db.prepare('SELECT id FROM members WHERE id=? AND org_id=?').bind(data.id,oid).first();need(member,'Membre introuvable');
 need(goodName(data.name),'Nom et prénoms obligatoires');
 await db.prepare('UPDATE members SET name=?,phone=?,locality=? WHERE id=? AND org_id=?').bind(String(data.name).trim(),String(data.phone||'').slice(0,30),String(data.locality||'').slice(0,100),data.id,oid).run();
 await audit(db,u,'member_updated',data.id);return j({ok:true});
}
if(section==='member_delete'){
 need(u.role==='admin','Seul l’administrateur peut supprimer un membre');
 need(data.confirm===true,'Confirmation obligatoire');
 const member=await db.prepare('SELECT id,name,active FROM members WHERE id=? AND org_id=?').bind(data.id,oid).first();need(member,'Membre introuvable');
 const account=await db.prepare('SELECT password_hash,password_salt FROM users WHERE id=?').bind(u.id).first();
 need(account&&typeof data.password==='string'&&equal(await hashPassword(data.password,account.password_salt),account.password_hash),'Mot de passe incorrect');
 const references=[['savings','member_id'],['loans','member_id'],['meeting_attendance','member_id'],['solidarity','member_id'],['distribution_items','member_id']];
 let hasRecords=false;
 for(const [table,col] of references){let row=await db.prepare(`SELECT 1 AS found FROM ${table} WHERE ${col}=? LIMIT 1`).bind(data.id).first();if(row){hasRecords=true;break;}}
 // Conservons les historiques financiers et l’identité du membre lorsque des écritures existent.
 if(hasRecords){await db.batch([db.prepare('UPDATE members SET active=0 WHERE id=? AND org_id=?').bind(data.id,oid),db.prepare('INSERT INTO audit_logs(id,org_id,user_id,action,target,details,created_at) VALUES(?,?,?,?,?,?,?)').bind(id(),oid,u.id,'member_archived',data.id,member.name,t)]);return j({ok:true,archived:true});}
 await db.batch([db.prepare('DELETE FROM members WHERE id=? AND org_id=?').bind(data.id,oid),db.prepare('INSERT INTO audit_logs(id,org_id,user_id,action,target,details,created_at) VALUES(?,?,?,?,?,?,?)').bind(id(),oid,u.id,'member_deleted',data.id,member.name,t)]);return j({ok:true,archived:false});
}
if(section==='member'){need(goodName(data.name),'Nom du membre obligatoire');let mid=id(),code='AVC-'+new Date().getUTCFullYear().toString().slice(2)+'-'+mid.replace(/-/g,'').slice(0,8).toUpperCase();await db.prepare('INSERT INTO members(id,org_id,code,name,phone,locality,created_at) VALUES(?,?,?,?,?,?,?)').bind(mid,oid,code,data.name.trim(),String(data.phone||'').slice(0,30),String(data.locality||'').slice(0,100),t).run();await audit(db,u,'member_created',mid);return j({ok:true,id:mid});}
if(section==='cycle'){need(admin,'Administrateur requis');let months=Number(data.duration_months),frequency=Number(data.frequency_days),weekday=Number(data.weekday),start=String(data.start_date||''),date=utcDate(start),fine=money(data.absence_fine);need(goodName(data.name)&&money(data.share_value)>0&&[9,12].includes(months)&&[7,14].includes(frequency)&&Number.isInteger(weekday)&&weekday>=0&&weekday<=6&&date&&fine>=0,'Paramètres du cycle invalides');let exists=await db.prepare("SELECT id FROM cycles WHERE org_id=? AND status='active'").bind(oid).first();need(!exists,'Clôturez le cycle actif avant d’en créer un autre');let cid=id(),endDate=endOfCycle(start,months);try{await db.prepare('INSERT INTO cycles(id,org_id,name,share_value,start_at,duration_months,end_date,frequency_days,weekday,absence_fine) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(cid,oid,data.name.trim(),money(data.share_value),date.getTime(),months,endDate,frequency,weekday,fine).run();}catch(e){if(String(e).includes('UNIQUE'))throw Error('Un cycle actif existe déjà');throw e;}await audit(db,u,'cycle_created',cid);return j({ok:true,id:cid,end_date:endDate});}
if(section==='cycle_update'){
 need(admin&&u.role==='admin','Seul l’administrateur de l’AVEC peut modifier un cycle');
 let cy=await activeCycle(db,oid,cid);need(cy,'Cycle clôturé ou introuvable');
 let months=Number(data.duration_months),frequency=Number(data.frequency_days),weekday=Number(data.weekday),start=String(data.start_date||''),date=utcDate(start),fine=money(data.absence_fine),part=money(data.share_value);
 need(goodName(data.name)&&part>0&&[9,12].includes(months)&&[7,14].includes(frequency)&&Number.isInteger(weekday)&&weekday>=0&&weekday<=6&&date&&fine>=0,'Paramètres du cycle invalides');
 const changed=part!==cy.share_value||months!==cy.duration_months||frequency!==cy.frequency_days||weekday!==cy.weekday||fine!==cy.absence_fine||date.getTime()!==cy.start_at;
 if(changed){
  let counts=await Promise.all(['meetings','savings','loans','solidarity','expenses','meeting_attendance'].map(table=>db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=? AND cycle_id=?`).bind(oid,cid).first()));
  need(counts.every(x=>x.n===0),'Ce cycle comporte déjà des mouvements : seul son nom peut être modifié.');
 }
 const updated=await db.prepare("UPDATE cycles SET name=?,share_value=?,start_at=?,duration_months=?,end_date=?,frequency_days=?,weekday=?,absence_fine=? WHERE id=? AND org_id=? AND status='active'").bind(data.name.trim(),part,date.getTime(),months,endOfCycle(start,months),frequency,weekday,fine,cid,oid).run();
 need(updated.meta.changes===1,'Cycle non modifiable');await audit(db,u,'cycle_updated',cid);return j({ok:true});
}
if(section==='cycle_delete'){
 need(u.role==='admin'&&!sa,'Seul l’administrateur de cette AVEC peut supprimer un cycle');
 need(typeof cid==='string'&&cid.length>0,'Cycle manquant');
 const cycle=await db.prepare('SELECT id,name,status FROM cycles WHERE id=? AND org_id=?').bind(cid,oid).first();
 need(cycle,'Cycle introuvable dans votre AVEC');
 need(data.confirm_name===cycle.name,'Le nom de confirmation ne correspond pas au cycle');
 need(data.confirm_delete===true,'Confirmez la suppression définitive');
 const account=await db.prepare('SELECT password_hash,password_salt FROM users WHERE id=? AND org_id=? AND role=\'admin\' AND active=1').bind(u.id,oid).first();
 need(account&&typeof data.password==='string'&&equal(await hashPassword(data.password,account.password_salt),account.password_hash),'Mot de passe administrateur incorrect');
 // All statements execute atomically in D1.batch. No other association can be affected.
 const wh='org_id=? AND cycle_id=?';
 const tables=['meeting_attendance','repayments','distribution_items','distributions','savings','loans','solidarity','expenses','meetings'];
 const counts={};
 for(const table of tables){
  let sql=table==='repayments'?'SELECT COUNT(*) AS n FROM repayments WHERE org_id=? AND loan_id IN (SELECT id FROM loans WHERE org_id=? AND cycle_id=?)':table==='distribution_items'?'SELECT COUNT(*) AS n FROM distribution_items WHERE distribution_id IN (SELECT id FROM distributions WHERE org_id=? AND cycle_id=?)':`SELECT COUNT(*) AS n FROM ${table} WHERE ${wh}`;
  let params=table==='repayments'?[oid,oid,cid]:[oid,cid];
  let r=await db.prepare(sql).bind(...params).first();counts[table]=r.n;
 }
 const statements=[
  db.prepare('DELETE FROM meeting_attendance WHERE org_id=? AND cycle_id=?').bind(oid,cid),
  db.prepare('DELETE FROM repayments WHERE org_id=? AND loan_id IN (SELECT id FROM loans WHERE org_id=? AND cycle_id=?)').bind(oid,oid,cid),
  db.prepare('DELETE FROM distribution_items WHERE distribution_id IN (SELECT id FROM distributions WHERE org_id=? AND cycle_id=?)').bind(oid,cid),
  db.prepare('DELETE FROM distributions WHERE org_id=? AND cycle_id=?').bind(oid,cid),
  db.prepare('DELETE FROM savings WHERE org_id=? AND cycle_id=?').bind(oid,cid),
  db.prepare('DELETE FROM loans WHERE org_id=? AND cycle_id=?').bind(oid,cid),
  db.prepare('DELETE FROM solidarity WHERE org_id=? AND cycle_id=?').bind(oid,cid),
  db.prepare('DELETE FROM expenses WHERE org_id=? AND cycle_id=?').bind(oid,cid),
  db.prepare('DELETE FROM meetings WHERE org_id=? AND cycle_id=?').bind(oid,cid),
  db.prepare('DELETE FROM cycles WHERE id=? AND org_id=?').bind(cid,oid),
  db.prepare('INSERT INTO audit_logs(id,org_id,user_id,action,target,details,created_at) VALUES(?,?,?,?,?,?,?)').bind(id(),oid,u.id,'cycle_deleted',cid,JSON.stringify({name:cycle.name,status:cycle.status,deleted_records:counts}),t)
 ];
 await db.batch(statements);
 return j({ok:true,message:'Cycle et mouvements liés supprimés',deleted_records:counts});
}
if(section==='cycle_close'){need(admin&&u.role==='admin','Seul l’administrateur de l’AVEC peut clôturer');let cy=await activeCycle(db,oid,cid);need(cy,'Cycle déjà clôturé ou introuvable');let account=await db.prepare('SELECT password_hash,password_salt FROM users WHERE id=?').bind(u.id).first();need(typeof data.password==='string'&&equal(await hashPassword(data.password,account.password_salt),account.password_hash),'Mot de passe administrateur incorrect');let debt=await db.prepare('SELECT COALESCE(SUM(l.principal+l.interest_total),0) AS total FROM loans l WHERE l.org_id=? AND l.cycle_id=?').bind(oid,cid).first();let rep=await db.prepare('SELECT COALESCE(SUM(r.principal_amount+r.interest_amount),0) AS total FROM repayments r JOIN loans l ON l.id=r.loan_id WHERE l.org_id=? AND l.cycle_id=?').bind(oid,cid).first();need(debt.total===rep.total,'Clôture impossible : capital ou intérêts encore dus');let outstanding=(await db.prepare('SELECT * FROM loans WHERE org_id=? AND cycle_id=?').bind(oid,cid).all()).results;for(const loan of outstanding){let sit=loanSituation(loan,await loanPaid(db,loan.id),t);need(sit.total===0,'Clôture impossible : pénalités impayées ou non régularisées');}let upd=await db.prepare("UPDATE cycles SET status='closed',closed_at=? WHERE id=? AND org_id=? AND status='active'").bind(t,cid,oid).run();need(upd.meta.changes===1,'Cycle non clôturable');await audit(db,u,'cycle_closed',cid);return j({ok:true});}
if(section==='meeting_bulk'){
 need(typeof data.meeting_date==='string'&&data.meeting_date<=new Date().toISOString().slice(0,10),'Réunion future verrouillée');
 let cy=await activeCycle(db,oid,cid);need(cy&&dateAllowed(cy,data.meeting_date),'Cycle clôturé ou date non autorisée');
 let rows=data.rows;need(Array.isArray(rows)&&rows.length>0&&rows.length<=500,'Liste de membres invalide');
 let ids=rows.map(r=>r.member_id);need(new Set(ids).size===ids.length,'Membre en double dans le formulaire');
 let valid=(await db.prepare('SELECT id FROM members WHERE org_id=? AND active=1').bind(oid).all()).results;
 let allowed=new Set(valid.map(v=>v.id));
 let midRow=await db.prepare('SELECT id FROM meetings WHERE org_id=? AND cycle_id=? AND meeting_date=?').bind(oid,cid,data.meeting_date).first();
 let meetingId=midRow?.id||id();
 let prior=(await db.prepare('SELECT member_id FROM savings WHERE org_id=? AND cycle_id=? AND meeting_id IN (SELECT id FROM meetings WHERE org_id=? AND cycle_id=? AND meeting_date=?)').bind(oid,cid,oid,cid,data.meeting_date).all()).results;
 let priorIds=new Set(prior.map(v=>v.member_id));
 let statements=[],nA=0,nS=0;
 if(!midRow)statements.push(db.prepare('INSERT INTO meetings(id,org_id,cycle_id,meeting_date,created_at) VALUES(?,?,?,?,?)').bind(meetingId,oid,cid,data.meeting_date,t));
 for(let r of rows){
  need(allowed.has(r.member_id),'Membre invalide ou inactif');
  need(r.present===null||r.present===0||r.present===1,'Présence invalide');
  need(r.fine_paid===0||r.fine_paid===1,'Statut du paiement invalide');
  let shares=r.shares;
  need(Number.isSafeInteger(shares)&&shares>=0&&shares<=100000,'Nombre de parts invalide');
  need(r.present===0||r.fine_paid===0,'Paiement d’amende sans absence');
  if(r.present!==null){let fine=r.present?0:cy.absence_fine;
   statements.push(db.prepare('INSERT INTO meeting_attendance(id,org_id,cycle_id,meeting_date,member_id,present,fine_amount,fine_paid,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(cycle_id,meeting_date,member_id) DO UPDATE SET present=excluded.present,fine_amount=excluded.fine_amount,fine_paid=excluded.fine_paid').bind(id(),oid,cid,data.meeting_date,r.member_id,r.present,fine,r.present?0:r.fine_paid,t));nA++;
  }
  if(shares>0){need(!priorIds.has(r.member_id),'Cotisation déjà enregistrée pour un membre');need(Number.isSafeInteger(shares*cy.share_value),'Montant trop élevé');
   statements.push(db.prepare('INSERT INTO savings(id,org_id,cycle_id,member_id,meeting_id,shares,share_value,amount,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id(),oid,cid,r.member_id,meetingId,shares,cy.share_value,shares*cy.share_value,t));nS++;
  }
 }
 statements.push(db.prepare('INSERT INTO audit_logs(id,org_id,user_id,action,target,details,created_at) VALUES(?,?,?,?,?,?,?)').bind(id(),oid,u.id,'meeting_bulk_saved',cid,`${data.meeting_date}: ${nA} présences, ${nS} cotisations`,t));
 await db.batch(statements);return j({ok:true,saved_attendance:nA,saved_savings:nS});
}
if(section==='attendance'){need(typeof data.meeting_date==='string'&&data.meeting_date<=new Date().toISOString().slice(0,10),'Impossible de saisir une réunion future');let cy=await activeCycle(db,oid,cid);need(cy&&dateAllowed(cy,data.meeting_date),'Cycle clôturé ou date invalide');let m=await validateScope(db,'members',data.member_id,oid);need(m&&m.active,'Membre introuvable');let present=Number(data.present),paid=Number(data.fine_paid);need([0,1].includes(present)&&[0,1].includes(paid),'Présence/paiement invalide');let fine=present?0:cy.absence_fine;need(!present||paid===0,'Aucune amende pour un membre présent');await db.prepare('INSERT INTO meeting_attendance(id,org_id,cycle_id,meeting_date,member_id,present,fine_amount,fine_paid,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(cycle_id,meeting_date,member_id) DO UPDATE SET present=excluded.present,fine_amount=excluded.fine_amount,fine_paid=excluded.fine_paid').bind(id(),oid,cid,data.meeting_date,m.id,present,fine,present?0:paid,t).run();await audit(db,u,'attendance_saved',m.id,`${data.meeting_date}: ${present?'présent':'absent'} / ${paid?'payé':'impayé'}`);return j({ok:true});}
if(section==='meeting_saving'){need(typeof data.meeting_date==='string'&&data.meeting_date<=new Date().toISOString().slice(0,10),'Impossible de saisir une réunion future');let cy=await activeCycle(db,oid,cid);need(cy&&dateAllowed(cy,data.meeting_date),'Cycle clôturé ou date invalide');let m=await validateScope(db,'members',data.member_id,oid),shares=money(data.shares);need(m&&m.active&&Number.isInteger(shares)&&shares>0&&shares<=100000&&Number.isSafeInteger(shares*cy.share_value),'Nombre de parts invalide');let amount=shares*cy.share_value;let meeting=await db.prepare('SELECT id FROM meetings WHERE org_id=? AND cycle_id=? AND meeting_date=?').bind(oid,cid,data.meeting_date).first();let mid=meeting?.id||id();let entries=[];if(!meeting)entries.push(db.prepare('INSERT OR IGNORE INTO meetings(id,org_id,cycle_id,meeting_date,created_at) VALUES(?,?,?,?,?)').bind(mid,oid,cid,data.meeting_date,t));if(!meeting){await db.batch(entries);meeting=await db.prepare('SELECT id FROM meetings WHERE org_id=? AND cycle_id=? AND meeting_date=?').bind(oid,cid,data.meeting_date).first();mid=meeting.id;}let previous=await db.prepare('SELECT id FROM savings WHERE meeting_id=? AND member_id=?').bind(mid,m.id).first();need(!previous,'Cotisation déjà enregistrée pour ce membre à cette réunion');await db.prepare('INSERT INTO savings(id,org_id,cycle_id,member_id,meeting_id,shares,share_value,amount,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id(),oid,cid,m.id,mid,amount/cy.share_value,cy.share_value,amount,t).run();await audit(db,u,'meeting_saving',m.id,String(amount));return j({ok:true});}
if(section==='meeting'){need(typeof data.meeting_date==='string'&&data.meeting_date<=new Date().toISOString().slice(0,10),'Impossible de saisir une réunion future');need(await activeCycle(db,oid,cid),'Cycle actif introuvable');need(dateAllowed(await activeCycle(db,oid,cid),data.meeting_date),'Date non prévue dans le calendrier du cycle');let mid=id();await db.prepare('INSERT INTO meetings(id,org_id,cycle_id,meeting_date,notes,created_at) VALUES(?,?,?,?,?,?)').bind(mid,oid,cid,data.meeting_date,String(data.notes||'').slice(0,400),t).run();await audit(db,u,'meeting_created',mid);return j({ok:true,id:mid});}
if(section==='saving'){let cycle=await activeCycle(db,oid,cid),m=await validateScope(db,'members',data.member_id,oid),shares=money(data.shares);need(cycle&&m&&m.active&&shares&&shares<=1000,'Cycle, membre ou parts incorrects');let amount=shares*cycle.share_value,sid=id();await db.prepare('INSERT INTO savings(id,org_id,cycle_id,member_id,shares,share_value,amount,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(sid,oid,cid,m.id,shares,cycle.share_value,amount,t).run();await audit(db,u,'saving_created',sid,String(amount));return j({ok:true,id:sid,amount});}
if(section==='loan'){
 let cycle=await activeCycle(db,oid,cid),m=await validateScope(db,'members',data.member_id,oid),principal=money(data.principal),rate=Number(data.rate_percent),days=money(data.term_days),pen=Number(data.penalty_percent||0),freq=data.repayment_frequency,pf=data.penalty_frequency;
 let disb=utcDate(data.disbursement_date);need(cycle&&m&&m.active&&principal>0&&rate>=0&&rate<=100&&days>0&&days<=1095&&disb&&['weekly','monthly'].includes(freq)&&['daily','monthly'].includes(pf)&&Number.isFinite(pen)&&pen>=0&&pen<=100,'Données du prêt invalides');
 let disbTime=disb.getTime(),due=disbTime+days*86400000;need(disbTime<=t&&disbTime>=cycle.start_at,'Date de décaissement invalide');
 let saved=await db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM savings WHERE org_id=? AND cycle_id=? AND member_id=?').bind(oid,cid,m.id).first();need(principal<=saved.n*3,'Plafond maximal : 3 fois l’épargne du cycle');
 let interest=Math.round(principal*rate/100),lid=id();await db.prepare('INSERT INTO loans(id,org_id,cycle_id,member_id,principal,rate_percent,interest_total,term_days,due_at,disbursed_at,repayment_frequency,penalty_percent,penalty_frequency,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(lid,oid,cid,m.id,principal,rate,interest,days,due,disbTime,freq,pen,pf,t).run();await audit(db,u,'loan_created',lid,`${principal}/${interest}`);return j({ok:true,id:lid,interest});
}
if(section==='loan_update'){
 need(admin&&u.role==='admin','Administrateur requis');let l=await validateScope(db,'loans',data.loan_id,oid);need(l&&await activeCycle(db,oid,l.cycle_id),'Crédit actif requis');let paid=await db.prepare('SELECT COUNT(*) AS n FROM repayments WHERE loan_id=?').bind(l.id).first();need(paid.n===0,'Impossible de modifier un crédit ayant des remboursements');
 let principal=money(data.principal),rate=Number(data.rate_percent),days=money(data.term_days),pen=Number(data.penalty_percent),disb=utcDate(data.disbursement_date),freq=data.repayment_frequency,pf=data.penalty_frequency;
 need(principal>0&&rate>=0&&rate<=100&&days>0&&days<=1095&&disb&&disb.getTime()<=t&&['weekly','monthly'].includes(freq)&&['daily','monthly'].includes(pf)&&pen>=0&&pen<=100,'Paramètres invalides');
 let saved=await db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM savings WHERE org_id=? AND cycle_id=? AND member_id=?').bind(oid,l.cycle_id,l.member_id).first();need(principal<=saved.n*3,'Plafond maximal dépassé');
 await db.prepare('UPDATE loans SET principal=?,rate_percent=?,interest_total=?,term_days=?,due_at=?,disbursed_at=?,repayment_frequency=?,penalty_percent=?,penalty_frequency=? WHERE id=? AND org_id=?').bind(principal,rate,Math.round(principal*rate/100),days,disb.getTime()+days*86400000,disb.getTime(),freq,pen,pf,l.id,oid).run();await audit(db,u,'loan_updated',l.id);return j({ok:true});
}
if(section==='loan_delete'){
 need(admin&&u.role==='admin'&&data.confirm===true,'Suppression interdite');let l=await validateScope(db,'loans',data.loan_id,oid);need(l&&await activeCycle(db,oid,l.cycle_id),'Cycle clôturé ou crédit introuvable');let account=await db.prepare('SELECT password_hash,password_salt FROM users WHERE id=?').bind(u.id).first();need(typeof data.password==='string'&&equal(await hashPassword(data.password,account.password_salt),account.password_hash),'Mot de passe incorrect');let rep=await db.prepare('SELECT COUNT(*) AS n FROM repayments WHERE loan_id=?').bind(l.id).first();need(rep.n===0,'Suppression refusée : des remboursements existent');await db.prepare('DELETE FROM loans WHERE id=? AND org_id=?').bind(l.id,oid).run();await audit(db,u,'loan_deleted',l.id,`capital: ${l.principal}`);return j({ok:true});
}
if(section==='repayment_update'||section==='repayment_delete'){
 need(admin&&u.role==='admin','Action réservée à l’administrateur');
 need(typeof data.password==='string'&&data.password.length>0,'Mot de passe requis');
 const account=await db.prepare('SELECT password_hash,password_salt FROM users WHERE id=?').bind(u.id).first();
 need(account&&equal(await hashPassword(data.password,account.password_salt),account.password_hash),'Mot de passe incorrect');
 const r=await db.prepare('SELECT * FROM repayments WHERE id=? AND org_id=?').bind(data.id,oid).first();need(r,'Remboursement introuvable');
 const l=await validateScope(db,'loans',r.loan_id,oid);need(l&&await activeCycle(db,oid,l.cycle_id),'Cycle clôturé ou prêt introuvable');
 const newer=await db.prepare('SELECT COUNT(*) AS n FROM repayments WHERE loan_id=? AND org_id=? AND (created_at>? OR (created_at=? AND id>?))').bind(l.id,oid,r.created_at,r.created_at,r.id).first();
 need(newer.n===0,'Seul le dernier remboursement de ce crédit peut être corrigé');
 need(Number(l.penalty_accrued||0)===0&&Number(r.penalty_amount||0)===0,'Ce remboursement comporte des pénalités : correction comptable supervisée nécessaire');
 const before=await db.prepare('SELECT COALESCE(SUM(principal_amount),0) AS p,COALESCE(SUM(interest_amount),0) AS i FROM repayments WHERE loan_id=? AND org_id=? AND id<>?').bind(l.id,oid,r.id).first();
 const due=Math.max(0,l.principal-before.p)+Math.max(0,l.interest_total-before.i);
 let stmts=[];
 if(section==='repayment_update'){
  const amt=Number(data.amount);need(Number.isSafeInteger(amt)&&amt>0&&amt<=due,'Montant invalide ou supérieur au dû');
  const interest=Math.min(amt,Math.max(0,l.interest_total-before.i));const principal=amt-interest;
  stmts.push(db.prepare('UPDATE repayments SET amount=?,principal_amount=?,interest_amount=? WHERE id=? AND org_id=?').bind(amt,principal,interest,r.id,oid));
  stmts.push(db.prepare('UPDATE loans SET status=? WHERE id=? AND org_id=?').bind(amt===due?'paid':'active',l.id,oid));
 }else{
  stmts.push(db.prepare('DELETE FROM repayments WHERE id=? AND org_id=?').bind(r.id,oid));
  stmts.push(db.prepare("UPDATE loans SET status='active' WHERE id=? AND org_id=?").bind(l.id,oid));
 }
 stmts.push(db.prepare('INSERT INTO audit_logs(id,org_id,user_id,action,target,details,created_at) VALUES(?,?,?,?,?,?,?)').bind(id(),oid,u.id,section,r.id,`Crédit ${l.id}, ancien montant ${r.amount}, nouveau montant ${section==='repayment_delete'?0:data.amount}`,t));
 await db.batch(stmts);return j({ok:true});
}
if(section==='repayment'){
 let loan=await validateScope(db,'loans',data.loan_id,oid);need(loan&&await activeCycle(db,oid,loan.cycle_id),'Prêt invalide ou cycle clôturé');let date=utcDate(data.payment_date);const paymentDay=date?.getTime(),disbursementDay=loan.disbursed_at??loan.created_at;const sameOrLater=Number.isFinite(disbursementDay)&&paymentDay>=Math.floor(disbursementDay/86400000)*86400000;need(date&&paymentDay<=t&&sameOrLater,'Date de paiement antérieure au décaissement ou future');let paid=await loanPaid(db,loan.id),at=paymentDay+86399999;
 need(!(loan.penalty_last_at!=null&&Number(loan.penalty_accrued||0)>0&&at<loan.penalty_last_at),'Paiements rétroactifs après calcul de pénalités non autorisés');let sit=loanSituation(loan,paid,at),type=data.repayment_type;need(['partial','total'].includes(type),'Type de remboursement invalide');let amt=type==='total'?sit.total:money(data.amount);need(amt>0&&amt<=sit.total,'Montant supérieur au restant dû');let pf=Math.min(amt,sit.penalty),ia=Math.min(amt-pf,sit.interest),pa=amt-pf-ia,rid=id();
 let stmts=[];if(sit.newPenalty>0)stmts.push(db.prepare('UPDATE loans SET penalty_accrued=penalty_accrued+?,penalty_last_at=? WHERE id=? AND org_id=?').bind(sit.newPenalty,at,loan.id,oid));
 stmts.push(db.prepare('INSERT INTO repayments(id,org_id,loan_id,amount,principal_amount,interest_amount,penalty_amount,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(rid,oid,loan.id,amt,pa,ia,pf,at));
 if(amt===sit.total)stmts.push(db.prepare("UPDATE loans SET status='paid' WHERE id=? AND org_id=?").bind(loan.id,oid));
 stmts.push(db.prepare('INSERT INTO audit_logs(id,org_id,user_id,action,target,details,created_at) VALUES(?,?,?,?,?,?,?)').bind(id(),oid,u.id,'repayment_created',rid,`montant ${amt}, pénalité ${pf}`,t));await db.batch(stmts);return j({ok:true,id:rid,principal_amount:pa,interest_amount:ia,penalty_amount:pf});
}
if(section==='solidarity'){need(await activeCycle(db,oid,cid),'Cycle actif requis');let amount=money(data.amount);need(amount>0&&['income','expense'].includes(data.kind),'Montant/type invalide');let sid=id();await db.prepare('INSERT INTO solidarity(id,org_id,cycle_id,member_id,kind,amount,notes,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(sid,oid,cid,null,data.kind,amount,String(data.notes||'').slice(0,300),t).run();await audit(db,u,'solidarity_created',sid);return j({ok:true,id:sid});}
if(section==='expense_update'||section==='expense_delete'){
 need(admin,'Administrateur requis');const row=await db.prepare('SELECT e.*,c.status AS cycle_status FROM expenses e JOIN cycles c ON c.id=e.cycle_id WHERE e.id=? AND e.org_id=?').bind(data.id,u.org_id).first();
 need(row,'Dépense introuvable');need(row.cycle_status==='active','Cycle clôturé : modification interdite');
 const acct=await db.prepare('SELECT password_hash,password_salt FROM users WHERE id=?').bind(u.id).first();need(acct&&equal(await hashPassword(String(data.password||''),acct.password_salt),acct.password_hash),'Mot de passe incorrect');
 if(section==='expense_delete'){await db.prepare('DELETE FROM expenses WHERE id=? AND org_id=?').bind(row.id,u.org_id).run();await audit(db,u,'expense_deleted',row.id,'Montant '+row.amount+' / '+row.description);return j({ok:true});}
 let amount=money(data.amount),description=String(data.description||'').trim();need(amount>0&&goodName(description),'Montant et description obligatoires');await db.prepare('UPDATE expenses SET amount=?,description=? WHERE id=? AND org_id=?').bind(amount,description,row.id,u.org_id).run();await audit(db,u,'expense_updated',row.id,'Ancien montant '+row.amount+' nouveau '+amount);return j({ok:true});
}
if(section==='expense'){need(admin,'Administrateur requis');need(await activeCycle(db,oid,cid),'Cycle actif requis');let amt=money(data.amount);need(amt>0&&goodName(data.description),'Montant et description obligatoires');let eid=id();await db.prepare('INSERT INTO expenses(id,org_id,cycle_id,amount,description,created_at) VALUES(?,?,?,?,?,?)').bind(eid,oid,cid,amt,data.description.trim(),t).run();await audit(db,u,'expense_created',eid);return j({ok:true,id:eid});}
if(section==='distribution_preview'){need(admin,'Administrateur requis');let cy=await activeCycle(db,oid,cid);need(cy,'Cycle actif requis');let amounts=(await db.prepare('SELECT member_id,SUM(amount) AS amount FROM savings WHERE org_id=? AND cycle_id=? GROUP BY member_id').bind(oid,cid).all()).results;let cash=await db.prepare('SELECT COALESCE(SUM(interest_amount),0) AS v FROM repayments r JOIN loans l ON l.id=r.loan_id WHERE l.org_id=? AND l.cycle_id=?').bind(oid,cid).first();let exp=await db.prepare('SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE org_id=? AND cycle_id=?').bind(oid,cid).first();let debt=await db.prepare('SELECT COALESCE(SUM(l.principal+l.interest_total),0) AS due FROM loans l WHERE l.org_id=? AND l.cycle_id=?').bind(oid,cid).first();let rep=await db.prepare('SELECT COALESCE(SUM(r.principal_amount+r.interest_amount),0) AS paid FROM repayments r JOIN loans l ON l.id=r.loan_id WHERE l.org_id=? AND l.cycle_id=?').bind(oid,cid).first();let fines=await db.prepare('SELECT COALESCE(SUM(fine_amount),0) AS v FROM meeting_attendance WHERE org_id=? AND cycle_id=? AND fine_paid=1 AND present=0').bind(oid,cid).first();let penalties=await db.prepare('SELECT COALESCE(SUM(r.penalty_amount),0) AS v FROM repayments r JOIN loans l ON l.id=r.loan_id WHERE l.org_id=? AND l.cycle_id=?').bind(oid,cid).first();let profit=cash.v+penalties.v+fines.v-exp.v,total=amounts.reduce((a,x)=>a+x.amount,0);let ongoing=(await db.prepare('SELECT * FROM loans WHERE org_id=? AND cycle_id=?').bind(oid,cid).all()).results;let unpaidPenalty=false;for(const loan of ongoing){if(loanSituation(loan,await loanPaid(db,loan.id)).total>0){unpaidPenalty=true;break}}let eligible=!unpaidPenalty&&debt.due<=rep.paid&&profit>=0&&total>0;let rows=amounts.map(x=>({...x,share:total?Math.floor(profit*x.amount/total):0}));let rem=profit-rows.reduce((a,x)=>a+x.share,0);rows.sort((a,b)=>((profit*b.amount)%total)-((profit*a.amount)%total)||a.member_id.localeCompare(b.member_id));for(let k=0;k<rem&&k<rows.length;k++)rows[k].share++;return j({ok:true,data:{eligible,reason:eligible?'':'Crédits non soldés, épargne vide ou résultat négatif',profit,total,rows}});}
return fail('Action inconnue',404);}
return fail('Route inconnue',404);
}catch(e){let msg=e.message||'Erreur serveur';return fail(msg,400);}
}
export default {async fetch(req,env,ctx){let path=new URL(req.url).pathname;if(path.startsWith('/api/')){try{return await api(req,env);}catch(e){return fail('Erreur du serveur : vérifiez la migration D1 et les secrets Cloudflare',500);}}if(req.method==='GET' && /^\/(summary|members|cycles|meetings|savings|loans|repayments|solidarity|expenses|distributions|reports|settings|users|audit|superadmin)\/?$/.test(path)){const url=new URL(req.url);url.pathname='/index.html';return env.ASSETS.fetch(new Request(url.toString(),req));}return env.ASSETS.fetch(req);}};
