import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'steady.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,tx_date TEXT NOT NULL,merchant TEXT NOT NULL,merchant_key TEXT NOT NULL,amount REAL NOT NULL,category TEXT NOT NULL,account TEXT DEFAULT 'Imported statement',source TEXT NOT NULL,created_at TEXT NOT NULL, UNIQUE(user_id,tx_date,merchant_key,amount));
CREATE TABLE IF NOT EXISTS rules(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,merchant_key TEXT NOT NULL,category TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,merchant_key));
CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,target REAL NOT NULL,saved REAL NOT NULL,due_date TEXT NOT NULL,monthly REAL NOT NULL);
CREATE TABLE IF NOT EXISTS settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,plan TEXT NOT NULL DEFAULT 'free',theme TEXT NOT NULL DEFAULT 'light',budgets TEXT NOT NULL DEFAULT '{}');`);
db.exec(`CREATE TABLE IF NOT EXISTS usage_events(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL,period TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,kind,period));`);

const sessions = new Map();
const limits = new Map();
const authAttempts = new Map();
const demoAttempts = new Map();
const scrypt = promisify(crypto.scrypt);
const plans = { free: { name: 'Steady', price: 0, goals: 2, history: 3, scenarios: 2, transactions: 100, pdf: true }, plus: { name: 'Steady Plus', price: 5, goals: 8, history: 24, scenarios: 30, transactions: 2500, pdf: true }, complete: { name: 'Steady Complete', price: 10, goals: 25, history: 60, scenarios: 100, transactions: 10000, pdf: true } };
const categories = ['Housing','Utilities','Groceries','Dining','Transport','Health','Shopping','Subscriptions','Income','Transfer','Other'];
const safeName = s => String(s || '').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,80);
const merchantKey = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g,'').replace(/\b(inc|llc|ltd|corp|com|payment|debit|credit|online|purchase)\b/g,'').replace(/\s+/g,' ').trim().slice(0,100) || 'unknown';
function categorize(name, amount, rule) {
  if (rule) return { category: rule, confidence: 1, reason: 'Your correction rule' };
  if (amount > 0) return { category: 'Income', confidence: 0.78, reason: 'Positive transaction' };
  const m = name.toLowerCase();
  const match = [[/rent|property mgmt|mortgage|apartment maintenance/,'Housing'], [/bescom|electric|utility|water|internet|comcast|verizon|at&t|phone|airtel|jiofiber/,'Utilities'], [/whole foods|trader joe|grocery|market|safeway|costco|kroger|bigbasket|d.?mart|reliance fresh|instamart/,'Groceries'], [/restaurant|cafe|coffee|doordash|uber eats|swiggy|zomato|sweetgreen|chipotle|dining|empire restaurant/,'Dining'], [/uber|lyft|ola|rapido|namma metro|bmtc|transit|parking|shell|chevron|petrol|fuel|gas station/,'Transport'], [/pharmacy|clinic|medical|dentist|health|apollo/,'Health'], [/spotify|netflix|hulu|stream|subscription|icloud|adobe/,'Subscriptions'], [/amazon|target|walmart|myntra|store|shop/,'Shopping'], [/transfer|zelle|venmo|paypal|upi transfer/,'Transfer']].find(x => x[0].test(m))?.[1];
  const cat = match || 'Other';
  return { category: cat, confidence: cat === 'Other' ? 0.43 : 0.78, reason: cat === 'Other' ? 'Needs your review' : 'Merchant pattern' };
}
function parseCsv(text) {
  const first=text.split(/\r?\n/,1)[0]||'', counts=[',',';','\t'].map(delim=>[...first].filter(c=>c===delim).length),delimiter=[',',';','\t'][counts.indexOf(Math.max(...counts))]||',';
  const rows=[]; let row=[], cell='', quoted=false;
  for(let i=0;i<text.length;i++){const ch=text[i]; if(quoted){if(ch==='"'&&text[i+1]==='"'){cell+='"';i++}else if(ch==='"')quoted=false;else cell+=ch;}else if(ch==='"')quoted=true;else if(ch===delimiter){row.push(cell.trim());cell='';}else if(ch==='\n'){row.push(cell.trim());rows.push(row);row=[];cell='';}else if(ch!=='\r')cell+=ch;}
  if(cell||row.length){row.push(cell.trim());rows.push(row);} if(rows.length<2) return [];
  const headers=rows.shift().map(h=>h.toLowerCase().replace(/[^a-z]/g,''));
  const find=tests=>headers.findIndex(h=>tests.some(t=>h.includes(t)));
  const di=find(['date','posted','transactiondate']); const mi=find(['description','merchant','payee','name','memo','details']); let ai=find(['amount','value']);const debit=find(['debit','withdrawal','moneyout']),credit=find(['credit','deposit','moneyin']);
  if(mi<0||(ai<0&&debit<0&&credit<0)) throw Object.assign(new Error('CSV needs recognizable description and amount or debit/credit columns.'),{status:400});
  return rows.map(r=>{let amount;if(ai>=0){const raw=String(r[ai]||'').trim().replace(/[$₹,\s]|INR|Rs\.?/gi,'');amount=Number(raw.replace(/^\((.*)\)$/,'-$1'));if(/^\(.*\)$/.test(String(r[ai]||'').trim()))amount=-Math.abs(amount);if(headers[ai].includes('debit')||headers[ai].includes('withdrawal'))amount=-Math.abs(amount);if(headers[ai].includes('credit')||headers[ai].includes('deposit'))amount=Math.abs(amount);}else{const d=Number(String(r[debit]||'').replace(/[$₹,\s]|INR|Rs\.?/gi,'')),c=Number(String(r[credit]||'').replace(/[$₹,\s]|INR|Rs\.?/gi,''));amount=(Number.isFinite(c)?Math.abs(c):0)-(Number.isFinite(d)?Math.abs(d):0)}const date=String(r[di]||new Date().toISOString().slice(0,10)).trim();return {date:normalizeDate(date),merchant:safeName(r[mi]),amount};}).filter(t=>t.merchant&&Number.isFinite(t.amount)&&t.amount!==0);
}
function normalizeDate(s){const raw=String(s).trim(),parts=raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);if(parts){let a=Number(parts[1]),b=Number(parts[2]),y=Number(parts[3]);if(y<100)y+=2000;let month=a,day=b;if(a>12){day=a;month=b;}if(month>=1&&month<=12&&day>=1&&day<=31)return `${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;}const d=new Date(raw);return Number.isNaN(d.valueOf())?new Date().toISOString().slice(0,10):d.toISOString().slice(0,10)}
function parsePdf(bytes){return new Promise((resolve,reject)=>{const p=spawn(process.env.PYTHON || (process.platform==='win32'?'python':'python3'),[path.join(__dirname,'pdf_extract.py')],{stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{p.kill();reject(new Error('PDF processing timed out.'))},15000);p.stdout.on('data',b=>{out+=b;if(out.length>12*1024*1024){p.kill();reject(new Error('Extracted PDF text is too large.'))}});p.stderr.on('data',b=>err+=b);p.on('error',e=>{clearTimeout(timer);reject(e)});p.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error(err.slice(-500)||'Could not extract PDF text.'));try{resolve(JSON.parse(out))}catch{reject(new Error('PDF extraction did not return valid text.'))}});p.stdin.end(bytes);});}
function parseStatementText(text){const found=[];for(const line of text.split(/\r?\n/)){const m=line.match(/^\s*(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2})\s+(.{2,90}?)\s+\$?\(?(-?\d[\d,]*\.\d{2})\)?\s*$/);if(!m)continue;let date=m[1];if(/^\d{1,2}[/-]\d{1,2}/.test(date)){const [mm,dd,yy='2026']=date.split(/[/-]/);date=`${yy.length===2?'20'+yy:yy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`}found.push({date:normalizeDate(date),merchant:safeName(m[2]),amount:Number(m[3].replace(/,/g,''))*(m[3].startsWith('-')?-1:1)});}return found;}
function money(n){return Math.round((Number(n)||0)*100)/100}
function financialModel(userId){
  const profile=JSON.parse(db.prepare('SELECT data FROM profiles WHERE user_id=?').get(userId).data);
  const settings=db.prepare('SELECT * FROM settings WHERE user_id=?').get(userId);
  const now=new Date(),month=now.toISOString().slice(0,7),cutoff=new Date(now.getFullYear(),now.getMonth()-plans[settings.plan].history,1).toISOString().slice(0,10);
  const txs=db.prepare('SELECT * FROM transactions WHERE user_id=? AND tx_date>=? ORDER BY tx_date DESC,created_at DESC').all(userId,cutoff);
  const thisMonth=txs.filter(t=>t.tx_date.startsWith(month));
  const income=thisMonth.filter(t=>t.amount>0).reduce((s,t)=>s+t.amount,0) || Number(profile.monthlyIncome)||0;
  const expenses=thisMonth.filter(t=>t.amount<0);
  const spendBy={};for(const t of expenses)spendBy[t.category]=(spendBy[t.category]||0)+Math.abs(t.amount);
  const fixed=Number(profile.fixedCosts)||0, essentials=Number(profile.essentialBudget)||0, savings=Number(profile.emergencyFund)||0;
  const goals=db.prepare('SELECT * FROM goals WHERE user_id=? ORDER BY due_date').all(userId);
  const planned=goals.reduce((s,g)=>s+g.monthly,0), discretionaryBudget=Number(profile.discretionaryBudget)||Math.max(income-fixed-essentials-planned,0);
  const discretionarySpent=(spendBy.Dining||0)+(spendBy.Shopping||0)+(spendBy.Transport||0);
  const daysLeft=Math.max(1,new Date(now.getFullYear(),now.getMonth()+1,0).getDate()-now.getDate()+1);
  const safeToSpend=money(Math.max(0,income-fixed-essentials-planned-discretionarySpent));
  const recurring=detectRecurring(txs);
  const nudges=[];
  if(discretionarySpent>discretionaryBudget)nudges.push({title:'Flexible spending is above plan',body:`You are ${Math.round((discretionarySpent/discretionaryBudget-1)*100)}% above your monthly flexible budget. Review dining, shopping, and transport before changing a goal.`,tone:'amber'});
  for(const r of recurring.filter(x=>x.change))nudges.push({title:`${r.merchant} changed`,body:`Recent charge is ${r.change>0?'up':'down'} ${profile.currency||'INR'} ${Math.abs(r.change).toFixed(2)} compared with the previous payment.`,tone:'amber'});
  return {profile,plan:settings.plan,theme:settings.theme,budgets:JSON.parse(settings.budgets),plans,transactions:txs.slice(0,100),goals,financial:{income, fixedCosts:fixed,rent:Number(profile.monthlyRent)||0, essentialBudget:essentials, emergencyFund:savings, runwayMonths:fixed?money(savings/fixed):0, safeToSpend,daysLeft,spendBy,discretionaryBudget,discretionarySpent,remainingBudget:money(discretionaryBudget-discretionarySpent),savingsRate:income?money(Math.max(0,income-fixed-Object.values(spendBy).reduce((a,b)=>a+b,0))/income*100):0},recurring,nudges};
}
function detectRecurring(txs){const groups=new Map();for(const t of txs.filter(t=>t.amount<0)){const k=t.merchant_key;groups.set(k,[...(groups.get(k)||[]),t]);}return [...groups.values()].filter(g=>g.length>=2).map(g=>{g.sort((a,b)=>b.tx_date.localeCompare(a.tx_date));const latest=g[0],prev=g[1],gap=(new Date(latest.tx_date)-new Date(prev.tx_date))/86400000,average=(Math.abs(latest.amount)+Math.abs(prev.amount))/2; if(gap<5||gap>40)return null;const change=Math.abs(latest.amount)-Math.abs(prev.amount);return {merchant:latest.merchant,amount:Math.abs(latest.amount),lastPaid:latest.tx_date,frequency:gap<10?'Weekly':gap<18?'Biweekly':'Monthly',change:Math.abs(change)>Math.max(3,average*.05)?money(change):0,category:latest.category};}).filter(Boolean);}
function monthlyReview(userId){const st=financialModel(userId);const cats=Object.entries(st.financial.spendBy).sort((a,b)=>b[1]-a[1]);return {period:new Date().toISOString().slice(0,7),income:st.financial.income,spend:money(cats.reduce((a,[,v])=>a+v,0)),topCategories:cats.slice(0,4),goals:st.goals.map(g=>({name:g.name,saved:g.saved,target:g.target,dueDate:g.due_date})),recurringCount:st.recurring.length,savingsRate:st.financial.savingsRate,nudge:st.nudges[0]?.title||'Your plan is steady this month.'};}

