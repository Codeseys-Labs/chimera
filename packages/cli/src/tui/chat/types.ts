export interface ToolUse {
  toolName: string;
  input?: string;
  status: 'pending' | 'running' | 'complete';
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  toolUses?: ToolUse[];
}

export interface ChatState {
  messages: ChatMessage[];
  streamingContent: string;
  isLoading: boolean;
  error: string | null;
  sessionId: string | null;
}
