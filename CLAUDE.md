# Working in this repo

Read `HANDOVER.md` first — it's the full reference (architecture, data model,
conventions, gotchas, agent-autonomy risk tiers). This file is just the one
habit worth surfacing every session rather than leaving buried in a 4500-line
doc.

## Sweep for every instance of a pattern before calling a fix done

If a fix addresses one instance of something implemented independently in
more than one place — a modal, a form-validation pattern, a delegated
click-listener, a repeated CSS-class mistake — **grep for every other
instance across the whole codebase before considering that class of work
finished.** Don't stop at the files already in scope for the current task.

This isn't hypothetical caution: `js/summary.js`'s modals were missed when
focus-trapping/Escape-key handling was added to every modal in the app,
because `summary.js` duplicates `kanban.js`'s modal machinery under different
names — a page-by-page review didn't catch the duplication. It resurfaced as
a live bug report. The *second* miss (`index.html`'s password-reset modal,
reachable through a separate pre-auth code path) was only found afterward by
grepping every `id="*Modal*"` across every `.html` file — not by the review
itself, no matter how thorough it felt at the time.

Concretely: before closing out work on a repeated pattern, run something
mechanical and exhaustive for it — an element-id grep, a function-name grep,
a shared-CSS-class grep — the same way `npm run build:css` / `npm run lint`
are default closing steps for CSS/JS changes, not something that only
happens when explicitly asked "are there any other gaps?" See HANDOVER.md
§7's "When a fix touches one instance of a repeated pattern" for the full
writeup and more examples of sweep-candidate patterns in this codebase.
