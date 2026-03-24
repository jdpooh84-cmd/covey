'use strict';
const express       = require('express');
const cors          = require('cors');
const rateLimit     = require('express-rate-limit');
const path          = require('path');
const crypto        = require('crypto');

try { require('dotenv').config(); } catch (e) {}

const app  = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_API_KEY     = process.env.ANTHROPIC_API_KEY     || '';
const JWT_SECRET            = process.env.JWT_SECRET            || crypto.randomBytes(32).toString('hex');
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY     || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ID_PRO   = process.env.STRIPE_PRICE_ID_PRO   || '';
const STRIPE_PRICE_ID_AGENCY= process.env.STRIPE_PRICE_ID_AGENCY|| '';
const APP_URL               = process.env.APP_URL               || 'http://localhost:' + PORT;
const DATABASE_URL          = process.env.DATABASE_URL          || '';
const NODE_ENV              = process.env.NODE_ENV              || 'development';

/* ─── Tier definitions ──────────────────────────────────────────────────── */
const TIERS = {
  free: {
    name:'Free', price:0, scriptsPerMonth:3, scoutsPerMonth:5, videosPerMonth:1, rateLimit:10,
    features:['3 scripts/month','5 community searches','1 video plan','Ricky chat']
  },
  pro: {
    name:'Pro', price:29, stripePriceId: STRIPE_PRICE_ID_PRO,
    scriptsPerMonth:50, scoutsPerMonth:100, videosPerMonth:20, rateLimit:60,
    features:['50 scripts/month','100 searches','20 video plans','Ricky unlimited','Priority AI','All platforms']
  },
  agency: {
    name:'Agency', price:99, stripePriceId: STRIPE_PRICE_ID_AGENCY,
    scriptsPerMonth:9999, scoutsPerMonth:9999, videosPerMonth:9999, rateLimit:200,
    features:['Unlimited everything','Multi-location','White-label ready','API access','Priority support']
  }
};

/* ─── Postgres DB layer ─────────────────────────────────────────────────── */
let pool = null;

async function dbQuery(sql, params) {
  const client = await pool.connect();
  try   { return await client.query(sql, params); }
  finally { client.release(); }
}

async function initDB() {
  if (!DATABASE_URL) {
    console.log('  DB:     no DATABASE_URL — in-memory fallback (data lost on restart)');
    return;
  }
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 10
    });
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS pc_users (
        id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        email                  TEXT UNIQUE NOT NULL,
        password_hash          TEXT NOT NULL,
        name                   TEXT NOT NULL DEFAULT '',
        tier                   TEXT NOT NULL DEFAULT 'free',
        stripe_customer_id     TEXT,
        stripe_subscription_id TEXT,
        usage                  JSONB NOT NULL DEFAULT '{}',
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Auto-update updated_at
    await dbQuery(`
      CREATE OR REPLACE FUNCTION pc_set_updated_at()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$
    `);
    await dbQuery(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='pc_users_updated_at') THEN
          CREATE TRIGGER pc_users_updated_at
          BEFORE UPDATE ON pc_users
          FOR EACH ROW EXECUTE FUNCTION pc_set_updated_at();
        END IF;
      END $$
    `);
    console.log('  DB:     Postgres connected, schema ready');
  } catch (e) {
    console.error('  DB:     Postgres init failed:', e.message, '— using in-memory');
    pool = null;
  }
}

/* ─── User store: DB or in-memory fallback ──────────────────────────────── */
const memUsers = new Map();

function rowToUser(r) {
  return {
    id: r.id, email: r.email, passwordHash: r.password_hash, name: r.name,
    tier: r.tier, usage: r.usage || {},
    stripeCustomerId: r.stripe_customer_id,
    stripeSubscriptionId: r.stripe_subscription_id,
    createdAt: r.created_at
  };
}

async function uFindEmail(email) {
  const e = email.toLowerCase();
  if (pool) {
    const r = await dbQuery('SELECT * FROM pc_users WHERE LOWER(email)=$1', [e]);
    return r.rows[0] ? rowToUser(r.rows[0]) : null;
  }
  return [...memUsers.values()].find(u => u.email === e) || null;
}
async function uFindId(id) {
  if (pool) {
    const r = await dbQuery('SELECT * FROM pc_users WHERE id=$1', [id]);
    return r.rows[0] ? rowToUser(r.rows[0]) : null;
  }
  return memUsers.get(id) || null;
}
async function uFindSub(subId) {
  if (pool) {
    const r = await dbQuery('SELECT * FROM pc_users WHERE stripe_subscription_id=$1', [subId]);
    return r.rows[0] ? rowToUser(r.rows[0]) : null;
  }
  return [...memUsers.values()].find(u => u.stripeSubscriptionId === subId) || null;
}
async function uCreate(data) {
  if (pool) {
    const r = await dbQuery(
      `INSERT INTO pc_users (email,password_hash,name) VALUES ($1,$2,$3) RETURNING *`,
      [data.email.toLowerCase(), data.passwordHash, data.name]
    );
    return rowToUser(r.rows[0]);
  }
  const u = {
    id: crypto.randomUUID(), email: data.email.toLowerCase(),
    passwordHash: data.passwordHash, name: data.name,
    tier: 'free', usage: {}, stripeCustomerId: null, stripeSubscriptionId: null,
    createdAt: new Date()
  };
  memUsers.set(u.id, u);
  return u;
}
async function uUpdate(id, fields) {
  if (pool) {
    const map = {
      tier:'tier', stripeCustomerId:'stripe_customer_id',
      stripeSubscriptionId:'stripe_subscription_id',
      name:'name', email:'email', passwordHash:'password_hash', usage:'usage'
    };
    const sets = [], vals = [];
    for (const [js, col] of Object.entries(map)) {
      if (fields[js] !== undefined) {
        vals.push(js === 'usage' ? JSON.stringify(fields[js]) : fields[js]);
        sets.push(`${col}=$${vals.length}`);
      }
    }
    if (!sets.length) return uFindId(id);
    vals.push(id);
    const r = await dbQuery(`UPDATE pc_users SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    return r.rows[0] ? rowToUser(r.rows[0]) : null;
  }
  const u = memUsers.get(id);
  if (!u) return null;
  Object.assign(u, fields);
  return u;
}

