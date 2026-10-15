#!/usr/bin/env bash
# Append one entry to Uptownkids/money-inbox inbox.json with SHA-guarded writes.
# Usage: inbox-append.sh '<entry-json>'
#   entry-json must include: id, kind (expense|income|adjust), amount (dollars),
#   payee (or account+balance for adjust), account, date (YYYY-MM-DD).
# Prunes entries older than 90 days on every write. Retries on SHA conflict.
set -euo pipefail

REPO="Uptownkids/money-inbox"
PATH_FILE="inbox.json"
ENTRY_JSON="${1:?pass the entry JSON as the first argument}"
MAX_RETRIES=5

for attempt in $(seq 1 "$MAX_RETRIES"); do
  # Fetch current file: sha + base64 content
  META=$(gh api "repos/$REPO/contents/$PATH_FILE" --jq '{sha: .sha, content: .content}')
  SHA=$(printf '%s' "$META" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')

  # Merge: decode, prune entries older than 90 days (by inbox age:
  # createdAt first, falling back to the transaction date), reject
  # duplicate ids, append, re-encode
  RESULT=$(printf '%s' "$META" | ENTRY_JSON="$ENTRY_JSON" python3 -c '
import json, os, base64, datetime, sys
meta = json.load(sys.stdin)
raw = base64.b64decode(meta["content"]).decode("utf-8")
doc = json.loads(raw)
entries = doc.get("entries", [])
today = datetime.date.today()

def inbox_age_date(e):
    ca = e.get("createdAt")
    if isinstance(ca, str) and len(ca) >= 10:
        try:
            return datetime.date.fromisoformat(ca[:10])
        except ValueError:
            pass
    try:
        return datetime.date.fromisoformat(e.get("date", ""))
    except ValueError:
        return None

kept = []
for e in entries:
    d = inbox_age_date(e)
    if d is None or (today - d).days <= 90:
        kept.append(e)  # keep unparseable rather than silently drop
new_entry = json.loads(os.environ["ENTRY_JSON"])
if not new_entry.get("id"):
    raise SystemExit("entry is missing id")
existing_ids = {e.get("id") for e in kept}
if new_entry.get("id") in existing_ids:
    raise SystemExit(f"duplicate entry id {new_entry.get(\"id\")!r}: not appended")
kept.append(new_entry)
out = json.dumps({"entries": kept}, indent=2) + "\n"
print(base64.b64encode(out.encode("utf-8")).decode("ascii"))
')
  # SHA-guarded write
  if gh api "repos/$REPO/contents/$PATH_FILE" -X PUT \
      -f message="Inbox: append entry" \
      -f content="$RESULT" \
      -f sha="$SHA" --jq '.commit.sha' >/dev/null 2>/tmp/inbox-append-err.txt; then
    echo "appended (attempt $attempt)"
    exit 0
  fi
  if grep -q -i "sha.*mismatch\|does not match\|conflict" /tmp/inbox-append-err.txt; then
    echo "SHA conflict on attempt $attempt, retrying..." >&2
    sleep 1
    continue
  fi
  cat /tmp/inbox-append-err.txt >&2
  exit 1
done
echo "FAILED: exhausted $MAX_RETRIES retries" >&2
exit 1
