#!/bin/sh
# Build AIbletonBar.app from main.swift — no Xcode project needed.
#
# The version ALWAYS follows the AIbleton extension (single source of truth:
# AIbleton/package.json). Bumping the extension and re-running this script
# keeps Info.plist and the distributable zip in sync automatically.
set -e
cd "$(dirname "$0")"

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../AIbleton/package.json | head -1)
if [ -z "$VERSION" ]; then
    echo "✘ Could not read version from ../AIbleton/package.json" >&2
    exit 1
fi
echo "→ Version $VERSION (from AIbleton/package.json)"

APP=AIbletonBar.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

swiftc -O -swift-version 5 main.swift \
    -o "$APP/Contents/MacOS/AIbletonBar" \
    -framework Cocoa -framework WebKit -framework Carbon

# Stamp the synced version into the source plist, then into the bundle.
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" Info.plist
cp Info.plist "$APP/Contents/Info.plist"

# Brand assets (logo used by the collapsed bar button and the menu-bar icon)
mkdir -p "$APP/Contents/Resources"
cp Resources/AIbleton.png "$APP/Contents/Resources/"
cp Resources/AppIcon.icns "$APP/Contents/Resources/"

# Ad-hoc sign so Gatekeeper lets it run on Apple Silicon.
codesign --force --sign - "$APP"

# Distributable zip, named after the synced version.
ZIP="AIbletonBar-$VERSION-macOS.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "✔ Built $APP"
echo "✔ Built $ZIP"
