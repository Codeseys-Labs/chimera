import { getCurrentUser, updatePassword } from 'aws-amplify/auth';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTheme } from '@/components/theme-provider';
import { useAuth } from '@/hooks/use-auth';
import { apiGet, apiPut } from '@/lib/api-client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

/** Available model backends and their models */
const MODEL_OPTIONS = [
  // Converse API models (Anthropic)
  {
    id: 'us.anthropic.claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    backend: 'converse',
    tier: 'Advanced',
  },
  {
    id: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    label: 'Claude 3.5 Sonnet v2',
    backend: 'converse',
    tier: 'Basic',
  },
  {
    id: 'us.anthropic.claude-3-haiku-20240307-v1:0',
    label: 'Claude 3 Haiku',
    backend: 'converse',
    tier: 'Basic',
  },
  { id: 'amazon.nova-pro-v1:0', label: 'Amazon Nova Pro', backend: 'converse', tier: 'Basic' },
  { id: 'amazon.nova-lite-v1:0', label: 'Amazon Nova Lite', backend: 'converse', tier: 'Basic' },
  // Mantle API models (OpenAI-compatible)
  { id: 'openai.gpt-oss-120b', label: 'GPT-OSS 120B', backend: 'mantle', tier: 'Premium' },
  { id: 'openai.gpt-oss-20b', label: 'GPT-OSS 20B', backend: 'mantle', tier: 'Advanced' },
] as const;

interface TenantModelConfig {
  modelId: string;
  backend: 'converse' | 'mantle';
  maxTokens: number;
  temperature: number;
}

