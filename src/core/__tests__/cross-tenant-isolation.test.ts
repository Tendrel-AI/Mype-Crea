// The test that creates data in tenant A, authenticates as tenant B, and
// asserts B cannot read or modify A's data. Phase A leaves this as a
// placeholder — meaningful cross-tenant assertions need the DB-backed store
// + repository layer (claude/skills/database/SKILL.md), which lands in
// Phase B. Add a case here for every new endpoint; if this test ever gets
// skipped or commented out, the multi-tenancy guarantee is broken.

import { describe, it } from 'vitest';

describe('cross-tenant isolation', () => {
  it.todo('tenant B cannot read tenant A data once DB-backed store lands (Phase B)');
});
