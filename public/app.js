const $ = id => document.getElementById(id);
const labels = {pending:'待处理',in_progress:'处理中',resolved:'已解决',closed:'已关闭'};
const date = value => new Date(value).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'});
function message(text, success=false, id='message') {
  const box=$(id); box.textContent=text; box.classList.toggle('success',success); box.hidden=false;
}
async function api(path, {method='GET',body}={}) {
  const mutating=!['GET','HEAD'].includes(method);
  const res=await fetch(path,{method,credentials:'same-origin',headers:mutating?{'Content-Type':'application/json'}:undefined,body:mutating?JSON.stringify(body || {}):undefined});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) {const hint=res.status===429?'操作过于频繁，请稍后再试。':data.code==='INVALID_EMAIL_OR_PASSWORD'?'账号或密码错误。':data.message || '请求失败，请稍后重试。';const e=new Error(hint); e.status=res.status; throw e;}
  return data;
}
function submit(form, run) {
  form.addEventListener('submit',async event=>{
    event.preventDefault(); const btn=form.querySelector('button[type=submit]');btn.disabled=true;
    try{await run();}catch(e){message(e.message,false,form.id==='statusForm'?'detailMessage':'message');}finally{btn.disabled=false;}
  });
}
function cell(row, value) {const td=document.createElement('td');td.textContent=value;row.append(td);return td;}
function action(td,label,run,style='secondary') {const btn=document.createElement('button');btn.type='button';btn.textContent=label;btn.className=style;btn.addEventListener('click',async()=>{btn.disabled=true;try{await run();}catch(e){message(e.message);}finally{btn.disabled=false;}});td.append(btn);return btn;}

