import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync } from 'node:fs';
import { auth } from '../lib/auth.js';
import { pool } from '../lib/db.js';

const email = process.env.INITIAL_ADMIN_EMAIL || 'admin@smartops.local';
const file = process.env.INITIAL_ADMIN_FILE;
if (!file) throw new Error('Set INITIAL_ADMIN_FILE to a private local file.');
try {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM "user"');
  if (rows[0].n) throw new Error('已有账号，首次初始化已关闭。');
  const password = randomBytes(24).toString('base64url');
  await auth.api.createUser({ body: { email, name: '系统管理员', password, role: 'admin', data: { mustChangePassword: true } } });
  writeFileSync(file, `SmartOps 首次登录信息\n账号：${email}\n临时密码：${password}\n首次登录后必须修改密码。请妥善保管并在修改后删除此文件。\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  console.log('首次管理员已创建，登录信息已写入指定私密文件。');
} finally { await pool.end(); }
