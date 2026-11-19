import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { auth, origin } from './lib/auth.js';
import { pool, transaction } from './lib/db.js';

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY',
    'Referrer-Policy':'same-origin', 'Cache-Control':'no-store',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://calm-mountain-16aa.skyxujian09102.workers.dev; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  // Vercel replaces this header; direct local connections use the socket address.
  req.headers['x-smartops-client-ip'] = process.env.VERCEL
    ? String(req.headers['x-vercel-forwarded-for'] || '').split(',')[0].trim()
    : req.socket.remoteAddress || 'unknown';
  next();
});

app.use('/api', (req, res, next) => {
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    if (req.headers.origin !== origin || !req.is('application/json'))
      return res.status(403).json({ message:'请求来源无效，请刷新页面。' });
  }
  next();
});

// Only these Better Auth routes are reachable over HTTP. Account creation and
// deletion go through our authorized application routes; public signup is disabled.
const authPaths = new Map([
  ['/sign-in/email','POST'], ['/sign-out','POST'], ['/get-session','GET'], ['/ok','GET'],
]);
const handler = toNodeHandler(auth);
app.use('/api/auth', (req, res) => {
  const path = req.path.replace(/\/$/, '');
  if (authPaths.get(path) !== req.method) return res.status(404).json({ message:'接口不存在' });
  return handler(req, res);
});
app.use(express.json({ limit:'32kb' }));

function fail(status, message) { return Object.assign(new Error(message), {status}); }
function text(value, name, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw fail(400, `${name}需为 ${min}–${max} 个字符`);
  return value.trim();
}
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const statuses = ['pending','in_progress','resolved','closed'];
async function audit(client, actor, action, target) {
  await client.query('INSERT INTO audit_log (actor_id, action, target_id) VALUES ($1,$2,$3)', [actor,action,target]);
}
async function rateLimit(req, max, bucket) {
  const ip = String(req.headers['x-smartops-client-ip']);
  const key = createHash('sha256').update(`${bucket}:${ip}`).digest('hex');
  const {rows} = await pool.query(`
    INSERT INTO request_limits (key,hits,expires_at) VALUES ($1,1,now()+interval '1 minute')
    ON CONFLICT (key) DO UPDATE SET
      hits = CASE WHEN request_limits.expires_at < now() THEN 1 ELSE request_limits.hits+1 END,
      expires_at = CASE WHEN request_limits.expires_at < now() THEN now()+interval '1 minute' ELSE request_limits.expires_at END
    RETURNING hits`, [key]);
  if (rows[0].hits > max) throw fail(429,'操作过于频繁，请稍后再试。');
}
async function requireAdmin(req,res,next) {
  try {
    const session = await auth.api.getSession({ headers:fromNodeHeaders(req.headers) });
    if (!session) throw fail(401,'请先登录。');
    const { rows } = await pool.query('SELECT id,email,name,role,banned,"mustChangePassword" FROM "user" WHERE id=$1', [session.user.id]);
    const user = rows[0];
    if (!user || user.banned || user.role !== 'admin') throw fail(403,'没有管理员权限。');
    if (user.mustChangePassword && !['/api/me','/api/password'].includes(req.path))
      throw fail(403,'首次登录请先修改临时密码。');
    req.admin = user;
    next();
  } catch(error) {next(error);}
}

