/**
 * Chimera Authentication Library
 *
 * Client-side authentication using Cognito OAuth2 PKCE flow and user registration.
 * Provides window.ChimeraAuth API for login, registration, and token management.
 */

(function () {
  'use strict';

  // Configuration loaded from /auth/config endpoint
  let config = null;

  // PKCE state
  let pkceState = {
    codeVerifier: null,
    codeChallenge: null,
    state: null,
  };

  /**
   * Generate random string for PKCE
   */
  function generateRandomString(length) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const values = new Uint8Array(length);
    crypto.getRandomValues(values);
    return Array.from(values)
      .map((v) => charset[v % charset.length])
      .join('');
  }

  /**
   * Generate PKCE code challenge from verifier
   */
  async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  /**
   * Load OAuth configuration from backend
   */
  async function loadConfig() {
    if (config) return config;

    const response = await fetch('/auth/config');
    if (!response.ok) {
      throw new Error('Failed to load auth configuration');
    }

    config = await response.json();
    return config;
  }

  /**
   * Initialize OAuth PKCE login flow
   * Redirects to Cognito hosted UI
   */
  async function initLogin() {
    try {
      await loadConfig();

      // Generate PKCE parameters
      const codeVerifier = generateRandomString(128);
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = generateRandomString(32);

      // Store PKCE parameters in sessionStorage (cleared on tab close)
      sessionStorage.setItem('chimera_code_verifier', codeVerifier);
      sessionStorage.setItem('chimera_state', state);

      // Build authorization URL
      const authUrl = new URL(config.authorizationEndpoint);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', config.clientId);
      authUrl.searchParams.set('redirect_uri', config.redirectUri);
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);

      // Redirect to Cognito
      window.location.href = authUrl.toString();
    } catch (error) {
      console.error('Failed to initialize login:', error);
      throw error;
    }
  }

  /**
   * Handle OAuth callback after redirect from Cognito
   * Exchanges authorization code for tokens
   */
  async function handleCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');
    const error = urlParams.get('error');

    // Check for OAuth error
    if (error) {
      const errorDescription = urlParams.get('error_description');
      throw new Error(errorDescription || error);
    }

    // No code? Not a callback
    if (!code) {
      return false;
    }

    // Verify state parameter
    const storedState = sessionStorage.getItem('chimera_state');
    if (state !== storedState) {
      throw new Error('Invalid state parameter - possible CSRF attack');
    }

    // Get code verifier
    const codeVerifier = sessionStorage.getItem('chimera_code_verifier');
    if (!codeVerifier) {
      throw new Error('Missing code verifier - PKCE flow incomplete');
    }

    try {
      // Exchange code for tokens
      const response = await fetch('/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Token exchange failed');
      }

      const tokens = await response.json();

      // Store tokens in localStorage
      localStorage.setItem('chimera_access_token', tokens.access_token);
      localStorage.setItem('chimera_id_token', tokens.id_token);
      localStorage.setItem('chimera_refresh_token', tokens.refresh_token);

      // Extract tenant ID from ID token claims
      const idTokenPayload = JSON.parse(atob(tokens.id_token.split('.')[1]));
      const tenantId = idTokenPayload['custom:tenant_id'];
      if (tenantId) {
        localStorage.setItem('chimera_tenant_id', tenantId);
      }

      // Clear PKCE parameters
      sessionStorage.removeItem('chimera_code_verifier');
      sessionStorage.removeItem('chimera_state');

      // Remove OAuth params from URL
      window.history.replaceState({}, document.title, window.location.pathname);

      return true;
    } catch (error) {
      console.error('Failed to handle OAuth callback:', error);
      throw error;
    }
  }

  /**
   * Register new user via Cognito SignUp API
   *
   * @param {string} name - User's full name
   * @param {string} email - User's email address
   * @param {string} password - User's password (must meet policy requirements)
   * @returns {Promise<{ userSub: string, confirmationRequired: boolean }>}
   */
  async function register(name, email, password) {
    try {
      const response = await fetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Registration failed');
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error('Registration failed:', error);
      throw error;
    }
  }

  /**
   * Check if user is authenticated (valid JWT token)
   */
  function checkAuth() {
    const idToken = localStorage.getItem('chimera_id_token');
    const accessToken = localStorage.getItem('chimera_access_token');

    if (!idToken || !accessToken) {
      return false;
    }

    // Basic JWT expiry check
    try {
      const payload = JSON.parse(atob(idToken.split('.')[1]));
      const expiry = payload.exp * 1000;
      const now = Date.now();

      if (now >= expiry) {
        // Token expired
        logout();
        return false;
      }

      return true;
    } catch (error) {
      console.error('Failed to validate JWT:', error);
      logout();
      return false;
    }
  }

  /**
   * Get current user info from ID token claims
   */
  function getUserInfo() {
    const idToken = localStorage.getItem('chimera_id_token');
    if (!idToken) {
      return null;
    }

    try {
      const payload = JSON.parse(atob(idToken.split('.')[1]));
      return {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        tenantId: payload['custom:tenant_id'],
        tenantTier: payload['custom:tenant_tier'],
        groups: payload['cognito:groups'] || [],
      };
    } catch (error) {
      console.error('Failed to parse ID token:', error);
      return null;
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async function refreshToken() {
    const refreshToken = localStorage.getItem('chimera_refresh_token');
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    try {
      const response = await fetch('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Token refresh failed');
      }

      const tokens = await response.json();

      // Update tokens in localStorage
      localStorage.setItem('chimera_access_token', tokens.access_token);
      localStorage.setItem('chimera_id_token', tokens.id_token);
      // Note: refresh token is not returned in refresh response, keep existing one

      return true;
    } catch (error) {
      console.error('Token refresh failed:', error);
      logout();
      throw error;
    }
  }

  /**
   * Log out user
   * Clears tokens and redirects to Cognito logout endpoint
   */
  async function logout() {
    // Clear tokens
    localStorage.removeItem('chimera_access_token');
    localStorage.removeItem('chimera_id_token');
    localStorage.removeItem('chimera_refresh_token');
    localStorage.removeItem('chimera_tenant_id');

    // Redirect to Cognito logout endpoint
    try {
      await loadConfig();
      const logoutUrl = new URL(config.logoutEndpoint);
      logoutUrl.searchParams.set('client_id', config.clientId);
      logoutUrl.searchParams.set('logout_uri', window.location.origin + '/login.html');
      window.location.href = logoutUrl.toString();
    } catch (error) {
      // Fallback: just redirect to login page
      window.location.href = '/login.html';
    }
  }

  // Expose public API
  window.ChimeraAuth = {
    initLogin,
    handleCallback,
    register,
    checkAuth,
    getUserInfo,
    refreshToken,
    logout,
  };
})();
