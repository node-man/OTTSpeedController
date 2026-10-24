// Chrome Native Messaging host. No arbitrary commands, paths or credentials.
using System;
using System.IO;
using System.Text;
using System.Net;
using System.Diagnostics;
using System.Collections.Generic;
using System.Web.Script.Serialization;

public static class OTTSpeedRuntimeHost {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string Base = AppDomain.CurrentDomain.BaseDirectory;
    static Dictionary<string, object> Config;
    static string Root;
    static string ExpectedTunnel;

    static Dictionary<string, object> ReadJson(string path) {
        return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
    }
    static bool Flag(Dictionary<string, object> value, string key) {
        return value.ContainsKey(key) && value[key] is bool && (bool)value[key];
    }
    static bool GetHealth(string url) {
        try {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Proxy = null; request.Timeout = 1500; request.ReadWriteTimeout = 1500;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) {
                return response.StatusCode == HttpStatusCode.OK;
            }
        } catch { return false; }
    }
    static bool GetBridgeHealth() {
        try {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:43127/healthz");
            request.Proxy = null; request.Timeout = 1500; request.ReadWriteTimeout = 1500;
            using (WebResponse response = request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream())) {
                Dictionary<string, object> health = Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                return Convert.ToString(health["service"]) == "ottspeed-translation-bridge" && Flag(health, "ready");
            }
        } catch { return false; }
    }
    static Dictionary<string, object> Status() {
        bool bridge = false, tunnel = false, supervisor = false;
        try {
            string statePath = Path.Combine(Root, "private-subtitles", "bridge", "stack-status.json");
            Dictionary<string, object> state = ReadJson(statePath);
            bool matching = Convert.ToString(state["tunnelId"]) == ExpectedTunnel;
            DateTime stamp = DateTime.Parse(Convert.ToString(state["checkedAt"])).ToUniversalTime();
            bool fresh = Math.Abs((DateTime.UtcNow - stamp).TotalSeconds) < 90;
            using (Process process = Process.GetProcessById(Convert.ToInt32(state["supervisorPid"]))) {
                supervisor = !process.HasExited && process.ProcessName.Equals("powershell", StringComparison.OrdinalIgnoreCase);
            }
            bridge = GetBridgeHealth();
            string healthFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "state", "tunnel-client", "health", "ottspeed.url");
            string baseUrl = File.ReadAllText(healthFile).Trim();
            Uri health;
            bool loopback = Uri.TryCreate(baseUrl, UriKind.Absolute, out health) && health.Scheme == "http" && health.Host == "127.0.0.1" && health.AbsolutePath == "/" && String.IsNullOrEmpty(health.Query) && String.IsNullOrEmpty(health.UserInfo);
            tunnel = matching && fresh && Flag(state, "tunnelReady") && loopback && GetHealth(baseUrl.TrimEnd('/') + "/readyz");
        } catch { }
        bool ready = bridge && tunnel && supervisor;
        return new Dictionary<string, object> {
            {"kind", "ottspeed.local-runtime"}, {"version", 1}, {"ok", true},
            {"state", ready ? "ready" : "stopped"}, {"bridgeReady", bridge},
            {"tunnelReady", tunnel}, {"supervisorReady", supervisor}, {"tunnelId", ExpectedTunnel}
        };
    }
    static Dictionary<string, object> Ensure() {
        // The fixed launcher is idempotent: never stop/reconnect a healthy runtime.
        string script = Path.Combine(Root, "scripts", "start-translation-stack-task.ps1");
        if (!File.Exists(script)) throw new InvalidOperationException();
        ProcessStartInfo info = new ProcessStartInfo {
            FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
            Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -File \"" + script + "\"",
            WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        using (Process process = Process.Start(info)) {
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(20000) || process.ExitCode != 0) return Failure("start_failed");
            // Do not forward helper stdout/stderr (or secrets) into Chrome.
        }
        Stopwatch timer = Stopwatch.StartNew();
        do {
            Dictionary<string, object> state = Status();
            if (Convert.ToString(state["state"]) == "ready") return state;
            System.Threading.Thread.Sleep(1000);
        } while (timer.Elapsed.TotalSeconds < 45);
        return Failure("start_timeout");
    }
    static Dictionary<string, object> Failure(string code) {
        return new Dictionary<string, object> {{"kind", "ottspeed.local-runtime"}, {"version", 1}, {"ok", false}, {"state", "unavailable"}, {"errorCode", code}};
    }
    static byte[] ReadExactly(Stream input, int count) {
        byte[] value = new byte[count]; int offset = 0;
        while (offset < count) { int read = input.Read(value, offset, count - offset); if (read == 0) throw new EndOfStreamException(); offset += read; }
        return value;
    }
    public static int Main(string[] args) {
        Dictionary<string, object> result;
        try {
            Config = ReadJson(Path.Combine(Base, "runtime-host-config.json"));
            Root = Path.GetFullPath(Convert.ToString(Config["projectRoot"]));
            ExpectedTunnel = Convert.ToString(Config["tunnelId"]);
            string origin = Convert.ToString(Config["allowedOrigin"]);
            if (args.Length < 1 || args[0] != origin) { result = Failure("forbidden_origin"); }
            else {
                Stream input = Console.OpenStandardInput();
                uint length = BitConverter.ToUInt32(ReadExactly(input, 4), 0);
                if (length == 0 || length > 16384) throw new InvalidDataException();
                string message = new UTF8Encoding(false, true).GetString(ReadExactly(input, (int)length));
                Dictionary<string, object> request = Json.Deserialize<Dictionary<string, object>>(message);
                if (request == null || request.Count != 1 || !request.ContainsKey("action")) result = Failure("invalid_request");
                else if (Convert.ToString(request["action"]) == "status") result = Status();
                else if (Convert.ToString(request["action"]) == "ensure") result = Ensure();
                else result = Failure("invalid_request");
            }
        } catch { result = Failure("host_error"); }
        byte[] output = Encoding.UTF8.GetBytes(Json.Serialize(result));
        Stream stream = Console.OpenStandardOutput();
        byte[] header = BitConverter.GetBytes(output.Length);
        stream.Write(header, 0, header.Length); stream.Write(output, 0, output.Length); stream.Flush();
        return 0;
    }
}
