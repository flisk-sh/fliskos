import Cocoa
import WebKit

final class DragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
    }
}

// Lightweight native shell: runs the bundled Node server and shows it in a WKWebView.
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let mode = ProcessInfo.processInfo.environment["FLISK_APPEARANCE"] { NSApp.appearance = NSAppearance(named: mode == "dark" ? .darkAqua : .aqua) }
        let config = WKWebViewConfiguration()
        // Lets the page switch to its translucent theme only inside the native window.
        config.userContentController.addUserScript(WKUserScript(source: "document.documentElement.classList.add('native')", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Light trackpad feedback when the page reports a button press (Force Touch trackpads only).
        config.userContentController.add(self, name: "haptic")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: Double(ProcessInfo.processInfo.environment["FLISK_WINDOW_WIDTH"] ?? "") ?? 1180, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "FliskOS"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        // Content runs under the (transparent) title bar; a thin strip keeps the window draggable.
        let container = NSVisualEffectView()
        container.material = .underWindowBackground
        container.blendingMode = .behindWindow
        container.state = .active
        window.isOpaque = false
        window.backgroundColor = .clear
        webView.translatesAutoresizingMaskIntoConstraints = false
        let strip = DragStrip()
        strip.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        container.addSubview(strip)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            strip.topAnchor.constraint(equalTo: container.topAnchor),
            strip.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            strip.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -130),
            strip.heightAnchor.constraint(equalToConstant: 28),
        ])
        window.contentView = container
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString(Self.splash("Starting…"), baseURL: nil)
        startServer()
    }

    // Instant native splash shown until the server answers; no network needed.
    static func splash(_ status: String) -> String {
        """
        <meta name=color-scheme content="light dark"><style>
        html,body{margin:0;height:100%;background:transparent;font:15px -apple-system,sans-serif;color:#141413}
        @media(prefers-color-scheme:dark){body{color:#faf9f5}}
        .c{height:100%;display:grid;place-content:center;justify-items:center;gap:18px}
        .m{width:64px;height:64px;border-radius:18px;display:grid;place-items:center;font:700 30px -apple-system;color:#fff;background:linear-gradient(135deg,#ff8a65,#b4532f);box-shadow:0 12px 36px rgba(180,83,47,.4);animation:p 1.6s ease-in-out infinite}
        .s{width:22px;height:22px;border-radius:50%;border:2.5px solid rgba(128,128,128,.3);border-top-color:#d9693f;animation:r .8s linear infinite}
        .t{opacity:.7;font-size:13px}
        @keyframes r{to{transform:rotate(360deg)}}@keyframes p{50%{transform:scale(1.06)}}
        </style><div class=c><div class=m>T</div><div class=s></div><div class=t>\(status)</div></div>
        """
    }

    func startServer() {
        guard let resources = Bundle.main.resourcePath else { return fail("Missing bundle resources.") }
        let process = Process()
        var environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let preferredPath = ["\(home)/.n/bin", "\(home)/.bun/bin", "\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        let inheritedPath = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
        var seenPathEntries = Set<String>()
        let appPath = (preferredPath + inheritedPath).filter { seenPathEntries.insert($0).inserted }.joined(separator: ":")
        environment["PATH"] = appPath
        // The login shell sources user profiles, which can put Intel Homebrew
        // ahead of the native Apple Silicon tools. Reapply this path after the
        // login shell starts so Colima resolves the native limactl first.
        environment["FLISKOS_PATH"] = appPath
        process.environment = environment
        // Start a login shell so Node managers (nvm, bun) initialize their PATH.
        process.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
        // Resolve node (or bun, which runs the same server) while the login shell's PATH is still
        // loaded (nvm, bun, Homebrew all set it there), then exec that absolute path. Exit 127 means neither was found.
        let script = """
        NODE=$(command -v node || command -v bun) || { echo "Neither node nor bun is on PATH; install Node.js 22.12+ or Bun, or add it to ~/.zprofile" >&2; exit 127; }
        export PATH="$FLISKOS_PATH:$PATH"; unset FLISKOS_PATH
        exec "$NODE" "$1" --no-open
        """
        process.arguments = ["-l", "-c", script, "fliskos", "\(resources)/app/src/cli.js"]
        let out = Pipe(), err = Pipe(), stdin = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = stdin  // server exits when this closes (app quit/crash)
        var buffer = ""
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            buffer += text
            DispatchQueue.main.async { if !buffer.contains("http://127.0.0.1") { self?.webView.evaluateJavaScript("document.querySelector('.t').textContent='Finding your projects…'") } }
            if let range = buffer.range(of: #"http://127\.0\.0\.1:\d+/\S*"#, options: .regularExpression),
               let url = URL(string: String(buffer[range])) {
                handle.readabilityHandler = nil
                DispatchQueue.main.async { self?.webView.load(URLRequest(url: url)) }
            }
        }
        process.terminationHandler = { [weak self] proc in
            let message = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                if proc.terminationReason == .exit && proc.terminationStatus != 0 {
                    self?.fail("Server exited (\(proc.terminationStatus)).\n\n\(message.isEmpty ? "Is Node.js 22.12+ or Bun installed and on your PATH?" : message)")
                }
            }
        }
        do { try process.run(); server = process } catch { fail("Could not start the server: \(error)") }
    }

    func fail(_ message: String) {
        let escaped = message.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        webView.loadHTMLString("<body style='background:#1c1c1e;color:#f87171;font:14px ui-monospace;padding:2em;white-space:pre-wrap'>\(escaped)</body>", baseURL: nil)
    }

    // Links to other hosts open in the default browser, not inside the app.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, let host = url.host, host != "127.0.0.1", url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    // Developer aid: FLISK_SNAPSHOT=/path.png renders the page to an image and exits.
    // FLISK_SNAPSHOT_JS runs first (e.g. to open a project); FLISK_APPEARANCE=dark|light forces the theme.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["FLISK_SNAPSHOT"], webView.url?.host == "127.0.0.1" else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + (Double(env["FLISK_SNAPSHOT_DELAY"] ?? "") ?? 4.0)) {
            let js = env["FLISK_SNAPSHOT_JS"] ?? "0"
            webView.evaluateJavaScript(js) { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    webView.takeSnapshot(with: nil) { image, _ in
                        guard let image = image else { exit(2) }
                        let dark = env["FLISK_APPEARANCE"] == "dark"
                        let out = NSImage(size: image.size)
                        out.lockFocus()
                        (dark ? NSColor(white: 0.13, alpha: 1) : NSColor(white: 0.93, alpha: 1)).setFill()
                        NSRect(origin: .zero, size: image.size).fill()
                        image.draw(in: NSRect(origin: .zero, size: image.size))
                        out.unlockFocus()
                        if let tiff = out.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                            try? png.write(to: URL(fileURLWithPath: path))
                        }
                        exit(0)
                    }
                }
            }
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "haptic" else { return }
        NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { server?.terminate() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
let menu = NSMenu(), appItem = NSMenuItem(), appMenu = NSMenu()
appMenu.addItem(withTitle: "Quit FliskOS", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appItem.submenu = appMenu; menu.addItem(appItem)
let edit = NSMenuItem(), editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
edit.submenu = editMenu; menu.addItem(edit)
app.mainMenu = menu
app.run()
