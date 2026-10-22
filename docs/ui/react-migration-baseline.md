# React UI and behavior baseline

Captured from the repository at KAN-72 baseline. This is a parity reference for the UI migration work; it records existing behavior and is not a product redesign. Source of truth for runtime behavior remains the cited code.

## Runtime versions

`package.json` declares Next.js `^16.2.3`, React `^19.2.1`, and React DOM `^19.2.1`. `package-lock.json` resolves Next.js `16.2.3`, React `19.2.4`, and React DOM `19.2.4`.

After KAN-73: `package.json` declares React and React DOM `^19.3.1` and `@types/react`/`@types/react-dom` `^19.3.0`; the lockfile resolves React `19.3.1`, React DOM `19.3.1`, and both type packages `19.3.0` (the npm `latest` tags as of 2026-10-21). Next.js stays at `16.2.3`; its peer range (`react`/`react-dom` `^19.0.0`) accepts 19.3.1, so no Next.js change was needed. `npm ci` and `npm ls` report no peer conflicts.

The UI uses the Next.js App Router, React client components, Tailwind CSS 4, `motion` (`motion/react`), lucide-react icons, and React Markdown. `next.config.ts` enables React strict mode, transpiles `motion`, and sets standalone output.

## Routes and page props

| Route | Current behavior and UI |
|---|---|
| `/` | Server page (`app/page.tsx`) calls WorkOS `withAuth()`. Unauthenticated requests render no page content here and are handled by `proxy.ts`/AuthKit. A global admin redirects to `/platform` with recent MFA or `/platform/mfa` otherwise. For `?conversationId=…`, loads owner-scoped history and passes `userEmail`, `userName`, conversation ID, turns, deliverables, or an initial error to `CreaMype`. Without an ID it creates and pins a conversation, then redirects to the query-string URL. |
| `/login` | WorkOS sign-in and sign-up links, CreaMype brand mark, and explanatory Spanish copy. Authenticated users redirect to `/` or the platform route according to global role/MFA. |
| `/admin/ai` | Server loads initial AI config data and passes it to `AiConfigurationAdmin`; failure renders a Spanish access/configuration message. |
| `/platform` | Global dashboard: organization/user/conversation/error summary cards, module catalog, and recent audit rows. Requires global admin plus recent MFA. |
| `/platform/mfa` | MFA enrollment/challenge form for global admins without recent proof. |
| `/platform/organizations`, `/platform/organizations/[tenantId]` | Organization list/create; organization detail, activation/edit controls, effective module versions, rollout history. |
| `/platform/modules`, `/platform/modules/[moduleId]` | Module catalog and module publish, preview, rollout, retry, and rollback controls. AI module also exposes shared release controls. |
| `/platform/operators` | Global operator grant/revoke administration. |
| `/platform/metrics`, `/platform/audit` | Platform metrics and audit views. |

Platform and admin pages are server-rendered around server actions; interactive controls live in `PlatformConsole`, `AiConfigurationAdmin`, and the MFA form. Most global admin pages redirect on missing MFA/role rather than rendering an in-place error. Tables use horizontal overflow wrappers where needed.

## Main wizard (`components/CreaMype.tsx`)

### Shell and navigation

- Full viewport `h-screen`, neutral background, fixed-width animated sidebar (260 px expanded / 64 px collapsed), and a main content region.
- Sidebar actions: **Crea tu producto**, **Página Web**, current user name/email, and **Cerrar sesión**. The `gallery` tab exists in state but has no visible navigation or rendered panel in this component.
- Create view is two columns at `md` and above: chat is `md:w-1/2 lg:w-5/12`; the brand dashboard is hidden below `md`. At narrow widths only chat is visible. There is no mobile control to expose the dashboard.
- Main chat header shows brand, **Exportar** (when there is a conversation), **Paso N de 5**, and **Nuevo**. “Nuevo” opens a confirmation modal; confirmation creates a new conversation and resets local state; cancel closes the modal.
- The dashboard includes five clickable progress labels (Nombre, Logo, Etiqueta, Web, Marketing), identity/asset/landing/marketing panels, and empty “Pendiente” states.

### Conversation and behavior states

