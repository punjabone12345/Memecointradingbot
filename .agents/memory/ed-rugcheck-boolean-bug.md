---
name: ED rugcheck boolean bug
description: checkEntryConditions was called with a boolean instead of the rugcheck status string, silently disabling the rugcheck guard
---

# The bug

`checkEntryConditions` expects `rugcheckStatus: "pending" | "passed" | "failed"` as its third argument.

The call site was passing:
```typescript
token.rugcheckStatus === "passed"   // evaluates to true/false (boolean!)
```

The guard inside is:
```typescript
if (rugcheckStatus === "failed") blockers.push("Rugcheck failed");
```

With a boolean argument, `true !== "failed"` and `false !== "failed"` — so **failed rugchecks never blocked entry**. TypeScript didn't catch this because the overload wasn't strict enough.

**Fix:** Always pass the raw string:
```typescript
token.rugcheckStatus   // "pending" | "passed" | "failed"
```

**Why:** This is a silent boolean-to-string comparison mistake. The function signature is clear but call sites can easily pass `.passed === true` if they're not paying attention.

**How to apply:** Whenever you call `checkEntryConditions`, the third argument must be the raw `rugcheckStatus` string field, never a derived boolean expression.
