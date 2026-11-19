import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';

// Every test run owns a new schema. It never reads or clears production tables.
process.env.DB_SCHEMA = `smartops_test_${Date.now()}`;
process.env.APP_ORIGIN = 'http://localhost:3137';
process.env.NODE_ENV = 'test';
process.env.BETTER_AUTH_SECRET = randomBytes(48).toString('base64url');
const {pool,schema} = await import('../lib/db.js');
const {auth} = await import('../lib/auth.js');
const {migrate} = await import('../scripts/migrate.js');
const {default:app} = await import('../server.js');
const base=process.env.APP_ORIGIN;
let server;
const password='Test-only-password-2026!';
const newPassword='Changed-test-password-2026!';
const payload=()=>({department:'儿科',type:'网络问题',title:'隔离测试工单',description:'仅用于独立测试表的数据',contact:'测试内线',remark:'自动测试',submissionKey:randomUUID()});
async function request(path,{method='GET',body,cookie,origin=base}={}) {
  const response=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(origin?{Origin:origin}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
  const json=await response.json().catch(()=>null);
  const cookies=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  return {status:response.status,json,cookie:cookies,headers:response.headers};
}
async function login(email,pwd=password) {return request('/api/auth/sign-in/email',{method:'POST',body:{email,password:pwd}});}

test('SmartOps real database integration and security', {timeout:180000}, async t=>{
  try {
    await migrate();
    server=app.listen(3137,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    const initial=await auth.api.createUser({body:{email:'admin@example.com',name:'管理员',password,role:'admin',data:{mustChangePassword:true}}});
    let adminCookie, ticketId, secondId, secondCookie;

    await t.test('unauthenticated reads and account management are denied',async()=>{
      for(const path of ['/api/me','/api/tickets','/api/admins'])assert.equal((await request(path)).status,401);
      assert.equal((await request('/api/admins',{method:'POST',body:{}})).status,401);
      assert.equal((await request('/api/admins/anything',{method:'DELETE'})).status,403);
      assert.equal((await request('/api/admins/anything',{method:'DELETE',body:{}})).status,401);
    });
    await t.test('signup and plugin administration have no public route',async()=>{
      for(const path of ['/api/auth/sign-up/email','/api/auth/admin/create-user','/api/auth/admin/remove-user'])
        assert.equal((await request(path,{method:'POST',body:{}})).status,404);
    });
    await t.test('first login requires password change and stores a salted hash',async()=>{
      const result=await login('admin@example.com');assert.equal(result.status,200);assert.ok(result.cookie.includes('smartops'));adminCookie=result.cookie;
      assert.equal((await request('/api/tickets',{cookie:adminCookie})).status,403);
      assert.equal((await request('/api/me',{cookie:adminCookie})).json.mustChangePassword,true);
      const hash=(await pool.query('SELECT password FROM account WHERE "userId"=$1',[initial.user.id])).rows[0].password;
      assert.notEqual(hash,password);assert.ok(hash.length>64);
      const changed=await request('/api/password',{method:'POST',cookie:adminCookie,body:{currentPassword:password,newPassword}});
      assert.equal(changed.status,200,JSON.stringify(changed.json));
      if(changed.cookie)adminCookie=changed.cookie;
      assert.equal((await request('/api/me',{cookie:adminCookie})).json.mustChangePassword,false);
    });
    await t.test('ticket submit persists once when the same submission is retried',async()=>{
      const data=payload();data.title='<img src=x onerror=alert(1)> 测试';
      const first=await request('/api/tickets',{method:'POST',body:data});assert.equal(first.status,201);ticketId=first.json.data.id;
      const retry=await request('/api/tickets',{method:'POST',body:data});assert.equal(retry.status,200);assert.equal(retry.json.data.id,ticketId);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM tickets')).rows[0].n,1);
      assert.equal((await request('/api/tickets/'+ticketId)).status,401);
    });
    await t.test('validation, CSRF and invalid identifiers are rejected',async()=>{
      assert.equal((await request('/api/tickets',{method:'POST',body:payload(),origin:'https://evil.example'})).status,403);
      assert.equal((await request('/api/tickets',{method:'POST',body:{...payload(),contact:''}})).status,400);
      assert.equal((await request('/api/tickets/not-a-uuid',{cookie:adminCookie})).status,404);
      assert.equal((await request('/api/tickets/'+randomUUID(),{cookie:adminCookie})).status,404);
      assert.equal((await request('/api/tickets?page=-1',{cookie:adminCookie})).status,400);
      assert.equal((await request('/api/tickets?status=bad',{cookie:adminCookie})).status,400);
    });
    await t.test('authorized list, details and state changes preserve fields and audit',async()=>{
      const list=await request('/api/tickets',{cookie:adminCookie});assert.equal(list.status,200);assert.equal(list.json.total,1);
      const detail=await request('/api/tickets/'+ticketId,{cookie:adminCookie});assert.equal(detail.json.department,'儿科');assert.equal(detail.json.contact,'测试内线');assert.match(detail.json.title,/<img/);
      assert.equal((await request('/api/tickets/'+ticketId,{method:'PATCH',cookie:adminCookie,body:{status:'in_progress'}})).status,200);
      assert.equal((await request('/api/tickets/'+ticketId,{cookie:adminCookie})).json.status,'in_progress');
      assert.equal((await pool.query('SELECT action FROM audit_log WHERE target_id=$1',[ticketId])).rows[0].action,'ticket.in_progress');
      assert.equal((await request('/api/tickets/'+ticketId,{method:'PATCH',cookie:adminCookie,body:{status:'invalid'}})).status,400);
    });
    await t.test('pagination and search use actual persisted rows',async()=>{
      for(let i=0;i<21;i++)await pool.query('INSERT INTO tickets (id,department,type,title,description,contact,submission_key) VALUES ($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),'IT部','其他','分页记录 '+i,'独立测试数据','测试',randomUUID()]);
      const page1=await request('/api/tickets',{cookie:adminCookie});assert.equal(page1.json.total,22);assert.equal(page1.json.items.length,20);
      const page2=await request('/api/tickets?page=2',{cookie:adminCookie});assert.equal(page2.json.items.length,2);
      const search=await request('/api/tickets?q='+encodeURIComponent('分页记录 20'),{cookie:adminCookie});assert.equal(search.json.total,1);
      assert.equal((await request('/api/tickets?status=in_progress',{cookie:adminCookie})).json.total,1);
    });
    await t.test('last administrator and current account are protected',async()=>{
      assert.equal((await request('/api/admins/'+initial.user.id,{method:'DELETE',cookie:adminCookie,body:{}})).status,409);
    });
    await t.test('admin creation, duplicate account rejection and password rules',async()=>{
      const result=await request('/api/admins',{method:'POST',cookie:adminCookie,body:{email:'second@example.com',name:'第二管理员',password}});
      assert.equal(result.status,201,JSON.stringify(result.json));secondId=result.json.id;
      assert.equal((await request('/api/admins',{method:'POST',cookie:adminCookie,body:{email:'second@example.com',name:'重复',password}})).status,400);
      assert.equal((await request('/api/admins',{method:'POST',cookie:adminCookie,body:{email:'short@example.com',name:'短密码',password:'123'}})).status,400);
      assert.equal((await request('/api/admins/'+initial.user.id,{method:'DELETE',cookie:adminCookie,body:{}})).status,409);
      const list=await request('/api/admins',{cookie:adminCookie});assert.equal(list.json.items.length,2);assert.ok(!JSON.stringify(list.json).includes('password'));
      const logged=await login('second@example.com');assert.equal(logged.status,200);secondCookie=logged.cookie;
    });
    await t.test('deleting administrator revokes existing session and removes password',async()=>{
      assert.equal((await request('/api/admins/'+secondId,{method:'DELETE',cookie:adminCookie,body:{}})).status,200);
      assert.equal((await request('/api/me',{cookie:secondCookie})).status,401);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM account WHERE "userId"=$1',[secondId])).rows[0].n,0);
    });
    await t.test('authenticated non-admin is denied on all protected operations',async()=>{
      await auth.api.createUser({body:{email:'normal@example.com',name:'普通账号',password,role:'user'}});
      const normal=await login('normal@example.com');assert.equal(normal.status,200);
      for(const path of ['/api/me','/api/admins','/api/tickets','/api/tickets/'+ticketId])assert.equal((await request(path,{cookie:normal.cookie})).status,403);
      assert.equal((await request('/api/admins',{method:'POST',cookie:normal.cookie,body:{}})).status,403);
    });
    await t.test('logout invalidates the session',async()=>{
      assert.equal((await request('/api/auth/sign-out',{method:'POST',cookie:adminCookie,body:{}})).status,200);
      assert.equal((await request('/api/me',{cookie:adminCookie})).status,401);
    });
    await t.test('incorrect password and repeated attempts are limited',async()=>{
      assert.equal((await login('admin@example.com','Wrong-password-2026!')).status,401);
      let limited=false;
      for(let i=0;i<6;i++) if((await login('admin@example.com','Wrong-password-2026!')).status===429)limited=true;
      assert.ok(limited);
      let submitLimited=false;
      for(let i=0;i<12;i++)if((await request('/api/tickets',{method:'POST',body:payload()})).status===429)submitLimited=true;
      assert.ok(submitLimited);
    });
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    if(!schema.startsWith('smartops_test_'))throw new Error('Refusing test cleanup');
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});
