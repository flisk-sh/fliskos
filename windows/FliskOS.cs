// A small native launcher for FliskOS on Windows: it runs the bundled server and shows it in an Edge app window, then
// stops the server when that window closes. Built with the C# compiler that ships with Windows, so it needs no SDK.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class FliskOS
{
    const string Title = "FliskOS";
    const string Ready = "FliskOS is running at ";

    [STAThread]
    static int Main()
    {
        bool first;
        using (new Mutex(true, "Local\\FliskOS", out first))
        {
            // A second copy would close its server when Edge hands its window to the one already open.
            return first ? Run() : 0;
        }
    }

    static int Run()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(root, "app", "src", "cli.js");
        string runtime = FindRuntime();
        if (runtime == null)
        {
            Show("FliskOS needs Node.js 22.12 or newer, or Bun. Install one from https://nodejs.org, then open FliskOS again.", MessageBoxIcon.Warning);
            return 1;
        }

        var server = new Process();
        server.StartInfo = new ProcessStartInfo(runtime, "\"" + script + "\" --no-open")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        };

        string url = null;
        var ready = new ManualResetEvent(false);
        var errors = new StringBuilder();
        server.OutputDataReceived += (sender, line) =>
        {
            if (line.Data != null && url == null && line.Data.StartsWith(Ready))
            {
                url = line.Data.Substring(Ready.Length).Trim();
                ready.Set();
            }
        };
        server.ErrorDataReceived += (sender, line) =>
        {
            if (line.Data != null && errors.Length < 2000) errors.AppendLine(line.Data);
        };
        server.Start();
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();

        var waiting = new Thread(() => { server.WaitForExit(); ready.Set(); });
        waiting.IsBackground = true;
        waiting.Start();

        ready.WaitOne(TimeSpan.FromSeconds(60));
        if (url == null)
        {
            Show("FliskOS could not start.\n\n" + errors, MessageBoxIcon.Error);
            Stop(server);
            return 1;
        }

        string edge = FindEdge();
        if (edge != null)
        {
            // Its own profile keeps this window separate from the user's browser, so its process ends when it closes.
            string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FliskOS", "window");
            string arguments = "--app=\"" + url + "\" --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check --window-size=1280,820";
            using (var window = Process.Start(new ProcessStartInfo(edge, arguments) { UseShellExecute = false }))
            {
                window.WaitForExit();
            }
        }
        else
        {
            Process.Start(url);
            Show("FliskOS is open in your browser. Choose OK to quit it.", MessageBoxIcon.Information);
        }

        Stop(server);
        return 0;
    }

    // Closing stdin is how the server is told to shut down cleanly, the same as the Mac app.
    static void Stop(Process server)
    {
        try
        {
            server.StandardInput.Close();
            if (!server.WaitForExit(5000)) server.Kill();
        }
        catch (InvalidOperationException) { }
    }

    static string FindRuntime()
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var folders = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')
            .Concat(new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"),
                Path.Combine(home, ".bun", "bin"),
            })
            .Where(folder => folder.Trim().Length > 0 && folder.IndexOfAny(Path.GetInvalidPathChars()) < 0)
            .ToList();
        return new[] { "node.exe", "bun.exe" }
            .SelectMany(name => folders.Select(folder => Path.Combine(folder.Trim(), name)))
            .FirstOrDefault(File.Exists);
    }

    static string FindEdge()
    {
        return new[] { Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.ProgramFiles }
            .Select(folder => Path.Combine(Environment.GetFolderPath(folder), "Microsoft", "Edge", "Application", "msedge.exe"))
            .FirstOrDefault(File.Exists);
    }

    static void Show(string message, MessageBoxIcon icon)
    {
        MessageBox.Show(message, Title, MessageBoxButtons.OK, icon);
    }
}
