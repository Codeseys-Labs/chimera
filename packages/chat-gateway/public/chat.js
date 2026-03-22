/**
 * Chimera Web Chat Client
 *
 * SSE-based streaming chat with automatic reconnection.
 * Uses Vercel AI SDK Data Stream Protocol for streaming responses.
 */

// Configuration
const API_BASE = window.location.origin;
const RECONNECT_DELAY = 2000; // 2 seconds
const MAX_RECONNECT_ATTEMPTS = 5;
const STORAGE_KEYS = {
  CONVERSATIONS: 'chimera_conversations',
  ACTIVE_CONVERSATION: 'chimera_active_conversation',
  MESSAGES_PREFIX: 'chimera_messages_',
};

// State
let sessionId = null;
let reconnectAttempts = 0;
let isConnected = false;
let currentConversationId = null;
let uploadedFiles = [];

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
    // Get access token from auth
    const accessToken = window.ChimeraAuth?.getAccessToken();
    const userInfo = window.ChimeraAuth?.getUserInfo();

    if (!accessToken || !userInfo) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: message }],
        tenantId: userInfo.tenantId,
        userId: userInfo.sub,
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
 * Conversation management functions
 */

// Generate unique ID for conversations
function generateId() {
  return `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Get all conversations
function getConversations() {
  const data = localStorage.getItem(STORAGE_KEYS.CONVERSATIONS);
  return data ? JSON.parse(data) : [];
}

// Save conversations list
function saveConversations(conversations) {
  localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(conversations));
}

// Get messages for a conversation
function getMessages(conversationId) {
  const key = STORAGE_KEYS.MESSAGES_PREFIX + conversationId;
  const data = localStorage.getItem(key);
  return data ? JSON.parse(data) : [];
}

// Save messages for a conversation
function saveMessages(conversationId, messages) {
  const key = STORAGE_KEYS.MESSAGES_PREFIX + conversationId;
  localStorage.setItem(key, JSON.stringify(messages));
}

// Create a new conversation
function createConversation(title = 'New Conversation') {
  const conversations = getConversations();
  const newConversation = {
    id: generateId(),
    title: title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  conversations.unshift(newConversation);
  saveConversations(conversations);
  saveMessages(newConversation.id, []);

  return newConversation;
}

// Update conversation title
function updateConversationTitle(conversationId, title) {
  const conversations = getConversations();
  const conv = conversations.find((c) => c.id === conversationId);
  if (conv) {
    conv.title = title;
    conv.updatedAt = new Date().toISOString();
    saveConversations(conversations);
  }
}

// Delete conversation
function deleteConversation(conversationId) {
  const conversations = getConversations().filter((c) => c.id !== conversationId);
  saveConversations(conversations);

  // Delete messages
  const key = STORAGE_KEYS.MESSAGES_PREFIX + conversationId;
  localStorage.removeItem(key);

  // If this was the active conversation, switch to another
  if (currentConversationId === conversationId) {
    const nextConv = conversations[0];
    if (nextConv) {
      switchConversation(nextConv.id);
    } else {
      // No conversations left, create a new one
      const newConv = createConversation();
      switchConversation(newConv.id);
    }
  }

  renderConversationsList();
}

// Switch to a different conversation
function switchConversation(conversationId) {
  currentConversationId = conversationId;
  localStorage.setItem(STORAGE_KEYS.ACTIVE_CONVERSATION, conversationId);

  // Clear chat container and load messages
  while (chatContainer.firstChild) {
    chatContainer.removeChild(chatContainer.firstChild);
  }

  const messages = getMessages(conversationId);
  if (messages.length === 0) {
    // Show welcome message using safe DOM methods
    const welcomeDiv = document.createElement('div');
    welcomeDiv.className = 'welcome-message';

    const heading = document.createElement('h2');
    heading.textContent = 'Welcome to Chimera';

    const paragraph = document.createElement('p');
    paragraph.textContent = 'Start a conversation with your AI assistant.';

    welcomeDiv.appendChild(heading);
    welcomeDiv.appendChild(paragraph);
    chatContainer.appendChild(welcomeDiv);
  } else {
    // Render existing messages
    messages.forEach((msg) => {
      addMessage(msg.role, msg.content, false);
    });
  }

  renderConversationsList();
}

// Render conversations sidebar
function renderConversationsList() {
  const listContainer = document.getElementById('conversations-list');
  if (!listContainer) return;

  const conversations = getConversations();
  while (listContainer.firstChild) {
    listContainer.removeChild(listContainer.firstChild);
  }

  conversations.forEach((conv) => {
    const item = document.createElement('div');
    item.className = `conversation-item ${conv.id === currentConversationId ? 'active' : ''}`;

    const title = document.createElement('div');
    title.className = 'conversation-title';
    // Use textContent to prevent XSS
    title.textContent = conv.title;

    const deleteBtn = document.createElement('span');
    deleteBtn.className = 'conversation-delete';
    deleteBtn.textContent = '×';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      if (confirm('Delete this conversation?')) {
        deleteConversation(conv.id);
      }
    };

    item.onclick = () => switchConversation(conv.id);
    item.appendChild(title);
    item.appendChild(deleteBtn);
    listContainer.appendChild(item);
  });
}

/**
 * File upload functions
 */

const fileInput = document.getElementById('file-input');
const filePreview = document.getElementById('file-preview');
const fileUploadArea = document.getElementById('file-upload-area');

// Handle file selection
if (fileInput) {
  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    files.forEach((file) => {
      // Check file size (max 10MB)
      if (file.size > 10 * 1024 * 1024) {
        alert(`File ${file.name} is too large. Max size is 10MB.`);
        return;
      }

      uploadedFiles.push(file);
    });

    renderFilePreview();
    fileInput.value = ''; // Reset input
  });
}

// Render file preview chips
function renderFilePreview() {
  if (!filePreview) return;

  while (filePreview.firstChild) {
    filePreview.removeChild(filePreview.firstChild);
  }

  if (uploadedFiles.length === 0) {
    fileUploadArea.style.display = 'none';
    return;
  }

  fileUploadArea.style.display = 'block';

  uploadedFiles.forEach((file, index) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';

    const name = document.createElement('span');
    // Use textContent to prevent XSS
    name.textContent = file.name;

    const remove = document.createElement('span');
    remove.className = 'file-chip-remove';
    remove.textContent = '×';
    remove.onclick = () => {
      uploadedFiles.splice(index, 1);
      renderFilePreview();
    };

    chip.appendChild(name);
    chip.appendChild(remove);
    filePreview.appendChild(chip);
  });
}

// Convert file to base64 for transmission
async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Enhanced sendMessage with file upload and history persistence
 */
async function sendMessageEnhanced(message) {
  if (!message.trim() && uploadedFiles.length === 0) return;

  // Add user message to chat
  addMessage('user', message);

  // Save to conversation history
  const messages = getMessages(currentConversationId);
  messages.push({ role: 'user', content: message, timestamp: new Date().toISOString() });

  // Update conversation title from first message
  if (messages.length === 1 && message.trim()) {
    const title = message.substring(0, 50) + (message.length > 50 ? '...' : '');
    updateConversationTitle(currentConversationId, title);
    renderConversationsList();
  }

  // Prepare attachments
  const attachments = [];
  if (uploadedFiles.length > 0) {
    for (const file of uploadedFiles) {
      try {
        const base64 = await fileToBase64(file);
        attachments.push({
          filename: file.name,
          contentType: file.type,
          data: base64,
        });
      } catch (error) {
        console.error('Failed to encode file:', error);
      }
    }
  }

  // Clear uploaded files
  uploadedFiles = [];
  renderFilePreview();

  // Disable input during request
  messageInput.disabled = true;
  sendButton.disabled = true;

  // Create assistant message placeholder
  let streamingContent = '';
  const contentDiv = addMessage('assistant', '', true);

  try {
    // Get access token from auth
    const accessToken = window.ChimeraAuth?.getAccessToken();
    const userInfo = window.ChimeraAuth?.getUserInfo();

    if (!accessToken || !userInfo) {
      throw new Error('Not authenticated');
    }

    const requestBody = {
      messages: [{ role: 'user', content: message }],
      tenantId: userInfo.tenantId,
      userId: userInfo.sub,
      sessionId: sessionId,
      platform: 'web',
    };

    // Add attachments if present
    if (attachments.length > 0) {
      requestBody.attachments = attachments;
    }

    const response = await fetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(requestBody),
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

    // Save assistant message to history
    messages.push({
      role: 'assistant',
      content: streamingContent,
      timestamp: new Date().toISOString(),
    });
    saveMessages(currentConversationId, messages);

    // Update conversation timestamp
    const conversations = getConversations();
    const conv = conversations.find((c) => c.id === currentConversationId);
    if (conv) {
      conv.updatedAt = new Date().toISOString();
      saveConversations(conversations);
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
 * Initialize chat
 */
async function init() {
  // Test initial connection
  const connected = await testConnection();

  if (!connected) {
    reconnect();
  }

  // Initialize conversations
  let conversations = getConversations();
  if (conversations.length === 0) {
    // Create first conversation
    const firstConv = createConversation();
    currentConversationId = firstConv.id;
  } else {
    // Load active conversation or default to first
    const activeId = localStorage.getItem(STORAGE_KEYS.ACTIVE_CONVERSATION);
    if (activeId && conversations.find((c) => c.id === activeId)) {
      currentConversationId = activeId;
    } else {
      currentConversationId = conversations[0].id;
    }
  }

  // Render conversations and load messages
  renderConversationsList();
  switchConversation(currentConversationId);

  // New chat button
  const newChatButton = document.getElementById('new-chat-button');
  if (newChatButton) {
    newChatButton.addEventListener('click', () => {
      const newConv = createConversation();
      switchConversation(newConv.id);
    });
  }

  // Handle form submission
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const message = messageInput.value.trim();
    if (message || uploadedFiles.length > 0) {
      sendMessageEnhanced(message);
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
