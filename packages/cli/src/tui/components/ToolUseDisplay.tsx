import React from 'react';
import { Box, Text } from 'ink';

interface ToolUseDisplayProps {
  toolName: string;
  input?: string;
  status: 'pending' | 'running' | 'complete';
  result?: string;
}

const STATUS_CONFIG = {
  pending: { color: 'white', dimColor: true, icon: '○', label: 'pending' },
  running: { color: 'yellow', dimColor: false, icon: '◎', label: 'running' },
  complete: { color: 'green', dimColor: false, icon: '●', label: 'complete' },
} as const;

export function ToolUseDisplay({ toolName, input, status, result }: ToolUseDisplayProps) {
  const cfg = STATUS_CONFIG[status];

  return (
    <Box
      borderStyle="single"
      borderColor={cfg.color}
      marginBottom={1}
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        <Text color={cfg.color} dimColor={cfg.dimColor}>
          {cfg.icon} tool:{' '}
        </Text>
        <Text bold>{toolName}</Text>
        <Text color={cfg.color} dimColor={cfg.dimColor}>
          {' '}[{cfg.label}]
        </Text>
      </Box>
      {input && (
        <Text dimColor wrap="wrap">
          {input}
        </Text>
      )}
      {result && status === 'complete' && (
        <Text color="green" dimColor>
          → {result}
        </Text>
      )}
    </Box>
  );
}
