import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  LOG_RETENTION_BY_CLASS,
  logRetentionFor,
} from '../../constructs/log-retention';

jest.setTimeout(15000);

describe('logRetentionFor', () => {
  describe('class defaults', () => {
    it('returns ONE_MONTH for app in prod (30-day S3-backed retention)', () => {
      expect(logRetentionFor('app', true)).toBe(RetentionDays.ONE_MONTH);
    });

    it('returns ONE_WEEK for app in dev', () => {
      expect(logRetentionFor('app', false)).toBe(RetentionDays.ONE_WEEK);
    });

    it('returns THREE_MONTHS for security in prod (90-day compliance window)', () => {
      expect(logRetentionFor('security', true)).toBe(RetentionDays.THREE_MONTHS);
    });

    it('returns ONE_WEEK for security in dev', () => {
      expect(logRetentionFor('security', false)).toBe(RetentionDays.ONE_WEEK);
    });

    it('returns ONE_WEEK for debug in prod', () => {
      expect(logRetentionFor('debug', true)).toBe(RetentionDays.ONE_WEEK);
    });

    it('returns THREE_DAYS for debug in dev', () => {
      expect(logRetentionFor('debug', false)).toBe(RetentionDays.THREE_DAYS);
    });
  });

  describe('prodMinimumDays floor', () => {
    it('raises prod retention when floor exceeds class baseline', () => {
      // Security class prod baseline is THREE_MONTHS (90). ONE_YEAR (365) is
      // greater — result must be ONE_YEAR for VPC flow logs.
      const result = logRetentionFor('security', true, {
        prodMinimumDays: RetentionDays.ONE_YEAR,
      });
      expect(result).toBe(RetentionDays.ONE_YEAR);
    });

    it('preserves class baseline when floor is below baseline', () => {
      // If someone passes a floor BELOW the class default, the class
      // default wins (floor is a minimum, not a cap).
      const result = logRetentionFor('security', true, {
        prodMinimumDays: RetentionDays.ONE_WEEK,
      });
      expect(result).toBe(RetentionDays.THREE_MONTHS);
    });

    it('ignores floor in dev', () => {
      // Dev retention is always the class dev value, regardless of the
      // prod floor — dev cost savings must not be silently erased by an
      // audit floor that only applies to prod.
      const result = logRetentionFor('security', false, {
        prodMinimumDays: RetentionDays.ONE_YEAR,
      });
      expect(result).toBe(RetentionDays.ONE_WEEK);
    });
  });

  describe('LOG_RETENTION_BY_CLASS table', () => {
    it('exposes the raw class table for test/cost-review consumption', () => {
      expect(LOG_RETENTION_BY_CLASS.app.prod).toBe(RetentionDays.ONE_MONTH);
      expect(LOG_RETENTION_BY_CLASS.security.prod).toBe(RetentionDays.THREE_MONTHS);
      expect(LOG_RETENTION_BY_CLASS.debug.prod).toBe(RetentionDays.ONE_WEEK);
    });
  });
});
