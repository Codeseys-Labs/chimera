/**
 * Dashboard UI JavaScript
 *
 * Displays agent status, recent conversations, and active tasks:
 * - Load metrics and display overview cards
 * - Fetch and render active agent status
 * - Show recent conversation history
 * - Display active tasks with priority
 * - Auto-refresh capability
 */

(function () {
  'use strict';

  // Configuration
  const config = {
    tenantId: localStorage.getItem('chimera_tenant_id') || 'demo-tenant',
    apiBase: '/api',
    refreshInterval: 30000, // 30 seconds
  };

  // State
  const state = {
    agents: [],
    conversations: [],
    tasks: [],
    metrics: {
      activeAgents: 0,
      conversations: 0,
      tasks: 0,
      tokens: 0,
    },
  };

  // Utility: Show error message
  function showError(message) {
    const errorDiv = document.getElementById('error-message');
    // Clear previous error safely
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

  // Utility: Format date
  function formatDate(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  }

  // Utility: Format number
  function formatNumber(num) {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
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

  // Load metrics from API
  async function loadMetrics() {
    try {
      const response = await apiRequest(`${config.apiBase}/metrics?tenantId=${config.tenantId}`);

      state.metrics = {
        activeAgents: response.activeAgents || 0,
        conversations: response.conversationsToday || 0,
        tasks: response.activeTasks || 0,
        tokens: response.tokensThisMonth || 0,
      };

      // Update metric displays
      document.getElementById('metric-active-agents').textContent = state.metrics.activeAgents;
      document.getElementById('metric-conversations').textContent = state.metrics.conversations;
      document.getElementById('metric-tasks').textContent = state.metrics.tasks;
      document.getElementById('metric-tokens').textContent = formatNumber(state.metrics.tokens);
    } catch (error) {
      console.error('Failed to load metrics:', error);
      // Set defaults on error
      document.getElementById('metric-active-agents').textContent = '0';
      document.getElementById('metric-conversations').textContent = '0';
      document.getElementById('metric-tasks').textContent = '0';
      document.getElementById('metric-tokens').textContent = '0';
    }
  }

  // Load agents from API
  async function loadAgents() {
    try {
      const agentsLoading = document.getElementById('agents-loading');
      const agentsContainer = document.getElementById('agents-container');
      const agentsEmpty = document.getElementById('agents-empty');

      agentsLoading.style.display = 'block';
      agentsContainer.style.display = 'none';
      agentsEmpty.style.display = 'none';

      const response = await apiRequest(`${config.apiBase}/agents?tenantId=${config.tenantId}`);
      state.agents = response.agents || [];

      agentsLoading.style.display = 'none';

      if (state.agents.length === 0) {
        agentsEmpty.style.display = 'block';
      } else {
        agentsContainer.style.display = 'grid';
        renderAgents();
      }
    } catch (error) {
      console.error('Failed to load agents:', error);
      document.getElementById('agents-loading').style.display = 'none';
      document.getElementById('agents-empty').style.display = 'block';
    }
  }

  // Render agents list
  function renderAgents() {
    const container = document.getElementById('agents-container');
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    state.agents.forEach((agent) => {
      const card = document.createElement('div');
      card.className = `agent-card ${agent.status}`;

      const header = document.createElement('div');
      header.className = 'agent-header';

      const name = document.createElement('div');
      name.className = 'agent-name';
      name.textContent = agent.name;

      const status = document.createElement('div');
      status.className = `agent-status ${agent.status}`;
      status.textContent = agent.status.toUpperCase();

      header.appendChild(name);
      header.appendChild(status);

      const details = document.createElement('div');
      details.className = 'agent-details';

      const taskP = document.createElement('p');
      taskP.textContent = agent.currentTask || 'No active task';
      taskP.style.margin = '0';

      details.appendChild(taskP);

      card.appendChild(header);
      card.appendChild(details);
      container.appendChild(card);
    });
  }

  // Load conversations from API
  async function loadConversations() {
    try {
      const conversationsLoading = document.getElementById('conversations-loading');
      const conversationsContainer = document.getElementById('conversations-container');
      const conversationsEmpty = document.getElementById('conversations-empty');

      conversationsLoading.style.display = 'block';
      conversationsContainer.style.display = 'none';
      conversationsEmpty.style.display = 'none';

      const response = await apiRequest(
        `${config.apiBase}/conversations?tenantId=${config.tenantId}&limit=5`
      );
      state.conversations = response.conversations || [];

      conversationsLoading.style.display = 'none';

      if (state.conversations.length === 0) {
        conversationsEmpty.style.display = 'block';
      } else {
        conversationsContainer.style.display = 'flex';
        renderConversations();
      }
    } catch (error) {
      console.error('Failed to load conversations:', error);
      document.getElementById('conversations-loading').style.display = 'none';
      document.getElementById('conversations-empty').style.display = 'block';
    }
  }

  // Render conversations list
  function renderConversations() {
    const container = document.getElementById('conversations-container');
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    state.conversations.forEach((conversation) => {
      const card = document.createElement('div');
      card.className = 'conversation-card';
      card.onclick = () => openConversation(conversation.id);

      const header = document.createElement('div');
      header.className = 'conversation-header';

      const id = document.createElement('div');
      id.className = 'conversation-id';
      id.textContent = conversation.id;

      const time = document.createElement('div');
      time.className = 'conversation-time';
      time.textContent = formatDate(conversation.lastMessageAt);

      header.appendChild(id);
      header.appendChild(time);

      const preview = document.createElement('div');
      preview.className = 'conversation-preview';
      preview.textContent = conversation.lastMessage || 'No messages yet';

      const meta = document.createElement('div');
      meta.className = 'conversation-meta';

      const messagesSpan = document.createElement('span');
      messagesSpan.textContent = `${conversation.messageCount || 0} messages`;

      const agentSpan = document.createElement('span');
      agentSpan.textContent = conversation.agentName || 'Unknown agent';

      meta.appendChild(messagesSpan);
      meta.appendChild(agentSpan);

      card.appendChild(header);
      card.appendChild(preview);
      card.appendChild(meta);
      container.appendChild(card);
    });
  }

  // Load tasks from API
  async function loadTasks() {
    try {
      const tasksLoading = document.getElementById('tasks-loading');
      const tasksContainer = document.getElementById('tasks-container');
      const tasksEmpty = document.getElementById('tasks-empty');

      tasksLoading.style.display = 'block';
      tasksContainer.style.display = 'none';
      tasksEmpty.style.display = 'none';

      const response = await apiRequest(
        `${config.apiBase}/tasks?tenantId=${config.tenantId}&status=in_progress`
      );
      state.tasks = response.tasks || [];

      tasksLoading.style.display = 'none';

      if (state.tasks.length === 0) {
        tasksEmpty.style.display = 'block';
      } else {
        tasksContainer.style.display = 'flex';
        renderTasks();
      }
    } catch (error) {
      console.error('Failed to load tasks:', error);
      document.getElementById('tasks-loading').style.display = 'none';
      document.getElementById('tasks-empty').style.display = 'block';
    }
  }

  // Render tasks list
  function renderTasks() {
    const container = document.getElementById('tasks-container');
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    state.tasks.forEach((task) => {
      const card = document.createElement('div');
      card.className = 'task-card';

      const header = document.createElement('div');
      header.className = 'task-header';

      const id = document.createElement('div');
      id.className = 'task-id';
      id.textContent = task.id;

      const priority = document.createElement('div');
      const priorityClass =
        task.priority === 1 || task.priority === 2
          ? 'high'
          : task.priority === 3
          ? 'medium'
          : 'low';
      priority.className = `task-priority ${priorityClass}`;
      priority.textContent = `P${task.priority}`;

      header.appendChild(id);
      header.appendChild(priority);

      const title = document.createElement('div');
      title.className = 'task-title';
      title.textContent = task.title;

      const agent = document.createElement('div');
      agent.className = 'task-agent';
      agent.textContent = `Assigned to: ${task.assignedAgent || 'Unassigned'}`;

      card.appendChild(header);
      card.appendChild(title);
      card.appendChild(agent);
      container.appendChild(card);
    });
  }

  // Open conversation (navigate to chat)
  function openConversation(conversationId) {
    window.location.href = `/index.html?conversation=${conversationId}`;
  }

  // Refresh agents
  async function refreshAgents() {
    await loadAgents();
    await loadMetrics();
  }

  // Refresh tasks
  async function refreshTasks() {
    await loadTasks();
    await loadMetrics();
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

  // Initialize dashboard
  async function init() {
    // Check authentication
    if (!checkAuth()) {
      return;
    }

    // Load all data
    await Promise.all([loadMetrics(), loadAgents(), loadConversations(), loadTasks()]);

    // Set up auto-refresh
    setInterval(() => {
      loadMetrics();
      loadAgents();
      loadTasks();
    }, config.refreshInterval);
  }

  // Expose public API
  window.dashboardApp = {
    refreshAgents,
    refreshTasks,
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
