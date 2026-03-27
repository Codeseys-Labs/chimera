import React, { useState, useEffect } from 'react';
import { Text } from 'ink';

interface StreamingTextProps {
  content: string;
  isStreaming: boolean;
}

export function StreamingText({ content, isStreaming }: StreamingTextProps) {
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 530);
    return () => clearInterval(interval);
  }, [isStreaming]);

  return (
    <Text>
      {content}
      {isStreaming && <Text dimColor>{cursorVisible ? '▋' : ' '}</Text>}
    </Text>
  );
}
