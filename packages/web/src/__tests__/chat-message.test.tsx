import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChatMessage } from '../components/chat-message'

describe('ChatMessage', () => {
  it('renders user message on the right side', () => {
    const { container } = render(
      <ChatMessage role="user" content="Hello there!" />,
    )
    // User messages have flex-row-reverse
    const wrapper = container.querySelector('.flex-row-reverse')
    expect(wrapper).toBeTruthy()
    expect(screen.getByText('Hello there!')).toBeTruthy()
  })

  it('renders assistant message with markdown', () => {
    render(
      <ChatMessage role="assistant" content="**Bold** text" />,
    )
    const bold = document.querySelector('strong')
    expect(bold?.textContent).toBe('Bold')
  })

  it('shows streaming cursor when isStreaming=true', () => {
    const { container } = render(
      <ChatMessage role="assistant" content="Thinking..." isStreaming />,
    )
    // Streaming cursor span is present (aria-hidden)
    const cursor = container.querySelector('[aria-hidden]')
    expect(cursor).toBeTruthy()
  })

  it('does not show streaming cursor when isStreaming=false', () => {
    const { container } = render(
      <ChatMessage role="assistant" content="Done." isStreaming={false} />,
    )
    const cursor = container.querySelector('[aria-hidden]')
    expect(cursor).toBeNull()
  })

  it('displays formatted timestamp when provided', () => {
    render(
      <ChatMessage
        role="user"
        content="Hi"
        timestamp="2026-01-15T10:30:00.000Z"
      />,
    )
    // Timestamp is rendered (exact format depends on locale)
    const timeElements = document.querySelectorAll('p')
    const hasTime = Array.from(timeElements).some((el) =>
      el.textContent?.includes(':'),
    )
    expect(hasTime).toBe(true)
  })
})
