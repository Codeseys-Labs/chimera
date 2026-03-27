import React, { useState } from 'react';
import { Box, Text, useApp, useInput, Static, Key } from 'ink';
import TextInput from 'ink-text-input';
import { ChatBubble } from '../components/ChatBubble.js';
import { Spinner } from '../components/Spinner.js';
import { useChat } from './useChat.js';
import type { ChatMessage } from './types.js';

interface ChatViewProps {
  sessionId?: string;
}

export default function ChatView({ sessionId }: ChatViewProps) {
  const { exit } = useApp();
  const { state, sendMessage } = useChat(sessionId);
  const [input, setInput] = useState('');

  useInput((char: string, key: Key) => {
    if (key.ctrl && char.toLowerCase() === 'c') {
      exit();
    }
  });

  const handleSubmit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || state.isLoading) return;
    setInput('');
    await sendMessage(trimmed);
  };

  return (
    <Box flexDirection="column" width="100%">
      {/* Status bar */}
      <Box borderStyle="single" borderColor="gray" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">
          Chimera Chat
        </Text>
        {state.sessionId && (
          <Text dimColor>
            {'  '}session: {state.sessionId}
          </Text>
        )}
        <Text dimColor>{'  '}Ctrl+C to exit</Text>
      </Box>

      {/* Finalized messages (Static prevents re-render) */}
      <Static items={state.messages}>
        {(message: ChatMessage) => (
          <ChatBubble
            key={message.id}
            role={message.role}
            content={message.content}
            timestamp={message.timestamp}
          />
        )}
      </Static>

      {/* Active streaming response */}
      {state.isLoading && (
        <ChatBubble
          role="assistant"
          content={state.streamingContent}
          isStreaming={true}
        />
      )}

      {/* Spinner while waiting for first token */}
      {state.isLoading && !state.streamingContent && (
        <Box marginBottom={1}>
          <Spinner label="Thinking…" />
        </Box>
      )}

      {/* Error display */}
      {state.error && (
        <Box borderStyle="round" borderColor="red" paddingX={1} marginBottom={1}>
          <Text color="red">✗ {state.error}</Text>
        </Box>
      )}

      {/* Input bar */}
      <Box borderStyle="round" borderColor={state.isLoading ? 'gray' : 'blue'} paddingX={1}>
        <Text color="blue" bold>
          You:{' '}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={state.isLoading ? 'Waiting for response…' : 'Type a message…'}
          focus={!state.isLoading}
        />
      </Box>
    </Box>
  );
}
