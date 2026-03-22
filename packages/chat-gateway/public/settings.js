/**
 * Settings UI JavaScript
 *
 * Manages user settings and preferences:
 * - User profile management (display name)
 * - Notification preferences
 * - API key generation and management
 * - Appearance settings
 * - Account actions (logout)
 */

(function () {
  'use strict';

  // Configuration
  const config = {
    tenantId: localStorage.getItem('chimera_tenant_id') || 'demo-tenant',
    apiBase: '/api',
  };

  // State
  const state = {
    profile: null,
    notifications: null,
    apiKey: null,
    apiKeyVisible: false,
  };

  // Utility: Show error message
  function showError(message) {
    const errorDiv = document.getElementById('error-message');
    while (errorDiv.firstChild) {
      errorDiv.removeChild(errorDiv.firstChild);
    }
    const errorBox = document.createElement('div');
    errorBox.className = 'error';
    errorBox.textContent = message;
    errorDiv.appendChild(errorBox);
    setTimeout(() => {
      while (errorDiv.firstChild) {
        errorDiv.removeChild(errorDiv.firstChild);
      }
    }, 5000);
  }

  // Utility: Show success message
  function showSuccess(message) {
    const successDiv = document.getElementById('success-message');
    while (successDiv.firstChild) {
      successDiv.removeChild(successDiv.firstChild);
    }
    const successBox = document.createElement('div');
    successBox.className = 'success';
    successBox.textContent = message;
    successDiv.appendChild(successBox);
    setTimeout(() => {
      while (successDiv.firstChild) {
        successDiv.removeChild(successDiv.firstChild);
      }
    }, 5000);
  }

  // Utility: Make API request
  async function apiRequest(url, options = {}) {
    const accessToken = localStorage.getItem('chimera_access_token');
    const headers = {
      'Content-Type': 'application/json',
      'X-Tenant-Id': config.tenantId,
      ...options.headers,
    };

    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: 'Request failed' } }));
      throw new Error(error.error?.message || 'Request failed');
    }

    return response.json();
  }

  // Load user profile
  async function loadProfile() {
    try {
      const response = await apiRequest(`${config.apiBase}/profile?tenantId=${config.tenantId}`);
      state.profile = response.profile || {};

      // Populate form
      document.getElementById('display-name').value = state.profile.displayName || '';
      document.getElementById('email').value = state.profile.email || '';
      document.getElementById('tenant-id').value = config.tenantId;
    } catch (error) {
      console.error('Failed to load profile:', error);
      showError('Failed to load profile: ' + error.message);
    }
  }

  // Save user profile
  async function saveProfile(event) {
    event.preventDefault();

    try {
      const formData = new FormData(event.target);
      const displayName = formData.get('displayName');

      await apiRequest(`${config.apiBase}/profile`, {
        method: 'PUT',
        body: JSON.stringify({
          tenantId: config.tenantId,
          displayName,
        }),
      });

      showSuccess('Profile updated successfully');
      await loadProfile();
    } catch (error) {
      console.error('Failed to save profile:', error);
      showError('Failed to save profile: ' + error.message);
    }
  }

  // Load notification preferences
  async function loadNotifications() {
    try {
      const response = await apiRequest(
        `${config.apiBase}/notifications?tenantId=${config.tenantId}`
      );
      state.notifications = response.preferences || {};

      // Populate form
      document.getElementById('notify-task-complete').checked =
        state.notifications.taskComplete !== false;
      document.getElementById('notify-errors').checked = state.notifications.errors !== false;
      document.getElementById('notify-quota').checked = state.notifications.quota !== false;
      document.getElementById('notify-security').checked =
        state.notifications.security !== false;
    } catch (error) {
      console.error('Failed to load notification preferences:', error);
      // Set defaults on error
      document.getElementById('notify-task-complete').checked = true;
      document.getElementById('notify-errors').checked = true;
      document.getElementById('notify-quota').checked = true;
      document.getElementById('notify-security').checked = true;
    }
  }

  // Save notification preferences
  async function saveNotifications(event) {
    event.preventDefault();

    try {
      const formData = new FormData(event.target);
      const preferences = {
        taskComplete: formData.get('notifyTaskComplete') === 'on',
        errors: formData.get('notifyErrors') === 'on',
        quota: formData.get('notifyQuota') === 'on',
        security: formData.get('notifySecurity') === 'on',
      };

      await apiRequest(`${config.apiBase}/notifications`, {
        method: 'PUT',
        body: JSON.stringify({
          tenantId: config.tenantId,
          preferences,
        }),
      });

      showSuccess('Notification preferences updated successfully');
    } catch (error) {
      console.error('Failed to save notification preferences:', error);
      showError('Failed to save notification preferences: ' + error.message);
    }
  }

  // Load API key
  async function loadApiKey() {
    try {
      const apiKeyLoading = document.getElementById('api-key-loading');
      const apiKeyDisplay = document.getElementById('api-key-display');
      const apiKeyEmpty = document.getElementById('api-key-empty');

      apiKeyLoading.style.display = 'block';
      apiKeyDisplay.style.display = 'none';
      apiKeyEmpty.style.display = 'none';

      const response = await apiRequest(`${config.apiBase}/api-keys?tenantId=${config.tenantId}`);

      apiKeyLoading.style.display = 'none';

      if (response.apiKey) {
        state.apiKey = response.apiKey;
        apiKeyDisplay.style.display = 'block';
        updateApiKeyDisplay();
      } else {
        apiKeyEmpty.style.display = 'block';
      }
    } catch (error) {
      console.error('Failed to load API key:', error);
      document.getElementById('api-key-loading').style.display = 'none';
      document.getElementById('api-key-empty').style.display = 'block';
    }
  }

  // Update API key display
  function updateApiKeyDisplay() {
    const valueElement = document.getElementById('api-key-value');
    const toggleButton = document.getElementById('toggle-api-key');

    if (state.apiKeyVisible) {
      valueElement.textContent = state.apiKey;
      toggleButton.textContent = 'Hide';
    } else {
      valueElement.textContent = '••••••••••••••••••••••••••••••••';
      toggleButton.textContent = 'Show';
    }
  }

  // Toggle API key visibility
  function toggleApiKey() {
    state.apiKeyVisible = !state.apiKeyVisible;
    updateApiKeyDisplay();
  }

  // Copy API key to clipboard
  async function copyApiKey() {
    try {
      await navigator.clipboard.writeText(state.apiKey);
      showSuccess('API key copied to clipboard');
    } catch (error) {
      console.error('Failed to copy API key:', error);
      showError('Failed to copy API key: ' + error.message);
    }
  }

  // Generate new API key
  async function generateApiKey() {
    try {
      const response = await apiRequest(`${config.apiBase}/api-keys`, {
        method: 'POST',
        body: JSON.stringify({
          tenantId: config.tenantId,
        }),
      });

      state.apiKey = response.apiKey;
      state.apiKeyVisible = false;

      document.getElementById('api-key-loading').style.display = 'none';
      document.getElementById('api-key-empty').style.display = 'none';
      document.getElementById('api-key-display').style.display = 'block';

      updateApiKeyDisplay();
      showSuccess('API key generated successfully');
    } catch (error) {
      console.error('Failed to generate API key:', error);
      showError('Failed to generate API key: ' + error.message);
    }
  }

  // Rotate API key
  async function rotateApiKey() {
    if (!confirm('Are you sure? This will invalidate your current API key.')) {
      return;
    }

    try {
      const response = await apiRequest(`${config.apiBase}/api-keys`, {
        method: 'PUT',
        body: JSON.stringify({
          tenantId: config.tenantId,
        }),
      });

      state.apiKey = response.apiKey;
      state.apiKeyVisible = true; // Show new key immediately

      updateApiKeyDisplay();
      showSuccess('API key rotated successfully');
    } catch (error) {
      console.error('Failed to rotate API key:', error);
      showError('Failed to rotate API key: ' + error.message);
    }
  }

  // Load appearance settings
  function loadAppearance() {
    const theme = localStorage.getItem('chimera_theme') || 'auto';
    document.getElementById('theme').value = theme;
  }

  // Save appearance settings
  function saveAppearance(event) {
    event.preventDefault();

    const formData = new FormData(event.target);
    const theme = formData.get('theme');

    localStorage.setItem('chimera_theme', theme);
    showSuccess('Appearance settings saved');

    // Apply theme (if implemented in styles.css)
    applyTheme(theme);
  }

  // Apply theme
  function applyTheme(theme) {
    // Theme application logic would go here
    // For now, just log it
    console.log('Theme applied:', theme);
  }

  // Logout
  function logout() {
    if (!confirm('Are you sure you want to sign out?')) {
      return;
    }

    // Clear all auth tokens
    localStorage.removeItem('chimera_id_token');
    localStorage.removeItem('chimera_access_token');
    localStorage.removeItem('chimera_refresh_token');
    localStorage.removeItem('chimera_tenant_id');

    // Redirect to login
    window.location.href = '/login.html';
  }

  // Utility: Check JWT authentication
  function checkAuth() {
    const idToken = localStorage.getItem('chimera_id_token');
    const accessToken = localStorage.getItem('chimera_access_token');

    if (!idToken || !accessToken) {
      window.location.href = '/login.html';
      return false;
    }

    // Basic JWT expiry check
    try {
      const payload = JSON.parse(atob(idToken.split('.')[1]));
      const expiry = payload.exp * 1000;
      const now = Date.now();

      if (now >= expiry) {
        localStorage.removeItem('chimera_id_token');
        localStorage.removeItem('chimera_access_token');
        localStorage.removeItem('chimera_refresh_token');
        window.location.href = '/login.html';
        return false;
      }

      return true;
    } catch (error) {
      console.error('Failed to validate JWT:', error);
      window.location.href = '/login.html';
      return false;
    }
  }

  // Initialize settings UI
  async function init() {
    // Check authentication
    if (!checkAuth()) {
      return;
    }

    // Load all settings
    await Promise.all([loadProfile(), loadNotifications(), loadApiKey()]);
    loadAppearance();

    // Set up event listeners
    document.getElementById('profile-form').addEventListener('submit', saveProfile);
    document.getElementById('notifications-form').addEventListener('submit', saveNotifications);
    document.getElementById('appearance-form').addEventListener('submit', saveAppearance);

    document.getElementById('toggle-api-key').addEventListener('click', toggleApiKey);
    document.getElementById('copy-api-key').addEventListener('click', copyApiKey);
    document.getElementById('rotate-api-key').addEventListener('click', rotateApiKey);
    document.getElementById('generate-api-key').addEventListener('click', generateApiKey);
    document.getElementById('logout-button').addEventListener('click', logout);
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
