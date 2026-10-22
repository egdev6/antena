param([uint32]$ParentIdentityPid)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Separate read-only query mode. No Add-Type, console attachment, target, or app
# pipes: stdout belongs exclusively to the launcher's bounded private query.
if ($PSBoundParameters.ContainsKey('ParentIdentityPid')) {
    $queriedParent = $null
    try {
        if ($ParentIdentityPid -eq 0) { throw 'Invalid parent identity query' }
        $queriedParent = [Diagnostics.Process]::GetProcessById($ParentIdentityPid)
        $creation = $queriedParent.StartTime.ToFileTimeUtc()
        if ($creation -le 0) { throw 'Invalid parent creation time' }
        [Console]::Out.Write($creation.ToString([Globalization.CultureInfo]::InvariantCulture))
    } catch { exit 1 }
    finally { if ($null -ne $queriedParent) { $queriedParent.Dispose() } }
    exit 0
}

# All controller output is the child's bytes. Configuration consumes exactly one UTF-8 line;
# reports/control are private files, never PowerShell's stdout or stderr.
try {
Add-Type -ErrorAction Stop -WarningAction SilentlyContinue 2>$null -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Globalization;
using System.Text;
using System.Threading.Tasks;
using System.Runtime.InteropServices;

public sealed class SignalHost : IDisposable {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Startup {
        public uint cb; public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
        public ushort show, reservedSize;
        public IntPtr reservedData, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)]
    public struct Child { public IntPtr process, thread; public uint id, threadId; }
    [StructLayout(LayoutKind.Sequential)]
    public struct FileTime { public uint low, high; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, StringBuilder command,
        IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment,
        string cwd, ref StartupEx startup, out Child child);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint id);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint GetConsoleProcessList([Out] uint[] ids, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GenerateConsoleCtrlEvent(uint kind, uint group);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr handle, out FileTime creation, out FileTime exit,
        out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr handle, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool MoveFileEx(string source, string destination, uint flags);

    readonly Stream hostInput, hostOutput, hostError;
    AnonymousPipeServerStream input, output, error;
    Task inputTask, outputTask, errorTask;
    IntPtr parent;
    Child child;
    bool attached;
    public uint TargetPid { get { return child.id; } }
    public bool HasChild { get { return child.process != IntPtr.Zero; } }
    public string CreationTime { get; private set; }
    public SignalHost() {
        // Pin the original redirected streams BEFORE FreeConsole/AttachConsole.
        hostInput = Console.OpenStandardInput();
        hostOutput = Console.OpenStandardOutput();
        hostError = Console.OpenStandardError();
    }
    static void Require(bool ok) { if (!ok) throw new InvalidOperationException("Native operation failed"); }
    public string ReadConfiguration() {
        using (var buffer = new MemoryStream()) {
            for (;;) {
                int value = hostInput.ReadByte();
                if (value < 0) throw new InvalidOperationException("Missing configuration");
                if (value == 10) break;
                if (buffer.Length >= 1048576) throw new InvalidOperationException("Configuration too large");
                buffer.WriteByte((byte)value);
            }
            return new UTF8Encoding(false, true).GetString(buffer.ToArray());
        }
    }
    // Windows CRT quoting, not cmd.exe/PowerShell interpretation. Quote every argument;
    // double trailing backslashes and 2n+1 backslashes before literal double quotes.
    static string Quote(string value) {
        if (value == null || value.IndexOf('\0') >= 0) throw new InvalidOperationException("Invalid argument");
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }
    public void Launch(string executable, string[] args, string cwd, uint parentPid, string parentCreationTime) {
        if (parentPid == 0 || parentPid == GetCurrentProcessId()) throw new InvalidOperationException("Invalid parent");
        ulong expectedCreation = 0;
        Require(parentCreationTime != null &&
            UInt64.TryParse(parentCreationTime, NumberStyles.None, CultureInfo.InvariantCulture, out expectedCreation) &&
            expectedCreation > 0 && String.Equals(parentCreationTime,
                expectedCreation.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal));
        parent = OpenProcess(0x00100000 | 0x1000, false, parentPid);
        Require(parent != IntPtr.Zero);
        FileTime parentCreation, parentExit, parentKernel, parentUser;
        Require(GetProcessTimes(parent, out parentCreation, out parentExit, out parentKernel, out parentUser));
        string actualCreation = (((ulong)parentCreation.high << 32) | parentCreation.low)
            .ToString(CultureInfo.InvariantCulture);
        // Validate the pinned process BEFORE creating any target. A reused PID is
        // not our owner: failure only closes this HANDLE, never terminates it.
        Require(String.Equals(actualCreation, parentCreationTime, StringComparison.Ordinal));
        Require(WaitForSingleObject(parent, 0) == 258);
        // Do not pass the special ignore-Ctrl+C attribute to the new console child.
        if (!SetConsoleCtrlHandler(IntPtr.Zero, false) && Marshal.GetLastWin32Error() != 6)
            throw new InvalidOperationException("Cannot reset controller Ctrl+C state");
        var command = new StringBuilder(Quote(executable));
        foreach (string arg in args ?? new string[0]) { command.Append(' '); command.Append(Quote(arg)); }
        if (command.Length >= 32767) throw new InvalidOperationException("Command line too long");
        input = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
        output = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
        error = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
        IntPtr[] clients = { new IntPtr(Int64.Parse(input.GetClientHandleAsString())),
            new IntPtr(Int64.Parse(output.GetClientHandleAsString())),
            new IntPtr(Int64.Parse(error.GetClientHandleAsString())) };
        IntPtr attributeSize = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero;
        bool initialized = false;
        try {
            // Explicit allowlist: no inherited runner/extra pipe handles that could hold EOF open.
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            Require(attributeSize != IntPtr.Zero);
            attributes = Marshal.AllocHGlobal(attributeSize);
            Require(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize));
            initialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * clients.Length);
            for (int i = 0; i < clients.Length; i++) Marshal.WriteIntPtr(handles, i * IntPtr.Size, clients[i]);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002),
                handles, new IntPtr(IntPtr.Size * clients.Length), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupEx();
            startup.startup.cb = (uint)Marshal.SizeOf(typeof(StartupEx));
            startup.startup.flags = 0x101; // USESTDHANDLES | USESHOWWINDOW, SW_HIDE.
            startup.startup.stdin = clients[0]; startup.startup.stdout = clients[1]; startup.startup.stderr = clients[2];
            startup.attributes = attributes;
            // CREATE_NEW_CONSOLE | EXTENDED_STARTUPINFO_PRESENT; environment inherits
            // this controller's explicit launch environment, never shell-expanded data.
            Require(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                0x00080010, IntPtr.Zero, cwd, ref startup, out child));
        } finally {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        }
        Require(CloseHandle(child.thread)); child.thread = IntPtr.Zero;
        input.DisposeLocalCopyOfClientHandle();
        output.DisposeLocalCopyOfClientHandle();
        error.DisposeLocalCopyOfClientHandle();
        FileTime creation, exit, kernel, user;
        Require(GetProcessTimes(child.process, out creation, out exit, out kernel, out user));
        CreationTime = (((ulong)creation.high << 32) | creation.low).ToString();
        outputTask = output.CopyToAsync(hostOutput);
        errorTask = error.CopyToAsync(hostError);
        inputTask = PumpInput();
    }
    async Task PumpInput() {
        try { await hostInput.CopyToAsync(input).ConfigureAwait(false); }
        finally { input.Dispose(); }
    }
    public bool ParentAlive() { return WaitForSingleObject(parent, 0) == 258; }
    public bool Running() {
        uint wait = WaitForSingleObject(child.process, 0);
        if (wait == 258) return true;
        Require(wait == 0);
        return false;
    }
    public uint ExitCode() {
        Require(!Running());
        uint code; Require(GetExitCodeProcess(child.process, out code)); return code;
    }
    public uint[] Interrupt() {
        Require(Running());
        // Only this emitter detaches. The child is identified by an OWNED live HANDLE;
        // retaining it also prevents PID reuse while AttachConsole addresses its PID.
        FreeConsole(); attached = false;
        Require(AttachConsole(child.id)); attached = true;
        Require(SetConsoleCtrlHandler(IntPtr.Zero, true)); // AFTER CreateProcess/AttachConsole.
        uint[] ids = new uint[16];
        uint count = GetConsoleProcessList(ids, (uint)ids.Length);
        uint self = GetCurrentProcessId();
        Require(count == 2 && child.id != self &&
            ((ids[0] == child.id && ids[1] == self) || (ids[1] == child.id && ids[0] == self)));
        Require(Running());
        // CTRL_C_EVENT group zero is safe ONLY inside this freshly verified owned console.
        Require(GenerateConsoleCtrlEvent(0, 0));
        return new uint[] { ids[0], ids[1] };
    }
    public void Terminate() {
        if (!Running()) return;
        if (!TerminateProcess(child.process, 1)) Require(!Running());
    }
    public void StopAndWait() {
        if (HasChild && Running()) {
            Terminate(); Require(WaitForSingleObject(child.process, 5000) == 0);
        }
    }
    public void Drain() {
        Require(outputTask != null && errorTask != null);
        Require(Task.WaitAll(new Task[] { outputTask, errorTask }, 10000));
        hostOutput.Flush(); hostError.Flush();
        // stdin EOF is independent of child lifetime; never interpret it as parent loss.
        if (inputTask.IsCompleted && inputTask.IsFaulted) {
            var observed = inputTask.Exception;
            // Broken pipe after a child exit is normal. Other input faults while alive fail closed.
            if (Running()) throw new InvalidOperationException("Input transport failed");
        }
    }
    public bool InputFaultedWhileRunning() {
        return inputTask != null && inputTask.IsFaulted && Running();
    }
    public sealed class PublishFailure {
        public string Operation { get; private set; }
        public string Kind { get; private set; }
        public int? NativeCode { get; private set; }
        public PublishFailure(string operation, string kind, int? nativeCode) {
            Operation = operation; Kind = kind; NativeCode = nativeCode;
        }
    }
    public static PublishFailure LastPublishFailure { get; private set; }
    public static void ResetPublishFailure() { LastPublishFailure = null; }
    public static int? AllowedNativeCode(int code) {
        switch (code) {
            case 2: case 3: case 5: case 6: case 8: case 14: case 17: case 19: case 21:
            case 32: case 33: case 80: case 87: case 112: case 123: case 145: case 183:
            case 206: case 995: return code;
            default: return null;
        }
    }
    public static PublishFailure WriteFailure(Exception exception) {
        string kind = exception is IOException ? "io" :
            exception is UnauthorizedAccessException ? "access" :
            exception is System.Security.SecurityException ? "security" :
            exception is ArgumentException ? "argument" :
            exception is NotSupportedException ? "unsupported" : "unknown";
        uint hresult = unchecked((uint)exception.HResult);
        int? nativeCode = kind != "unknown" && (hresult & 0xFFFF0000u) == 0x80070000u ?
            AllowedNativeCode((int)(hresult & 0xFFFFu)) : null;
        return new PublishFailure("write", kind, nativeCode);
    }
    public static void AtomicJson(string directory, string name, string json) {
        ResetPublishFailure();
        string destination;
        try {
            destination = Path.Combine(directory, name);
            File.WriteAllText(destination + ".tmp", json, new UTF8Encoding(false));
        } catch (Exception exception) {
            LastPublishFailure = WriteFailure(exception);
            throw;
        }
        bool moved = MoveFileEx(destination + ".tmp", destination, 1 | 8);
        if (!moved) {
            int nativeCode = Marshal.GetLastWin32Error();
            LastPublishFailure = new PublishFailure("replace", "win32", AllowedNativeCode(nativeCode));
        }
        Require(moved);
    }
    public void Dispose() {
        try {
            StopAndWait();
        } finally {
            if (attached) { FreeConsole(); attached = false; }
            if (child.thread != IntPtr.Zero) { CloseHandle(child.thread); child.thread = IntPtr.Zero; }
            if (child.process != IntPtr.Zero) { CloseHandle(child.process); child.process = IntPtr.Zero; }
            if (parent != IntPtr.Zero) { CloseHandle(parent); parent = IntPtr.Zero; }
            if (input != null) input.Dispose();
            if (output != null) output.Dispose();
            if (error != null) error.Dispose();
            // Do not await a blocking host-stdin read: the parent closes it on native exit.
            // These copy operations are .NET tasks, never cross-thread PowerShell callbacks.
        }
    }
}
'@
} catch { exit 1 }

