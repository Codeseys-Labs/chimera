/**
 * Admin UI JavaScript
 *
 * Manages chat platform integrations UI:
 * - Load and display connected integrations
 * - Initiate OAuth flows for Slack/Discord/Teams
 * - Manage user pairings
 * - Remove integrations
 */

(function () {
  'use strict';

  // Configuration
  const config = {
    tenantId: localStorage.getItem('chimera_tenant_id') || 'demo-tenant',
    apiBase: '/integrations',
  };

  // State
  const state = {
    integrations: [],
    pairings: [],
  };

  // Utility: Show error message
  function showError(message) {
    const errorDiv = document.getElementById('error-message');
    const errorBox = document.createElement('div');
    errorBox.className = 'error';
    errorBox.textContent = message;
    errorDiv.innerHTML = '';
    errorDiv.appendChild(errorBox);
    setTimeout(() => {
      errorDiv.innerHTML = '';
    }, 5000);
  }

  // Utility: Show success message
  function showSuccess(message) {
    const successDiv = document.getElementById('success-message');
    const successBox = document.createElement('div');
    successBox.className = 'success';
    successBox.textContent = message;
    successDiv.innerHTML = '';
    successDiv.appendChild(successBox);
    setTimeout(() => {
      successDiv.innerHTML = '';
    }, 5000);
  }

  // Utility: Format date
  function formatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  }

  // Utility: Make API request
  async function apiRequest(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Tenant-Id': config.tenantId,
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Request failed');
    }

    return response.json();
  }

  // Load integrations from API
  async function loadIntegrations() {
    try {
      const integrationsLoading = document.getElementById('integrations-loading');
      const integrationsContainer = document.getElementById('integrations-container');
      const integrationsEmpty = document.getElementById('integrations-empty');

      integrationsLoading.style.display = 'block';
      integrationsContainer.style.display = 'none';
      integrationsEmpty.style.display = 'none';

      const response = await apiRequest(`${config.apiBase}/${config.tenantId}`);
      state.integrations = response.integrations || [];

      integrationsLoading.style.display = 'none';

      if (state.integrations.length === 0) {
        integrationsEmpty.style.display = 'block';
      } else {
        integrationsContainer.style.display = 'grid';
        renderIntegrations();
      }
    } catch (error) {
      console.error('Failed to load integrations:', error);
      showError('Failed to load integrations: ' + error.message);
      document.getElementById('integrations-loading').style.display = 'none';
      document.getElementById('integrations-empty').style.display = 'block';
    }
  }

  // Render integrations list
  function renderIntegrations() {
    const container = document.getElementById('integrations-container');
    container.innerHTML = '';

    state.integrations.forEach((integration) => {
      const platformIcon =
        integration.platform === 'slack'
          ? '💬'
          : integration.platform === 'discord'
          ? '🎮'
          : '📊';
      const platformName =
        integration.platform.charAt(0).toUpperCase() + integration.platform.slice(1);

      // Create card
      const card = document.createElement('div');
      card.className = `integration-card ${
        integration.status === 'active' ? 'connected' : ''
      }`;

      // Header
      const header = document.createElement('div');
      header.className = 'integration-header';

      const title = document.createElement('div');
      title.className = 'integration-title';
      const icon = document.createElement('span');
      icon.className = 'platform-icon';
      icon.textContent = platformIcon;
      title.appendChild(icon);
      title.appendChild(document.createTextNode(' ' + platformName));

      const statusBadge = document.createElement('span');
      statusBadge.className = `status-badge ${integration.status}`;
      statusBadge.textContent = integration.status.toUpperCase();

      header.appendChild(title);
      header.appendChild(statusBadge);

      // Details
      const details = document.createElement('div');
      details.className = 'integration-details';

      const workspaceP = document.createElement('p');
      const workspaceLabel = document.createElement('strong');
      workspaceLabel.textContent = 'Workspace: ';
      workspaceP.appendChild(workspaceLabel);
      workspaceP.appendChild(document.createTextNode(integration.workspaceName));

      const idP = document.createElement('p');
      const idLabel = document.createElement('strong');
      idLabel.textContent = 'Workspace ID: ';
      idP.appendChild(idLabel);
      idP.appendChild(document.createTextNode(integration.workspaceId));

      const dateP = document.createElement('p');
      const dateLabel = document.createElement('strong');
      dateLabel.textContent = 'Installed: ';
      dateP.appendChild(dateLabel);
      dateP.appendChild(document.createTextNode(formatDate(integration.installedAt)));

      details.appendChild(workspaceP);
      details.appendChild(idP);
      details.appendChild(dateP);

      // Actions
      const actions = document.createElement('div');
      actions.className = 'integration-actions';

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-danger';
      removeBtn.textContent = 'Remove';
      removeBtn.onclick = () =>
        window.adminApp.removeIntegration(integration.platform, integration.workspaceId);

      actions.appendChild(removeBtn);

      // Assemble card
      card.appendChild(header);
      card.appendChild(details);
      card.appendChild(actions);
      container.appendChild(card);
    });
  }

  // Load user pairings from API
  async function loadPairings() {
    try {
      const pairingsLoading = document.getElementById('pairings-loading');
      const pairingsContainer = document.getElementById('pairings-container');
      const pairingsEmpty = document.getElementById('pairings-empty');

      pairingsLoading.style.display = 'block';
      pairingsContainer.style.display = 'none';
      pairingsEmpty.style.display = 'none';

      const response = await apiRequest(`${config.apiBase}/${config.tenantId}/users`);
      state.pairings = response.pairings || [];

      pairingsLoading.style.display = 'none';

      if (state.pairings.length === 0) {
        pairingsEmpty.style.display = 'block';
      } else {
        pairingsContainer.style.display = 'block';
        renderPairings();
      }
    } catch (error) {
      console.error('Failed to load user pairings:', error);
      showError('Failed to load user pairings: ' + error.message);
      document.getElementById('pairings-loading').style.display = 'none';
      document.getElementById('pairings-empty').style.display = 'block';
    }
  }

  // Render user pairings table
  function renderPairings() {
    const tbody = document.getElementById('pairings-table-body');
    tbody.innerHTML = '';

    state.pairings.forEach((pairing) => {
      const platformName =
        pairing.platform.charAt(0).toUpperCase() + pairing.platform.slice(1);

      const row = document.createElement('tr');

      // Platform
      const platformCell = document.createElement('td');
      platformCell.textContent = platformName;
      row.appendChild(platformCell);

      // Platform User ID
      const userIdCell = document.createElement('td');
      userIdCell.textContent = pairing.platformUserId;
      row.appendChild(userIdCell);

      // Cognito Sub
      const cognitoCell = document.createElement('td');
      const cognitoCode = document.createElement('code');
      cognitoCode.textContent = pairing.cognitoSub;
      cognitoCell.appendChild(cognitoCode);
      row.appendChild(cognitoCell);

      // Paired At
      const dateCell = document.createElement('td');
      dateCell.textContent = formatDate(pairing.pairedAt);
      row.appendChild(dateCell);

      // Actions
      const actionsCell = document.createElement('td');
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-danger';
      removeBtn.textContent = 'Remove';
      removeBtn.onclick = () =>
        window.adminApp.removePairing(pairing.platform, pairing.platformUserId);
      actionsCell.appendChild(removeBtn);
      row.appendChild(actionsCell);

      tbody.appendChild(row);
    });
  }

  // Connect Slack workspace
  async function connectSlack() {
    try {
      const redirectUri = window.location.origin + '/admin.html';

      const response = await apiRequest(`${config.apiBase}/${config.tenantId}/slack`, {
        method: 'POST',
        body: JSON.stringify({ redirectUri }),
      });

      // Redirect to Slack OAuth URL
      window.location.href = response.authUrl;
    } catch (error) {
      console.error('Failed to initiate Slack OAuth:', error);
      showError('Failed to connect Slack: ' + error.message);
    }
  }

  // Handle OAuth callback
  async function handleOAuthCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');

    if (!code || !state) {
      return; // Not an OAuth callback
    }

    try {
      showSuccess('Processing Slack OAuth callback...');

      const response = await apiRequest(
        `${config.apiBase}/${config.tenantId}/slack/callback`,
        {
          method: 'POST',
          body: JSON.stringify({ code, state }),
        }
      );

      showSuccess('Slack workspace connected successfully!');

      // Remove OAuth params from URL
      window.history.replaceState({}, document.title, '/admin.html');

      // Reload integrations
      await loadIntegrations();
    } catch (error) {
      console.error('Failed to complete Slack OAuth:', error);
      showError('Failed to complete Slack OAuth: ' + error.message);
    }
  }

  // Remove integration
  async function removeIntegration(platform, workspaceId) {
    if (!confirm(`Are you sure you want to remove this ${platform} integration?`)) {
      return;
    }

    try {
      await apiRequest(`${config.apiBase}/${config.tenantId}/${platform}/${workspaceId}`, {
        method: 'DELETE',
      });

      showSuccess(`${platform} integration removed successfully`);
      await loadIntegrations();
    } catch (error) {
      console.error('Failed to remove integration:', error);
      showError('Failed to remove integration: ' + error.message);
    }
  }

  // Remove user pairing
  async function removePairing(platform, platformUserId) {
    if (!confirm('Are you sure you want to remove this user pairing?')) {
      return;
    }

    try {
      await apiRequest(
        `${config.apiBase}/${config.tenantId}/users/${platform}/${platformUserId}`,
        {
          method: 'DELETE',
        }
      );

      showSuccess('User pairing removed successfully');
      await loadPairings();
    } catch (error) {
      console.error('Failed to remove user pairing:', error);
      showError('Failed to remove user pairing: ' + error.message);
    }
  }

  // Initialize admin UI
  async function init() {
    // Update tenant badge
    document.getElementById('tenant-badge').textContent = config.tenantId;

    // Check for OAuth callback
    await handleOAuthCallback();

    // Load data
    await Promise.all([loadIntegrations(), loadPairings()]);
  }

  // Expose public API
  window.adminApp = {
    connectSlack,
    removeIntegration,
    removePairing,
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
