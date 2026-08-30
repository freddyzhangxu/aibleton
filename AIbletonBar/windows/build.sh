#!/bin/sh
# Build AIbletonBar for Windows (single-file win-x64 exe) — no Windows machine
# needed: .NET cross-publishes from macOS via EnableWindowsTargeting.
#
# The version ALWAYS follows the AIbleton extension (single source of truth:
# AIbleton/package.json), same as the macOS build.sh one level up.
set -e
cd "$(dirname "$0")"

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../../AIbleton/package.json | head -1)
if [ -z "$VERSION" ]; then
    echo "✘ Could not read version from ../../AIbleton/package.json" >&2
    exit 1
fi
echo "→ Version $VERSION (from AIbleton/package.json)"

# Tray/window icon: repack the PNG sizes inside AppIcon.icns as a Windows .ico
# (Vista+ .ico entries are just PNG payloads — no conversion needed).
echo "→ Generating Resources/AppIcon.ico from ../Resources/AppIcon.icns"
python3 - <<'PY'
import struct
data = open('../Resources/AppIcon.icns', 'rb').read()
assert data[:4] == b'icns', 'not an icns file'
pos, sizes = 8, {}
while pos < len(data):
    ln = struct.unpack('>I', data[pos+4:pos+8])[0]
    payload = data[pos+8:pos+ln]
    if payload[:8] == b'\x89PNG\r\n\x1a\n':
        w, h = struct.unpack('>II', payload[16:24])
        if w == h and w <= 256:
            sizes[w] = payload
    pos += ln
assert sizes, 'no PNG icons found in icns'
order = sorted(sizes)
entries, imgs, off = b'', b'', 6 + 16 * len(order)
for s in order:
    png = sizes[s]
    b = 0 if s >= 256 else s
    entries += struct.pack('<BBBBHHII', b, b, 0, 0, 1, 32, len(png), off)
    imgs += png
    off += len(png)
open('Resources/AppIcon.ico', 'wb').write(struct.pack('<HHH', 0, 1, len(order)) + entries + imgs)
print('  sizes:', ', '.join(str(s) for s in order))
PY

echo "→ Publishing win-x64 single-file exe"
dotnet publish AIbletonBar.csproj -c Release -r win-x64 --self-contained true \
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true \
    -p:EnableCompressionInSingleFile=true -p:DebugType=none -p:DebugSymbols=false \
    -p:Version="$VERSION" \
    -o publish

ZIP="AIbletonBar-$VERSION-Windows.zip"
rm -f "$ZIP"
# zip -j (not ditto): no macOS ._ AppleDouble junk in the archive.
zip -j "$ZIP" publish/AIbletonBar.exe >/dev/null

echo "✔ Built publish/AIbletonBar.exe"
echo "✔ Built $ZIP"
