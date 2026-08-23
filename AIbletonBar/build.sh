#!/bin/sh
# Build AIbletonBar.app from main.swift — no Xcode project needed.
set -e
cd "$(dirname "$0")"

APP=AIbletonBar.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

swiftc -O -swift-version 5 main.swift \
    -o "$APP/Contents/MacOS/AIbletonBar" \
    -framework Cocoa -framework WebKit -framework Carbon

cp Info.plist "$APP/Contents/Info.plist"

# Brand assets (logo used by the collapsed bar button and the menu-bar icon)
mkdir -p "$APP/Contents/Resources"
cp Resources/AIbleton.png "$APP/Contents/Resources/"
cp Resources/AppIcon.icns "$APP/Contents/Resources/"

# Ad-hoc sign so Gatekeeper lets it run on Apple Silicon.
codesign --force --sign - "$APP"

echo "✔ Built $APP"
