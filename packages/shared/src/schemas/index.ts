/**
 * Runtime validation schemas for @chimera/shared boundary types.
 *
 * Each schema mirrors the static TypeScript type defined under `../types/`
 * and is intended to be used at every cross-process trust boundary:
 *   - DynamoDB → in-process TS (`chimera-tenants`, `chimera-sessions`,
 *     `chimera-skills`, `chimera-audit`)
 *   - JWT/API claims → in-process TS
 *   - External API payloads → in-process TS
 *
 * TS types remain authoritative for shape. If you add or change a field,
 * update BOTH the TS type and the schema in lockstep, and the round-trip
 * test in `../__tests__/`.
 *
 * TODO (Wave-16+ follow-up, OPEN-PUNCH-LIST §typescript-hardening #3):
 * audit `packages/core/src/**` for ad-hoc `typeof x === 'string'` style
 * validation of DDB items and replace with these schemas' `.parse()` /
 * `.safeParse()`.
 */

export * from './tenant';
export * from './skill';
export * from './session';
export * from './audit';
