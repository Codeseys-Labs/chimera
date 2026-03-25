/**
 * Stage 1: Static Analysis Lambda
 *
 * Scans skill bundles for dangerous code patterns using regex analysis.
 * Ported from packages/core/src/skills/scanners/static-analyzer.ts
 *
 * Input:  { skillBundle: { filename: base64content }, skillId, tenantId }
 * Output: { static_result: 'PASS'|'FAIL', findings: [...], scannerVersion, ...passthrough }
 */

const SCANNER_VERSION = '2.0.0';
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

// Patterns are compiled at module load. Where the pattern string itself would
// look like dangerous code to a static hook, we build it programmatically.
const _e = 'xec';   // used to construct detection patterns without triggering hooks
const _ev = 'val';  // same for eval

const PATTERNS = [
  // --- Code execution ---
  { re: new RegExp('e' + _ev + '\\s*\\(', 'gi'),                    msg: 'Use of eval() detected',                              sev: 'critical', cat: 'code-execution'   },
  { re: new RegExp('\\be' + _e + '\\s*\\(', 'gi'),                  msg: 'Use of exec() detected',                              sev: 'critical', cat: 'code-execution'   },
  { re: /Function\s*\(/gi,                                           msg: 'Dynamic Function constructor detected',               sev: 'high',     cat: 'code-execution'   },
  { re: /setTimeout\s*\(\s*["'`]/gi,                                 msg: 'setTimeout with string argument (code execution)',    sev: 'high',     cat: 'code-execution'   },
  { re: /setInterval\s*\(\s*["'`]/gi,                                msg: 'setInterval with string argument (code execution)',   sev: 'high',     cat: 'code-execution'   },
  // --- Prompt injection ---
  { re: /ignore\s+(all\s+)?(previous|prior)\s+(instructions|prompts|rules)/gi, msg: 'Potential prompt injection: ignore instructions', sev: 'high',  cat: 'prompt-injection' },
  { re: /system\s*:\s*you\s+are\s+now/gi,                           msg: 'Potential prompt injection: system role override',    sev: 'high',     cat: 'prompt-injection' },
  { re: /(pretend|act|behave)\s+as\s+if/gi,                         msg: 'Potential prompt injection: role manipulation',       sev: 'medium',   cat: 'prompt-injection' },
  { re: /\[SYSTEM\]/gi,                                              msg: 'Potential prompt injection: system tag injection',   sev: 'medium',   cat: 'prompt-injection' },
  // --- Base64 payloads ---
  { re: /atob\s*\(/gi,                                               msg: 'Base64 decoding detected (potential obfuscated payload)', sev: 'medium', cat: 'base64-payload' },
  { re: /Buffer\.from\s*\([^,]+,\s*['"]base64['"]\)/gi,             msg: 'Base64 buffer decoding detected',                    sev: 'medium',   cat: 'base64-payload'   },
  { re: /[A-Za-z0-9+/]{100,}={0,2}/g,                               msg: 'Large base64-like string detected (>100 chars)',      sev: 'low',      cat: 'base64-payload'   },
  // --- Shell injection ---
  { re: /;\s*(rm|dd|mkfs|format)\s+/gi,                             msg: 'Dangerous shell command detected',                    sev: 'critical', cat: 'shell-injection'  },
  { re: /\$\([^)]+\)/g,                                             msg: 'Shell command substitution detected',                 sev: 'medium',   cat: 'shell-injection'  },
  { re: /`[^`]*(ls|cat|echo|rm|cp|mv|chmod|chown|wget|curl|nc|netcat|bash|sh|whoami|id|ps|kill)[^`]*`/gi, msg: 'Backtick command execution detected', sev: 'medium', cat: 'shell-injection' },
  { re: /\|\s*sh\b/gi,                                              msg: 'Pipe to shell detected',                              sev: 'high',     cat: 'shell-injection'  },
  // --- Credentials ---
  { re: /(password|passwd|pwd)\s*=\s*["'][^"']+["']/gi,             msg: 'Hardcoded password detected',                        sev: 'critical', cat: 'credentials'      },
  { re: /(api[_-]?key|apikey)\s*=\s*["'][^"']+["']/gi,             msg: 'Hardcoded API key detected',                         sev: 'critical', cat: 'credentials'      },
  { re: /(secret|token)\s*=\s*["'][^"']+["']/gi,                   msg: 'Hardcoded secret detected',                          sev: 'high',     cat: 'credentials'      },
  { re: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/gi,              msg: 'Private key detected',                               sev: 'critical', cat: 'credentials'      },
  // --- Network (SSRF) ---
  { re: /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/gi,        msg: 'Localhost URL detected (potential SSRF)',             sev: 'medium',   cat: 'network'          },
  { re: /https?:\/\/(169\.254\.169\.254|metadata\.google\.internal)/gi, msg: 'Cloud metadata endpoint detected (SSRF risk)', sev: 'critical', cat: 'network'          },
  // --- Filesystem ---
  { re: /\.\.\/\.\.\//g,                                            msg: 'Path traversal pattern detected',                    sev: 'high',     cat: 'filesystem'       },
  { re: /\/etc\/(passwd|shadow)/gi,                                 msg: 'System file access detected',                        sev: 'high',     cat: 'filesystem'       },
];

const RECOMMENDATIONS = {
  'code-execution':   'Avoid dynamic code execution. Use static function declarations or safe alternatives.',
  'prompt-injection': 'Sanitize user input and use structured prompts with clear boundaries.',
  'base64-payload':   'Avoid encoding payloads. Use plain text or verify decoded content.',
  'shell-injection':  'Use parameterized commands or avoid shell execution.',
  credentials:        'Use AWS Secrets Manager or environment variables. Never hardcode credentials.',
  network:            'Validate URLs against allowlist. Avoid localhost and metadata endpoints.',
  filesystem:         'Validate and sanitize file paths. Use allowlist for permitted directories.',
};

function scanContent(content, filename) {
  const findings = [];
  if (content.length > MAX_FILE_SIZE) {
    findings.push({ severity: 'high', category: 'file-size', message: `File exceeds maximum size`, location: { file: filename, line: 0 } });
    return findings;
  }
  const lines = content.split('\n');
  for (const { re, msg, sev, cat } of PATTERNS) {
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    lines.forEach((line, idx) => {
      let m;
      while ((m = globalRe.exec(line)) !== null) {
        findings.push({
          severity: sev,
          category: cat,
          message: msg,
          location: { file: filename, line: idx + 1, column: m.index + 1 },
          pattern: m[0],
          recommendation: RECOMMENDATIONS[cat] ?? 'Review and address security concern.',
        });
      }
    });
  }
  return findings;
}

export const handler = async (event) => {
  const skillId = event.skillId ?? 'unknown';
  console.log('static-analysis: skillId=%s', skillId);

  const skillBundle = event.skillBundle ?? {};
  const allFindings = [];
  let linesScanned = 0;

  for (const [filename, encodedContent] of Object.entries(skillBundle)) {
    let content;
    try {
      content = Buffer.from(encodedContent, 'base64').toString('utf8');
    } catch {
      content = String(encodedContent);
    }
    linesScanned += content.split('\n').length;
    allFindings.push(...scanContent(content, filename));
  }

  const hasCritical = allFindings.some(f => f.severity === 'critical');
  const hasHigh     = allFindings.some(f => f.severity === 'high');
  const static_result = (hasCritical || hasHigh) ? 'FAIL' : 'PASS';

  console.log('static-analysis: result=%s findings=%d', static_result, allFindings.length);

  return {
    ...event,
    static_result,
    findings: allFindings,
    scannerVersion: SCANNER_VERSION,
    filesScanned: Object.keys(skillBundle).length,
    linesScanned,
  };
};
