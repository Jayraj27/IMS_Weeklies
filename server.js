import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './src/api.js';
import { authRouter, ensureFirstAdmin, redirectIfSignedIn, requireApi, requirePage, sameOriginOnly } from './src/auth.js';
import { startSyncSchedule } from './src/students/sync.js';
import { startInputSyncSchedule } from './src/inputs/sync.js';
import { startCalendarSchedule } from './src/calendar/sync.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

// Online, a host's proxy sits in front of the app. This lets it see each visitor's real
// address, so wrong-password limits apply per visitor, and know the visit used HTTPS.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

// For the host's uptime check. It reveals nothing.
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// Student data must not linger in browser or proxy caches.
app.use('/api', sameOriginOnly, (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api/auth', authRouter);
app.use('/api', requireApi, api);

app.get('/', (_req, res) => res.redirect('/admin/'));
// Fonts, open to everyone because the sign-in page uses them too.
app.use('/assets', express.static(path.join(root, 'public', 'assets'), { maxAge: '30d' }));
app.use('/login', redirectIfSignedIn, express.static(path.join(root, 'public', 'login')));
app.use('/admin', requirePage, express.static(path.join(root, 'public', 'admin')));

app.use((_req, res) => res.status(404).type('text').send('Not found'));

await ensureFirstAdmin();

// With no login-free mode, only this computer can reach it unless HOST says otherwise.
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, HOST, () => {
  console.log(`Weeklies admin running at http://localhost:${PORT}/admin/`);
  startSyncSchedule();
  startInputSyncSchedule();
  startCalendarSchedule();
});
