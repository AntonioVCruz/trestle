# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-10-02

## Context

Commerce platforms live for a decade and accumulate contributors who were not present for the
original trade-offs. Shopware (167 ADRs) and Sylius both keep decision records, and their newer
records show decisions being revisited with the earlier reasoning at hand, e.g. Shopware's 2026
move from subclassing `Abstract*Route` classes to typed extension events.

## Decision

Keep ADRs in `adr/`, numbered, using `0000-template.md`. Any change to module boundaries, public
API shape, extension contracts, persistence or process topology needs an ADR in the same pull
request.

## Consequences

Reviewers can ask "which ADR covers this?". Decisions are cheap to revisit because the original
context is written down.
