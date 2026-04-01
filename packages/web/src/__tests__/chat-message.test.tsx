import { describe, it, expect, beforeAll } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { ChatMessage } from '../components/chat-message'

// Set up jsdom environment for bun test runner.
// vitest uses vite.config.ts (environment: 'jsdom') automatically;
// bun test needs explicit DOM setup via jsdom.
beforeAll(async () => {
  if (typeof document === 'undefined') {
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost',
      pretendToBeVisual: true,
    })
    const { window } = dom
    const g = globalThis as Record<string, unknown>
    g.window = window
    g.document = window.document
    g.HTMLElement = window.HTMLElement
    g.SVGElement = window.SVGElement
    g.Element = window.Element
    g.Node = window.Node
    g.Text = window.Text
    g.Comment = window.Comment
    g.DocumentFragment = window.DocumentFragment
    g.Event = window.Event
    g.CustomEvent = window.CustomEvent
    g.MouseEvent = window.MouseEvent
    g.KeyboardEvent = window.KeyboardEvent
    g.MutationObserver = window.MutationObserver
    g.getComputedStyle = (el: Element) => window.getComputedStyle(el)
    g.IS_REACT_ACT_ENVIRONMENT = true
  }
})

describe('ChatMessage', () => {
  it('renders user message on the right side', () => {
    const { container } = render(
      <ChatMessage role="user" content="Hello there!" />,
    )
    // User messages have flex-row-reverse
    const wrapper = container.querySelector('.flex-row-reverse')
    expect(wrapper).toBeTruthy()
    expect(container.textContent).toContain('Hello there!')
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
