/**
 * Signature Verification Scanner
 *
 * Stage 4 of 7-stage skill security pipeline
 * Verifies cryptographic signatures on skill bundles using GPG/Sigstore
 * Implements Ed25519 dual-signature chain (author + platform)
 *
 * Reference: docs/research/architecture-reviews/Chimera-Skill-Ecosystem-Design.md § 4.2
 *
 * Signature Model:
 * - Author signature: Skill developer signs bundle with their Ed25519 key
 * - Platform signature: Chimera co-signs after security pipeline passes
 * - Trust chain: platform sig → author sig → skill bundle
 */

/**
 * Signature verification method
 */
export type SignatureMethod = 'ed25519' | 'gpg' | 'sigstore';

/**
 * Signature trust level
 */
export type SignatureTrustLevel = 'trusted' | 'untrusted' | 'revoked' | 'expired' | 'unknown';

/**
 * Signature verification result for a single signature
 */
export interface SignatureVerification {
  valid: boolean;
  signer: string; // Key ID or email
  signedAt?: string; // ISO 8601
  trustLevel: SignatureTrustLevel;
  method: SignatureMethod;
  keyFingerprint?: string;
  errors?: string[];
}

/**
 * Certificate validation result
 */
export interface CertificateValidation {
  valid: boolean;
  issuer?: string;
  subject?: string;
  notBefore?: string; // ISO 8601
  notAfter?: string; // ISO 8601
  revoked: boolean;
  errors?: string[];
}

/**
 * Signature verification result (overall)
 */
export interface SignatureVerificationResult {
  passed: boolean;
  authorSignature?: SignatureVerification;
  platformSignature?: SignatureVerification;
  certificate?: CertificateValidation;
  bundleHash: string; // SHA256 of verified content
  verifiedAt: string;
  scannerVersion: string;
}

/**
 * Signature verifier configuration
 */
export interface SignatureVerifierConfig {
  /** Require author signature */
  requireAuthor?: boolean;
  /** Require platform signature */
  requirePlatform?: boolean;
  /** Signature method to use */
  method?: SignatureMethod;
  /** Trusted key fingerprints (allowlist) */
  trustedKeys?: string[];
  /** Certificate validation endpoint (for X.509) */
  certValidationEndpoint?: string;
  /** Enable CRL/OCSP revocation checking */
  checkRevocation?: boolean;
  /** Allow expired signatures (not recommended) */
  allowExpired?: boolean;
}

/**
 * Signature metadata from skill bundle
 */
export interface SkillSignatureMetadata {
  author?: {
    signature: string; // Base64 encoded
    publicKey?: string; // Base64 encoded Ed25519 public key
    keyId?: string;
  };
  platform?: {
    signature: string;
    publicKey?: string;
    keyId?: string;
  };
}

/**
 * Signature Verifier
 *
 * Verifies cryptographic signatures on skill bundles:
 * - Ed25519 signatures (primary method)
 * - GPG signatures (legacy support)
 * - Sigstore transparency log verification
 *
 * Dual-signature model:
 * 1. Author signs skill bundle with their private key
 * 2. Platform co-signs after security pipeline passes
 * 3. Verifier checks both signatures form valid trust chain
 *
 * Current implementation: Ed25519 verification with mock key infrastructure
 * Production: Would integrate with AWS KMS, HashiCorp Vault, or Sigstore Fulcio
 */
export class SignatureVerifier {
  private config: SignatureVerifierConfig;
  private readonly SCANNER_VERSION = '1.0.0';

  constructor(config: SignatureVerifierConfig = {}) {
    this.config = {
      requireAuthor: config.requireAuthor ?? true,
      requirePlatform: config.requirePlatform ?? false, // Platform sig added after initial scan
      method: config.method || 'ed25519',
      trustedKeys: config.trustedKeys || [],
      checkRevocation: config.checkRevocation ?? true,
      allowExpired: config.allowExpired ?? false,
    };
  }

  /**
   * Verify skill bundle signatures
   *
   * @param bundleContent - Skill bundle content (as Buffer or string)
   * @param signatures - Signature metadata from skill manifest
   * @returns Signature verification result
   */
  async verifyBundle(
    bundleContent: Buffer | string,
    signatures: SkillSignatureMetadata
  ): Promise<SignatureVerificationResult> {
    const bundleBuffer =
      typeof bundleContent === 'string' ? Buffer.from(bundleContent) : bundleContent;

    // Compute bundle hash
    const bundleHash = await this.computeHash(bundleBuffer);

    // Verify author signature
    let authorVerification: SignatureVerification | undefined;
    if (signatures.author) {
      authorVerification = await this.verifySignature(
        bundleBuffer,
        signatures.author.signature,
        signatures.author.publicKey,
        'author'
      );
    }

    // Verify platform signature
    let platformVerification: SignatureVerification | undefined;
    if (signatures.platform) {
      platformVerification = await this.verifySignature(
        bundleBuffer,
        signatures.platform.signature,
        signatures.platform.publicKey,
        'platform'
      );
    }

    // Check certificate (if using X.509/Sigstore)
    let certificate: CertificateValidation | undefined;
    if (this.config.method === 'sigstore') {
      certificate = await this.validateCertificate(signatures);
    }

    // Determine overall pass/fail
    const passed = this.evaluateResult(authorVerification, platformVerification, certificate);

    return {
      passed,
      authorSignature: authorVerification,
      platformSignature: platformVerification,
      certificate,
      bundleHash,
      verifiedAt: new Date().toISOString(),
      scannerVersion: this.SCANNER_VERSION,
    };
  }

