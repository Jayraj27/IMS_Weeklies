const form = document.getElementById('login');
const error = document.getElementById('error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = form.querySelector('button');
  error.hidden = true;
  button.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value, password: form.password.value }),
    });
    if (res.ok) {
      location.href = '/admin/';
      return;
    }
    const data = await res.json().catch(() => ({}));
    error.textContent = data.error ?? 'Could not sign in. Please try again.';
  } catch {
    error.textContent = "Can't reach the server. Check your connection.";
  }
  error.hidden = false;
  button.disabled = false;
  form.password.value = '';
  form.password.focus();
});
