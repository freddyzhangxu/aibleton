//
// AIbletonBar for Windows — floating sidebar window for the AIbleton Live extension.
// Port of ../main.swift (macOS). Loads http://localhost:17666 (served by the
// extension running inside Live) in an always-on-top panel docked to the
// right screen edge.
//
// Toggle with Win+Alt+A, or via the tray icon.
//
// Unlike macOS (real traffic lights overlay the web page), WebView2 owns its
// HWND and native controls can't float above it — so this window has its own
// dark caption strip with [–] collapse / [✕] hide buttons, and the web page
// skips its macOS traffic-light padding via the "native-bar-win" body class.
//

using System;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AIbletonBar
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            // Tray utility: a second instance would only duplicate the tray
            // icon and lose the global hotkey to the first.
            using var mutex = new System.Threading.Mutex(true, "AIbletonBar", out bool created);
            if (!created) return;

            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    public sealed class MainForm : Form
    {
        private const string PageUrl = "http://localhost:17666/";
        private const string PanelApi = "http://localhost:17666/api/panel";
        private const int PanelWidth = 420; // logical px, same as macOS
        private const int BarWidth = 240;
        private const int BarHeight = 32;
        private const int HotkeyId = 0xA1B1;

        private readonly WebView2 web = new();
        private readonly Panel caption = new();
        private readonly Panel barPanel = new();
        private readonly ToolTip tips = new();
        private readonly NotifyIcon tray;
        private readonly System.Windows.Forms.Timer pollTimer = new() { Interval = 1500 };
        private readonly System.Windows.Forms.Timer retryTimer = new() { Interval = 3000 };

        // localhost only — never go through the system proxy (Clash/V2Ray etc.
        // would otherwise break the connection to the extension server).
        private static readonly HttpClient http =
            new(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromMilliseconds(1200) };

        private string? lastBuild;
        private bool isCollapsed;
        private bool showingOffline;
        private bool navigatingOfflineString;
        private bool polling;
        private bool exiting;
        private Rectangle expandedBounds;

        public MainForm()
        {
            Text = "AIbleton";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(0x1C, 0x1C, 0x1E);
            TopMost = true;            // macOS .floating
            ShowInTaskbar = false;     // accessory app, like the macOS menu-bar utility
            MinimumSize = Scaled(320, 400);
            Icon = LoadIcon();
            // A thin frame of form background around the web view doubles as
            // the resize grip (the WebView2 child HWND swallows its own hits).
            Padding = new Padding(S(5), 0, S(5), S(5));

            SetupWeb();
            SetupCaption();
            SetupBarPanel();
            // Docking runs in reverse z-order (last added docks first):
            // barPanel (Fill, hidden) → caption (Top) → web (Fill, rest).
            Controls.Add(web);
            Controls.Add(caption);
            Controls.Add(barPanel);

            tray = SetupTray();
            Bounds = DockedBounds();
            expandedBounds = Bounds;

            pollTimer.Tick += async (_, _) => await PollPanelCommand();
            retryTimer.Tick += (_, _) => LoadPage();
        }

        private static int S(int v, int dpi) => (int)Math.Round(v * dpi / 96.0);
        private int S(int v) => S(v, DeviceDpi);
        private Size Scaled(int w, int h) => new(S(w), S(h));

        /// Tray-only window: keep the panel out of Alt+Tab.
        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
                return cp;
            }
        }

        /// The "bar" command from Live must appear without stealing focus;
        /// explicit shows (hotkey/tray) call Activate() themselves.
        protected override bool ShowWithoutActivation => true;

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int round = 2; // DWMWCP_ROUND — match the macOS window's corners
                DwmSetWindowAttribute(Handle, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, ref round, sizeof(int));
            }
            catch { /* pre-Windows 11 */ }

            // Win+Alt+A (⌥⌘A on the Mac). If another app grabbed it first the
            // tray menu still works.
            RegisterHotKey(Handle, HotkeyId, MOD_NOREPEAT | MOD_WIN | MOD_ALT, (uint)Keys.A);
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            try
            {
                var udf = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "AIbletonBar", "WebView2");
                var env = await CoreWebView2Environment.CreateAsync(userDataFolder: udf);
                await web.EnsureCoreWebView2Async(env);
                // "AIbletonBar" → page adds .native-bar; "Windows" (already in
                // the default UA) → page adds .native-bar-win.
                web.CoreWebView2.Settings.UserAgent += " AIbletonBar/1.0";
                // Parity with macOS reloadIgnoringLocalCacheData: after the
                // extension rebuilds in Live, never show a stale cached page.
                web.CoreWebView2.AddWebResourceRequestedFilter(PageUrl + "*", CoreWebView2WebResourceContext.All);
                web.CoreWebView2.WebResourceRequested += (_, e) =>
                    e.Request.Headers.SetHeader("Cache-Control", "no-cache");
                LoadPage();
                pollTimer.Start();
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(this,
                    "缺少 WebView2 运行时（Windows 11 一般自带）。请安装后重试：\n" +
                    "https://go.microsoft.com/fwlink/p/?LinkId=2124703",
                    "AIbletonBar", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                ExitApp();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "WebView2 初始化失败：\n" + ex.Message,
                    "AIbletonBar", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                ExitApp();
            }
        }

        // MARK: - Caption strip (stands in for macOS traffic lights)

        private void SetupCaption()
        {
            caption.Dock = DockStyle.Top;
            caption.Height = S(32);
            caption.BackColor = BackColor;


            // No logo/title here — the page header right below already shows
            // them (macOS hides the window title the same way). The empty
            // strip is just a drag area + the two window buttons.
            // Dock=Right: the one added LAST docks against the right edge.
            var btnBar = MakeCaptionButton("\uE921", "最小化为右下角小条", isClose: false);
            var btnHide = MakeCaptionButton("\uE8BB", "隐藏（Win+Alt+A 重新打开）", isClose: true);

            caption.MouseDown += DragWindow;
            caption.Controls.Add(btnHide);
            caption.Controls.Add(btnBar);
        }

        private Button MakeCaptionButton(string glyph, string tip, bool isClose)
        {
            var b = new Button
            {
                Text = glyph,
                Font = new Font("Segoe MDL2 Assets", 9f),
                ForeColor = Color.FromArgb(0xD4, 0xD4, 0xD4),
                BackColor = BackColor,
                FlatStyle = FlatStyle.Flat,
                Dock = DockStyle.Right,
                Width = S(46),
                TabStop = false,
            };
            b.FlatAppearance.BorderSize = 0;
            b.FlatAppearance.MouseOverBackColor = isClose
                ? Color.FromArgb(0xE8, 0x11, 0x23)   // Windows caption-close red
                : Color.FromArgb(0x3A, 0x3A, 0x3C);
            b.Click += (_, _) => { if (isClose) Hide(); else CollapseToBar(); };
            tips.SetToolTip(b, tip);
            return b;
        }

        private void DragWindow(object? sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, IntPtr.Zero);
        }

        // MARK: - Collapsed mini bar

        private void SetupBarPanel()
        {
            barPanel.Dock = DockStyle.Fill;
            barPanel.BackColor = BackColor;
            barPanel.Cursor = Cursors.Hand;
            barPanel.Visible = false;

            var logo = new PictureBox
            {
                Image = LoadLogo(),
                SizeMode = PictureBoxSizeMode.Zoom,
                Size = Scaled(28, 14),
                Location = new Point(S(10), S(9)),
                Cursor = Cursors.Hand,
            };
            var title = new Label
            {
                Text = "AIbleton",
                AutoSize = true,
                ForeColor = Color.FromArgb(0x98, 0x98, 0x9D),
                Font = new Font("Segoe UI", 9f),
                Location = new Point(logo.Right + S(8), S(8)),
                BackColor = Color.Transparent,
                Cursor = Cursors.Hand,
            };
            // macOS keeps the red light clickable in bar mode; ✕ does the same.
            var btnHide = new Button
            {
                Text = "\uE8BB",
                Font = new Font("Segoe MDL2 Assets", 9f),
                ForeColor = Color.FromArgb(0x98, 0x98, 0x9D),
                BackColor = BackColor,
                FlatStyle = FlatStyle.Flat,
                Dock = DockStyle.Right,
                Width = S(36),
                TabStop = false,
            };
            btnHide.FlatAppearance.BorderSize = 0;
            btnHide.FlatAppearance.MouseOverBackColor = Color.FromArgb(0xE8, 0x11, 0x23);
            btnHide.Click += (_, _) => Hide();
            tips.SetToolTip(btnHide, "隐藏（Win+Alt+A 重新打开）");

            barPanel.MouseDown += (_, e) => { if (e.Button == MouseButtons.Left) RestorePanel(); };
            logo.MouseDown += (_, e) => { if (e.Button == MouseButtons.Left) RestorePanel(); };
            title.MouseDown += (_, e) => { if (e.Button == MouseButtons.Left) RestorePanel(); };
            barPanel.Controls.Add(logo);
            barPanel.Controls.Add(title);
            barPanel.Controls.Add(btnHide);
        }

        // MARK: - Web view

        private void SetupWeb()
        {
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = BackColor;
            web.NavigationCompleted += OnNavigationCompleted;
        }

        private void LoadPage()
        {
            web.CoreWebView2?.Navigate(PageUrl);
        }

        private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (navigatingOfflineString) { navigatingOfflineString = false; return; }
            if (e.IsSuccess)
            {
                showingOffline = false;
                retryTimer.Stop();
            }
            else
            {
                ShowOfflinePage();
            }
        }

        private void ShowOfflinePage()
        {
            showingOffline = true;
            navigatingOfflineString = true;
            web.NavigateToString(OfflineHtml); // re-assert: the failed retry leaves an error page
            retryTimer.Start();              // retry the live page every 3s
        }

        // MARK: - Tray icon

        private NotifyIcon SetupTray()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("显示 / 隐藏　Win+Alt+A", null, (_, _) => Toggle());
            menu.Items.Add("重新加载", null, (_, _) => ReloadPage());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出 AIbletonBar", null, (_, _) => ExitApp());
            var t = new NotifyIcon
            {
                Icon = Icon,
                Text = "AIbleton",
                ContextMenuStrip = menu,
                Visible = true,
            };
            t.DoubleClick += (_, _) => Toggle();
            return t;
        }

        // MARK: - Actions

        private void Toggle()
        {
            if (Visible) { Hide(); return; }
            if (isCollapsed) RestorePanel(); else Bounds = DockedBounds();
            if (showingOffline) LoadPage();
            Show();
            Activate(); // ShowWithoutActivation=true, so ask for focus explicitly
        }

        private void CollapseToBar()
        {
            if (isCollapsed) { RestorePanel(); return; }
            isCollapsed = true;
            expandedBounds = Bounds;
            web.Visible = false;
            caption.Visible = false;
            barPanel.Visible = true;
            MinimumSize = new Size(S(200), S(BarHeight));
            PositionBar();
        }

        private void PositionBar()
        {
            var wa = Screen.FromHandle(Handle).WorkingArea;
            Bounds = new Rectangle(
                wa.Right - S(BarWidth) - S(12), wa.Bottom - S(BarHeight) - S(12),
                S(BarWidth), S(BarHeight));
        }

        private void RestorePanel()
        {
            if (!isCollapsed) return;
            isCollapsed = false;
            barPanel.Visible = false;
            caption.Visible = true;
            web.Visible = true;
            MinimumSize = Scaled(320, 400);
            Bounds = expandedBounds;
        }

        private void ReloadPage()
        {
            LoadPage();
            if (!Visible) Toggle();
        }

        private void ExitApp()
        {
            exiting = true;
            tray.Visible = false;
            Application.Exit();
        }

        // MARK: - Window commands from the Live modal dialog (same as macOS)

        private async Task PollPanelCommand()
        {
            if (polling || exiting) return;
            polling = true;
            try
            {
                using var doc = JsonDocument.Parse(await http.GetStringAsync(PanelApi));
                var root = doc.RootElement;
                var mode = root.TryGetProperty("mode", out var m) ? m.GetString() : null;
                var build = root.TryGetProperty("build", out var b) ? b.GetString() : null;
                RefreshIfExtensionRebuilt(build);
                if (!string.IsNullOrEmpty(mode)) ApplyPanelCommand(mode!);
            }
            catch { /* Live not running / server down — next tick retries */ }
            finally { polling = false; }
        }

        private void RefreshIfExtensionRebuilt(string? build)
        {
            if (build == null) return;
            if (lastBuild == null) { lastBuild = build; return; } // just launched; page is fresh
            if (build != lastBuild)
            {
                lastBuild = build;
                LoadPage();
            }
        }

        private void ApplyPanelCommand(string mode)
        {
            switch (mode)
            {
                case "bar":
                    if (isCollapsed) PositionBar(); else CollapseToBar();
                    if (!Visible) Show(); // no Activate(): Live keeps the focus
                    break;
                case "show":
                    if (isCollapsed) RestorePanel();
                    if (!Visible) Toggle();
                    break;
            }
        }

        // MARK: - Geometry

        private Rectangle DockedBounds()
        {
            var wa = (Handle != IntPtr.Zero ? Screen.FromHandle(Handle) : Screen.PrimaryScreen!).WorkingArea;
            return new Rectangle(wa.Right - S(PanelWidth), wa.Top, S(PanelWidth), wa.Height);
        }

        // MARK: - Win32

        private const int WM_HOTKEY = 0x0312;
        private const int WM_NCHITTEST = 0x0084;
        private const int WM_NCLBUTTONDOWN = 0x00A1;
        private const int HTCAPTION = 2;
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_WIN = 0x0008;
        private const uint MOD_NOREPEAT = 0x4000;

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HotkeyId)
            {
                Toggle();
                return;
            }
            // Borderless window: turn client-area edge hits into resize grips.
            // (Reaches us only over the form-background frame — see Padding.)
            if (m.Msg == WM_NCHITTEST && !isCollapsed)
            {
                base.WndProc(ref m);
                if (m.Result == (IntPtr)1) // HTCLIENT
                {
                    long lp = m.LParam.ToInt64();
                    var p = PointToClient(new Point((short)(lp & 0xFFFF), (short)(lp >> 16)));
                    int g = S(6);
                    bool l = p.X < g, r = p.X >= ClientSize.Width - g;
                    bool t = p.Y < g, b = p.Y >= ClientSize.Height - g;
                    if (t && l) m.Result = (IntPtr)13;       // HTTOPLEFT
                    else if (t && r) m.Result = (IntPtr)14;  // HTTOPRIGHT
                    else if (b && l) m.Result = (IntPtr)16;  // HTBOTTOMLEFT
                    else if (b && r) m.Result = (IntPtr)17;  // HTBOTTOMRIGHT
                    else if (l) m.Result = (IntPtr)10;       // HTLEFT
                    else if (r) m.Result = (IntPtr)11;       // HTRIGHT
                    else if (t) m.Result = (IntPtr)12;       // HTTOP
                    else if (b) m.Result = (IntPtr)15;       // HTBOTTOM
                }
                return;
            }
            base.WndProc(ref m);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!exiting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true; // like macOS: closing the panel only hides it
                Hide();
                return;
            }
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            UnregisterHotKey(Handle, HotkeyId);
            tray.Visible = false;
            tray.Dispose();
            base.OnFormClosed(e);
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        // MARK: - Resources

        private static Icon LoadIcon()
        {
            var s = typeof(Program).Assembly.GetManifestResourceStream("AIbletonBar.Resources.AppIcon.ico");
            return s != null ? new Icon(s) : SystemIcons.Application;
        }

        private static Image LoadLogo()
        {
            var s = typeof(Program).Assembly.GetManifestResourceStream("AIbletonBar.Resources.AIbleton.png");
            return s != null ? Image.FromStream(s) : new Bitmap(1, 1);
        }

        // Same page the macOS bar shows when the extension isn't reachable.
        private const string OfflineHtml = """
        <html><body style="margin:0;height:100vh;display:flex;flex-direction:column;gap:12px;
        align-items:center;justify-content:center;background:#1c1c1e;color:#98989d;
        font:13px 'Segoe UI',sans-serif;text-align:center;padding:24px">
        <svg width='76' height='38' viewBox='42.666667 298.666667 938.666666 469.333333'>
        <defs><mask id='m' maskUnits='userSpaceOnUse' x='42.666667' y='298.666667' width='426.666666' height='469.333333'>
        <rect x='42.666667' y='298.666667' width='426.666666' height='469.333333' fill='#fff'/>
        <path fill='#000' fill-rule='evenodd' d='M61 768 199.72 298.67H308.74L451 768H358.61L327.27 659.01H183.1L152.84 768Z
        M203.81 583.73H305.74L293.47 541.52Q283.66 505.61 273.85 463.72Q264.04 421.83 253.41 373.95
        Q243.33 422.46 234.06 464.35Q224.79 506.24 215.53 541.52Z M203.81 583.73L305.74 583.73L327.27 659.01L183.1 659.01Z'/>
        <path fill='#000' d='M241.41 363.95h24v21.05h-24z'/></mask></defs>
        <g mask='url(#m)'><path fill='#797F7E' d='M42.67 298.67h426.67v85.33H42.67z M42.67 426.67h426.67v85.33H42.67z
        M42.67 554.67h426.67v85.33H42.67z M42.67 682.67h426.67v85.33H42.67z'/></g>
        <path fill='#797F7E' d='M512 298.67h85.33v469.33H512z M640 298.67h85.33v469.33H640z M768 298.67h85.33v469.33H768z M896 298.67h85.33v469.33H896z'/>
        </svg>
        <div><b style="color:#fff">连不上 AIbleton 服务</b></div>
        <div>请在 Ableton Live 12 中加载 AIbleton 扩展<br>（localhost:17666），连上后会自动恢复</div>
        </body></html>
        """;
    }
}
