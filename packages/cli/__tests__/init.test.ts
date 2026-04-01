/**
 * Tests for chimera init command helper functions
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { listAwsProfiles, writeAwsProfile, generatePassword, isValidEmail, getRegionInferencePrefix, getDefaultModelId, MAX_CONTEXT_CHOICES } from '../src/commands/init';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-init-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('listAwsProfiles', () => {
  it('returns empty array when no AWS files exist', () => {
    const tmpDir = makeTempDir();
    try {
      const profiles = listAwsProfiles(
        path.join(tmpDir, 'nonexistent-credentials'),
        path.join(tmpDir, 'nonexistent-config')
      );
      expect(profiles).toEqual([]);
    } finally {
      rmrf(tmpDir);
    }
  });

  it('parses profiles from credentials file format [profile_name]', () => {
    const tmpDir = makeTempDir();
    try {
      const credPath = path.join(tmpDir, 'credentials');
      fs.writeFileSync(
        credPath,
        '[default]\naws_access_key_id = ABC\naws_secret_access_key = XYZ\n\n[prod]\naws_access_key_id = DEF\n'
      );

      const profiles = listAwsProfiles(credPath, path.join(tmpDir, 'no-config'));
      expect(profiles).toContain('default');
      expect(profiles).toContain('prod');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('parses profiles from config file format [profile name] and [default]', () => {
    const tmpDir = makeTempDir();
    try {
      const configPath = path.join(tmpDir, 'config');
      fs.writeFileSync(
        configPath,
        '[default]\nregion = us-east-1\n\n[profile staging]\nregion = eu-west-1\n\n[profile prod-env]\nregion = us-west-2\n'
      );

      const profiles = listAwsProfiles(path.join(tmpDir, 'no-creds'), configPath);
      expect(profiles).toContain('default');
      expect(profiles).toContain('staging');
      expect(profiles).toContain('prod-env');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('deduplicates profiles appearing in both files', () => {
    const tmpDir = makeTempDir();
    try {
      const credPath = path.join(tmpDir, 'credentials');
      const configPath = path.join(tmpDir, 'config');

      fs.writeFileSync(credPath, '[default]\naws_access_key_id = ABC\n\n[myprofile]\naws_access_key_id = DEF\n');
      fs.writeFileSync(configPath, '[default]\nregion = us-east-1\n\n[profile myprofile]\nregion = us-west-2\n');

      const profiles = listAwsProfiles(credPath, configPath);
      expect(profiles.filter((p) => p === 'default').length).toBe(1);
      expect(profiles.filter((p) => p === 'myprofile').length).toBe(1);
    } finally {
      rmrf(tmpDir);
    }
  });

  it('returns sorted array', () => {
    const tmpDir = makeTempDir();
    try {
      const credPath = path.join(tmpDir, 'credentials');
      fs.writeFileSync(credPath, '[zebra]\n\n[alpha]\n\n[monkey]\n');

      const profiles = listAwsProfiles(credPath, path.join(tmpDir, 'no-config'));
      expect(profiles).toEqual(['alpha', 'monkey', 'zebra']);
    } finally {
      rmrf(tmpDir);
    }
  });

  it('handles empty credentials file', () => {
    const tmpDir = makeTempDir();
    try {
      const credPath = path.join(tmpDir, 'credentials');
      fs.writeFileSync(credPath, '');

      const profiles = listAwsProfiles(credPath, path.join(tmpDir, 'no-config'));
      expect(profiles).toEqual([]);
    } finally {
      rmrf(tmpDir);
    }
  });
});

describe('writeAwsProfile', () => {
  it('creates credentials file with correct content when file does not exist', () => {
    const tmpDir = makeTempDir();
    try {
      const credPath = path.join(tmpDir, 'credentials');
      writeAwsProfile('myprofile', 'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY', credPath);

      expect(fs.existsSync(credPath)).toBe(true);
      const contents = fs.readFileSync(credPath, 'utf8');
      expect(contents).toContain('[myprofile]');
      expect(contents).toContain('aws_access_key_id = AKIAIOSFODNN7EXAMPLE');
      expect(contents).toContain('aws_secret_access_key = wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('appends to existing credentials file without clobbering existing profiles', () => {
    const tmpDir = makeTempDir();
    try {
      const credPath = path.join(tmpDir, 'credentials');
      fs.writeFileSync(credPath, '[existing]\naws_access_key_id = OLD\naws_secret_access_key = OLDSECRET\n');

      writeAwsProfile('newprofile', 'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY', credPath);

      const contents = fs.readFileSync(credPath, 'utf8');
      expect(contents).toContain('[existing]');
      expect(contents).toContain('OLD');
      expect(contents).toContain('[newprofile]');
      expect(contents).toContain('AKIAIOSFODNN7EXAMPLE');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('creates parent directory if it does not exist', () => {
    const tmpDir = makeTempDir();
    try {
      const awsDir = path.join(tmpDir, '.aws');
      const credPath = path.join(awsDir, 'credentials');

      writeAwsProfile('testprofile', 'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY', credPath);

      expect(fs.existsSync(awsDir)).toBe(true);
      expect(fs.existsSync(credPath)).toBe(true);
    } finally {
      rmrf(tmpDir);
    }
  });

  it('sets correct file permissions (0o600) on new credentials file', () => {
    const tmpDir = makeTempDir();
    try {
      const credPath = path.join(tmpDir, 'credentials');

      writeAwsProfile('testprofile', 'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY', credPath);

      const stat = fs.statSync(credPath);
      // On POSIX systems, check owner read+write only (0o600)
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    } finally {
      rmrf(tmpDir);
    }
  });
});

describe('generatePassword', () => {
  it('generates a 16-character password', () => {
    const pwd = generatePassword();
    expect(pwd.length).toBe(16);
  });

  it('contains at least one uppercase letter', () => {
    const pwd = generatePassword();
    expect(/[A-Z]/.test(pwd)).toBe(true);
  });

  it('contains at least one lowercase letter', () => {
    const pwd = generatePassword();
    expect(/[a-z]/.test(pwd)).toBe(true);
  });

  it('contains at least one digit', () => {
    const pwd = generatePassword();
    expect(/[0-9]/.test(pwd)).toBe(true);
  });

  it('contains at least one symbol', () => {
    const pwd = generatePassword();
    expect(/[^A-Za-z0-9]/.test(pwd)).toBe(true);
  });

  it('generates unique passwords on each call', () => {
    const passwords = new Set(Array.from({ length: 10 }, () => generatePassword()));
    expect(passwords.size).toBeGreaterThan(1);
  });
});

describe('getRegionInferencePrefix', () => {
  it('returns us for us-east-1', () => {
    expect(getRegionInferencePrefix('us-east-1')).toBe('us');
  });

  it('returns us for us-west-2', () => {
    expect(getRegionInferencePrefix('us-west-2')).toBe('us');
  });

  it('returns eu for eu-west-1', () => {
    expect(getRegionInferencePrefix('eu-west-1')).toBe('eu');
  });

  it('returns eu for eu-central-1', () => {
    expect(getRegionInferencePrefix('eu-central-1')).toBe('eu');
  });

  it('returns ap for ap-southeast-1', () => {
    expect(getRegionInferencePrefix('ap-southeast-1')).toBe('ap');
  });

  it('returns ap for ap-northeast-1', () => {
    expect(getRegionInferencePrefix('ap-northeast-1')).toBe('ap');
  });

  it('defaults to us for unknown regions', () => {
    expect(getRegionInferencePrefix('sa-east-1')).toBe('us');
    expect(getRegionInferencePrefix('me-south-1')).toBe('us');
  });
});

describe('getDefaultModelId', () => {
  it('returns us inference profile for us regions', () => {
    expect(getDefaultModelId('us-east-1')).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
    expect(getDefaultModelId('us-west-2')).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
  });

  it('returns eu inference profile for eu regions', () => {
    expect(getDefaultModelId('eu-west-1')).toBe('eu.anthropic.claude-sonnet-4-6-v1:0');
  });

  it('returns ap inference profile for ap regions', () => {
    expect(getDefaultModelId('ap-southeast-1')).toBe('ap.anthropic.claude-sonnet-4-6-v1:0');
  });
});

describe('MAX_CONTEXT_CHOICES', () => {
  it('has three entries: 200K, 500K, 1M', () => {
    expect(MAX_CONTEXT_CHOICES).toHaveLength(3);
    expect(MAX_CONTEXT_CHOICES.map((c) => c.value)).toEqual([200000, 500000, 1000000]);
  });

  it('defaults first choice to 200K', () => {
    expect(MAX_CONTEXT_CHOICES[0].value).toBe(200000);
  });
});

describe('isValidEmail', () => {
  it('accepts valid email addresses', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('admin+tag@sub.domain.org')).toBe(true);
    expect(isValidEmail('a@b.io')).toBe(true);
  });

  it('rejects invalid email addresses', () => {
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('@nodomain.com')).toBe(false);
    expect(isValidEmail('missing@tld')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('spaces in@email.com')).toBe(false);
  });
});