| State/trigger | Visible behavior |
|---|---|
| New conversation | Welcome message: “¡Hola! Soy tu estratega de marca y diseñador de IA. Vamos a crear tu marca y lanzar tu producto en 5 pasos.” Then asks industry, values, and audience under “Paso 1: Nombre del Negocio”. Text entry placeholder is “Escribe tu mensaje aquí...”; Enter sends, Shift+Enter inserts a newline. Footer: “La IA puede cometer errores. Verifica la información importante.” |
| Send | Adds the user's message immediately, clears input, shows **Pensando…**, calls `chatAction` with conversation ID, random request ID, and text. Success appends Markdown response and any notices. Failed response appends returned error; retryable known failures show **Continuar este turno**. |
| Uncertain turn | Shows warning asking the user not to resend and to start a new product; input is disabled. |
| Conversation init/load failure | Amber status message is shown above composer; no conversation ID disables actual send with a configuration message on click. |
| Welcome vs history | History is reconstructed from user message, response text, and notices. An incomplete turn in `reserved`, `extracted`, or `effects_committed` offers same-request continuation. `effects_started`/`uncertain` requires a new conversation. |
| Logo processing | `task_processing` SSE event marks the agent processing and shows spinner in logo spaces; a logo image `artifact` updates logo state and clears processing. Other artifact types clear that agent spinner but do not populate other asset fields. |
| Export | **Exportar** downloads owner conversation evidence as `crea-mype-conversation-<id>.json`; errors appear as the amber conversation status. |
| Restart | Confirmation copy: “¿Crear nuevo producto?” and “Esto iniciará un nuevo proceso de creación y descartará el producto actual.” Controls: **Cancelar**, **Sí, crear nuevo**. Successful restart resets welcome/assets/retry/error state, changes URL to `/?conversationId=…`, and replaces SSE subscription. |
| Landing page absent | Full-screen landing tab shows “Aún no hay página web”, explanatory copy and **Ir al creador**. |
| Landing page present | Landing content is shown in an iframe; create view shows a 400 px preview panel and **Ver en pantalla completa**. Full preview has **Volver al editor**. |

### Step/progress details and current pilot limitation

The component derives displayed progress from local `assets`: logo maps to step 3, label to 4, landing page to 5, marketing plan to 6 (display clamps to five). It does not derive steps from planner state. Initial server props hydrate only a logo URL from deliverables; name/profile, label, landing page, and marketing plan start empty. In the current pilot, only the logo agent is live, so non-logo dashboard areas remain pending unless populated through a future UI/data path. These are existing behaviors/limitations to preserve or explicitly decide during migration.

## Exact HTML iframe preview behavior

At the baseline, the landing preview was implemented twice inline in `components/CreaMype.tsx`: once in the 400 px dashboard card and once in the full-screen landing tab. Since KAN-75 both placements use `components/crea-mype/landing-src-doc.ts`. Both build the same `srcDoc` string:

1. HTML5 doctype, UTF-8 meta, viewport meta.
2. Loads Tailwind from `https://cdn.tailwindcss.com` and Google Fonts Inter (300–700) plus Space Grotesk (500, 700).
3. Configures Tailwind `fontFamily.sans` as Inter and `fontFamily.display` as Space Grotesk. Inline CSS sets body Inter with antialiasing and heading elements Space Grotesk with `letter-spacing: -0.02em`.
4. Body classes are `bg-neutral-50 text-neutral-900`.
5. Inserts `assets.landingPage` as raw HTML after replacing all `LOGO_URL_PLACEHOLDER` strings with `assets.logoUrl || ''` and all `LABEL_URL_PLACEHOLDER` strings with `assets.labelUrl || ''`.
6. The iframe fills its parent (`w-full h-full border-0`), has descriptive title (“Landing Page Preview” or “Landing Page Full Preview”), and sandbox is exactly `allow-scripts` (scripts permitted; same-origin, forms, popups, and top navigation are not granted).

The preview relies on network access to Tailwind CDN and Google Fonts; offline or blocked third-party requests can change its rendering. The HTML payload is inserted directly into `srcDoc` without escaping/sanitization in this component. The migration should preserve the current rendering contract and sandbox permissions unless a separate security/product decision changes them. There is no local landing HTML fixture or local image/font asset directory in the current repository.

## Styling, copy, and assets

- Global CSS imports Tailwind only (`app/globals.css`). Styling is largely utility classes with neutral/orange palette, rounded cards, borders, status colors, and lucide icons.
- The wizard, login, and platform surfaces use Spanish. Preserve exact labels and neutral Latin-American tuteo (no voseo) when migrating. Errors/notices are user-visible UI states and part of parity.
- Icons are from lucide-react; system motion/transition behavior comes from `motion/react` and Tailwind transitions.
- No checked-in `public/` or `assets/` files currently exist. Wizard logos/labels are remote/generated URLs; image tags are used directly in the wizard. The iframe preview uses remote CDN/font assets as described above.
- `app/layout.tsx` sets `<html lang="en">` despite Spanish product copy; this is an existing accessibility/localization detail to record for migration review.

## Reproducible parity acceptance checks

Use a development session with a registered tenant, active WorkOS membership, pinned AI configuration, Postgres, and Redis as required by the current app. These checks are manual UI checks; do not use real customer data.

