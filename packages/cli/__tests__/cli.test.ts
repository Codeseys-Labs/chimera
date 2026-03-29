/**
 * Basic CLI tests
 */

import { formatSuccess, formatError, formatWarning } from '../src/utils/output';

describe('CLI Utils', () => {
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
