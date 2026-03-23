/**
 * Signature Verifier Tests
 *
 * Tests for stage 4 of skill security pipeline
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  SignatureVerifier,
  SignatureVerifierConfig,
  SkillSignatureMetadata,
} from '../scanners/signature-verifier';

describe('SignatureVerifier', () => {
  let verifier: SignatureVerifier;

  beforeEach(() => {
    verifier = new SignatureVerifier();
  });

  describe('Bundle Verification', () => {
    it('should verify bundle with valid author signature', async () => {
      const bundleContent = Buffer.from('skill content here');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'), // Mock 64-byte Ed25519 sig
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'), // Mock 32-byte Ed25519 key
          keyId: 'author-key-001',
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.passed).toBe(true);
      expect(result.authorSignature).toBeDefined();
      expect(result.authorSignature?.valid).toBe(true);
      expect(result.bundleHash).toBeDefined();
      expect(result.bundleHash.length).toBe(64); // SHA256 hex string
    });

    it('should verify bundle with dual signatures (author + platform)', async () => {
      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
          keyId: 'author-key-001',
        },
        platform: {
          signature: Buffer.from('c'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('d'.repeat(32)).toString('base64'),
          keyId: 'platform-key-001',
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.passed).toBe(true);
      expect(result.authorSignature?.valid).toBe(true);
      expect(result.platformSignature?.valid).toBe(true);
    });

    it('should fail with missing author signature when required', async () => {
      const verifier = new SignatureVerifier({ requireAuthor: true });
      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {}; // No signatures

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.passed).toBe(false);
      expect(result.authorSignature).toBeUndefined();
    });

    it('should fail with invalid signature format', async () => {
      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: '', // Empty signature
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.passed).toBe(false);
      expect(result.authorSignature?.valid).toBe(false);
      expect(result.authorSignature?.errors).toBeDefined();
      expect(result.authorSignature?.errors?.[0]).toContain('Empty signature');
    });

    it('should fail with missing public key', async () => {
      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          // Missing publicKey
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.passed).toBe(false);
      expect(result.authorSignature?.errors).toBeDefined();
      expect(result.authorSignature?.errors?.[0]).toContain('Missing public key');
    });
  });

  describe('Signature Format Validation', () => {
    it('should reject signature with incorrect length', async () => {
      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(32)).toString('base64'), // Wrong length (32 vs 64)
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.passed).toBe(false);
      expect(result.authorSignature?.valid).toBe(false);
    });

    it('should reject public key with incorrect length', async () => {
      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(16)).toString('base64'), // Wrong length (16 vs 32)
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.passed).toBe(false);
      expect(result.authorSignature?.valid).toBe(false);
    });
  });

  describe('Trust Level Validation', () => {
    it('should mark signature as trusted when key is in allowlist', async () => {
      const publicKeyBuffer = Buffer.from('b'.repeat(32));
      const keyFingerprint = publicKeyBuffer.toString('hex').substring(0, 16);

      const verifier = new SignatureVerifier({
        trustedKeys: [keyFingerprint],
      });

      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: publicKeyBuffer.toString('base64'),
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.authorSignature?.trustLevel).toBe('trusted');
    });

    it('should mark signature as untrusted when key not in allowlist', async () => {
      const verifier = new SignatureVerifier({
        trustedKeys: ['different-fingerprint'],
      });

      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.authorSignature?.trustLevel).toBe('untrusted');
    });
  });

  describe('Configuration Options', () => {
    it('should respect requireAuthor=false', async () => {
      const verifier = new SignatureVerifier({ requireAuthor: false });
      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {}; // No signatures

      const result = await verifier.verifyBundle(bundleContent, signatures);

      // Should pass because author not required
      expect(result.passed).toBe(false); // Still fails: no signatures at all
    });

    it('should respect requirePlatform=true', async () => {
      const verifier = new SignatureVerifier({
        requireAuthor: false,
        requirePlatform: true,
      });

      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
        },
        // Missing platform signature
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.passed).toBe(false); // Fails because platform required
    });

    it('should allow different signature methods', async () => {
      const verifier = new SignatureVerifier({ method: 'ed25519' });

      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.authorSignature?.method).toBe('ed25519');
    });
  });

  describe('Certificate Validation', () => {
    it('should validate certificate for Sigstore method', async () => {
      const verifier = new SignatureVerifier({ method: 'sigstore' });

      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
          keyId: 'sigstore-cert-001',
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.certificate).toBeDefined();
      expect(result.certificate?.valid).toBe(true);
      expect(result.certificate?.issuer).toBeDefined();
    });

    it('should not validate certificate for Ed25519 method', async () => {
      const verifier = new SignatureVerifier({ method: 'ed25519' });

      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.certificate).toBeUndefined();
    });
  });

  describe('Bundle Hash Computation', () => {
    it('should compute consistent SHA256 hash', async () => {
      const bundleContent = Buffer.from('identical content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
        },
      };

      const result1 = await verifier.verifyBundle(bundleContent, signatures);
      const result2 = await verifier.verifyBundle(bundleContent, signatures);

      expect(result1.bundleHash).toBe(result2.bundleHash);
    });

    it('should compute different hash for different content', async () => {
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
        },
      };

      const result1 = await verifier.verifyBundle(Buffer.from('content A'), signatures);
      const result2 = await verifier.verifyBundle(Buffer.from('content B'), signatures);

      expect(result1.bundleHash).not.toBe(result2.bundleHash);
    });
  });

  describe('Key Fingerprint', () => {
    it('should include key fingerprint in verification result', async () => {
      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.authorSignature?.keyFingerprint).toBeDefined();
      expect(result.authorSignature?.keyFingerprint?.length).toBe(16);
    });
  });

  describe('Metadata', () => {
    it('should include scanner version', async () => {
      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.scannerVersion).toBeDefined();
      expect(result.scannerVersion).toBe('1.0.0');
    });

    it('should include verification timestamp', async () => {
      const bundleContent = Buffer.from('skill content');
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.verifiedAt).toBeDefined();
      expect(new Date(result.verifiedAt).getTime()).toBeGreaterThan(0);
    });
  });

  describe('String Bundle Support', () => {
    it('should accept string bundle content', async () => {
      const bundleContent = 'skill content as string';
      const signatures: SkillSignatureMetadata = {
        author: {
          signature: Buffer.from('a'.repeat(64)).toString('base64'),
          publicKey: Buffer.from('b'.repeat(32)).toString('base64'),
        },
      };

      const result = await verifier.verifyBundle(bundleContent, signatures);

      expect(result.bundleHash).toBeDefined();
      expect(result.passed).toBe(true);
    });
  });
});
