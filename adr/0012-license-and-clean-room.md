# 0012. MIT license and clean-room policy

- Status: Proposed. The license choice needs the maintainers' sign-off before the first public
  release.
- Date: 2026-10-02

## Context

| Benchmark | License |
|---|---|
| OpenCart | GPLv3 |
| ERPNext | GPLv3 (frappe_docker: MIT) |
| nopCommerce | NPL 4.0: AGPLv3 plus a "powered by nopCommerce" requirement |
| Vendure | GPLv3 or commercial; plugins distributed separately may use any license |
| Medusa | MIT, except RBAC and SSO under `ENTERPRISE-LICENSE.md` |
| Saleor | BSD-3-Clause |
| Sylius | MIT (trademark and logo licensed separately) |
| Shopware 6 | MIT |

## Decision

- License the project under MIT, which agencies and extension authors already accept from
  Medusa, Saleor, Sylius and Shopware. Apache-2.0 is the alternative if an explicit patent grant
  becomes important.
- **Clean room.** The benchmarks are studied for ideas, feature lists and trade-offs only. No
  code, schemas, templates, translations or tests are copied or ported from any of them,
  permissive ones included, so provenance is never in doubt. This is strict for GPL/AGPL sources
  (OpenCart, ERPNext, nopCommerce, Vendure) and for Medusa's enterprise-licensed paths
  (`packages/modules/rbac`, `packages/core/framework/src/policies`).
- Contributions are accepted under the project license with a DCO sign-off (`Signed-off-by`)
  rather than a CLA.

## Consequences

Anyone can build commercial products and closed-source extensions on the platform. A
permissive license is not a differentiator on its own, because most modern peers are
permissive too. The differentiator is the architecture.
