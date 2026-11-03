# KAN-71 — Small-cohort suppression in platform metrics

Status: **approved 2026-11-03**

## Context

The superadmin console (`/platform`, `/platform/metrics`, `/platform/organizations/[id]`) shows
monthly aggregates per organization and for the whole platform: active users, new
conversations, provider/model calls and tokens, costs and errors. With a handful of users in an
organization, those numbers describe individuals. The original KAN-71 spec
(`pipeline/kan-71-specs.md`) had dropped the ticket's suppression requirement and shown cells
even for one active user; this decision restores it.

## Rule

- k = 5. For each organization-month row, if the organization had fewer than 5 active users in
  the month, every count and cost field of the row (`activeUsers`, `newConversations`,
  `providerModelUsage`, `estimatedCost`, `errors`) is `null` and the row carries
  `suppressed: true`. The UI shows «Datos insuficientes para mostrar: menos de 5 usuarios
  activos en el mes.»
- The platform-wide row follows the same rule: its totals are shown only when the platform had
  at least 5 active users in the month.
- Active module versions stay visible: they are configuration, not cohort activity.
- Enforced server-side in `src/services/platform/metrics/monthly.ts:getPlatformMonthlyMetrics`
  (`suppressSmallCohort`), so every caller (pages and the `getMonthlyPlatformMetrics` server
  action) gets the suppressed row. Tests: `src/services/platform/metrics/__tests__/monthly.test.ts`,
  `app/platform/metrics/__tests__/page.test.tsx`.

## Known limit

Complementary disclosure is not handled: when the platform total is shown and only one
organization is suppressed, the total minus the visible rows reveals that organization's
figures. Revisit (e.g. suppress a second row, or round totals) if the pilot grows past one
small organization next to large ones.
