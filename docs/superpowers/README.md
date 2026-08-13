# Superpowers plans and specs are intentionally not tracked

`docs/notes/` and `docs/plans/` reference files under `docs/superpowers/specs/` and
`docs/superpowers/plans/`. Those references are correct, and the files exist — on the
machine where the work was done. They are not in the repository, on purpose.

**Why.** A plan is written to be executed on one machine, so it accumulates absolute
paths, private hostnames, and local database DSNs as a matter of course. Five of the six
plans tracked here before 2026-08-07 carried at least one. Sanitising them costs ongoing
vigilance on every future plan, and the failure mode is silent.

**Where the reasoning actually lives.** Commit messages carry the why for each change, and
`docs/notes/` carries the findings that outlive the work — captured wire shapes, parity
gaps, decisions taken and rejected. A plan is scaffolding for building the thing; the notes
are the documentation of it. If a `docs/superpowers/…` reference in a note matters to you
and you do not have the file, what you want is almost certainly in the note itself or in
`git log` for the files it names.
