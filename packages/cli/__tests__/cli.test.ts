/**
 * Basic CLI tests
 */

import { loadConfig, saveConfig, clearConfig } from '../src/utils/config';
import { formatSuccess, formatError, formatWarning } from '../src/utils/output';

describe('CLI Utils', () => {
  describe('Config Management', () => {
    afterEach(() => {
      // Clean up test config
      clearConfig();
    });

    it('should load default config when file does not exist', () => {
      clearConfig();
      const config = loadConfig();
      expect(config.currentTenant).toBeNull();
    });

    it('should save and load config', () => {
      const testConfig = {
        currentTenant: 'tenant-123',
        tenants: [
          {
            tenantId: 'tenant-123',
            name: 'Test Tenant',
            tier: 'basic',
            region: 'us-east-1',
            status: 'active',
            createdAt: new Date().toISOString(),
          },
        ],
      };

      saveConfig(testConfig);
      const loaded = loadConfig();

      expect(loaded.currentTenant).toBe('tenant-123');
      expect(loaded.tenants).toHaveLength(1);
      expect(loaded.tenants![0].name).toBe('Test Tenant');
    });
  });

  describe('Output Formatting', () => {
    it('should format success messages', () => {
      const message = formatSuccess('Operation completed');
      expect(message).toContain('✓');
      expect(message).toContain('Operation completed');
    });

    it('should format error messages', () => {
      const message = formatError('Operation failed');
      expect(message).toContain('✗');
      expect(message).toContain('Operation failed');
    });

    it('should format warning messages', () => {
      const message = formatWarning('Be careful');
      expect(message).toContain('⚠');
      expect(message).toContain('Be careful');
    });
  });
});