function reply(res,status,obj,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(obj));}
async function body(req,limit=8*1024*1024){const chunks=[];let n=0;for await(const chunk of req){n+=chunk.length;if(n>limit)throw Object.assign(new Error('Request is too large.'),{status:413});chunks.push(chunk);}return Buffer.concat(chunks)}
async function json(req){const b=await body(req);try{return b.length?JSON.parse(b.toString()):{}}catch{throw Object.assign(new Error('Invalid JSON.'),{status:400})}}
function currentUser(req){const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('steady_session='))?.slice(15);return token?sessions.get(token):null}
function apiLimit(req){const ip=req.socket.remoteAddress||'local',now=Date.now(),arr=(limits.get(ip)||[]).filter(t=>now-t<60000);arr.push(now);limits.set(ip,arr);return arr.length<=90}
function cookie(token,maxAge){const secure=process.env.NODE_ENV==='production'?'; Secure':'';return `steady_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;}
async function handle(req,res){
  const u=new URL(req.url,'http://localhost');if(!u.pathname.startsWith('/api/'))return serveStatic(u.pathname,res);
  if(!apiLimit(req))return reply(res,429,{error:'Too many requests. Wait a moment and try again.'});
  if(req.headers.origin&&req.headers.host&&!req.headers.origin.endsWith('://'+req.headers.host))return reply(res,403,{error:'Cross-origin request refused.'});
  try{
    if(req.method==='GET'&&u.pathname==='/api/health')return reply(res,200,{ok:true,service:'steady',version:'1.0.0'});
    if(req.method==='POST'&&u.pathname==='/api/demo'){
      const ip=req.socket.remoteAddress||'unknown',now=Date.now(),attempts=(demoAttempts.get(ip)||[]).filter(t=>now-t<60*60*1000);
      if(attempts.length>=8)return reply(res,429,{error:'The sample workspace has been opened several times from this network. Please try again later.'});
      attempts.push(now);demoAttempts.set(ip,attempts);
      const id=crypto.randomUUID(),email=`sample-${id}@demo.steady.invalid`,salt=crypto.randomBytes(16).toString('hex'),hash=crypto.randomBytes(64).toString('hex'),created=new Date().toISOString();
      db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id,'Shashank Kumar',email,hash,salt,created);
      db.prepare('INSERT INTO profiles VALUES(?,?)').run(id,JSON.stringify({monthlyIncome:88500,fixedCosts:28600,monthlyRent:24000,essentialBudget:22000,emergencyFund:160000,discretionaryBudget:20000,goalsContext:'Bengaluru household balancing rent, family essentials, an emergency cushion and a planned family trip.',currency:'INR'}));
      db.prepare('INSERT INTO settings(user_id,budgets) VALUES(?,?)').run(id,JSON.stringify({Housing:26000,Utilities:3500,Groceries:14000,Dining:4500,Transport:3500,Health:2000,Shopping:5000,Subscriptions:1000,Other:5000}));
      const goals=db.prepare('INSERT INTO goals VALUES(?,?,?,?,?,?,?)');
      const dateIn=(monthsAgo,day)=>{const d=new Date(),m=new Date(d.getFullYear(),d.getMonth()-monthsAgo,1),last=new Date(m.getFullYear(),m.getMonth()+1,0).getDate(),safeDay=Math.min(day,last,monthsAgo===0?Math.max(1,d.getDate()-1):last);return `${m.getFullYear()}-${String(m.getMonth()+1).padStart(2,'0')}-${String(safeDay).padStart(2,'0')}`};
      const future=(months)=>{const d=new Date();d.setMonth(d.getMonth()+months);return d.toISOString().slice(0,10)};
      goals.run(crypto.randomUUID(),id,'Emergency cushion',300000,160000,future(12),5500);
      goals.run(crypto.randomUUID(),id,'Family trip fund',85000,25000,future(9),3500);
      const rows=[
        ['Salary credit · sample employer',88500,'Income',1],['Home rent · Bengaluru',-24000,'Housing',3],['Apartment maintenance',-2200,'Housing',4],['BESCOM electricity',-1650,'Utilities',6],['Airtel mobile',-749,'Utilities',8],['BigBasket groceries',-5300,'Groceries',9],['D-Mart groceries',-2100,'Groceries',10],['Swiggy order',-1200,'Dining',12],['Zomato order',-980,'Dining',13],['Namma Metro',-1100,'Transport',15],['Ola ride',-750,'Transport',16],['Apollo Pharmacy',-650,'Health',18],['Netflix subscription',-199,'Subscriptions',20],['Spotify subscription',-119,'Subscriptions',21],['Myntra purchase',-1400,'Shopping',23],['Amazon household',-2250,'Shopping',25],['Family education fee',-4000,'Other',27],['Cafe coffee',-340,'Dining',28]
      ];
      const variableMerchants=new Set(['BigBasket groceries','D-Mart groceries','Swiggy order','Zomato order','Ola ride','Apollo Pharmacy','Myntra purchase','Amazon household','Cafe coffee']);
      const insert=db.prepare('INSERT INTO transactions(id,user_id,tx_date,merchant,merchant_key,amount,category,account,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
      for(let monthsAgo=3;monthsAgo>=0;monthsAgo--)for(const row of rows){
        const [merchant,base,category,day]=row;let amount=base;const txDate=dateIn(monthsAgo,day),demoMerchant=variableMerchants.has(merchant)?`${merchant} · ${txDate.slice(0,7)}`:merchant;
        if(merchant==='Netflix subscription'&&monthsAgo===0)amount=-249;
        if(merchant==='BigBasket groceries'&&monthsAgo===1)amount=-6100;
        if(merchant==='Swiggy order'&&monthsAgo===0)amount=-1850;
        insert.run(crypto.randomUUID(),id,txDate,demoMerchant,merchantKey(demoMerchant),amount,category,'Sample Bengaluru household','demo',created);
      }
      const token=crypto.randomBytes(32).toString('hex');sessions.set(token,id);
      return reply(res,200,{ok:true,name:'Shashank Kumar',demo:true},{'set-cookie':cookie(token,60*60*4)});
    }
    if(req.method==='POST'&&u.pathname==='/api/auth/register'){
      const b=await json(req),name=safeName(b.name||'Shashank Kumar'),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<10||password.length>200)return reply(res,400,{error:'Enter a valid email and password with at least 10 characters.'});
      if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return reply(res,409,{error:'An account with this email already exists.'});
      const id=crypto.randomUUID(),salt=crypto.randomBytes(16).toString('hex'),hash=(await scrypt(password,salt,64)).toString('hex');
      db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id,name,email,hash,salt,new Date().toISOString());
      db.prepare('INSERT INTO profiles VALUES(?,?)').run(id,JSON.stringify({monthlyIncome:0,fixedCosts:0,essentialBudget:0,emergencyFund:0,goalsContext:'',currency:'INR'}));
      db.prepare('INSERT INTO settings(user_id) VALUES(?)').run(id);
      const token=crypto.randomBytes(32).toString('hex');sessions.set(token,id);return reply(res,201,{ok:true,name},{'set-cookie':cookie(token,60*60*24*14)});
    }
    if(req.method==='POST'&&u.pathname==='/api/auth/login'){
      const ip=req.socket.remoteAddress||'local',attempts=(authAttempts.get(ip)||[]).filter(t=>Date.now()-t<15*60*1000);if(attempts.length>=8)return reply(res,429,{error:'Too many sign-in attempts. Try again in 15 minutes.'});
      const b=await json(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
      if(!user){attempts.push(Date.now());authAttempts.set(ip,attempts);return reply(res,401,{error:'Email or password is incorrect.'});}const hash=await scrypt(password,user.pass_salt,64);if(!crypto.timingSafeEqual(hash,Buffer.from(user.pass_hash,'hex'))){attempts.push(Date.now());authAttempts.set(ip,attempts);return reply(res,401,{error:'Email or password is incorrect.'});}
      authAttempts.delete(ip);const token=crypto.randomBytes(32).toString('hex');sessions.set(token,user.id);return reply(res,200,{ok:true,name:user.name},{'set-cookie':cookie(token,60*60*24*14)});
    }
    if(req.method==='POST'&&u.pathname==='/api/auth/logout'){const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('steady_session='))?.slice(15),userId=token?sessions.get(token):null;if(token)sessions.delete(token);if(userId&&db.prepare('SELECT email FROM users WHERE id=?').get(userId)?.email.endsWith('@demo.steady.invalid'))db.prepare('DELETE FROM users WHERE id=?').run(userId);return reply(res,200,{ok:true},{'set-cookie':cookie('',0)});}
    const userId=currentUser(req);if(!userId)return reply(res,401,{error:'Sign in to continue.'});
    if(req.method==='GET'&&u.pathname==='/api/state'){const user=db.prepare('SELECT name,email FROM users WHERE id=?').get(userId);return reply(res,200,{state:financialModel(userId),name:user.name,demo:user.email.endsWith('@demo.steady.invalid')});}
    if(req.method==='GET'&&u.pathname==='/api/review')return reply(res,200,monthlyReview(userId));
    if(req.method==='PUT'&&u.pathname==='/api/profile'){const b=await json(req),p=JSON.parse(db.prepare('SELECT data FROM profiles WHERE user_id=?').get(userId).data);for(const k of ['monthlyIncome','fixedCosts','monthlyRent','essentialBudget','emergencyFund'])if(b[k]!==undefined){const n=Number(b[k]);if(!Number.isFinite(n)||n<0||n>1e8)return reply(res,400,{error:'Amounts must be between 0 and 100,000,000.'});p[k]=n;}if(b.goalsContext!==undefined)p.goalsContext=safeName(b.goalsContext);if(b.currency!==undefined&&['USD','CAD','GBP','EUR','INR'].includes(b.currency))p.currency=b.currency;db.prepare('UPDATE profiles SET data=? WHERE user_id=?').run(JSON.stringify(p),userId);return reply(res,200,{ok:true});}
    if(req.method==='PUT'&&u.pathname==='/api/settings'){const b=await json(req);if(b.theme&&['light','dark','system'].includes(b.theme))db.prepare('UPDATE settings SET theme=? WHERE user_id=?').run(b.theme,userId);if(b.plan&&plans[b.plan])db.prepare('UPDATE settings SET plan=? WHERE user_id=?').run(b.plan,userId);if(b.budgets){const clean={};for(const [k,v]of Object.entries(b.budgets)){const n=Number(v);if(categories.includes(k)&&Number.isFinite(n)&&n>=0&&n<1e7)clean[k]=n;}db.prepare('UPDATE settings SET budgets=? WHERE user_id=?').run(JSON.stringify(clean),userId);}return reply(res,200,{ok:true,notice:'Plan selection changes demo feature access only; billing is not connected.'});}
    if(req.method==='POST'&&u.pathname==='/api/goals'){const b=await json(req),name=safeName(b.name),target=Number(b.target),saved=Number(b.saved||0),monthly=Number(b.monthly||0),due=String(b.dueDate||'');if(!name||!Number.isFinite(target)||target<=0||saved<0||monthly<0||!/\d{4}-\d{2}-\d{2}/.test(due))return reply(res,400,{error:'Enter a goal name, positive target, monthly amount, and target date.'});const plan=db.prepare('SELECT plan FROM settings WHERE user_id=?').get(userId).plan,limit=plans[plan].goals,count=db.prepare('SELECT COUNT(*) n FROM goals WHERE user_id=?').get(userId).n;if(count>=limit)return reply(res,402,{error:`Your ${plans[plan].name} plan supports up to ${limit} goals.`});const id=crypto.randomUUID();db.prepare('INSERT INTO goals VALUES(?,?,?,?,?,?,?)').run(id,userId,name,target,saved,due,monthly);return reply(res,201,{ok:true,id});}
    const catRoute=u.pathname.match(/^\/api\/transactions\/([\w-]+)\/category$/);if(req.method==='PUT'&&catRoute){const b=await json(req),cat=String(b.category||'');if(!categories.includes(cat))return reply(res,400,{error:'Choose a valid category.'});const tx=db.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').get(catRoute[1],userId);if(!tx)return reply(res,404,{error:'Transaction not found.'});db.prepare('UPDATE transactions SET category=? WHERE id=?').run(cat,tx.id);db.prepare('INSERT INTO rules VALUES(?,?,?,?) ON CONFLICT(user_id,merchant_key) DO UPDATE SET category=excluded.category,updated_at=excluded.updated_at').run(userId,tx.merchant_key,cat,new Date().toISOString());return reply(res,200,{ok:true,learnedRule:tx.merchant_key,category:cat});}
    if(req.method==='POST'&&u.pathname==='/api/transactions/import'){
      const b=await json(req),filename=safeName(b.filename||'statement'),ext=path.extname(filename).toLowerCase();if(!['.csv','.pdf','.sms'].includes(ext))return reply(res,400,{error:'Upload a CSV or PDF statement, or submit an SMS transaction.'});let records=[];
      const settingsNow=db.prepare('SELECT plan FROM settings WHERE user_id=?').get(userId),planNow=plans[settingsNow.plan],period=new Date().toISOString().slice(0,7),used=db.prepare('SELECT count FROM usage_events WHERE user_id=? AND kind=? AND period=?').get(userId,'import',period)?.count||0;if(used>=planNow.transactions)return reply(res,402,{error:`Your ${planNow.name} plan includes ${planNow.transactions} imported transactions per month.`});
      if(ext==='.sms'){const text=String(b.text||'').slice(0,2000),am=text.match(/(?:₹|INR|Rs\.?|\$)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i),merchant=text.match(/(?:at|to|for)\s+(.+?)(?:\s+on\s+|\s+card\s+|\s+via\s+|$)/i);if(!am||!merchant)return reply(res,400,{error:'Could not find an amount and merchant in that SMS.'});records=[{date:new Date().toISOString().slice(0,10),merchant:safeName(merchant[1]),amount:-Math.abs(Number(am[1].replace(/,/g,'')))}];}
      if(ext==='.csv'){const text=typeof b.text==='string'?b.text:Buffer.from(String(b.base64||''),'base64').toString('utf8');if(Buffer.byteLength(text)>7*1024*1024)return reply(res,413,{error:'Statement is over 7 MB.'});records=parseCsv(text)}else if(ext==='.pdf'){const bytes=Buffer.from(String(b.base64||''),'base64');if(bytes.length<5||bytes.subarray(0,5).toString()!=='%PDF-')return reply(res,400,{error:'This file is not a valid PDF.'});if(bytes.length>7*1024*1024)return reply(res,413,{error:'Statement is over 7 MB.'});let parsed;try{parsed=await parsePdf(bytes)}catch(e){return reply(res,422,{error:'PDF could not be read. '+e.message})}records=parseStatementText(parsed.text);if(!records.length)return reply(res,422,{error:'No transactions matched this statement layout. Scanned PDFs require OCR, and bank layouts may need a parser.'})}
      if(!records.length)return reply(res,422,{error:'No transaction rows found. Check that the statement has date, description, and amount columns.'});const capacity=Math.max(0,planNow.transactions-used);if(records.length>capacity)records=records.slice(0,capacity);if(!records.length)return reply(res,402,{error:`Your ${planNow.name} monthly import allowance is used. You can change plans or wait until next month.`});if(records.length>5000)records=records.slice(0,5000);
      const rule=db.prepare('SELECT category FROM rules WHERE user_id=? AND merchant_key=?'),insert=db.prepare('INSERT OR IGNORE INTO transactions(id,user_id,tx_date,merchant,merchant_key,amount,category,source,created_at) VALUES(?,?,?,?,?,?,?,?,?)');let added=0;
      db.exec('BEGIN IMMEDIATE');try{for(const t of records){if(!t.merchant||!Number.isFinite(t.amount)||Math.abs(t.amount)>1e8)continue;const key=merchantKey(t.merchant),c=categorize(t.merchant,t.amount,rule.get(userId,key)?.category);const r=insert.run(crypto.randomUUID(),userId,t.date,safeName(t.merchant),key,money(t.amount),c.category,filename,new Date().toISOString());added+=Number(r.changes)}db.prepare('INSERT INTO usage_events VALUES(?,?,?,?) ON CONFLICT(user_id,kind,period) DO UPDATE SET count=count+excluded.count').run(userId,'import',period,added);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e;}
      return reply(res,201,{ok:true,read:records.length,added,duplicates:records.length-added,transactions:financialModel(userId).transactions.slice(0,100)});
    }
    if(req.method==='POST'&&u.pathname==='/api/scenario'){const b=await json(req),st=financialModel(userId),kind=String(b.kind),value=Number(b.value),period=new Date().toISOString().slice(0,7),plan=plans[st.plan],used=db.prepare('SELECT count FROM usage_events WHERE user_id=? AND kind=? AND period=?').get(userId,'scenario',period)?.count||0;if(used>=plan.scenarios)return reply(res,402,{error:`Your ${plan.name} plan includes ${plan.scenarios} scenario simulations per month.`});if(!Number.isFinite(value)||value<0||value>100)return reply(res,400,{error:'Scenario value must be between 0 and 100.'});const dining=st.financial.spendBy.Dining||0;let impact=0,label='';if(kind==='dining'){impact=money(dining*value/100);label='monthly goal contribution';}else if(kind==='rent'){if(!st.financial.rent)return reply(res,422,{error:'Add your monthly rent or mortgage to your financial profile before modelling a rent increase.'});impact=-money(st.financial.rent*value/100);label='monthly cash-flow change';}else if(kind==='income'){impact=money(st.financial.income*value/100);label='monthly cash-flow change';}else return reply(res,400,{error:'Choose a supported scenario.'});db.prepare('INSERT INTO usage_events VALUES(?,?,?,1) ON CONFLICT(user_id,kind,period) DO UPDATE SET count=count+1').run(userId,'scenario',period);return reply(res,200,{kind,value,impact,label,currentSafeToSpend:st.financial.safeToSpend,projectedSafeToSpend:Math.max(0,money(st.financial.safeToSpend+impact)),disclaimer:'An estimate based on the profile and imported transactions. It is educational and does not recommend securities or move money.'});}
    if(req.method==='GET'&&u.pathname==='/api/tiers')return reply(res,200,{plans,billing:'Demo entitlement switching; connect a payment provider before charging customers.'});
    return reply(res,404,{error:'Not found.'});
  }catch(e){console.error(e);return reply(res,e.status||500,{error:e.status?e.message:'The request could not be completed.'});}
}
function serveStatic(url,res){const file=url==='/'?'index.html':decodeURIComponent(url.slice(1));const target=path.resolve(__dirname,'public',file);if(!target.startsWith(path.resolve(__dirname,'public')+path.sep))return reply(res,403,{error:'Forbidden'});fs.readFile(target,(err,data)=>{if(err)return reply(res,404,{error:'Not found'});const type=target.endsWith('.html')?'text/html; charset=utf-8':target.endsWith('.css')?'text/css; charset=utf-8':target.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream';res.writeHead(200,{'content-type':type,'x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"});res.end(data);});}
const port=Number(process.env.PORT||3000);http.createServer(handle).listen(port,'0.0.0.0',()=>console.log(`Steady listening on port ${port}. Database: ${path.join(dataDir,'steady.sqlite')}`));
