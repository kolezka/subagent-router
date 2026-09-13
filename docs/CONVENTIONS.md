# Documentation conventions

This document describes lightweight rules for `subagent-router` documentation. It applies to the design state and later also to the implemented state.

## Statuses

Each spec, plan, or block document states `Date` and `Status` in its body.

- `draft`: material for review, not yet approved.
- `approved`: decision accepted, but not necessarily implemented.
- `implemented`: the description matches working behavior verified against the referenced code and tests.
- `superseded`: material replaced by a newer document, with a link to the successor.

Tasks belong to the plan, not to the specification. Plans are not created before the specification is approved.

## Facts, assumptions, and requirements

The documentation marks the evidence level of every significant claim:

- `[verified]`: confirmed in the referenced source or in a check that was performed. Reading the code does not count as testing a working integration.
- `[inferred]`: a conclusion drawn from confirmed facts, with the reasoning stated.
- `[assumption]`: an assumption or information not verified against the source.
- `[historical: YYYY-MM-DD, source]`: a past measurement that cannot be reproduced now. The document's age alone does not justify this tag.

Normative requirements are written separately, usually as `MUST`, `MUST NOT`, or `SHOULD`. They must not be presented as measured facts.

For initial meta documents we do not add YAML or a `verified_against` field, because there is no implementation that can honestly be referenced.

## Evidence and contracts

Every future description of a working block contains YAML with the fields `block`, `doc`, `verified_against`, and `verified_on`. The value of `verified_against` is the identifier of the verified commit. Citations in the body reference the file and symbol, not the line number.

The behavior description separates:

- the public contract,
- invariants that the code and tests must preserve,
- gaps and unverified paths,
- the enforcement mechanism that actually exists,
- elements that are only planned.

Do not copy the verification field into a document that has not been checked against working code.

## Structure and links

`docs/README.md` is the index. Specifications are saved as `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`. Future plans are saved as `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`.

Links inside the repo are relative. External sources use a pinned commit when they refer to code. Citations reference the symbol, commit, and file, without line numbers.

## Style

New documentation prose is written in English. Identifiers, file names, symbol names, and technical values stay in their original form when they are part of a contract or source.

The source of the adapted style is [dotfiles-next, commit `9337ab95a2fa3f673e77d16aa2be720e7b8353b1`](https://github.com/kolezka/dotfiles-next/tree/9337ab95a2fa3f673e77d16aa2be720e7b8353b1/docs). The convention was simplified for a project without an implementation and does not automatically carry over its facts or structure.
