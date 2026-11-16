import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADMIN } from './sign-in.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weeklies-auth-'));
const PORT = 3980;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const API = `${ORIGIN}/api`;

function start(port, env) {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    env: { ...process.env, PORT: port, GOOGLE_SHEET_ID: '', GOOGLE_SERVICE_ACCOUNT_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function ready(url) {
  for (let i = 0; i < 300; i++) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('Server did not start');
}

const post = (url, body, headers = {}) =>
  fetch(API + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const login = (body = ADMIN, headers) => post('/auth/login', body, headers);
const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];

describe('sign-in', () => {
  let server;

  before(async () => {
    server = start(PORT, { DB_PATH: path.join(dir, 'auth.db') });
    await ready(`${ORIGIN}/healthz`);
  });

  after(async () => {
    server.kill();
    await new Promise((r) => server.once('exit', r));
  });

  test('nothing is readable without signing in', async () => {
    const paths = ['/api/state', '/api/students', '/api/students/sync', '/api/flows/1/progress'];
    for (const p of paths) assert.equal((await fetch(ORIGIN + p)).status, 401, p);
    const write = await fetch(`${API}/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal(write.status, 401);
    assert.equal((await fetch(`${API}/rooms/1`, { method: 'DELETE' })).status, 401);
  });

  test('pages send visitors to the sign-in page, which itself is open', async () => {
    for (const p of ['/', '/admin/', '/admin/app.js', '/admin/index.html']) {
      const res = await fetch(ORIGIN + p, { redirect: 'manual' });
      assert.equal(res.status, 302, p);
      assert.match(res.headers.get('location'), p === '/' ? /admin/ : /login/);
    }
    const page = await fetch(`${ORIGIN}/login/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Sign in/);
    assert.equal((await fetch(`${ORIGIN}/healthz`)).status, 200);
  });

  test('project files are never served', async () => {
    for (const p of ['/.env', '/server.js', '/src/api.js', '/package.json', '/data/weeklies.db', '/secrets/google-service-account.json', '/login/../.env', '/login/%2e%2e/%2e%2e/.env', '/admin/..%2f..%2f.env']) {
      const res = await fetch(ORIGIN + p, { redirect: 'manual' });
      assert.ok([302, 403, 404].includes(res.status), `${p} gave ${res.status}`);
      assert.doesNotMatch(await res.text(), /GOOGLE_SHEET_ID|DatabaseSync/);
    }
  });

  test('a wrong password or unknown user gets the same answer, with no cookie', async () => {
    const wrong = await login({ username: ADMIN.username, password: 'wrong-password' });
    const unknown = await login({ username: 'nobody', password: 'wrong-password' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal((await wrong.json()).error, (await unknown.json()).error);
    assert.equal(wrong.headers.get('set-cookie'), null);
    assert.equal((await login({ username: {}, password: [] })).status, 401);
  });

  test('a correct sign-in opens the API and pages, with a protected cookie', async () => {
    const res = await login();
    assert.equal(res.status, 200);
    const header = res.headers.get('set-cookie');
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    const cookie = cookieOf(res);
    const state = await fetch(`${API}/state`, { headers: { cookie } });
    assert.equal(state.status, 200);
    assert.equal(state.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${ORIGIN}/admin/`, { headers: { cookie } })).status, 200);
    const loginPage = await fetch(`${ORIGIN}/login/`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(loginPage.status, 302);
    assert.equal((await (await fetch(`${API}/auth/me`, { headers: { cookie } })).json()).username, ADMIN.username);
  });

  test('passwords and tokens are not stored in the clear', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const res = await login();
    const token = cookieOf(res).split('=')[1];
    const raw = new DatabaseSync(path.join(dir, 'auth.db'), { readOnly: true });
    const stored = JSON.stringify({ admins: raw.prepare('SELECT * FROM admins').all(), sessions: raw.prepare('SELECT * FROM sessions').all() });
    raw.close();
    assert.equal(stored.includes(ADMIN.password), false);
    assert.equal(stored.includes(token), false);
  });

  test('other websites cannot make changes, even with a valid session', async () => {
    const cookie = cookieOf(await login());
    const evil = await post('/rooms', { name: 'Evil room' }, { cookie, origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const del = await fetch(`${API}/rooms/1`, { method: 'DELETE', headers: { cookie, origin: 'https://evil.example' } });
    assert.equal(del.status, 403);
    assert.equal((await login(ADMIN, { origin: 'null' })).status, 403);

    const own = await post('/rooms', { name: 'Own room' }, { cookie, origin: ORIGIN });
    assert.equal(own.status, 201);
    const rooms = (await (await fetch(`${API}/state`, { headers: { cookie } })).json()).rooms;
    assert.deepEqual(rooms.map((r) => r.name), ['Own room']);
  });

  test('security headers are set', async () => {
    const res = await fetch(`${ORIGIN}/login/`);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('signing out ends that session only', async () => {
    const [one, two] = [cookieOf(await login()), cookieOf(await login())];
    assert.equal((await fetch(`${API}/auth/logout`, { method: 'POST', headers: { cookie: one } })).status, 204);
    assert.equal((await fetch(`${API}/state`, { headers: { cookie: one } })).status, 401);
    assert.equal((await fetch(`${API}/state`, { headers: { cookie: two } })).status, 200);
  });

  test('changing the password needs the old one, and signs out other devices', async () => {
    const [mine, other] = [cookieOf(await login()), cookieOf(await login())];
    const change = (current, next, cookie = mine) => post('/auth/password', { current, next }, { cookie });

    assert.equal((await post('/auth/password', { current: ADMIN.password, next: 'a-long-new-password' })).status, 401);
    assert.equal((await change('wrong-old-password', 'a-long-new-password')).status, 400);
    assert.equal((await change(ADMIN.password, 'short')).status, 400);
    assert.equal((await fetch(`${API}/state`, { headers: { cookie: mine } })).status, 200, 'refused changes leave the session alone');

    const done = await change(ADMIN.password, 'a-long-new-password');
    assert.equal(done.status, 204);
    const fresh = cookieOf(done);
    assert.equal((await fetch(`${API}/state`, { headers: { cookie: fresh } })).status, 200, 'this device stays signed in');
    assert.equal((await fetch(`${API}/state`, { headers: { cookie: other } })).status, 401);
    assert.equal((await login()).status, 401, 'the old password no longer works');
    assert.equal((await login({ username: ADMIN.username, password: 'a-long-new-password' })).status, 200);
  });

  // Last, because it locks this address out for the rest of the server's life.
  test('repeated wrong passwords are blocked, even if the next one is right', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await login({ username: ADMIN.username, password: 'wrong-password' });
    assert.equal(last.status, 429);
    assert.equal((await login({ username: ADMIN.username, password: 'a-long-new-password' })).status, 429);
  });
});

describe('starting up', () => {
  const run = (env) => new Promise((resolve) => {
    const child = start(3981, env);
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => child.kill(), 8000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

  test('online, the app refuses to start without an admin password', async () => {
    const { output, code } = await run({ NODE_ENV: 'production', ADMIN_PASSWORD: '', DB_PATH: path.join(dir, 'prod.db') });
    assert.notEqual(code, null);
    assert.match(output, /Set ADMIN_PASSWORD/);
    assert.doesNotMatch(output, /running at/);
  });

  test('a too-short admin password is refused', async () => {
    const { output } = await run({ ADMIN_PASSWORD: 'short', DB_PATH: path.join(dir, 'short.db') });
    assert.match(output, /at least 10/);
    assert.doesNotMatch(output, /running at/);
  });

  test('on this computer, a generated password is shown once, and only the first time', async () => {
    const db = path.join(dir, 'local.db');
    const first = await run({ ADMIN_USERNAME: '', ADMIN_PASSWORD: '', DB_PATH: db });
    assert.match(first.output, /Password: \S{16}/);
    assert.match(first.output, /running at/);
    const second = await run({ ADMIN_USERNAME: '', ADMIN_PASSWORD: '', DB_PATH: db });
    assert.doesNotMatch(second.output, /Password:/);
  });

  test('online, the session cookie is HTTPS-only and HTTPS is enforced for browsers', async () => {
    const server = start(3982, { NODE_ENV: 'production', TRUST_PROXY: '1', DB_PATH: path.join(dir, 'secure.db') });
    try {
      await ready('http://127.0.0.1:3982/healthz');
      const res = await fetch('http://127.0.0.1:3982/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
      assert.match(res.headers.get('set-cookie'), /Secure/);
      assert.match(res.headers.get('strict-transport-security'), /max-age/);
      const proxied = await fetch('http://127.0.0.1:3982/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'https://weeklies.example.com', 'x-forwarded-host': 'weeklies.example.com' },
        body: JSON.stringify(ADMIN),
      });
      assert.equal(proxied.status, 200, 'works behind a host’s proxy');
    } finally {
      server.kill();
      await new Promise((r) => server.once('exit', r));
    }
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));
});