/* ─── Middleware ────────────────────────────────────────────────────────── */
// Webhook must receive raw body for Stripe signature verification
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(cors({ origin:true, methods:['GET','POST','PUT','DELETE','OPTIONS'],
               allowedHeaders:['Content-Type','Authorization','x-session-id'] }));

/* ─── JWT helpers ───────────────────────────────────────────────────────── */
function signToken(payload) {
  const h = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  const s = crypto.createHmac('sha256', JWT_SECRET).update(h+'.'+b).digest('base64url');
  return h+'.'+b+'.'+s;
}
function verifyToken(token) {
  try {
    const [h,b,s] = token.split('.');
    const exp = crypto.createHmac('sha256', JWT_SECRET).update(h+'.'+b).digest('base64url');
    if (s !== exp) return null;
    const p = JSON.parse(Buffer.from(b,'base64url').toString());
    if (Date.now() - p.iat > 30*24*60*60*1000) return null;
    return p;
  } catch(e) { return null; }
}
function hashPw(pw) { return crypto.createHmac('sha256', JWT_SECRET).update(pw).digest('hex'); }

async function requireAuth(req, res, next) {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  if (!token) return res.status(401).json({ error:'Authentication required.' });
  const p = verifyToken(token);
  if (!p)    return res.status(401).json({ error:'Invalid or expired session. Please log in again.' });
  try {
    const user = await uFindId(p.userId);
    if (!user) return res.status(401).json({ error:'User not found.' });
    req.user = user; next();
  } catch(e) { res.status(500).json({ error:'Auth check failed.' }); }
}
async function optionalAuth(req, res, next) {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  if (token) {
    const p = verifyToken(token);
    if (p) { try { req.user = await uFindId(p.userId); } catch(e) {} }
  }
  next();
}

/* ─── Usage helpers ─────────────────────────────────────────────────────── */
function checkUsage(user, action) {
  const tier   = TIERS[user.tier] || TIERS.free;
  const limits = { script:tier.scriptsPerMonth, scout:tier.scoutsPerMonth, video:tier.videosPerMonth };
  const limit  = limits[action]; if (!limit) return { allowed:true };
  const mk     = new Date().getFullYear()+'-'+(new Date().getMonth()+1);
  const count  = ((user.usage||{})[mk]||{})[action] || 0;
  if (count >= limit) return { allowed:false,
    reason:`You have used all ${limit} ${action}s this month. Upgrade your plan.`,
    current:count, limit };
  return { allowed:true, current:count, limit };
}
async function recordUsage(user, action) {
  const mk   = new Date().getFullYear()+'-'+(new Date().getMonth()+1);
  const usage = { ...(user.usage||{}) };
  if (!usage[mk]) usage[mk] = {};
  usage[mk][action] = (usage[mk][action]||0) + 1;
  await uUpdate(user.id, { usage });
  user.usage = usage;
}

