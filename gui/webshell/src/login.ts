// ---------------------------------------------------------------------------
// Login page — PAM auth gate UI
// Mobile-first: centered card, 44px touch targets, shake animation
// ---------------------------------------------------------------------------

import theme from './theme.js';

export function createLoginPage(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = '';

  // Hide loading indicator
  const loadingEl = document.getElementById('loading');
  if (loadingEl) loadingEl.style.display = 'none';

  // Inject login-specific styles
  const style = document.createElement('style');
  style.textContent = `
    @keyframes cc-shake {
      0%, 100% { transform: translateX(0); }
      20% { transform: translateX(-6px); }
      40% { transform: translateX(6px); }
      60% { transform: translateX(-4px); }
      80% { transform: translateX(4px); }
    }

    .cc-login-wrapper {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100dvh;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
      overscroll-behavior: none;
    }

    .cc-login-card {
      background: ${theme.cardBg};
      border: 1px solid ${theme.border};
      border-radius: 12px;
      padding: 32px 24px;
      width: 100%;
      max-width: 360px;
      margin: 16px;
      transition: border-color 0.2s;
      box-shadow: ${theme.glow};
    }

    .cc-login-card.shake {
      animation: cc-shake 0.4s ease;
    }

    .cc-login-logo {
      display: block;
      width: 320px;
      max-width: 90%;
      height: auto;
      margin: 0 auto 16px;
      border-radius: 12px;
      object-fit: contain;
      filter: drop-shadow(${theme.glow});
    }

    .cc-login-title {
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 4px;
      text-align: center;
      color: ${theme.accent};
      text-shadow: ${theme.glow};
      letter-spacing: 2px;
      text-transform: uppercase;
    }

    .cc-login-subtitle {
      font-size: 11px;
      color: ${theme.textSecondary};
      text-align: center;
      margin-bottom: 24px;
      letter-spacing: 1px;
    }

    .cc-form-group {
      margin-bottom: 16px;
    }

    .cc-form-group label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 6px;
      color: ${theme.textSecondary};
      user-select: none;
    }

    .cc-form-group input {
      width: 100%;
      min-height: 44px;
      padding: 10px 14px;
      background: ${theme.inputBg};
      color: ${theme.text};
      border: 1px solid ${theme.inputBorder};
      border-radius: 8px;
      font-family: inherit;
      font-size: 16px;
      outline: none;
      -webkit-appearance: none;
      transition: border-color 0.2s;
    }

    .cc-form-group input:focus {
      border-color: ${theme.accent};
    }

    .cc-form-group input.error {
      border-color: ${theme.accentRed};
    }

    .cc-error-msg {
      color: ${theme.accentRed};
      font-size: 12px;
      margin-top: 4px;
      min-height: 18px;
    }

    .cc-login-btn {
      width: 100%;
      min-height: 44px;
      background: ${theme.accent};
      color: #0a0a0a;
      border: none;
      border-radius: 8px;
      font-family: inherit;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      margin-top: 8px;
      transition: opacity 0.15s, box-shadow 0.2s;
      -webkit-appearance: none;
      -webkit-tap-highlight-color: transparent;
      box-shadow: ${theme.glow};
      letter-spacing: 1px;
      text-transform: uppercase;
    }

    .cc-login-btn:active {
      opacity: 0.8;
    }

    .cc-login-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .cc-login-error {
      color: ${theme.accentRed};
      font-size: 12px;
      text-align: center;
      margin-top: 12px;
      min-height: 18px;
    }
  `;
  document.head.appendChild(style);

  // Build login card
  const wrapper = document.createElement('div');
  wrapper.className = 'cc-login-wrapper';

  const card = document.createElement('div');
  card.className = 'cc-login-card';

  card.innerHTML = `
    <img class="cc-login-logo" src="/assets/cobra-logo.jpg" alt="Cobra Commander">
    <h1 class="cc-login-title">Cobra Commander</h1>
    <p class="cc-login-subtitle">Head of Engineering &middot; Direct Access</p>
    <div class="cc-form-group">
      <label for="cc-username">Username</label>
      <input type="text" id="cc-username" name="username" autocomplete="username" placeholder="linux user" tabindex="0">
      <div class="cc-error-msg" id="cc-username-error"></div>
    </div>
    <div class="cc-form-group">
      <label for="cc-password">Password</label>
      <input type="password" id="cc-password" name="password" autocomplete="current-password" placeholder="password">
      <div class="cc-error-msg" id="cc-password-error"></div>
    </div>
    <button class="cc-login-btn" id="cc-login-btn" type="submit">Sign In</button>
    <div class="cc-login-error" id="cc-login-error"></div>
  `;

  wrapper.appendChild(card);
  app.appendChild(wrapper);

  // Elements
  const usernameInput = document.getElementById('cc-username') as HTMLInputElement;
  const passwordInput = document.getElementById('cc-password') as HTMLInputElement;
  const loginBtn = document.getElementById('cc-login-btn') as HTMLButtonElement;
  const usernameError = document.getElementById('cc-username-error') as HTMLElement;
  const passwordError = document.getElementById('cc-password-error') as HTMLElement;
  const loginError = document.getElementById('cc-login-error') as HTMLElement;

  // NO auto-focus on load — prevents iOS keyboard popup

  function clearErrors(): void {
    usernameInput.classList.remove('error');
    passwordInput.classList.remove('error');
    usernameError.textContent = '';
    passwordError.textContent = '';
    loginError.textContent = '';
  }

  function shakeCard(): void {
    card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 400);
  }

  async function handleLogin(): Promise<void> {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    clearErrors();

    let hasError = false;

    if (!username) {
      usernameInput.classList.add('error');
      usernameError.textContent = 'Username is required';
      hasError = true;
    }

    if (!password) {
      passwordInput.classList.add('error');
      passwordError.textContent = 'Password is required';
      hasError = true;
    }

    if (hasError) {
      shakeCard();
      return;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in...';

    try {
      const resp = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (resp.ok) {
        // Redirect to shell
        window.location.href = '/index.html';
        return;
      }

      if (resp.status === 429) {
        loginError.textContent = 'Too many attempts. Please wait 30 seconds.';
      } else if (resp.status === 401) {
        loginError.textContent = 'Invalid username or password.';
        shakeCard();
      } else {
        loginError.textContent = 'Login failed. Please try again.';
      }
    } catch {
      loginError.textContent = 'Connection error. Please check your network.';
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In';
    }
  }

  // Events
  loginBtn.addEventListener('click', handleLogin);

  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') passwordInput.focus();
  });

  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
  });
}