if(document.body.dataset.page==='login') {
  submit($('loginForm'),async()=>{
    await api('/api/auth/sign-in/email',{method:'POST',body:{email:$('email').value.trim(),password:$('password').value}});
    location.assign('/admin.html');
  });
}
if(document.body.dataset.page==='report') {
  let submissionKey=crypto.randomUUID();
  submit($('reportForm'),async()=>{
    const body={submissionKey};
    for(const key of ['department','type','title','description','contact','remark'])body[key]=$(key).value.trim();
    const data=await api('/api/tickets',{method:'POST',body});
    message(`提交成功！请保存工单编号：${data.data.id}`,true);
    $('reportForm').reset(); submissionKey=crypto.randomUUID();
    $('message').scrollIntoView({behavior:'smooth',block:'center'});
  });
}
if(document.body.dataset.page==='admin') {
  let me, page=1, total=0, selectedId=null, detailTrigger=null;
  const sections=['ticket','admin','password'];
  function show(name) {
    if(me?.mustChangePassword)name='password';
    sections.forEach(s=>$(s+'Section').hidden=s!==name);
    $('message').hidden=true;
  }
  async function loadMe() {
    try {
      me=await api('/api/me');
      $('welcome').textContent=`${me.name}，欢迎回来。`;
      $('passwordHint').textContent=me.mustChangePassword?'首次登录请先修改临时密码，再使用管理功能。':'设置至少 12 个字符的新密码。';
      $('ticketTab').disabled=$('adminTab').disabled=me.mustChangePassword;
      return me;
    }catch(e){if(e.status===401 || e.status===403){location.replace('/');}else message(e.message);}
  }
  async function tickets() {
    const params=new URLSearchParams({page,status:$('statusFilter').value,q:$('search').value.trim()});
    const data=await api('/api/tickets?'+params);total=data.total;
    $('ticketRows').replaceChildren();
    for(const item of data.items) {
      const row=document.createElement('tr');
      const title=cell(row,item.title);const small=document.createElement('div');small.className='muted';small.textContent=item.id.slice(0,8);title.append(small);
      cell(row,item.department);cell(row,item.type);
      const badge=document.createElement('span');badge.className='pill '+item.status;badge.textContent=labels[item.status];cell(row,'').append(badge);
      cell(row,date(item.created_at));action(cell(row,''),'查看详情',async()=>{detailTrigger=document.activeElement;await details(item.id);});
      $('ticketRows').append(row);
    }
    $('empty').hidden=data.items.length>0;
    $('count').textContent=`共 ${total} 条 · 第 ${page} / ${Math.max(1,Math.ceil(total/20))} 页`;
    $('previous').disabled=page<=1;$('next').disabled=page*20>=total;
  }
  async function details(id) {
    const data=await api('/api/tickets/'+encodeURIComponent(id)); selectedId=id;
    $('detailTitle').textContent=data.title;$('detailFields').replaceChildren();
    const fields={id:'工单编号',department:'报修科室',type:'问题类型',description:'问题描述',contact:'联系方式',remark:'备注',created_at:'提交时间',updated_at:'更新时间'};
    for(const [key,label] of Object.entries(fields)) {
      const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=key.endsWith('_at')?date(data[key]):data[key]||'—';$('detailFields').append(dt,dd);
    }
    $('detailStatus').value=data.status;$('detailMessage').hidden=true;$('detail').hidden=false;$('closeDetail').focus();
  }
  async function admins() {
    const data=await api('/api/admins');$('adminRows').replaceChildren();
    for(const user of data.items) {
      const row=document.createElement('tr'),info=cell(row,user.name),small=document.createElement('div');small.className='muted';small.textContent=user.email;info.append(small);cell(row,date(user.createdAt));
      const td=cell(row,'');
      if(user.id===me.id) td.textContent='当前账号';
      else action(td,'删除',async()=>{
        if(!confirm(`删除管理员 ${user.email}？该账号将立即无法登录，已有会话也会失效。`))return;
        await api('/api/admins/'+encodeURIComponent(user.id),{method:'DELETE'});await admins();message('管理员已删除。',true);
      },'danger');
      $('adminRows').append(row);
    }
  }
  $('ticketTab').addEventListener('click',()=>{show('ticket');tickets().catch(e=>message(e.message));});
  $('adminTab').addEventListener('click',()=>{show('admin');admins().catch(e=>message(e.message));});
  $('passwordTab').addEventListener('click',()=>show('password'));
  $('logout').addEventListener('click',async()=>{try{await api('/api/auth/sign-out',{method:'POST',body:{}});location.replace('/');}catch(e){message(e.message);}});
  submit($('filterForm'),async()=>{page=1;await tickets();});
  $('previous').addEventListener('click',async()=>{page=Math.max(1,page-1);try{await tickets();}catch(e){message(e.message);}});
  $('next').addEventListener('click',async()=>{page++;try{await tickets();}catch(e){page--;message(e.message);}});
  function closeDetail() {$('detail').hidden=true;detailTrigger?.focus();}
  $('closeDetail').addEventListener('click',closeDetail);
  $('detail').addEventListener('click',event=>{if(event.target===$('detail'))closeDetail();});
  document.addEventListener('keydown',event=>{
    if($('detail').hidden)return;
    if(event.key==='Escape')closeDetail();
    if(event.key==='Tab') {const nodes=[...$('detail').querySelectorAll('button,select')].filter(x=>!x.disabled);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
  });
  submit($('statusForm'),async()=>{await api('/api/tickets/'+selectedId,{method:'PATCH',body:{status:$('detailStatus').value}});await tickets();await details(selectedId);message('状态已保存。',true,'detailMessage');});
  submit($('adminForm'),async()=>{await api('/api/admins',{method:'POST',body:{name:$('adminName').value.trim(),email:$('adminEmail').value.trim(),password:$('adminPassword').value}});$('adminForm').reset();await admins();message('管理员已添加，首次登录需修改临时密码。',true);});
  submit($('passwordForm'),async()=>{
    if($('newPassword').value!==$('confirmPassword').value)throw new Error('两次输入的新密码不一致。');
    await api('/api/password',{method:'POST',body:{currentPassword:$('currentPassword').value,newPassword:$('newPassword').value}});
    $('passwordForm').reset();await loadMe();show('ticket');await tickets();message('密码已修改，其他设备的会话已失效。',true);
  });
  loadMe().then(async user=>{if(!user)return;show('ticket');if(!user.mustChangePassword)await tickets();}).catch(e=>message(e.message));
}