/* ─── Auth routes ───────────────────────────────────────────────────────── */
app.post('/api/auth/register', async (req,res) => {
  const { email, password, name } = req.body;
  if (!email||!password)         return res.status(400).json({ error:'Email and password are required.' });
  if (password.length < 8)       return res.status(400).json({ error:'Password must be at least 8 characters.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
                                 return res.status(400).json({ error:'Invalid email address.' });
  try {
    if (await uFindEmail(email)) return res.status(409).json({ error:'An account with this email already exists.' });
    const user  = await uCreate({ email, passwordHash:hashPw(password), name:(name||email.split('@')[0]).trim() });
    const token = signToken({ userId:user.id });
    res.status(201).json({ token, user:{id:user.id,email:user.email,name:user.name,tier:user.tier}, tier:TIERS[user.tier] });
  } catch(e) { console.error('[register]',e.message); res.status(500).json({ error:'Registration failed.' }); }
});

app.post('/api/auth/login', async (req,res) => {
  const { email, password } = req.body;
  if (!email||!password) return res.status(400).json({ error:'Email and password are required.' });
  try {
    const user = await uFindEmail(email);
    if (!user || user.passwordHash !== hashPw(password))
      return res.status(401).json({ error:'Invalid email or password.' });
    const token = signToken({ userId:user.id });
    res.json({ token, user:{id:user.id,email:user.email,name:user.name,tier:user.tier}, tier:TIERS[user.tier], usage:user.usage||{} });
  } catch(e) { console.error('[login]',e.message); res.status(500).json({ error:'Login failed.' }); }
});

app.get('/api/auth/me', requireAuth, (req,res) => {
  const u = req.user;
  res.json({ user:{id:u.id,email:u.email,name:u.name,tier:u.tier,createdAt:u.createdAt}, tier:TIERS[u.tier], usage:u.usage||{} });
});

app.put('/api/auth/profile', requireAuth, async (req,res) => {
  const { name, email } = req.body;
  const up = {};
  if (name)  up.name  = name.trim();
  if (email) up.email = email.toLowerCase().trim();
  try {
    const updated = await uUpdate(req.user.id, up);
    res.json({ user:{id:updated.id,email:updated.email,name:updated.name,tier:updated.tier} });
  } catch(e) { res.status(500).json({ error:'Profile update failed.' }); }
});

app.post('/api/auth/change-password', requireAuth, async (req,res) => {
  const { currentPassword, newPassword } = req.body;
  if (req.user.passwordHash !== hashPw(currentPassword))
    return res.status(401).json({ error:'Current password is incorrect.' });
  if (!newPassword||newPassword.length<8)
    return res.status(400).json({ error:'New password must be at least 8 characters.' });
  try { await uUpdate(req.user.id, { passwordHash:hashPw(newPassword) }); res.json({ success:true }); }
  catch(e) { res.status(500).json({ error:'Password change failed.' }); }
});

/* ─── Billing routes ────────────────────────────────────────────────────── */
app.get('/api/billing/plans', (req,res) => {
  res.json({ plans:TIERS, stripeEnabled:!!STRIPE_SECRET_KEY });
});

app.post('/api/billing/create-checkout', requireAuth, async (req,res) => {
  const { tier } = req.body;
  if (!TIERS[tier]||tier==='free') return res.status(400).json({ error:'Invalid plan.' });

  if (!STRIPE_SECRET_KEY) {
    // Demo mode: upgrade immediately (no real money)
    await uUpdate(req.user.id, { tier });
    return res.json({ success:true, demo:true, tier,
      message:'Upgraded to '+TIERS[tier].name+' (demo — add STRIPE_SECRET_KEY for real billing).' });
  }

  try {
    const stripe  = require('stripe')(STRIPE_SECRET_KEY);
    const priceId = TIERS[tier].stripePriceId;
    if (!priceId) return res.status(400).json({ error:'Price ID not configured. Set STRIPE_PRICE_ID_PRO or STRIPE_PRICE_ID_AGENCY.' });

    let cid = req.user.stripeCustomerId;
    if (!cid) {
      const c = await stripe.customers.create({ email:req.user.email, name:req.user.name, metadata:{ userId:req.user.id } });
      cid = c.id;
      await uUpdate(req.user.id, { stripeCustomerId:cid });
    }

    // {CHECKOUT_SESSION_ID} is a Stripe server-side placeholder, not a JS template literal
    const session = await stripe.checkout.sessions.create({
      customer:  cid,
      mode:      'subscription',
      line_items:[{ price:priceId, quantity:1 }],
      success_url: APP_URL + '?upgrade=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  APP_URL + '?upgrade=cancelled',
      allow_promotion_codes: true,
      metadata: { userId:req.user.id, tier },
      subscription_data: { metadata:{ userId:req.user.id, tier } }
    });
    res.json({ url:session.url });
  } catch(e) {
    console.error('[Stripe checkout]', e.message);
    res.status(500).json({ error:'Could not create checkout. Please try again.' });
  }
});

app.post('/api/billing/cancel', requireAuth, async (req,res) => {
  if (!STRIPE_SECRET_KEY) {
    await uUpdate(req.user.id, { tier:'free' });
    return res.json({ success:true });
  }
  try {
    const stripe = require('stripe')(STRIPE_SECRET_KEY);
    if (req.user.stripeSubscriptionId)
      await stripe.subscriptions.update(req.user.stripeSubscriptionId, { cancel_at_period_end:true });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Webhook: raw body required; respond 200 immediately, process in setImmediate
app.post('/api/billing/webhook', async (req,res) => {
  if (!STRIPE_SECRET_KEY||!STRIPE_WEBHOOK_SECRET) return res.status(200).send('OK');
  let event;
  try {
    const stripe = require('stripe')(STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch(e) {
    console.error('[Webhook verify]', e.message);
    return res.status(400).send('Webhook signature invalid.');
  }
  res.status(200).json({ received:true }); // Stripe requires 200 within 5s

  setImmediate(async () => {
    try {
      if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        if (s.metadata?.userId && s.metadata?.tier)
          await uUpdate(s.metadata.userId, { tier:s.metadata.tier, stripeSubscriptionId:s.subscription });
      }
      if (event.type === 'invoice.payment_succeeded') {
        // Ensure tier stays active on renewal
        const stripe2 = require('stripe')(STRIPE_SECRET_KEY);
        const subId   = event.data.object.subscription;
        if (subId) {
          const sub = await stripe2.subscriptions.retrieve(subId);
          if (sub.metadata?.userId && sub.metadata?.tier)
            await uUpdate(sub.metadata.userId, { tier:sub.metadata.tier, stripeSubscriptionId:subId });
        }
      }
      if (event.type==='customer.subscription.deleted'||event.type==='invoice.payment_failed') {
        const subId = event.data.object.subscription || event.data.object.id;
        if (subId) {
          const user = await uFindSub(subId);
          if (user) await uUpdate(user.id, { tier:'free', stripeSubscriptionId:null });
        }
      }
    } catch(e) { console.error('[Webhook handler]', event.type, e.message); }
  });
});

/* ─── Usage route ───────────────────────────────────────────────────────── */
app.get('/api/usage', requireAuth, (req,res) => {
  const u=req.user, tier=TIERS[u.tier]||TIERS.free, now=new Date();
  const mk=(now.getFullYear()+'-'+(now.getMonth()+1)), month=(u.usage||{})[mk]||{};
  res.json({ tier:u.tier,
    limits:{ scripts:tier.scriptsPerMonth, scouts:tier.scoutsPerMonth, videos:tier.videosPerMonth },
    used:  { scripts:month.script||0, scouts:month.scout||0, videos:month.video||0 },
    resetDate: new Date(now.getFullYear(),now.getMonth()+1,1).toISOString() });
});

/* ─── Claude proxy (usage-gated) ────────────────────────────────────────── */
app.post('/api/claude', optionalAuth, (req,res,next) => {
  const tier = req.user?(TIERS[req.user.tier]||TIERS.free):TIERS.free;
  rateLimit({ windowMs:15*60*1000, max:tier.rateLimit||10,
    standardHeaders:true, legacyHeaders:false,
    keyGenerator:r=>r.user?.id||r.ip,
    message:{ error:'Too many requests. Please wait.' } })(req,res,next);
}, async (req,res) => {
  if (!ANTHROPIC_API_KEY)
    return res.status(503).json({ error:{ message:'Server API key not configured. Add ANTHROPIC_API_KEY to Render environment variables.' } });
  if (req.user) {
    const action=req.body._action||'general';
    if (['script','scout','video'].includes(action)) {
      const check=checkUsage(req.user,action);
      if (!check.allowed)
        return res.status(402).json({ error:{ message:check.reason },upgrade:true,usageFull:true,action,current:check.current,limit:check.limit });
      await recordUsage(req.user,action);
    }
  }
  const { model,max_tokens,system,messages,tools }=req.body;
  if (!messages||!Array.isArray(messages))
    return res.status(400).json({ error:{ message:'messages array is required.' } });
  const body = { model:model||'claude-sonnet-4-20250514', max_tokens:Math.min(max_tokens||2000,4096),
    system:system||'You are a helpful assistant.', messages };
  if (tools) body.tools=tools;
  const headers = { 'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01' };
  if (tools&&tools.some(t=>t.name==='web_search')) headers['anthropic-beta']='web-search-2025-03-05';
  try {
    const fetch=(await import('node-fetch')).default;
    const up=await fetch('https://api.anthropic.com/v1/messages',{ method:'POST',headers,body:JSON.stringify(body) });
    res.status(up.status).json(await up.json());
  } catch(err) { console.error('[Claude proxy]',err.message); res.status(502).json({ error:{ message:'Could not reach Anthropic API.' } }); }
});

/* ─── Health / metrics ──────────────────────────────────────────────────── */
app.get('/health', async (req,res) => {
  let users=memUsers.size;
  if (pool) { try { const r=await dbQuery('SELECT COUNT(*) FROM pc_users'); users=parseInt(r.rows[0].count); } catch(e){} }
  res.json({ status:'ok', version:'8.0', timestamp:new Date().toISOString(),
    apiKeyConfigured:!!ANTHROPIC_API_KEY, stripeConfigured:!!STRIPE_SECRET_KEY,
    dbConnected:!!pool, environment:NODE_ENV, users, url:APP_URL });
});

app.get('/api/metrics', requireAuth, async (req,res) => {
  if (req.user.email!==(process.env.ADMIN_EMAIL||'')) return res.status(403).json({ error:'Admin only.' });
  if (pool) {
    const t=await dbQuery('SELECT COUNT(*) FROM pc_users');
    const c=await dbQuery("SELECT tier,COUNT(*) FROM pc_users GROUP BY tier");
    const counts={}; c.rows.forEach(r=>counts[r.tier]=parseInt(r.count));
    return res.json({ totalUsers:parseInt(t.rows[0].count), tierCounts:counts, timestamp:new Date().toISOString() });
  }
  const counts={free:0,pro:0,agency:0};
  memUsers.forEach(u=>counts[u.tier]=(counts[u.tier]||0)+1);
  res.json({ totalUsers:memUsers.size, tierCounts:counts, timestamp:new Date().toISOString() });
});

/* ─── Static files ──────────────────────────────────────────────────────── */
const publicDir = process.cwd();
app.use('/sw.js',(req,res,next)=>{ res.setHeader('Cache-Control','no-cache'); res.setHeader('Service-Worker-Allowed','/'); next(); },express.static(publicDir));
app.use(express.static(publicDir,{ maxAge:0 }));
app.get('*',(req,res)=>{
  if (!req.path.startsWith('/api/')&&req.path!=='/health') {
    res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
    res.sendFile(path.join(publicDir,'index.html'));
  } else { res.status(404).json({ error:{ message:'Not found.' } }); }
});
app.use((err,req,res,next)=>{ console.error('[error]',err.message); res.status(500).json({ error:{ message:'Server error.' } }); });

/* ─── Start ─────────────────────────────────────────────────────────────── */
async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║      PulseCore SaaS v8.0 — RUNNING       ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('  URL:    ' + APP_URL);
    console.log('  API:    ' + (ANTHROPIC_API_KEY?'✓ configured':'✗ MISSING'));
    console.log('  Stripe: ' + (STRIPE_SECRET_KEY?'✓ configured':'○ demo mode'));
    console.log('  JWT:    ' + (process.env.JWT_SECRET?'✓ configured':'⚠ random key (set JWT_SECRET)'));
    console.log('');
  });
  process.on('SIGTERM',()=>process.exit(0));
  process.on('SIGINT', ()=>process.exit(0));
}
start().catch(e=>{ console.error('Fatal startup error:',e); process.exit(1); });