$hostTransport = $null
$config = $null
$directory = $null
$failed = $false
# Mark before publishing: even a partial failure must not retry an immutable name.
$exitPublicationAttempted = $false
$completionPublicationAttempted = $false
$phase = 'configuration'
try {
    $hostTransport = New-Object SignalHost
    $config = $hostTransport.ReadConfiguration() | ConvertFrom-Json
    $directory = [IO.Path]::GetFullPath([string]$config.directory)
    if (![IO.Directory]::Exists($directory) -or
        (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
        ([string]$config.launchId -notmatch '^[0-9a-f-]{36}$')) { throw 'Invalid control ownership' }
    $startupHintAttempted = @{}
    function Write-StartupHint([string]$boundary) {
        try {
            $name = switch -Exact ($boundary) {
                'startup-check' { 'startup-startup-check.json' }
                'native-launch' { 'startup-native-launch.json' }
                'ready-publish' { 'startup-ready-publish.json' }
                default { return }
            }
            if ($startupHintAttempted.ContainsKey($boundary)) { return }
            # An observed boundary is not completion; even a partial write gets no retry.
            $startupHintAttempted[$boundary] = $true
            $stream = $null
            try {
                $json = @{ launchId = [string]$config.launchId; phase = $boundary } | ConvertTo-Json -Compress
                $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
                $stream = [IO.File]::Open((Join-Path $directory $name), [IO.FileMode]::CreateNew,
                    [IO.FileAccess]::Write, [IO.FileShare]::None)
                $stream.Write($bytes, 0, $bytes.Length)
            } finally {
                if ($null -ne $stream) { $stream.Dispose() }
            }
        } catch { }
    }
    function Publish([string]$name, $value) {
        # Serialization may fail before AtomicJson runs: never retain an earlier failure.
        [SignalHost]::ResetPublishFailure()
        [SignalHost]::AtomicJson($directory, $name, ($value | ConvertTo-Json -Compress -Depth 8))
    }
    function Cancelled {
        $file = Join-Path $directory 'cancel.json'
        if (!(Test-Path -LiteralPath $file)) { return $false }
        $cancel = [IO.File]::ReadAllText($file) | ConvertFrom-Json
        return $cancel.launchId -eq $config.launchId
    }
    $phase = 'startup-check'
    Write-StartupHint $phase
    if (Cancelled) { throw 'Startup cancelled' }
    if ($config.parentCreationTime -isnot [string]) { throw 'Invalid parent creation time' }
    $phase = 'native-launch'
    Write-StartupHint $phase
    $hostTransport.Launch([string]$config.executable, [string[]]$config.args,
        [string]$config.cwd, [uint32]$config.parentPid, [string]$config.parentCreationTime)
    $identity = @{ launchId = [string]$config.launchId; targetPid = $hostTransport.TargetPid;
        controllerPid = [SignalHost]::GetCurrentProcessId(); creationTime = $hostTransport.CreationTime }
    $phase = 'ready-publish'
    Write-StartupHint $phase
    Publish 'ready.json' $identity
    [long]$sequence = 1
    $phase = 'running-check'
    while ($hostTransport.Running()) {
        $phase = 'owner-input-check'
        if (!$hostTransport.ParentAlive() -or (Cancelled) -or $hostTransport.InputFaultedWhileRunning()) {
            throw 'Control owner unavailable'
        }
        $requestPath = Join-Path $directory ('request-{0:D10}.json' -f $sequence)
        if (Test-Path -LiteralPath $requestPath) {
            $ack = @{ launchId = $identity.launchId; targetPid = $identity.targetPid;
                creationTime = $identity.creationTime; sequence = $sequence; ok = $false }
            try {
                $phase = 'request-read'
                $request = [IO.File]::ReadAllText($requestPath) | ConvertFrom-Json
                $phase = 'request-validate'
                if ($request.launchId -ne $identity.launchId -or $request.sequence -ne $sequence -or
                    $request.targetPid -ne $identity.targetPid -or $request.creationTime -ne $identity.creationTime) {
                    throw 'Invalid request ownership'
                }
                $ack.operation = [string]$request.operation
                if ($request.operation -eq 'interrupt') {
                    $phase = 'interrupt'
                    $members = $hostTransport.Interrupt()
                    $ack.event = 'CTRL_C_EVENT'
                    $ack.consolePids = @($members)
                } elseif ($request.operation -eq 'terminate') {
                    $phase = 'terminate'
                    $hostTransport.Terminate()
                    $ack.nativeOperation = 'TerminateProcess'
                } else { throw 'Unsupported operation' }
                $ack.ok = $true
            } catch {
                $requestFailurePhase = $phase
                $phase = 'rejected-ack-publish'
                Publish ('ack-{0:D10}.json' -f $sequence) $ack
                $phase = $requestFailurePhase
                throw 'Native control request failed'
            }
            $phase = 'ack-publish'
            Publish ('ack-{0:D10}.json' -f $sequence) $ack
            $sequence++
        }
        $phase = 'poll-wait'
        Start-Sleep -Milliseconds 10
        $phase = 'running-check'
    }
    $phase = 'exit-status'
    $nativeExit = @{ launchId = $identity.launchId; targetPid = $identity.targetPid;
        creationTime = $identity.creationTime; exitCode = $hostTransport.ExitCode(); state = 'exiting' }
    $phase = 'exit-publish'
    $exitPublicationAttempted = $true
    Publish 'exit.json' $nativeExit
    $phase = 'output-drain'
    $hostTransport.Drain()
    $nativeExit.state = 'complete'
    $phase = 'complete-publish'
    $completionPublicationAttempted = $true
    Publish 'complete.json' $nativeExit
} catch {
    $failed = $true
    # Snapshot before Publish resets it; only fixed, bounded metadata crosses this boundary.
    $publishFailure = [SignalHost]::LastPublishFailure
    if ($null -ne $directory -and $null -ne $config) {
        try {
            $errorReport = @{ launchId = [string]$config.launchId; code = 'NATIVE_CONTROLLER_FAILURE'; phase = $phase }
            if ($phase -eq 'complete-publish' -and $null -ne $publishFailure) {
                $errorReport.publishFailure = @{ operation = $publishFailure.Operation; kind = $publishFailure.Kind;
                    nativeCode = $publishFailure.NativeCode }
            }
            Publish 'error.json' $errorReport
        } catch { }
    }
} finally {
    if ($null -ne $hostTransport) {
        if ($failed -and $hostTransport.HasChild) {
            try {
                $hostTransport.StopAndWait()
                if ($null -ne $hostTransport.CreationTime) {
                    $cleanupExit = @{ launchId = [string]$config.launchId; targetPid = $hostTransport.TargetPid;
                        creationTime = $hostTransport.CreationTime; exitCode = $hostTransport.ExitCode(); state = 'exiting' }
                    if (!$exitPublicationAttempted) {
                        $exitPublicationAttempted = $true
                        Publish 'exit.json' $cleanupExit
                    }
                    $hostTransport.Drain()
                    $cleanupExit.state = 'complete'
                    if (!$completionPublicationAttempted) {
                        $completionPublicationAttempted = $true
                        Publish 'complete.json' $cleanupExit
                    }
                }
            } catch { $failed = $true }
        }
        try { $hostTransport.Dispose() } catch { $failed = $true }
    }
}
if ($failed) { exit 1 }
exit 0
