---
name: Edit tool $ substitution corruption
description: Edit tool's new_string appears to go through a JS String.prototype.replace-style substitution, so $-sequences are dangerous and can silently duplicate large chunks of a file.
---

Symptom: after an `Edit` call that looked correct (old_string matched, tool reported success), the file balloons in size and later greps show the same block of code repeated 2-3x, often with a mangled line where one string got split mid-token (e.g. `'Entry ` on one line, the rest of the array literal missing).

Root cause: `new_string` values containing a `$` immediately followed by `'`, `` ` ``, `&`, or a digit (`$'`, `` $` ``, `$&`, `$1`) are special replacement patterns in JS `String.prototype.replace`. If the Edit tool's implementation pipes `new_string` through a JS replace call, `$'` inserts "everything after the match" a second time — which duplicates the remainder of the file into the edited region.

This bit hardest in JSX string-literal arrays used for table headers, e.g.:
`['Token', 'Entry $', 'Exit $', ...]` — the sequence `$',` (dollar, quote, comma) matches the dangerous pattern.

**How to apply:**
- Avoid writing `new_string` (or `old_string`) content with a literal `$` directly followed by `'`, `` ` ``, `&`, or a digit. Rephrase (e.g. `'Entry Price'` instead of `'Entry $'`), or split the edit so the `$` and following character land in different, non-adjacent edits.
- If you must keep the literal, prefer a full-file rewrite via a Node/shell script that reads and writes the file directly (`fs.readFileSync`/`writeFileSync` with plain string concatenation) rather than the Edit tool's find/replace.
- After any edit involving `$` near quotes, grep the file for duplicated landmark lines (e.g. `grep -n "sorted.length === 0"`) to catch corruption immediately — don't assume success from the tool's "no error" response.
- The `WriteFile` tool has shown related `$`-in-JSX corruption too (per earlier incident) — the safe fallback for content with tricky `$` sequences is a Node script doing literal file I/O, not template/replace-based writes.
