/*
 * Test helper. Importing it gives spawned servers a first admin, and signIn() makes this
 * test process's fetch carry the session cookie, like a signed-in browser.
 */

export const ADMIN = { username: 'test-admin', password: 'correct-horse-battery' };
process.env.ADMIN_USERNAME = ADMIN.username;
process.env.ADMIN_PASSWORD = ADMIN.password;

/** fetch without the test session, for checking what signed-out visitors get. */
export const realFetch = globalThis.fetch;

export async function signIn(base) {
  const res = await realFetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (!res.ok) throw new Error(`Test sign-in failed: ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  globalThis.fetch = (url, options = {}) => realFetch(url, { ...options, headers: { ...options.headers, cookie } });
}
