# apps/admin — admin SPA (not started)

A client of the Admin API only, through `@trestle/sdk`. Provider configuration forms are
rendered from the typed config schemas that providers declare (ADR 0008), so an extension gets
an admin UI without shipping admin code. Extensions may add pages and widgets through named slots.

Real admin authentication (users, sessions, RBAC) replaces the bootstrap `ADMIN_API_TOKEN`
before this app ships.
