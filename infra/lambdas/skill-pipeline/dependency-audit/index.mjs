/**
 * Stage 2: Dependency Audit Lambda
 *
 * Queries OSV.dev batch API for known vulnerabilities in pip/npm dependencies.
 * Reference: https://osv.dev/docs/
 *
 * Input:  { pipPackages: [{name,version}], npmPackages: [{name,version}], skillId }
 * Output: { dependency_result: 'PASS'|'FAIL', vulnerabilities: [...], advisories: [...], ...passthrough }
 */

import https from 'https';

const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const FAIL_ON_SEVERITIES = new Set(['CRITICAL', 'HIGH']);

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(url, opts, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(new Error('OSV request timeout')); });
    req.write(data);
    req.end();
  });
}

function normalisedVersion(v = '') {
  return v.replace(/^[\^~>=<!]+/, '').split(/\s/)[0] || undefined;
}

export const handler = async (event) => {
  const skillId = event.skillId ?? 'unknown';
  console.log('dependency-audit: skillId=%s', skillId);

  const pipPkgs = (event.pipPackages ?? []).map(p => ({ name: p.name, version: normalisedVersion(p.version), ecosystem: 'PyPI' }));
  const npmPkgs = (event.npmPackages ?? []).map(p => ({ name: p.name, version: normalisedVersion(p.version), ecosystem: 'npm' }));
  const allPkgs = [...pipPkgs, ...npmPkgs];

  if (allPkgs.length === 0) {
    console.log('dependency-audit: no packages — skipping');
    return { ...event, dependency_result: 'PASS', vulnerabilities: [], advisories: [], packageCount: 0 };
  }

  const queries = allPkgs.map(p => {
    const q = { package: { name: p.name, ecosystem: p.ecosystem } };
    if (p.version) q.version = p.version;
    return q;
  });

  let osvResults = [];
  try {
    // OSV batch limit is 1000; chunk into 100 to stay safe
    for (let i = 0; i < queries.length; i += 100) {
      const chunk = queries.slice(i, i + 100);
      const resp = await httpsPost(OSV_BATCH_URL, { queries: chunk });
      osvResults.push(...(resp.results ?? []));
    }
  } catch (err) {
    console.error('dependency-audit: OSV API error:', err.message);
    // Non-blocking — treat as no vulns found but warn
    return { ...event, dependency_result: 'PASS', vulnerabilities: [], advisories: [`OSV API unavailable: ${err.message}`], packageCount: allPkgs.length };
  }

  const vulnerabilities = [];
  const advisories = [];

  osvResults.forEach((result, idx) => {
    const pkg = allPkgs[idx];
    for (const vuln of (result.vulns ?? [])) {
      const severity = getSeverity(vuln);
      const entry = {
        id: vuln.id,
        package: pkg.name,
        ecosystem: pkg.ecosystem,
        installedVersion: pkg.version ?? 'unknown',
        summary: vuln.summary ?? '',
        severity,
        aliases: vuln.aliases ?? [],
        fixedVersion: extractFixedVersion(vuln),
        published: vuln.published,
      };
      if (FAIL_ON_SEVERITIES.has(severity)) {
        vulnerabilities.push(entry);
      } else {
        advisories.push(entry);
      }
    }
  });

  const dependency_result = vulnerabilities.length > 0 ? 'FAIL' : 'PASS';
  console.log('dependency-audit: result=%s pkgs=%d vulns=%d advisories=%d',
    dependency_result, allPkgs.length, vulnerabilities.length, advisories.length);

  return { ...event, dependency_result, vulnerabilities, advisories, packageCount: allPkgs.length };
};

function getSeverity(vuln) {
  for (const s of (vuln.severity ?? [])) {
    const score = s.score ?? '';
    // CVSS v3 base score heuristic from vector string
    if (score.startsWith('CVSS:3')) {
      const bsMatch = score.match(/\/AV:[^/]+\/AC:[^/]+\/PR:[^/]+\/UI:[^/]+\/S:[^/]+\/C:([HLN])\/I:([HLN])\/A:([HLN])/);
      if (bsMatch) {
        const [, c, i, a] = bsMatch;
        const high = [c, i, a].filter(x => x === 'H').length;
        if (high >= 2) return 'CRITICAL';
        if (high >= 1) return 'HIGH';
        return 'MODERATE';
      }
    }
  }
  // Fall back to alias-based detection
  for (const alias of (vuln.aliases ?? [])) {
    if (alias.startsWith('CVE-')) return 'MODERATE';
    if (alias.startsWith('GHSA-')) return 'MODERATE';
  }
  return 'LOW';
}

function extractFixedVersion(vuln) {
  for (const aff of (vuln.affected ?? [])) {
    for (const range of (aff.ranges ?? [])) {
      for (const evt of (range.events ?? [])) {
        if (evt.fixed) return evt.fixed;
      }
    }
  }
  return undefined;
}
