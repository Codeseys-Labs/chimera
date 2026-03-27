import React from 'react';
import { Box, Text } from 'ink';
import { StreamingText } from './StreamingText.js';

interface ChatBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: Date;
  isStreaming?: boolean;
}

export function ChatBubble({ role, content, timestamp, isStreaming = false }: ChatBubbleProps) {
  const isUser = role === 'user';
  const borderColor = isUser ? 'blue' : 'green';
  const labelColor = isUser ? 'blue' : 'green';
  const label = isUser ? 'You' : 'Chimera';

  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      marginBottom={1}
      paddingX={1}
      flexDirection="column"
    >
      <Box marginBottom={0}>
        <Text color={labelColor} bold>
          {label}
        </Text>
        {timestamp && (
          <Text dimColor>
            {'  '}
            {timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        )}
      </Box>
      <StreamingText content={content} isStreaming={isStreaming} />
    </Box>
  );
}