1. **Auth and entry:** logged-out visit reaches sign-in; tenant user lands on `/`; global admin without recent MFA lands on MFA; verified global admin sees platform dashboard. Verify the home page creates a conversation once and URL contains its ID.
2. **Wizard baseline:** at desktop width, check sidebar open/closed, chat/dashboard split, all five dashboard steps, initial pending cards, welcome Markdown, placeholder, Enter/Shift+Enter, thinking indicator, notices/errors, export download, and new-product confirm/cancel/reset.
3. **Responsive baseline:** below `md`, dashboard is absent and chat occupies content; at/above `md`, both panes appear; at `lg`, chat width changes to 5/12. Check that sidebar can collapse at each size and modal remains centered.
4. **History/recovery:** reload with valid `conversationId`; verify turn order, notice rendering, logo hydration, retryable incomplete turn, and uncertain-turn disabled composer. Verify foreign/malformed/unavailable IDs produce the existing error state.
5. **SSE:** while a logo task is dispatched, confirm `task_processing` spinner then logo artifact display, event stream closes/reopens when starting a new product, and a reload reconnects using the query-string conversation ID.
6. **Preview contract:** when supplied with synthetic HTML containing both placeholder tokens, check replacements, 400 px dashboard preview, full-screen preview, return-to-editor control, title, iframe sandbox, fonts/Tailwind loading, and behavior when external requests are blocked.
7. **Admin surfaces:** with appropriately authorized synthetic accounts, inspect each route listed above, including empty/error states, tables and horizontal overflow, form pending/result messages, tenant role-specific AI controls, and MFA redirect behavior.
8. **Accessibility/copy:** check keyboard focus and form labels/buttons, iframe titles, status announcements, Spanish copy, and current document language. Record any changed behavior as an explicit parity exception.

### Screenshot status

No screenshots were captured. The repository's documented local run requires WorkOS, database configuration, pinned tenant AI setup, and Redis for durable artifact display; no service-free static storybook/fixture harness exists. The current environment therefore cannot establish an authenticated screenshot baseline without those external services/credentials. The checks above are the reproducible reference; capture screenshots later in an authorized synthetic tenant session at a narrow viewport and desktop viewport.

## Migration deviations (KAN-74, KAN-75, KAN-76)

The component split was compared path by path with the pre-migration component
(`git show 67eed9f:components/CreaMype.tsx`): step derivation, sidebar, restart modal, export,
send/retry/uncertain handling, `task_processing`/`artifact` SSE handling, logo hydration from
deliverables, dashboard pending/processing states, and both landing previews. State, server
actions, and SSE wiring stay in the `CreaMype` container; the extracted components receive
props/callbacks and keep the same markup, Tailwind classes, and Spanish copy. The only
observable differences are these deliberate ones:

1. **`srcDoc` indentation.** The iframe document is built once in
   `components/crea-mype/landing-src-doc.ts` for both placements. The two old inline templates
   differed from each other and from the new one only in leading whitespace per line (before the
   doctype, between tags, and before the interpolated landing HTML). Whitespace before the doctype
   and between head/body elements is ignored by the HTML parser, so the rendered result is the
   same. `parity.test.tsx` compares the new output against a verbatim copy of the old template
   after trimming each line.
2. **Optional typed landing content.** `CreaMype` accepts an optional `landingPageContent` prop
   (validated on render by `src/landing-page/contract.ts`). `app/page.tsx` does not pass it and no
   producer exists, so pilot behavior is unchanged. When supplied, it takes precedence over the
   legacy HTML string, counts as "landing page present" for step 5, and renders as React; if it
   fails validation, the preview area shows "No se pudo mostrar esta página web." instead of an
   iframe. Legacy HTML strings always parse as legacy and keep the iframe path above.
3. **Restart clears typed content.** "Sí, crear nuevo" resets assets to empty, which also drops
   any typed content supplied at mount, same as the other asset fields.

## Source map

- Wizard state, server actions, and SSE wiring: `components/CreaMype.tsx` (container)
- Wizard presentation: `components/crea-mype/` (`Sidebar`, `ChatPanel`, `Dashboard`, `RestartModal`, `LandingPreview`)
- Landing preview: `components/crea-mype/LandingPageRenderer.tsx` → `LandingHtmlPreviewFrame.tsx` (iframe) using `landing-src-doc.ts` (single `srcDoc` builder); typed contract in `src/landing-page/contract.ts`
- Automated parity checks: `components/crea-mype/__tests__/parity.test.tsx`
- Server entry/props/auth routing: `app/page.tsx`, `proxy.ts`, `src/auth/resolve-identity.ts`
- Login/layout/global CSS: `app/login/page.tsx`, `app/layout.tsx`, `app/globals.css`
- Chat and conversation actions: `app/actions/chat.ts`, `app/actions/conversations.ts`
- Artifact stream: `app/api/agents/stream/route.ts`
- AI admin: `app/admin/ai/page.tsx`, `components/AiConfigurationAdmin.tsx`
- Platform console/pages: `app/platform/**`, `components/PlatformConsole.tsx`
- Stack and local run requirements: `docs/agents/stack.md`
