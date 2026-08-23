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

# Ad-hoc sign so Gatekeeper lets it run on Apple Silicon.
codesign --force --sign - "$APP"

echo "✔ Built $APP"