app.get('/api/health', async (_req,res,next) => {
  try { await pool.query('SELECT 1 FROM tickets LIMIT 1'); res.json({ok:true}); } catch(e){next(e);}
});
app.post('/api/tickets', async (req,res,next) => {
  try {
    await rateLimit(req,10,'submit');
    const body = req.body || {};
    if (!uuid(body.submissionKey)) throw fail(400,'缺少有效提交编号，请刷新页面。');
    const values = [text(body.department,'科室',1,80),text(body.type,'问题类型',1,40),text(body.title,'标题',3,160),text(body.description,'描述',5,5000),text(body.contact,'联系方式',1,160),text(body.remark || '','备注',0,1000)];
    const {rows} = await pool.query(`INSERT INTO tickets (id,department,type,title,description,contact,remark,submission_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (submission_key) DO NOTHING RETURNING id`, [randomUUID(),...values,body.submissionKey]);
    const id = rows[0]?.id || (await pool.query('SELECT id FROM tickets WHERE submission_key=$1',[body.submissionKey])).rows[0].id;
    res.status(rows.length ? 201:200).json({ success:true, data:{id} });
  } catch(e){next(e);}
});
app.get('/api/me', requireAdmin, (req,res) => res.json(req.admin));
app.post('/api/password', requireAdmin, async (req,res,next) => {
  try {
    await rateLimit(req,5,'password');
    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword;
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 128 || newPassword === currentPassword)
      throw fail(400,'新密码需为 12–128 个字符，且不能与旧密码相同。');
    const changed = await auth.api.changePassword({asResponse:true,headers:fromNodeHeaders(req.headers),body:{currentPassword,newPassword,revokeOtherSessions:true}});
    if (!changed.ok) {
      const error = await changed.json();
      throw fail(changed.status,error.message || '修改密码失败。');
    }
    await transaction(async client => {
      await client.query('UPDATE "user" SET "mustChangePassword"=false WHERE id=$1',[req.admin.id]);
      await audit(client, req.admin.id,'password.change',req.admin.id);
    });
    const cookies = changed.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie',cookies);
    res.json({success:true});
  } catch(e){next(e);}
});
app.get('/api/tickets', requireAdmin, async (req,res,next) => {
  try {
    const page = Number(req.query.page || 1);
    if (!Number.isSafeInteger(page) || page<1 || page>100000) throw fail(400,'页码无效。');
    const status = req.query.status || '';
    const q = String(req.query.q || '').trim().slice(0,160);
    if (status && !statuses.includes(status)) throw fail(400,'状态无效。');
    const where = "WHERE ($1='' OR status=$1) AND ($2='' OR position(lower($2) in lower(title || ' ' || department || ' ' || id::text))>0)";
    const count = await pool.query(`SELECT count(*)::int AS total FROM tickets ${where}`,[status,q]);
    const {rows} = await pool.query(`SELECT id,department,type,title,status,created_at FROM tickets ${where} ORDER BY created_at DESC,id LIMIT 20 OFFSET $3`,[status,q,(page-1)*20]);
    res.json({items:rows,total:count.rows[0].total,page,pageSize:20});
  }catch(e){next(e);}
});
app.get('/api/tickets/:id', requireAdmin, async (req,res,next) => {
  try {
    if (!uuid(req.params.id)) throw fail(404,'工单不存在。');
    const {rows} = await pool.query('SELECT id,department,type,title,description,contact,remark,status,created_at,updated_at FROM tickets WHERE id=$1',[req.params.id]);
    if (!rows.length) throw fail(404,'工单不存在。');
    res.json(rows[0]);
  }catch(e){next(e);}
});
app.patch('/api/tickets/:id', requireAdmin, async (req,res,next) => {
  try {
    if (!uuid(req.params.id) || !statuses.includes(req.body?.status)) throw fail(400,'工单或状态无效。');
    await transaction(async client => {
      const result = await client.query('UPDATE tickets SET status=$1,updated_at=now() WHERE id=$2 RETURNING id',[req.body.status,req.params.id]);
      if (!result.rowCount) throw fail(404,'工单不存在。');
      await audit(client,req.admin.id,`ticket.${req.body.status}`,req.params.id);
    });
    res.json({success:true});
  }catch(e){next(e);}
});
app.get('/api/admins', requireAdmin, async (_req,res,next) => {
  try {
    const {rows} = await pool.query('SELECT id,email,name,"createdAt" FROM "user" WHERE role=$1 ORDER BY "createdAt"',[ 'admin' ]);
    res.json({items:rows});
  }catch(e){next(e);}
});
app.post('/api/admins', requireAdmin, async (req,res,next) => {
  try {
    await rateLimit(req,5,'admin-create');
    const email = text(req.body?.email,'账号邮箱',3,254).toLowerCase();
    const name = text(req.body?.name,'姓名',1,80);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400,'请输入有效邮箱。');
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length<12 || password.length>128) throw fail(400,'临时密码需为 12–128 个字符。');
    // Server-only API; the browser cannot call the plugin's admin endpoints.
    const result = await auth.api.createUser({body:{email,name,password,role:'admin',data:{mustChangePassword:true}}});
    await audit(pool,req.admin.id,'admin.create',result.user.id);
    res.status(201).json({success:true,id:result.user.id});
  }catch(e){next(e);}
});
app.delete('/api/admins/:id', requireAdmin, async (req,res,next) => {
  try {
    await rateLimit(req,5,'admin-delete');
    await transaction(async client => {
      // Serialize deletion across all instances so concurrent requests cannot
      // delete the final two administrators simultaneously.
      await client.query('SELECT id FROM admin_guard WHERE id=1 FOR UPDATE');
      const {rows} = await client.query('SELECT id FROM "user" WHERE role=$1 AND (banned IS NULL OR banned=false)', ['admin']);
      if (rows.length <= 1) throw fail(409,'不能删除最后一位管理员。');
      if (req.params.id === req.admin.id) throw fail(409,'不能删除当前登录账号。');
      const target = rows.find(x=>x.id===req.params.id);
      if (!target) throw fail(404,'管理员不存在。');
      await client.query('DELETE FROM session WHERE "userId"=$1',[target.id]);
      await client.query('DELETE FROM account WHERE "userId"=$1',[target.id]);
      await client.query('DELETE FROM "user" WHERE id=$1',[target.id]);
      await audit(client,req.admin.id,'admin.delete',target.id);
    });
    res.json({success:true});
  }catch(e){next(e);}
});
app.use('/api', (_req,res)=>res.status(404).json({message:'接口不存在。'}));
app.use(express.static(fileURLToPath(new URL('./public/',import.meta.url)),{etag:true,maxAge:0}));
app.use((error,_req,res,_next) => {
  const status = typeof error.status==='number' ? error.status : typeof error.statusCode==='number' ? error.statusCode : error.type==='entity.too.large' ? 413 : 500;
  const safeStatus = status>=400 && status<=599 ? status:500;
  if(safeStatus>=500) console.error('SmartOps request failed',error.code || error.name);
  res.status(safeStatus).json({message:safeStatus>=500 ? '服务暂时不可用，请稍后重试。': error.body?.message || error.message || '请求失败。'});
});
export default app;
