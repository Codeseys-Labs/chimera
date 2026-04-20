import { describe, it, expect } from 'bun:test';
import {
  loadGatewayFlags,
  assertGatewayFlagsConsistent,
} from '../feature-flags';

describe('gateway feature flags', () => {
  it('all flags default to false with undefined gatewayId', () => {
    const f = loadGatewayFlags({});
    expect(f.gatewayMigrationEnabled).toBe(false);
    expect(f.gatewayPrimaryInvoke).toBe(false);
    expect(f.gatewayId).toBeUndefined();
    expect(f.gatewayRegion).toBeUndefined();
  });

  it('parses string truthy values', () => {
    const f = loadGatewayFlags({
      GATEWAY_MIGRATION_ENABLED: 'true',
      GATEWAY_PRIMARY_INVOKE: '1',
      GATEWAY_ID: 'gw-abc123',
      GATEWAY_REGION: 'us-west-2',
    });
    expect(f.gatewayMigrationEnabled).toBe(true);
    expect(f.gatewayPrimaryInvoke).toBe(true);
    expect(f.gatewayId).toBe('gw-abc123');
    expect(f.gatewayRegion).toBe('us-west-2');
  });

  it('accepts yes/YES variants and rejects empty string', () => {
    const f = loadGatewayFlags({
      GATEWAY_MIGRATION_ENABLED: 'YES',
      GATEWAY_PRIMARY_INVOKE: '',
    });
    expect(f.gatewayMigrationEnabled).toBe(true);
    expect(f.gatewayPrimaryInvoke).toBe(false);
  });

  it('defaults gatewayRegion to AWS_REGION when GATEWAY_REGION is unset', () => {
    const f = loadGatewayFlags({ AWS_REGION: 'eu-west-1' });
    expect(f.gatewayRegion).toBe('eu-west-1');
  });

  it('rejects primaryInvoke without migrationEnabled', () => {
    expect(() =>
      assertGatewayFlagsConsistent({
        gatewayMigrationEnabled: false,
        gatewayPrimaryInvoke: true,
        gatewayId: 'gw-x',
        gatewayRegion: 'us-west-2',
      })
    ).toThrow(
      /GATEWAY_PRIMARY_INVOKE=true requires GATEWAY_MIGRATION_ENABLED=true/
    );
  });

  it('rejects migrationEnabled without gatewayId', () => {
    expect(() =>
      assertGatewayFlagsConsistent({
        gatewayMigrationEnabled: true,
        gatewayPrimaryInvoke: false,
        gatewayId: undefined,
        gatewayRegion: 'us-west-2',
      })
    ).toThrow(/requires GATEWAY_ID to be set/);
  });

  it('accepts a valid Phase-1 config (migration on, primary off)', () => {
    expect(() =>
      assertGatewayFlagsConsistent({
        gatewayMigrationEnabled: true,
        gatewayPrimaryInvoke: false,
        gatewayId: 'gw-abc123',
        gatewayRegion: 'us-west-2',
      })
    ).not.toThrow();
  });

  it('accepts a valid Phase-2 config (both on)', () => {
    expect(() =>
      assertGatewayFlagsConsistent({
        gatewayMigrationEnabled: true,
        gatewayPrimaryInvoke: true,
        gatewayId: 'gw-abc123',
        gatewayRegion: 'us-west-2',
      })
    ).not.toThrow();
  });

  it('accepts the all-off Phase-0 default config', () => {
    expect(() =>
      assertGatewayFlagsConsistent({
        gatewayMigrationEnabled: false,
        gatewayPrimaryInvoke: false,
        gatewayId: undefined,
        gatewayRegion: undefined,
      })
    ).not.toThrow();
  });
});
