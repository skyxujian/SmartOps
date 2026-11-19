import pg from 'pg';
const schema = process.env.DB_SCHEMA || 'smartops';
if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('Invalid DB_SCHEMA');
export { schema };
const connection = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connection) throw new Error('Database connection is not configured');
const url = connection ? new URL(connection) : null;
if (url?.hostname.endsWith('.neon.tech')) url.searchParams.set('sslmode','verify-full');
export const pool = new pg.Pool({
  // A direct Neon connection supports the dedicated schema in startup options.
  connectionString: url?.toString(),
  options: `-c search_path=${schema},public`,
  max: 3,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 10000,
});
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
