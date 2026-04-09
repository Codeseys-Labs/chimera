import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

// ── Mocks ───────────────────────────────────────────────────────────────────

// Mock aws-amplify/auth
vi.mock('aws-amplify/auth', () => ({
  getCurrentUser: vi.fn().mockResolvedValue({
    userId: 'user-1',
    username: 'TestUser',
    signInDetails: { loginId: 'test@example.com' },
  }),
  fetchAuthSession: vi.fn().mockResolvedValue({
    tokens: { idToken: { toString: () => 'tok', payload: {} } },
  }),
  updatePassword: vi.fn().mockResolvedValue(undefined),
}));

// Mock api-client
vi.mock('../lib/api-client', () => ({
  apiGet: vi.fn().mockResolvedValue({
    modelId: 'us.anthropic.claude-sonnet-4-6',
    backend: 'converse',
    maxTokens: 4096,
    temperature: 1.0,
  }),
  apiPost: vi.fn(),
  apiPut: vi.fn().mockResolvedValue(undefined),
}));

// Mock useAuth
vi.mock('../hooks/use-auth', () => ({
  useAuth: () => ({
    tenantId: 'tenant-1',
    userId: 'user-1',
    user: { userId: 'user-1', username: 'TestUser' },
    isLoading: false,
    isAuthenticated: true,
    getAuthToken: vi.fn(),
    handleSignOut: vi.fn(),
  }),
}));

// Mock theme-provider
const mockSetTheme = vi.fn();
vi.mock('../components/theme-provider', () => ({
  useTheme: () => ({
    theme: 'system',
    setTheme: mockSetTheme,
  }),
}));

// Mock the Select UI component to avoid Radix dual-React issue
vi.mock('../components/ui/select', async () => {
  const React = await import('react');
  return {
    Select: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (v: string) => void;
    }) => React.createElement('div', { 'data-testid': 'select-root' }, children),
    SelectTrigger: React.forwardRef(
      ({ children, ...props }: { children: React.ReactNode }, ref: React.Ref<HTMLButtonElement>) =>
        React.createElement('button', { ref, role: 'combobox', ...props }, children)
    ),
    SelectValue: ({ placeholder }: { placeholder?: string }) =>
      React.createElement('span', null, placeholder ?? ''),
    SelectContent: React.forwardRef(
      ({ children, ...props }: { children: React.ReactNode }, ref: React.Ref<HTMLDivElement>) =>
        React.createElement('div', { ref, ...props }, children)
    ),
    SelectItem: React.forwardRef(
      (
        { children, value, ...props }: { children: React.ReactNode; value: string },
        ref: React.Ref<HTMLDivElement>
      ) =>
        React.createElement('div', { ref, role: 'option', 'data-value': value, ...props }, children)
    ),
  };
});

process.env.VITE_API_BASE_URL = 'https://api.test.com';

import { SettingsPage } from '../pages/settings';

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client: qc }, createElement(SettingsPage)));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all tab triggers (Account, Models, Security, Integrations, Appearance)', () => {
    renderSettings();

    expect(screen.getByRole('tab', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Models' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Security' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Integrations' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Appearance' })).toBeInTheDocument();
  });

  it('Account tab shows email and display name labels', async () => {
    renderSettings();

    // Account is the default tab — wait for async getCurrentUser to populate
    await waitFor(() => {
      expect(screen.getByText('Display Name')).toBeInTheDocument();
      expect(screen.getByText('Email')).toBeInTheDocument();
    });
  });

  it('renders the Settings heading', () => {
    renderSettings();

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('Models tab renders model selector dropdown', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole('tab', { name: 'Models' }));

    await waitFor(() => {
      expect(screen.getByText('Model Configuration')).toBeInTheDocument();
    });
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('Max Tokens')).toBeInTheDocument();
    expect(screen.getByText('Temperature')).toBeInTheDocument();
  });

  it('Integrations tab shows Slack, Discord, Telegram, Teams entries', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole('tab', { name: 'Integrations' }));

    await waitFor(() => {
      expect(screen.getByText('Slack')).toBeInTheDocument();
    });
    expect(screen.getByText('Discord')).toBeInTheDocument();
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.getByText('Microsoft Teams')).toBeInTheDocument();
  });

  it('Appearance tab shows theme buttons', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole('tab', { name: 'Appearance' }));

    await waitFor(() => {
      expect(screen.getByText('light')).toBeInTheDocument();
    });
    expect(screen.getByText('dark')).toBeInTheDocument();
    expect(screen.getByText('system')).toBeInTheDocument();
  });

  it('Security tab shows password change form', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole('tab', { name: 'Security' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Current Password')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('New Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update Password' })).toBeInTheDocument();
  });

  it('Integrations tab shows Connect buttons', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole('tab', { name: 'Integrations' }));

    await waitFor(() => {
      expect(screen.getByText('Slack')).toBeInTheDocument();
    });

    // Should have Connect buttons for Slack, Teams, Telegram + Invite Bot for Discord
    const connectButtons = screen.getAllByRole('button', { name: 'Connect' });
    expect(connectButtons.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('link', { name: 'Invite Bot' })).toBeInTheDocument();
  });
});
