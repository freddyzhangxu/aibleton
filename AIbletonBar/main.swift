//
// AIbletonBar — floating sidebar window for the AIbleton Live extension.
// Loads http://localhost:17666 (served by the extension running inside Live)
// in a borderless, always-on-top panel docked to the right screen edge.
//
// Toggle with ⌥⌘A (Option+Command+A), or via the menu-bar icon.
//

import Cocoa
import WebKit
import Carbon.HIToolbox

let PAGE_URL = URL(string: "http://localhost:17666/")!
let PANEL_WIDTH: CGFloat = 420
let BAR_WIDTH: CGFloat = 240
let BAR_HEIGHT: CGFloat = 32 // traffic lights center = 16px from top (measured)

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var hotKeyRef: EventHotKeyRef?
    private var retryTimer: Timer?
    private var showingOfflinePage = false
    private var barButton: NSButton!
    private var isCollapsed = false
    private var expandedFrame: NSRect = .zero

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupWindow()
        setupStatusItem()
        registerHotKey()
        loadPage()
        startCommandPolling()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false // closing the panel only hides it; quit from the menu-bar icon
    }

    // MARK: - Window

    private func setupWindow() {
        let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        let win = NSWindow(contentRect: .zero, styleMask: style, backing: .buffered, defer: false)
        win.title = "AIbleton"
        win.titlebarAppearsTransparent = true
        win.titleVisibility = .hidden
        win.isMovableByWindowBackground = true
        win.level = .floating
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        win.isReleasedWhenClosed = false
        win.minSize = NSSize(width: 320, height: 400)
        win.backgroundColor = NSColor(red: 0.11, green: 0.11, blue: 0.12, alpha: 1)
        win.delegate = self

        // Traffic lights: no green zoom button — only red (hide) and
        // yellow (collapse to bar). Rewire yellow directly to our bar mode,
        // since this accessory app has no Dock tile to miniaturize into.
        win.standardWindowButton(.zoomButton)?.isHidden = true
        win.standardWindowButton(.zoomButton)?.isEnabled = false
        if let yellow = win.standardWindowButton(.miniaturizeButton) {
            yellow.target = self
            yellow.action = #selector(collapseToBar)
        }

        // Container view so the collapsed-bar overlay can sit on top of the web view.
        let container = NSView(frame: NSRect(x: 0, y: 0, width: PANEL_WIDTH, height: 800))
        container.autoresizingMask = [.width, .height]
        win.contentView = container

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // Lets the chat UI detect the native window and pad its header
        // clear of the real traffic-light buttons.
        config.applicationNameForUserAgent = "AIbletonBar/1.0"
        let web = WKWebView(frame: container.bounds, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground") // blend with window until page paints
        container.addSubview(web)

        // Bar-mode overlay: click anywhere right of the traffic lights to expand.
        let bar = NSButton(title: "AIbleton", target: self, action: #selector(restorePanel))
        bar.isBordered = false
        bar.font = .systemFont(ofSize: 12, weight: .medium)
        bar.contentTintColor = .secondaryLabelColor
        bar.alignment = .left
        if let logo = Self.loadLogo() {
            logo.size = NSSize(width: 24, height: 12)
            bar.image = logo
            bar.imagePosition = .imageLeft
        }
        bar.frame = NSRect(x: 78, y: 0, width: BAR_WIDTH - 78, height: BAR_HEIGHT)
        bar.autoresizingMask = [.width]
        bar.isHidden = true
        container.addSubview(bar)

        self.window = win
        self.webView = web
        self.barButton = bar
        dockRight()
    }

    /// Snap the panel to the right edge of the screen, full height.
    private func dockRight() {
        guard let screen = window?.screen ?? NSScreen.main else { return }
        let vf = screen.visibleFrame
        window.setFrame(
            NSRect(x: vf.maxX - PANEL_WIDTH, y: vf.minY, width: PANEL_WIDTH, height: vf.height),
            display: true
        )
    }

    // MARK: - Menu bar

    /// Brand logo from the app bundle (Resources/AIbleton.png, 2:1 stripes).
    private static func loadLogo() -> NSImage? {
        guard let url = Bundle.main.url(forResource: "AIbleton", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            if let logo = Self.loadLogo() {
                logo.size = NSSize(width: 26, height: 13)
                logo.isTemplate = true // silhouette; adapts to light/dark menu bar
                button.image = logo
            } else {
                button.image = NSImage(systemSymbolName: "waveform.badge.mic", accessibilityDescription: "AIbleton")
            }
        }
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "显示 / 隐藏　⌥⌘A", action: #selector(toggle), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "重新加载", action: #selector(reload), keyEquivalent: "r"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出 AIbletonBar", action: #selector(quit), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusItem.menu = menu
    }

    // MARK: - Global hotkey (⌥⌘A, no accessibility permission needed)

    private func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let handler: EventHandlerUPP = { _, _, userData in
            guard let userData else { return OSStatus(noErr) }
            let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { delegate.toggle() }
            return OSStatus(noErr)
        }
        InstallEventHandler(GetApplicationEventTarget(), handler, 1, &spec,
                            Unmanaged.passUnretained(self).toOpaque(), nil)

        let hotKeyID = EventHotKeyID(signature: 0x4149424C, id: 1) // 'AIBL'
        RegisterEventHotKey(UInt32(kVK_ANSI_A), UInt32(optionKey | cmdKey), hotKeyID,
                            GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    // MARK: - Actions

    @objc func toggle() {
        if window.isVisible {
            window.orderOut(nil)
        } else {
            if isCollapsed { restorePanel() } else { dockRight() }
            if showingOfflinePage { loadPage() }
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        }
    }

    /// Yellow button: collapse into a small floating bar at the bottom-right
    /// corner of the screen (we have no Dock tile to miniaturize into).
    /// Clicking yellow again while collapsed restores the panel.
    @objc func collapseToBar() {
        if isCollapsed { restorePanel(); return }
        enterBarMode()
        positionBar(animated: true)
    }

    private func enterBarMode() {
        guard !isCollapsed else { return }
        isCollapsed = true
        expandedFrame = window.frame
        webView.isHidden = true
        barButton.isHidden = false
        window.minSize = NSSize(width: 200, height: BAR_HEIGHT)
    }

    private func positionBar(animated: Bool) {
        guard let screen = window.screen ?? NSScreen.main else { return }
        let vf = screen.visibleFrame
        window.setFrame(
            NSRect(x: vf.maxX - BAR_WIDTH - 12, y: vf.minY + 12,
                   width: BAR_WIDTH, height: BAR_HEIGHT),
            display: true, animate: animated
        )
    }

    /// Restore the full panel from bar mode.
    @objc func restorePanel() {
        guard isCollapsed else { return }
        isCollapsed = false
        window.minSize = NSSize(width: 320, height: 400)
        barButton.isHidden = true
        webView.isHidden = false
        window.setFrame(expandedFrame, display: true, animate: true)
    }

    @objc func reload() {
        loadPage()
        if !window.isVisible { toggle() }
    }

    @objc func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - Window commands from the Live modal dialog

    /// The modal's yellow button queues a command on the extension server
    /// (POST /api/panel); we poll it here so "minimize" inside Live pops the
    /// mini bar at the screen's bottom-right corner.
    private func startCommandPolling() {
        Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.pollPanelCommand()
        }
    }

    private var lastKnownBuild: String?

    private func pollPanelCommand() {
        var request = URLRequest(url: URL(string: "http://localhost:17666/api/panel")!)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            let mode = obj["mode"] as? String
            let build = obj["build"] as? String
            DispatchQueue.main.async {
                self.refreshIfExtensionRebuilt(build)
                if let mode, !mode.isEmpty { self.applyPanelCommand(mode) }
            }
        }.resume()
    }

    /// The extension serves a fresh build id after every rebuild+reload in
    /// Live — when it changes, our already-open webview is showing stale HTML
    /// and must reload.
    private func refreshIfExtensionRebuilt(_ build: String?) {
        guard let build else { return }
        if lastKnownBuild == nil {
            lastKnownBuild = build // just launched; the page is already fresh
            return
        }
        if build != lastKnownBuild {
            lastKnownBuild = build
            loadPage()
        }
    }

    private func applyPanelCommand(_ mode: String) {
        switch mode {
        case "bar":
            enterBarMode()
            positionBar(animated: window.isVisible)
            if !window.isVisible {
                // Appear WITHOUT activating — Live keeps the focus.
                window.orderFront(nil)
            }
        case "show":
            if isCollapsed { restorePanel() }
            if !window.isVisible { toggle() }
        default:
            break
        }
    }

    // MARK: - Page loading with auto-retry

    private func loadPage() {
        webView.load(URLRequest(url: PAGE_URL, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryTimer?.invalidate()
        retryTimer = nil
        showingOfflinePage = false
        webView.setValue(true, forKey: "drawsBackground")
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        showOfflinePage()
    }

    private func showOfflinePage() {
        showingOfflinePage = true
        webView.setValue(true, forKey: "drawsBackground")
        webView.loadHTMLString("""
        <html><body style="margin:0;height:100vh;display:flex;flex-direction:column;gap:12px;\
        align-items:center;justify-content:center;background:#1c1c1e;color:#98989d;\
        font:13px -apple-system;text-align:center;padding:24px">
        <svg width='76' height='38' viewBox='42.666667 298.666667 938.666666 469.333333'>\
        <defs><mask id='m' maskUnits='userSpaceOnUse' x='42.666667' y='298.666667' width='426.666666' height='469.333333'>\
        <rect x='42.666667' y='298.666667' width='426.666666' height='469.333333' fill='#fff'/>\
        <path fill='#000' fill-rule='evenodd' d='M61 768 199.72 298.67H308.74L451 768H358.61L327.27 659.01H183.1L152.84 768Z\
        M203.81 583.73H305.74L293.47 541.52Q283.66 505.61 273.85 463.72Q264.04 421.83 253.41 373.95\
        Q243.33 422.46 234.06 464.35Q224.79 506.24 215.53 541.52Z M203.81 583.73L305.74 583.73L327.27 659.01L183.1 659.01Z'/>\
        <path fill='#000' d='M241.41 363.95h24v21.05h-24z'/></mask></defs>\
        <g mask='url(#m)'><path fill='#797F7E' d='M42.67 298.67h426.67v85.33H42.67z M42.67 426.67h426.67v85.33H42.67z \
        M42.67 554.67h426.67v85.33H42.67z M42.67 682.67h426.67v85.33H42.67z'/></g>\
        <path fill='#797F7E' d='M512 298.67h85.33v469.33H512z M640 298.67h85.33v469.33H640z M768 298.67h85.33v469.33H768z M896 298.67h85.33v469.33H896z'/>\
        </svg>
        <div><b style="color:#fff">连不上 AIbleton 服务</b></div>
        <div>请在 Ableton Live 12 中加载 AIbleton 扩展<br>（localhost:17666），连上后会自动恢复</div>
        </body></html>
        """, baseURL: nil)
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            self?.loadPage()
        }
    }
    // MARK: - WKUIDelegate

    /// Without this the chat UI's attach button is a dead click: macOS WKWebView
    /// only opens a file picker when the host app provides one.
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        // The app runs as a menu-bar accessory — bring the panel to the front.
        NSApp.activate(ignoringOtherApps: true)
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}

extension AppDelegate: NSWindowDelegate {
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil) // hide instead of closing
        return false
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // no Dock icon — menu-bar utility only
app.run()
