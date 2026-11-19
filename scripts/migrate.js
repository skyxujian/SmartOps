import { getMigrations } from 'better-auth/db/migration';
import { auth } from '../lib/auth.js';
import { pool, schema } from '../lib/db.js';

export async function migrate() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id uuid PRIMARY KEY, department text NOT NULL, type text NOT NULL,
      title text NOT NULL, description text NOT NULL, contact text NOT NULL,
      remark text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','in_progress','resolved','closed')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      submission_key uuid UNIQUE NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tickets_created_idx ON tickets (created_at DESC, id);
    CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status, created_at DESC);
    CREATE TABLE IF NOT EXISTS audit_log (
      id bigserial PRIMARY KEY, actor_id text NOT NULL,
      action text NOT NULL, target_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS request_limits (
      key text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_guard (id integer PRIMARY KEY CHECK (id=1));
    INSERT INTO admin_guard (id) VALUES (1) ON CONFLICT DO NOTHING;
  `);
}
if (process.argv[1]?.endsWith('/migrate.js')) {
  try { await migrate(); console.log('数据库结构已初始化。'); }
  finally { await pool.end(); }
}
