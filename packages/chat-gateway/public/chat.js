/**
 * Chimera Web Chat Client
 *
 * SSE-based streaming chat with automatic reconnection.
 * Uses Vercel AI SDK Data Stream Protocol for streaming responses.
 */

// Configuration
const API_BASE = window.location.origin;
const TENANT_ID = 'demo-tenant'; // In production, get from auth token
const USER_ID = 'demo-user';
const RECONNECT_DELAY = 2000; // 2 seconds
const MAX_RECONNECT_ATTEMPTS = 5;

// State
let sessionId = null;
let reconnectAttempts = 0;
let isConnected = false;

// DOM elements
const chatContainer = document.getElementById('chat-container');
const messageInput = document.getElementById('message-input');
const chatForm = document.getElementById('chat-form');
const sendButton = document.getElementById('send-button');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

/**
 * Update connection status
 */
function updateStatus(connected) {
  isConnected = connected;
  statusDot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  statusText.textContent = connected ? 'Connected' : 'Disconnected';
  messageInput.disabled = !connected;
  sendButton.disabled = !connected;

  if (connected) {
    reconnectAttempts = 0;
  }
}

/**
 * Add a message to the chat
 */
function addMessage(role, content, streaming = false) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  contentDiv.textContent = content;

  messageDiv.appendChild(contentDiv);

  // Remove welcome message on first interaction
  const welcomeMessage = chatContainer.querySelector('.welcome-message');
  if (welcomeMessage) {
    welcomeMessage.remove();
  }

  chatContainer.appendChild(messageDiv);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  return streaming ? contentDiv : null;
}

/**
 * Update streaming message content
 */
function updateStreamingMessage(contentDiv, text) {
  if (contentDiv) {
    contentDiv.textContent = text;
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }
}

/**
 * Parse Data Stream Protocol event
 *
 * Vercel AI SDK DSP uses the format:
 * data: {event_type}:{json_payload}
 */
function parseDSPEvent(data) {
  const colonIndex = data.indexOf(':');
  if (colonIndex === -1) {
    return null;
  }

  const eventType = data.substring(0, colonIndex);
  const payload = data.substring(colonIndex + 1);

  try {
    return {
      type: eventType,
      data: payload ? JSON.parse(payload) : null,
    };
  } catch (err) {
    console.error('Failed to parse DSP event:', err);
    return null;
  }
}

/**
 * Send a message via SSE streaming
 */
async function sendMessage(message) {
  if (!message.trim()) return;

  // Add user message to chat
  addMessage('user', message);

  // Disable input during request
  messageInput.disabled = true;
  sendButton.disabled = true;

  // Create assistant message placeholder
  let streamingContent = '';
  const contentDiv = addMessage('assistant', '', true);

  try {
    const response = await fetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': TENANT_ID,
        'X-User-ID': USER_ID,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: message }],
        tenantId: TENANT_ID,
        userId: USER_ID,
        sessionId: sessionId,
        platform: 'web',
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Read SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.substring(6); // Remove 'data: ' prefix

          // Handle DSP events
          const event = parseDSPEvent(data);
          if (!event) continue;

          switch (event.type) {
            case 'text':
              // Text delta
              streamingContent += event.data;
              updateStreamingMessage(contentDiv, streamingContent);
              break;

            case 'message_start':
              // Message started
              if (event.data && event.data.sessionId) {
                sessionId = event.data.sessionId;
              }
              break;

            case 'message_stop':
              // Message complete
              break;

            case 'error':
              // Error occurred
              console.error('Stream error:', event.data);
              if (contentDiv) {
                contentDiv.textContent = 'Error: ' + (event.data.message || 'Unknown error');
                contentDiv.classList.add('error');
              }
              break;
          }
        }
      }
    }

    // If no content was streamed, show a placeholder
    if (!streamingContent && contentDiv) {
      contentDiv.textContent = 'No response received.';
    }
  } catch (error) {
    console.error('Request failed:', error);
    if (contentDiv) {
      contentDiv.textContent = `Error: ${error.message}`;
      contentDiv.classList.add('error');
    }
  } finally {
    // Re-enable input
    messageInput.disabled = false;
    sendButton.disabled = false;
    messageInput.focus();
  }
}

/**
 * Test connection to server
 */
async function testConnection() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    if (response.ok) {
      updateStatus(true);
      return true;
    }
  } catch (error) {
    console.error('Connection test failed:', error);
  }

  updateStatus(false);
  return false;
}

/**
 * Reconnect with exponential backoff
 */
function reconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    statusText.textContent = 'Connection failed';
    return;
  }

  reconnectAttempts++;
  statusText.textContent = `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`;

  setTimeout(async () => {
    const connected = await testConnection();
    if (!connected) {
      reconnect();
    }
  }, RECONNECT_DELAY * reconnectAttempts);
}

/**
 * Initialize chat
 */
async function init() {
  // Test initial connection
  const connected = await testConnection();

  if (!connected) {
    reconnect();
  }

  // Handle form submission
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const message = messageInput.value.trim();
    if (message) {
      sendMessage(message);
      messageInput.value = '';
    }
  });

  // Handle connection loss
  window.addEventListener('online', () => {
    console.log('Network online');
    testConnection();
  });

  window.addEventListener('offline', () => {
    console.log('Network offline');
    updateStatus(false);
  });

  // Focus input
  if (isConnected) {
    messageInput.focus();
  }
}

// Start app
init();
