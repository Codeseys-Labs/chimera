/**
 * Chimera OAuth PKCE Authentication Module
 *
 * Implements OAuth 2.0 PKCE flow for Cognito:
 * - PKCE code verifier/challenge generation
 * - Authorization code exchange
 * - Token storage and refresh
 * - Automatic token refresh on expiry
 */

(function () {
  'use strict';

  // Configuration
  const config = {
    cognitoRegion: window.CHIMERA_CONFIG?.cognitoRegion || 'us-east-1',
    cognitoDomain: window.CHIMERA_CONFIG?.cognitoDomain || 'chimera-dev.auth.us-east-1.amazoncognito.com',
    clientId: window.CHIMERA_CONFIG?.clientId || 'YOUR_CLIENT_ID',
    redirectUri: window.location.origin,
    scope: 'openid email profile aws.cognito.signin.user.admin',
  };

  // Token storage keys
  const STORAGE_KEYS = {
    ID_TOKEN: 'chimera_id_token',
    ACCESS_TOKEN: 'chimera_access_token',
    REFRESH_TOKEN: 'chimera_refresh_token',
    TOKEN_EXPIRY: 'chimera_token_expiry',
    CODE_VERIFIER: 'chimera_code_verifier',
    STATE: 'chimera_oauth_state',
  };

  // PKCE helper functions
  function base64URLEncode(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  function generateCodeVerifier() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return base64URLEncode(array);
  }

  async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return base64URLEncode(hash);
  }

  function generateState() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return base64URLEncode(array);
  }

  /**
   * Start OAuth PKCE flow
   */
  async function login() {
    try {
      // Generate PKCE parameters
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = generateState();

      // Store for callback
      sessionStorage.setItem(STORAGE_KEYS.CODE_VERIFIER, codeVerifier);
      sessionStorage.setItem(STORAGE_KEYS.STATE, state);

      // Build authorization URL
      const authUrl = new URL(`https://${config.cognitoDomain}/oauth2/authorize`);
      authUrl.searchParams.set('client_id', config.clientId);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', config.scope);
      authUrl.searchParams.set('redirect_uri', config.redirectUri);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);

      // Redirect to Cognito
      window.location.href = authUrl.toString();
    } catch (error) {
      console.error('Failed to start OAuth flow:', error);
      throw new Error('Failed to start authentication');
    }
  }

  /**
   * Handle OAuth callback
   */
  async function handleCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');
    const error = urlParams.get('error');

    // Check for OAuth errors
    if (error) {
      throw new Error(`OAuth error: ${error} - ${urlParams.get('error_description')}`);
    }

    // No callback params - not in OAuth flow
    if (!code || !state) {
      return false;
    }

    // Verify state parameter
    const storedState = sessionStorage.getItem(STORAGE_KEYS.STATE);
    if (state !== storedState) {
      throw new Error('State mismatch - possible CSRF attack');
    }

    // Retrieve code verifier
    const codeVerifier = sessionStorage.getItem(STORAGE_KEYS.CODE_VERIFIER);
    if (!codeVerifier) {
      throw new Error('Code verifier not found');
    }

    // Exchange code for tokens
    await exchangeCodeForTokens(code, codeVerifier);

    // Clean up session storage
    sessionStorage.removeItem(STORAGE_KEYS.CODE_VERIFIER);
    sessionStorage.removeItem(STORAGE_KEYS.STATE);

    // Remove OAuth params from URL
    window.history.replaceState({}, document.title, window.location.pathname);

    return true;
  }

  /**
   * Exchange authorization code for tokens
   */
  async function exchangeCodeForTokens(code, codeVerifier) {
    const tokenUrl = `https://${config.cognitoDomain}/oauth2/token`;

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code: code,
      code_verifier: codeVerifier,
      redirect_uri: config.redirectUri,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error_description || 'Token exchange failed');
    }

    const tokens = await response.json();
    storeTokens(tokens);
  }

  /**
   * Store tokens in localStorage
   */
  function storeTokens(tokens) {
    localStorage.setItem(STORAGE_KEYS.ID_TOKEN, tokens.id_token);
    localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, tokens.access_token);
    if (tokens.refresh_token) {
      localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, tokens.refresh_token);
    }

    // Calculate expiry time (seconds from now)
    const expiryTime = Date.now() + tokens.expires_in * 1000;
    localStorage.setItem(STORAGE_KEYS.TOKEN_EXPIRY, expiryTime.toString());
  }

  /**
   * Refresh access token using refresh token
   */
  async function refreshTokens() {
    const refreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const tokenUrl = `https://${config.cognitoDomain}/oauth2/token`;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      refresh_token: refreshToken,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      // Refresh token invalid or expired - force re-login
      logout();
      throw new Error('Token refresh failed - please log in again');
    }

    const tokens = await response.json();
    storeTokens(tokens);
  }

  /**
   * Check if user is authenticated
   */
  function isAuthenticated() {
    const idToken = localStorage.getItem(STORAGE_KEYS.ID_TOKEN);
    const accessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    const expiry = localStorage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);

    if (!idToken || !accessToken || !expiry) {
      return false;
    }

    // Check if token is expired
    const now = Date.now();
    const expiryTime = parseInt(expiry, 10);

    if (now >= expiryTime) {
      // Token expired - attempt refresh
      return false;
    }

    return true;
  }

  /**
   * Get access token (auto-refresh if needed)
   */
  async function getAccessToken() {
    const expiry = localStorage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);
    const now = Date.now();
    const expiryTime = parseInt(expiry, 10);

    // Refresh if token expires in less than 5 minutes
    if (now >= expiryTime - 5 * 60 * 1000) {
      await refreshTokens();
    }

    return localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
  }

  /**
   * Get user info from ID token
   */
  function getUserInfo() {
    const idToken = localStorage.getItem(STORAGE_KEYS.ID_TOKEN);
    if (!idToken) {
      return null;
    }

    try {
      // Decode JWT payload
      const payload = JSON.parse(atob(idToken.split('.')[1]));

      return {
        sub: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified,
        tenantId: payload['custom:tenantId'] || 'demo-tenant',
        username: payload['cognito:username'],
      };
    } catch (error) {
      console.error('Failed to parse ID token:', error);
      return null;
    }
  }

  /**
   * Logout and clear tokens
   */
  function logout() {
    // Clear all tokens
    localStorage.removeItem(STORAGE_KEYS.ID_TOKEN);
    localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
    localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
    localStorage.removeItem(STORAGE_KEYS.TOKEN_EXPIRY);

    // Redirect to login
    window.location.href = '/login.html';
  }

  /**
   * Initialize auth module
   */
  async function init() {
    // Check if we're on the callback page
    if (window.location.search.includes('code=')) {
      try {
        const handled = await handleCallback();
        if (handled) {
          // Successful OAuth callback - redirect to main app
          window.location.href = '/index.html';
          return;
        }
      } catch (error) {
        console.error('OAuth callback failed:', error);
        // Show error and redirect to login
        alert('Authentication failed: ' + error.message);
        logout();
        return;
      }
    }

    // Check if we're on a protected page and not authenticated
    const isLoginPage = window.location.pathname.includes('login');
    if (!isLoginPage && !isAuthenticated()) {
      // Not authenticated - redirect to login
      window.location.href = '/login.html';
    }
  }

  // Auto-refresh tokens periodically (every 10 minutes)
  setInterval(async () => {
    if (isAuthenticated()) {
      try {
        await getAccessToken(); // Will auto-refresh if needed
      } catch (error) {
        console.error('Token refresh failed:', error);
      }
    }
  }, 10 * 60 * 1000);

  // Expose public API
  window.ChimeraAuth = {
    login,
    logout,
    isAuthenticated,
    getAccessToken: () => localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN),
    getUserInfo,
    init,
  };

  // Auto-initialize on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
