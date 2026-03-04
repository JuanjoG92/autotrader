/* ── Auth JS ── */
(function() {
  if (getToken()) { window.location.href = '/dashboard'; return; }

  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const errEl = document.getElementById('errorMsg');
      errEl.style.display = 'none';
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Entrando...';

      try {
        const data = await apiFetch('/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            email: document.getElementById('email').value.trim(),
            password: document.getElementById('password').value,
          }),
        });
        setToken(data.token);
        setUser(data.user);
        window.location.href = '/dashboard';
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Entrar';
      }
    });
  }

  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const errEl = document.getElementById('errorMsg');
      errEl.style.display = 'none';

      const password = document.getElementById('password').value;
      const password2 = document.getElementById('password2').value;
      if (password !== password2) {
        errEl.textContent = 'Las contraseñas no coinciden';
        errEl.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creando cuenta...';

      try {
        const data = await apiFetch('/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            email: document.getElementById('email').value.trim(),
            name: document.getElementById('name').value.trim(),
            password,
          }),
        });
        setToken(data.token);
        setUser(data.user);
        window.location.href = '/dashboard';
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-user-plus"></i> Crear cuenta';
      }
    });
  }
})();