export function SettingsPage() {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');
  const { theme, setTheme } = useTheme();
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    getCurrentUser()
      .then((u) => {
        setEmail(u.signInDetails?.loginId ?? '');
        setDisplayName(u.username);
      })
      .catch(console.error);
  }, []);

  // Fetch current model config
  const { data: modelConfig } = useQuery({
    queryKey: ['model-config', tenantId],
    queryFn: () =>
      apiGet<TenantModelConfig>(`/chat/config/model`).catch(() => ({
        modelId: 'us.anthropic.claude-sonnet-4-6',
        backend: 'converse' as const,
        maxTokens: 4096,
        temperature: 1.0,
      })),
    enabled: !!tenantId,
  });

  const [selectedModel, setSelectedModel] = useState('');
  const [maxTokens, setMaxTokens] = useState('4096');
  const [temperature, setTemperature] = useState('1.0');

  // Sync form state when config loads
  useEffect(() => {
    if (modelConfig) {
      setSelectedModel(modelConfig.modelId);
      setMaxTokens(String(modelConfig.maxTokens));
      setTemperature(String(modelConfig.temperature));
    }
  }, [modelConfig]);

  const saveModelMutation = useMutation({
    mutationFn: (config: TenantModelConfig) => apiPut('/chat/config/model', config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['model-config'] });
    },
  });

  function handleSaveModel() {
    const model = MODEL_OPTIONS.find((m) => m.id === selectedModel);
    if (!model) return;
    saveModelMutation.mutate({
      modelId: selectedModel,
      backend: model.backend,
      maxTokens: parseInt(maxTokens, 10) || 4096,
      temperature: parseFloat(temperature) || 1.0,
    });
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwLoading(true);
    setPwError('');
    setPwSuccess('');
    try {
      await updatePassword({ oldPassword, newPassword });
      setPwSuccess('Password updated successfully.');
      setOldPassword('');
      setNewPassword('');
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Password change failed');
    } finally {
      setPwLoading(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Tabs defaultValue="account">
        <TabsList>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
        </TabsList>

        {/* Account */}
        <TabsContent value="account">
          <Card>
            <CardHeader>
              <CardTitle>Account</CardTitle>
              <CardDescription>Your profile information from Cognito</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Display Name</Label>
                <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input value={email} disabled className="cursor-not-allowed" />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Models */}
        <TabsContent value="models">
          <Card>
            <CardHeader>
              <CardTitle>Model Configuration</CardTitle>
              <CardDescription>
                Choose the AI model for your agent. Models are served via Bedrock Converse API
                (Anthropic, Amazon Nova) or Bedrock Mantle (OpenAI-compatible GPT-OSS).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>Model</Label>
                <Select value={selectedModel} onValueChange={setSelectedModel}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_OPTIONS.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <div className="flex items-center gap-2">
                          <span>{m.label}</span>
                          <Badge variant="outline" className="text-xs">
                            {m.backend}
                          </Badge>
                          <Badge variant="secondary" className="text-xs">
                            {m.tier}+
                          </Badge>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {selectedModel &&
                  MODEL_OPTIONS.find((m) => m.id === selectedModel)?.backend === 'mantle'
                    ? 'This model uses Bedrock Mantle (OpenAI-compatible endpoint). Requires a Bedrock API key.'
                    : 'This model uses the Bedrock Converse API with native streaming.'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Max Tokens</Label>
                  <Input
                    type="number"
                    min={256}
                    max={128000}
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Maximum response length (256–128,000)
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Temperature</Label>
                  <Input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={temperature}
                    onChange={(e) => setTemperature(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    0 = deterministic, 1 = balanced, 2 = creative
                  </p>
                </div>
              </div>

              <Button onClick={handleSaveModel} disabled={saveModelMutation.isPending}>
                {saveModelMutation.isPending ? 'Saving…' : 'Save Model Config'}
              </Button>

              {saveModelMutation.isSuccess && (
                <Alert>
                  <AlertDescription>Model configuration saved.</AlertDescription>
                </Alert>
              )}
              {saveModelMutation.isError && (
                <Alert variant="destructive">
                  <AlertDescription>
                    Failed to save: {saveModelMutation.error?.message}
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Security */}
        <TabsContent value="security">
          <Card>
            <CardHeader>
              <CardTitle>Security</CardTitle>
              <CardDescription>Change your password and MFA settings</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleChangePassword} className="space-y-4">
                {pwError && (
                  <Alert variant="destructive">
                    <AlertDescription>{pwError}</AlertDescription>
                  </Alert>
                )}
                {pwSuccess && (
                  <Alert>
                    <AlertDescription>{pwSuccess}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="old-pw">Current Password</Label>
                  <Input
                    id="old-pw"
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-pw">New Password</Label>
                  <Input
                    id="new-pw"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </div>
                <Button type="submit" disabled={pwLoading}>
                  {pwLoading ? 'Updating…' : 'Update Password'}
                </Button>
              </form>

              <Separator className="my-6" />
              <div>
                <h3 className="mb-2 text-sm font-medium">Multi-Factor Authentication</h3>
                <p className="text-sm text-muted-foreground">
                  MFA setup is managed through Cognito. Contact your administrator to configure
                  TOTP.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Integrations */}
        <TabsContent value="integrations">
          <Card>
            <CardHeader>
              <CardTitle>Integrations</CardTitle>
              <CardDescription>Connect external platforms to Chimera</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-md border p-4">
                <div>
                  <p className="font-medium">Slack</p>
                  <p className="text-sm text-muted-foreground">Connect your Slack workspace</p>
                </div>
                <Button variant="outline" size="sm">
                  Connect
                </Button>
              </div>
              <div className="flex items-center justify-between rounded-md border p-4">
                <div>
                  <p className="font-medium">Discord</p>
                  <p className="text-sm text-muted-foreground">Add the Chimera Discord bot</p>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <a href="#discord-invite" target="_blank" rel="noreferrer">
                    Invite Bot
                  </a>
                </Button>
              </div>
              <div className="flex items-center justify-between rounded-md border p-4">
                <div>
                  <p className="font-medium">Telegram</p>
                  <p className="text-sm text-muted-foreground">
                    Connect via Telegram Bot API webhook
                  </p>
                </div>
                <Button variant="outline" size="sm">
                  Configure
                </Button>
              </div>
              <div className="flex items-center justify-between rounded-md border p-4">
                <div>
                  <p className="font-medium">Microsoft Teams</p>
                  <p className="text-sm text-muted-foreground">Add Chimera as a Teams app</p>
                </div>
                <Button variant="outline" size="sm">
                  Connect
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Appearance */}
        <TabsContent value="appearance">
          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>Customize the interface theme</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-3">
                {(['light', 'dark', 'system'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={`rounded-md border p-3 text-sm capitalize transition-colors hover:bg-accent ${
                      theme === t ? 'border-primary bg-accent' : ''
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
