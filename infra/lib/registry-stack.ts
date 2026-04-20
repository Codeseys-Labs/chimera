import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface RegistryStackProps extends cdk.StackProps {
  envName: string;
  // TODO(spike): add tenantStrategy: 'per-tenant' | 'shared-with-scope' once resolved
}

/**
 * AgentCore Registry — PLACEHOLDER STACK.
 *
 * Intentionally empty until the multi-tenancy spike (docs/designs/agentcore-registry-spike.md)
 * resolves the per-tenant vs shared-with-scope model. Synthesized ONLY when the
 * `deployRegistry` CDK context flag is true: `npx cdk synth -c deployRegistry=true`.
 *
 * See:
 * - ADR-034 (docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md)
 * - Spike design (docs/designs/agentcore-registry-spike.md)
 * - Migration guide (docs/MIGRATION-registry.md)
 */
export class RegistryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RegistryStackProps) {
    super(scope, id, props);
    // Empty. See class docstring.
  }
}
