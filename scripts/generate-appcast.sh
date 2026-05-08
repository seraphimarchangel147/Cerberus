#!/usr/bin/env bash
# Generate Sparkle appcast.xml entry for a signed .dmg.
#
# Args (env):
#   DMG=path/to/OpenAGI-X.Y.Z.dmg
#   VERSION=0.0.2
#   BUILD=2          (optional — defaults to VERSION with dots stripped)
#   APPCAST=path/to/appcast.xml (optional — defaults to build/appcast.xml)
#   RELEASE_NOTES_URL=https://...   (optional)
#
# Requires:
#   - Sparkle's sign_update (mac/.build/artifacts/sparkle/Sparkle/bin/sign_update)
#   - The Sparkle EdDSA private key in the keychain (from generate_keys), OR
#     SPARKLE_ED_PRIVATE_KEY env var (base64) which we'll write to a temp file.
#
# Output: appcast.xml at $APPCAST.

set -euo pipefail

DMG="${DMG:?DMG=path/to/file.dmg required}"
VERSION="${VERSION:?VERSION=X.Y.Z required}"
BUILD="${BUILD:-${VERSION//./}}"
APPCAST="${APPCAST:-build/appcast.xml}"
RELEASE_NOTES_URL="${RELEASE_NOTES_URL:-}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIGN_UPDATE="${ROOT}/mac/.build/artifacts/sparkle/Sparkle/bin/sign_update"
[[ -x "$SIGN_UPDATE" ]] || { echo "sign_update not found at $SIGN_UPDATE — run 'swift build' in mac/ first" >&2; exit 1; }
[[ -f "$DMG" ]] || { echo "DMG not found at $DMG" >&2; exit 1; }

# If a base64-encoded private key was passed via env (CI path), drop it to
# a temp file so sign_update -f can use it directly without the keychain.
KEY_FILE=""
if [[ -n "${SPARKLE_ED_PRIVATE_KEY:-}" ]]; then
  KEY_FILE="$(mktemp)"
  trap 'rm -f "$KEY_FILE"' EXIT
  echo -n "${SPARKLE_ED_PRIVATE_KEY}" > "$KEY_FILE"
fi

# Sign the dmg with Sparkle's EdDSA.
if [[ -n "$KEY_FILE" ]]; then
  SIG_OUTPUT="$("$SIGN_UPDATE" -f "$KEY_FILE" "$DMG")"
else
  SIG_OUTPUT="$("$SIGN_UPDATE" "$DMG")"
fi

# sign_update prints something like:
#   sparkle:edSignature="abc123..." length="12345678"
ED_SIG="$(echo "$SIG_OUTPUT" | sed -nE 's/.*sparkle:edSignature="([^"]+)".*/\1/p')"
LENGTH="$(echo "$SIG_OUTPUT" | sed -nE 's/.*length="([^"]+)".*/\1/p')"

if [[ -z "$ED_SIG" || -z "$LENGTH" ]]; then
  echo "sign_update output not parseable: $SIG_OUTPUT" >&2
  exit 1
fi

DMG_NAME="$(basename "$DMG")"
ENCLOSURE_URL="https://github.com/Spshulem/openAGI/releases/download/v${VERSION}/${DMG_NAME}"
NOTES_BLOCK=""
if [[ -n "$RELEASE_NOTES_URL" ]]; then
  NOTES_BLOCK="<sparkle:releaseNotesLink>${RELEASE_NOTES_URL}</sparkle:releaseNotesLink>"
fi
PUBDATE="$(date -u +'%a, %d %b %Y %H:%M:%S %z')"

mkdir -p "$(dirname "$APPCAST")"
cat > "$APPCAST" <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>OpenAGI</title>
    <link>https://openagi.sh</link>
    <description>OpenAGI release feed</description>
    <language>en</language>
    <item>
      <title>Version ${VERSION}</title>
      <pubDate>${PUBDATE}</pubDate>
      <sparkle:version>${BUILD}</sparkle:version>
      <sparkle:shortVersionString>${VERSION}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      ${NOTES_BLOCK}
      <enclosure
        url="${ENCLOSURE_URL}"
        sparkle:edSignature="${ED_SIG}"
        length="${LENGTH}"
        type="application/octet-stream" />
    </item>
  </channel>
</rss>
XML

echo "▶ Wrote ${APPCAST}"
echo "  version: ${VERSION} (build ${BUILD})"
echo "  enclosure: ${ENCLOSURE_URL}"
echo "  ed signature length: $(echo -n "$ED_SIG" | wc -c | tr -d ' ')"
