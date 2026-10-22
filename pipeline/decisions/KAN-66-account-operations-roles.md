# KAN-66 — Account operations and management roles for the pilot

Status: proposed — awaiting owner approval

## Context

- **Blocks:** KAN-41 (SYS-06), under epic KAN-22. KAN-41 AC: an admin authenticated by WorkOS
  provisions accounts and runs the *agreed* operations inside their tenant. Role and tenant are
  derived on the server. Every admin action and resulting account state is recorded. Only the
  single productive pilot tenant exists. Two synthetic tenants are for validation only.
  Invitation, edit, and deactivation must not be assumed. Institutional reporting is Phase 2
  (P0620).
- **Thesis:** the Administrator "aprovisiona y gestiona las cuentas de emprendedores dentro de su
  tenant" (P0271, P0582, P0640, P0646; T020R08 "Aprovisionamiento de cuentas por tenant").
  P0570/P0621: the pilot runs on test tenants, with at least two seeded tenants for cross-tenant
  isolation and anonymized aggregation, and participants in at least one. Real institutional
  demand is not validated in Phase 1.
- **Code today:**
  - `users` has `role user_role ('admin','member')` and free-text `status` (default `'active'`),
    unique on `(tenant_id, email)` and `(tenant_id, workos_user_id)`. `workos_user_id` is
    **NOT NULL** (`migrations/1777046925701_tenants-and-users.js`).
  - `resolveIdentity()` (`src/auth/resolve-identity.ts`, architecture §5) maps the signed WorkOS
    organization to `tenants.workos_org_id`. It checks a live active WorkOS membership and an
    existing active local user. It **never creates tenants or users**. SSE streams recheck status.
  - Tenant-admin authority is `users.role = 'admin'`. Platform authority is separate
    (`platform_superadmins` + TOTP).
  - Platform operators can already create, rename, and activate/deactivate organizations
    (WorkOS + tenant), audited in `platform_audit_events` (`app/actions/platform-admin.ts`, KAN-71).
  - There is **no tenant-level member management** and no tenant-scoped admin audit table. The only
    local user today is the seeded pilot admin (`…001110_seed-pilot`). `PILOT_TENANT_ID` remains
    a local `.env` value. Runtime routing uses organization metadata.

## Decision needed

1. Which member operations does a tenant admin get in Phase 1?
2. How is the first tenant admin created, and who may grant or revoke `admin`?
3. WorkOS organization ↔ tenant mapping, and which system is the source of truth for membership.
4. Productive vs synthetic tenants: where do the two seeded tenants live?
5. What audit evidence is expected per operation?

## Options

**A. Operator-only provisioning.** TendrelAI operators create users in WorkOS and local rows
through the platform console. There is no tenant-admin UI. This is the smallest option (one
platform action plus audit), but it does not meet SYS-06 or P0646 (the institution's admin
manages accounts). The thesis traceability gap stays open.

**B. Minimal tenant-admin lifecycle (recommended scope).** The tenant admin can **provision**
(email → create WorkOS user + organization membership, then a local `users` row with role
`member` in one audited operation), **list** members with status, **deactivate**, and
**reactivate**. Deactivation sets local `status = 'inactive'` and deactivates the WorkOS
membership. Because identity is checked live, access ends on the next request or stream recheck.
Data is kept, with no hard delete. Guards: an admin cannot deactivate themself, and the last
active admin cannot be removed. The first admin and any admin role change are **platform-operator
actions**, audited globally with MFA. Each tenant action writes a tenant-scoped, append-only
admin-audit row (actor, action, target, before/after status, reason, outcome) under RLS. Size:
medium (actions, repo methods, one migration, UI, isolation tests).

**C. Full lifecycle.** B plus email-invitation acceptance flow, in-tenant role promotion/demotion,
email edits, bulk CSV import, and deletion/anonymization on request (Ley 29733 rights, P0576).
This is the most complete option, but it is large. Deletion interacts with trace retention, which
is still **TBD with user** in `ai-configuration-admin-design.md`, and it needs legal input.

Deterministic-planner impact: none for all three options. This is the authorization and
repository layer, and the orchestrator stays untouched.

## Recommendation

**Option B.** It satisfies SYS-06 with the fewest new states and reuses the live
membership check, the existing role enum, and the KAN-71 audit pattern. Provisioning creates the
WorkOS user up front, so the `NOT NULL workos_user_id` invariant holds and no pending-invitation
table is needed. Keep the **1:1 WorkOS organization ↔ tenant** mapping (`tenants.workos_org_id`),
already implemented. Membership requires both a WorkOS membership and a local active row (fail
closed). In the production pilot environment, keep **one active institutional tenant**. Use the
second seeded tenant for isolation evidence in CI/disposable databases (KAN-17), and put it in
production only if the owner wants the P0570 anonymized-aggregation demonstration there. Personal
tenants stay disabled.

Example user-facing copy (neutral Spanish, tú): «Desactivaste la cuenta de ana@ejemplo.pe. Sus
conversaciones se conservan.» Rejected-case example: «No puedes desactivar tu propia cuenta de
administrador.»

## Consequences / follow-up tickets

- Migration: a tenant admin-audit table (RLS, composite FKs) and a constrained `users.status`
  (`active`, `inactive`) instead of free text. Update `database.md`.
- Repository methods under `withTenantAdminTransaction`. Cross-tenant and insufficient-role tests
  (KAN-41 DoD). Update the Figma admin screens (KAN-51).
- Optional later: Option C items as separate tickets, especially deletion, after retention and
  legal input.

## Open questions for the owner

1. Approve Option B's operations: provision, list, deactivate, reactivate. No in-tenant role
   changes and no deletion in Phase 1?
2. Who is the pilot tenant admin: an institution staff member, or a TendrelAI operator acting for
   the institution?
3. Should the second seeded tenant exist in the production pilot environment (P0570 aggregation),
   or only in CI/disposable databases?
4. Should provisioning send a WorkOS email invitation, or should the admin share the login link
   manually?
