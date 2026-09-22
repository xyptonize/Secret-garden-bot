#!/bin/sh
# Daily copy of SG-BOT's data/: KZ registrations, bounties, birthdays, open
# draft lobbies and the draft tournament history (which is kept forever).
# Keeps KEEP_DAYS of dated archives. Run by sgkz-bot-backup.timer.
set -eu
SRC=/home/tengis.g/bot/data
DEST=/home/tengis.g/bot-backups
KEEP_DAYS=30

mkdir -p "$DEST"
chmod 700 "$DEST"
STAMP=$(date +%F)
# Only the real files — never a half-written *.tmp from an in-progress save.
FILES=$(cd "$SRC" && ls store.json draft-history.json 2>/dev/null || true)
[ -n "$FILES" ] || { echo "backup: nothing to back up in $SRC" >&2; exit 1; }
# shellcheck disable=SC2086
tar -czf "$DEST/data-$STAMP.tar.gz.part" -C "$SRC" $FILES
mv "$DEST/data-$STAMP.tar.gz.part" "$DEST/data-$STAMP.tar.gz"
chmod 600 "$DEST/data-$STAMP.tar.gz"
find "$DEST" -name 'data-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup: $DEST/data-$STAMP.tar.gz ($(du -h "$DEST/data-$STAMP.tar.gz" | cut -f1))"
