import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins/admin';
import { pool } from './db.js';

export const origin = process.env.APP_ORIGIN || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
export const auth = betterAuth({
  appName: 'SmartOps',
  baseURL: origin,
  secret: process.env.BETTER_AUTH_SECRET,
  database: pool,
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128 },
  user: { additionalFields: { mustChangePassword: { type: 'boolean', defaultValue: false, input: false } } },
  session: { expiresIn: 8 * 60 * 60, updateAge: 60 * 60, cookieCache: { enabled: false } },
  rateLimit: {
    enabled: true, storage: 'database', window: 60, max: 60,
    customRules: { '/sign-in/email': { window: 60, max: 5 } },
  },
  advanced: {
    cookiePrefix: 'smartops',
    useSecureCookies: origin.startsWith('https:'),
    ipAddress: { ipAddressHeaders: ['x-smartops-client-ip'] },
  },
  plugins: [admin()],
});
