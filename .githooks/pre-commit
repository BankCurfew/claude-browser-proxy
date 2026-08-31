#!/bin/bash
# scope-guard.sh — fleet scope guard (Security-Oracle ruling, 2026-08-17)
# Refuses a commit staging BOTH application source (src/) AND oracle-operations
# prose (ψ/ output/ inbox/ handoff/). Mounted via each repo's .githooks/pre-commit,
# which the global fleet pre-commit chains to — so this NEVER touches the secret
# scan and cannot disable it.
#
# WHY: shared working trees. `git add -A` claims every dirty file is yours; in a
# multi-oracle tree that is usually false. On 2026-08-17 Echo-Oracle swept
# BotDev-Oracle's in-flight src/line/reply.ts into a "docs:" commit under the wrong
# author and pushed it. The near-miss (half-written code under wrong name) is the
# bug class; this is the cheap canary.
#
# PROSE SCOPE is deliberately NARROW: ψ/ output/ inbox/ handoff/ only. Root-level
# README.md / CLAUDE.md legitimately commit alongside src/ every day and must NOT
# be blocked. (Original draft used \.md$ — that false-blocked code+README in 32
# repos. Tightened 2026-08-17.)
#
# Override (deliberate, greppable): SCOPE_GUARD=off git commit ...
set -uo pipefail

[ "${SCOPE_GUARD:-on}" = "off" ] && exit 0

# -z: NUL-delimited and UNQUOTED. Without it git honours core.quotepath (default
# true) and renders any non-ASCII path as C-escapes: ψ/inbox/focus.md arrives as
# "\317\210/inbox/focus.md", which the ψ/ pattern below can never match. That made
# the guard blind in exactly the repos it was written for (oracle repos are the ones
# with both src/ and ψ/). Verified: the originating incident, Admin-Oracle 29e3cd9,
# staged src/line/reply.ts + ψ/inbox/{focus,in-flight}.md and CLEARED the guard.
# -z is NUL-delimited and unquoted, so it is immune to core.quotepath (default
# true), which otherwise C-escapes non-ASCII paths — ψ/inbox/focus.md would arrive
# as "\317\210/inbox/focus.md" and ^ψ/ could never match, silently clearing the
# exact commit this guard exists to block. T608 (dev), 2026-08-17.
STAGED=$(git diff --cached --name-only -z 2>/dev/null | tr '\0' '\n')
[ -n "$STAGED" ] || exit 0

# grep -cE not wc -l: no trailing newline undercounts by one.
SRC=$(printf '%s\n' "$STAGED" | grep -cE '^src/' || true)
PROSE=$(printf '%s\n' "$STAGED" | grep -cE '^(ψ/|output/|inbox/|handoff/)' || true)

if [ "$SRC" -gt 0 ] && [ "$PROSE" -gt 0 ]; then
  echo "❌ SCOPE GUARD: this commit stages BOTH application source and oracle-operations prose." >&2
  echo "" >&2
  echo "   src/  ($SRC file(s)):" >&2
  printf '%s\n' "$STAGED" | grep -E '^src/' | sed 's/^/     /' >&2
  echo "   prose ($PROSE file(s)):" >&2
  printf '%s\n' "$STAGED" | grep -E '^(ψ/|output/|inbox/|handoff/)' | sed 's/^/     /' >&2
  echo "" >&2
  echo "   This is the shape of a \`git add -A\` accident in a SHARED working tree." >&2
  echo "   On 2026-08-17 that swept BotDev's in-flight src/line/reply.ts into a commit" >&2
  echo "   titled \"docs: focus + in-flight\", under the wrong author, and pushed it." >&2
  echo "" >&2
  echo "   Before overriding, confirm the src/ files above are YOURS and finished." >&2
  echo "   Then either stage explicitly:  git reset && git add <your paths>" >&2
  echo "   or, if the mix is deliberate:  SCOPE_GUARD=off git commit ..." >&2
  exit 1
fi
exit 0