  /**
   * Verify a single signature
   *
   * NOTE: This is a mock implementation. Production would use:
   * - @noble/ed25519 for Ed25519 verification
   * - node-forge or openpgp for GPG
   * - @sigstore/verify for Sigstore
   */
  private async verifySignature(
    data: Buffer,
    signature: string,
    publicKey: string | undefined,
    signerType: 'author' | 'platform'
  ): Promise<SignatureVerification> {
    const errors: string[] = [];

    // Validate signature format
    if (!signature || signature.length === 0) {
      errors.push('Empty signature');
      return {
        valid: false,
        signer: signerType,
        trustLevel: 'unknown',
        method: this.config.method!,
        errors,
      };
    }

    // Validate public key presence
    if (!publicKey) {
      errors.push('Missing public key');
      return {
        valid: false,
        signer: signerType,
        trustLevel: 'unknown',
        method: this.config.method!,
        errors,
      };
    }

    try {
      // Mock verification logic
      // In production: use crypto library to verify signature
      const signatureBuffer = Buffer.from(signature, 'base64');
      const publicKeyBuffer = Buffer.from(publicKey, 'base64');

      // Simulate verification
      const isValid = await this.mockVerifyEd25519(data, signatureBuffer, publicKeyBuffer);

      if (!isValid) {
        errors.push('Signature verification failed: invalid signature');
      }

      // Check if key is trusted
      const keyFingerprint = this.computeFingerprint(publicKeyBuffer);
      const trustLevel = this.checkTrustLevel(keyFingerprint);

      // Check if key is revoked (if revocation checking enabled)
      if (this.config.checkRevocation && trustLevel === 'revoked') {
        errors.push('Key has been revoked');
      }

      return {
        valid: isValid && errors.length === 0,
        signer: signerType,
        signedAt: new Date().toISOString(), // Mock timestamp
        trustLevel,
        method: this.config.method!,
        keyFingerprint,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      errors.push(
        `Signature verification error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );

      return {
        valid: false,
        signer: signerType,
        trustLevel: 'unknown',
        method: this.config.method!,
        errors,
      };
    }
  }

  /**
   * Mock Ed25519 signature verification
   *
   * In production, this would use @noble/ed25519:
   * ```
   * import { verify } from '@noble/ed25519';
   * return await verify(signature, message, publicKey);
   * ```
   */
  private async mockVerifyEd25519(
    message: Buffer,
    signature: Buffer,
    publicKey: Buffer
  ): Promise<boolean> {
    // Mock implementation: check signature length and basic validation
    if (signature.length !== 64) {
      // Ed25519 signatures are 64 bytes
      return false;
    }

    if (publicKey.length !== 32) {
      // Ed25519 public keys are 32 bytes
      return false;
    }

    // Mock: assume valid if lengths match and message is non-empty
    return message.length > 0;
  }

  /**
   * Validate certificate (for X.509/Sigstore)
   */
  private async validateCertificate(
    signatures: SkillSignatureMetadata
  ): Promise<CertificateValidation> {
    const errors: string[] = [];

    // Mock certificate validation
    // In production: validate X.509 certificate chain, check CRL/OCSP
    if (!signatures.author?.keyId && !signatures.platform?.keyId) {
      errors.push('No certificate information provided');
      return {
        valid: false,
        revoked: false,
        errors,
      };
    }

    // Mock: assume valid certificate
    return {
      valid: true,
      issuer: 'Chimera Platform CA',
      subject: signatures.author?.keyId || 'unknown',
      notBefore: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year ago
      notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year from now
      revoked: false,
    };
  }

  /**
   * Compute SHA256 hash of bundle
   */
  private async computeHash(data: Buffer): Promise<string> {
    // Using Web Crypto API (available in Node.js 15+)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Buffer.from(hashBuffer).toString('hex');
  }

  /**
   * Compute key fingerprint (SHA256 of public key)
   */
  private computeFingerprint(publicKey: Buffer): string {
    // Simple fingerprint: first 16 chars of hex-encoded public key
    return publicKey.toString('hex').substring(0, 16);
  }

  /**
   * Check trust level of a key fingerprint
   */
  private checkTrustLevel(fingerprint: string): SignatureTrustLevel {
    if (this.config.trustedKeys && this.config.trustedKeys.includes(fingerprint)) {
      return 'trusted';
    }

    // Mock revocation check
    // In production: query CRL or OCSP responder
    if (this.config.checkRevocation) {
      // No revoked keys in mock implementation
    }

    // Default to untrusted for unknown keys
    return 'untrusted';
  }

  /**
   * Evaluate overall verification result
   */
  private evaluateResult(
    author: SignatureVerification | undefined,
    platform: SignatureVerification | undefined,
    certificate: CertificateValidation | undefined
  ): boolean {
    // Check author signature (required by default)
    if (this.config.requireAuthor && (!author || !author.valid)) {
      return false;
    }

    // Check platform signature (optional by default)
    if (this.config.requirePlatform && (!platform || !platform.valid)) {
      return false;
    }

    // Check certificate validity (if Sigstore)
    if (certificate && !certificate.valid) {
      return false;
    }

    // Check revocation
    if (author && author.trustLevel === 'revoked') {
      return false;
    }

    if (platform && platform.trustLevel === 'revoked') {
      return false;
    }

    // Check expiration (if not allowed)
    if (!this.config.allowExpired) {
      if (author && author.trustLevel === 'expired') {
        return false;
      }
      if (platform && platform.trustLevel === 'expired') {
        return false;
      }
    }

    // At least one valid signature required
    return (author?.valid ?? false) || (platform?.valid ?? false);
  }
}
