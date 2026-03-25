/**
 * Stage 4: Signature Verification Lambda
 *
 * Verifies an optional author Ed25519 signature, then adds a platform
 * Ed25519 signature to the bundle hash.  Signing key is stored in / generated
 * into Secrets Manager on first invocation.
 *
 * Input:  { skillBundle, signatures?: { author?: { signature, publicKey, signer } }, skillId }
 * Output: { signature_result: 'PASS'|'FAIL', authorSignature, platformSignature, bundleHash, ...passthrough }
 */

import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const smClient = new SecretsManagerClient({});
const SIGNING_KEY_SECRET_ARN = process.env.SIGNING_KEY_SECRET_ARN;

let _cachedKeyPair = null; // module-level cache (warm Lambda reuse)

async function getOrCreateKeyPair() {
  if (_cachedKeyPair) return _cachedKeyPair;

  if (SIGNING_KEY_SECRET_ARN) {
    try {
      const resp = await smClient.send(new GetSecretValueCommand({ SecretId: SIGNING_KEY_SECRET_ARN }));
      const secret = JSON.parse(resp.SecretString ?? '{}');
      if (secret.privateKey && secret.publicKey) {
        _cachedKeyPair = {
          privateKey: createPrivateKey(secret.privateKey),
          publicKeyPem: secret.publicKey,
        };
        return _cachedKeyPair;
      }
    } catch (err) {
      if (err.name !== 'ResourceNotFoundException') {
        console.warn('signature-verification: Secrets Manager read error:', err.message);
      }
    }
  }

  // Generate new Ed25519 key pair
  console.log('signature-verification: generating new Ed25519 key pair');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem  = publicKey.export({ type: 'spki',  format: 'pem' });

  if (SIGNING_KEY_SECRET_ARN) {
    try {
      await smClient.send(new PutSecretValueCommand({
        SecretId: SIGNING_KEY_SECRET_ARN,
        SecretString: JSON.stringify({ privateKey: privateKeyPem, publicKey: publicKeyPem }),
      }));
    } catch (err) {
      console.warn('signature-verification: failed to persist key pair:', err.message);
    }
  }

  _cachedKeyPair = { privateKey, publicKeyPem };
  return _cachedKeyPair;
}

function computeBundleHash(skillBundle) {
  const h = createHash('sha256');
  for (const key of Object.keys(skillBundle ?? {}).sort()) {
    h.update(key);
    h.update(Buffer.from(skillBundle[key] ?? '', 'base64'));
  }
  return h.digest('hex');
}

export const handler = async (event) => {
  const skillId = event.skillId ?? 'unknown';
  console.log('signature-verification: skillId=%s', skillId);

  const bundleHash = computeBundleHash(event.skillBundle);
  const hashBuf = Buffer.from(bundleHash, 'hex');

  // Verify optional author signature
  let authorSignature;
  const existingAuthorSig = event.signatures?.author;
  if (existingAuthorSig?.signature && existingAuthorSig?.publicKey) {
    let valid = false;
    try {
      const pubKey = createPublicKey(existingAuthorSig.publicKey);
      valid = verify(null, hashBuf, pubKey, Buffer.from(existingAuthorSig.signature, 'hex'));
    } catch (err) {
      console.warn('signature-verification: author sig verify error:', err.message);
    }
    authorSignature = {
      valid,
      signer: existingAuthorSig.signer ?? 'unknown',
      trustLevel: valid ? 'verified' : 'invalid',
      method: 'ed25519',
    };
    if (!valid) {
      console.log('signature-verification: author signature INVALID for skillId=%s', skillId);
      return { ...event, signature_result: 'FAIL', failureReason: 'Author signature verification failed', authorSignature, bundleHash };
    }
  } else {
    // No author signature — allow but mark as self-signed / low trust
    authorSignature = { valid: true, signer: 'self-signed', trustLevel: 'low', method: 'none', note: 'No author signature provided' };
  }

  // Add platform signature
  let platformSignature;
  try {
    const { privateKey, publicKeyPem } = await getOrCreateKeyPair();
    const sig = sign(null, hashBuf, privateKey);
    platformSignature = {
      valid: true,
      signer: 'platform@chimera.aws',
      trustLevel: 'trusted',
      method: 'ed25519',
      signature: sig.toString('hex'),
      publicKey: publicKeyPem,
      signedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('signature-verification: platform signing failed:', err.message);
    return { ...event, signature_result: 'FAIL', failureReason: `Platform signing failed: ${err.message}`, authorSignature, bundleHash };
  }

  console.log('signature-verification: PASS for skillId=%s', skillId);
  return { ...event, signature_result: 'PASS', authorSignature, platformSignature, bundleHash };
};
