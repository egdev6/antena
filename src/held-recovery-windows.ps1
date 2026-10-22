# Windows PowerShell 5.1 / .NET Framework. No pwsh-only FileSystemAclExtensions.
param([string]$Operation, [string]$Base, [string]$Batch, [string]$Leaf)
$ErrorActionPreference = 'Stop'
$WarningPreference = 'Stop'
Set-StrictMode -Version 2.0
$locks = New-Object 'System.Collections.Generic.List[System.IDisposable]'
$success = $false
try {
    if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion -lt [version]'5.1') { throw 'platform' }
    if ($Operation -notin @('create-namespace','create-batch','create-temp','verify-directory','verify-file','inspect-namespace')) { throw 'operation' }
    if ($Operation -eq 'inspect-namespace' -and ($PSBoundParameters.ContainsKey('Batch') -or
        $PSBoundParameters.ContainsKey('Leaf') -or $args.Count -ne 0)) { throw 'inspect inputs' }
    # Independently constrain all inputs, even when invoked without the Node wrapper.
    if ($Base -notmatch '^[a-zA-Z]:\\' -or $Base.Substring(3) -match '[\x00-\x1f<>:"|?*/]' -or
        [System.IO.Path]::GetFullPath($Base) -cne $Base -or ($Base.Length -gt 3 -and $Base.EndsWith('\'))) { throw 'base' }
    foreach ($part in $Base.Substring(3).Split('\')) {
        if ($part -match '[. ]$|^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\.|$)') { throw 'component' }
    }
    if ($Batch -and $Batch -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') { throw 'batch' }
    if (($Operation -in @('create-batch','create-temp','verify-file')) -and -not $Batch) { throw 'batch' }
    if ($Operation -eq 'create-namespace' -and $Batch) { throw 'batch' }
    if (($Operation -eq 'verify-file' -and $Leaf -cnotin @('batch.json','.batch.tmp')) -or
        ($Operation -eq 'create-temp' -and $Leaf -cne '.batch.tmp') -or
        ($Operation -notin @('verify-file','create-temp') -and $Leaf)) { throw 'leaf' }

    # Win32 CreateDirectoryW supplies the descriptor at creation AND reports collisions.
    # Directory.CreateDirectory/DirectoryInfo.Create on Framework can silently reuse.
    # Handles deny sharing write/delete during THIS invocation only; not a continuous
    # filesystem snapshot or a guarantee against adversarial filesystem races.
    # No ancestor descriptor is ever modified.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class HeldNative {
    [StructLayout(LayoutKind.Sequential)] struct SA { public int Size; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateDirectoryW(string name, ref SA security);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, ref SA security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    public static bool Create(string name, byte[] descriptor) {
        var pin = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
        try {
            var sa = new SA { Size=Marshal.SizeOf(typeof(SA)), Descriptor=pin.AddrOfPinnedObject(), Inherit=0 };
            if (CreateDirectoryW(name, ref sa)) return true;
            if (Marshal.GetLastWin32Error() == 183) return false;
            throw new InvalidOperationException("create");
        } finally { pin.Free(); }
    }
    // CreateFileW: https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew
    // READ_CONTROL | FILE_READ_ATTRIBUTES (0x20080): inspection, NO payload write access.
    // FILE_SHARE_READ (1): deny writers/deletion while this handle is held.
    // CREATE_NEW (1): any existing leaf fails, never OPEN_ALWAYS/truncate/repair.
    // NORMAL | OPEN_REPARSE_POINT (0x200080): file, no final-link traversal.
    // Non-inheritable SA supplies the protected FileSecurity descriptor AT creation;
    // the pin is needed only for the syscall. SafeFileHandle is retained by PS finally.
    public static SafeFileHandle NativeCreateFile(string name, byte[] descriptor) {
        var pin = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
        try {
            var sa = new SA { Size=Marshal.SizeOf(typeof(SA)), Descriptor=pin.AddrOfPinnedObject(), Inherit=0 };
            var h = CreateFileW(name, 0x20080, 1, ref sa, 1, 0x200080, IntPtr.Zero);
            if (h.IsInvalid) { h.Dispose(); throw new InvalidOperationException("create"); }
            return h;
        } finally { pin.Free(); }
    }
    public static SafeFileHandle Lock(string name, bool directory) { return Open(name, directory, false); }
    // Only called for the fixed leaf after all base/ancestor handles are retained.
    public static SafeFileHandle InspectNamespace(string name) { return Open(name, true, true); }
    static SafeFileHandle Open(string name, bool directory, bool allowMissing) {
        var h = CreateFileW(name, 0x20080, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (h.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            h.Dispose();
            // ERROR_FILE_NOT_FOUND only. PATH_NOT_FOUND (3), ACCESS_DENIED (5),
            // sharing violations and all other errors are NOT evidence of absence.
            if (allowMissing && error == 2) return null;
            throw new InvalidOperationException("open");
        }
        Info info;
        if (!GetFileInformationByHandle(h, out info)) { h.Dispose(); throw new InvalidOperationException("open"); }
        if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory) {
            h.Dispose(); throw new InvalidOperationException("type");
        }
        return h;
    }
}
'@
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    try { $owner = $identity.User } finally { $identity.Dispose() }
    if ($null -eq $owner) { throw 'identity' }
    $sids = @(@($owner.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique)
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetOwner($owner)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($value in $sids) {
        $sid = New-Object System.Security.Principal.SecurityIdentifier($value)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $security.AddAccessRule($rule)
    }
    $descriptor = $security.GetSecurityDescriptorBinaryForm()
    function Lock-Target([string]$Target, [bool]$Directory) {
        $handle = [HeldNative]::Lock($Target, $Directory)
        $locks.Add($handle)
    }
    function Verify-Target([string]$Target, [bool]$Directory) {
        Lock-Target $Target $Directory
        if ($Directory) { $acl = [System.IO.Directory]::GetAccessControl($Target) }
        else { $acl = [System.IO.File]::GetAccessControl($Target) }
        if (-not $acl.AreAccessRulesProtected -or -not $acl.AreAccessRulesCanonical -or
            $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) { throw 'acl' }
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
        if ($null -eq $raw.DiscretionaryAcl -or $raw.DiscretionaryAcl.Count -ne $sids.Count -or $rules.Count -ne $sids.Count) { throw 'acl' }
        $inherit = 0
        if ($Directory) { $inherit = 3 }
        foreach ($ace in $raw.DiscretionaryAcl) {
            if ($ace.AceType -ne [System.Security.AccessControl.AceType]::AccessAllowed -or
                [int]$ace.AceFlags -ne $inherit -or $ace.AccessMask -ne 2032127) { throw 'ace' }
        }
        $seen = @{}
        foreach ($rule in $rules) {
            $sid = $rule.IdentityReference.Value
            if ($sid -notin $sids -or $seen.ContainsKey($sid) -or $rule.IsInherited -or
                $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
                $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
                [int]$rule.InheritanceFlags -ne $inherit -or [int]$rule.PropagationFlags -ne 0) { throw 'acl' }
            $seen[$sid] = $true
        }
    }
    # Existing local base only, every ancestor inspected read-only and held open.
    $current = $Base.Substring(0, 3)
    Lock-Target $current $true
    foreach ($part in $Base.Substring(3).Split('\')) {
        if ($part) { $current = [System.IO.Path]::Combine($current, $part); Lock-Target $current $true }
    }
    $root = [System.IO.Path]::Combine($Base, 'held-recovery')
    if ($Operation -eq 'create-namespace') { $null = [HeldNative]::Create($root, $descriptor) }
    $namespaceState = 'valid'
    if ($Operation -eq 'inspect-namespace') {
        $namespaceHandle = [HeldNative]::InspectNamespace($root)
        if ($null -eq $namespaceHandle) { $namespaceState = 'absent' }
        else { $locks.Add($namespaceHandle) }
    }
    # An existing namespace is only accepted after FULL verification, never repaired.
    if ($namespaceState -ne 'absent') { Verify-Target $root $true }
    if ($Batch) {
        $folder = [System.IO.Path]::Combine($root, $Batch)
        if ($Operation -eq 'create-batch' -and -not [HeldNative]::Create($folder, $descriptor)) { throw 'exists' }
        Verify-Target $folder $true
        if ($Operation -eq 'create-temp') {
            $fileSecurity = New-Object System.Security.AccessControl.FileSecurity
            $fileSecurity.SetOwner($owner)
            $fileSecurity.SetAccessRuleProtection($true, $false)
            foreach ($value in $sids) {
                $sid = New-Object System.Security.Principal.SecurityIdentifier($value)
                $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'None', 'None', 'Allow')
                $fileSecurity.AddAccessRule($rule)
            }
            $target = [System.IO.Path]::Combine($folder, '.batch.tmp')
            $created = [HeldNative]::NativeCreateFile($target, $fileSecurity.GetSecurityDescriptorBinaryForm())
            $locks.Add($created)
            Verify-Target $target $false
            # Empty by CREATE_NEW; no payload API, reopen-for-write, retry or cleanup.
        }
        if ($Operation -eq 'verify-file') { Verify-Target ([System.IO.Path]::Combine($folder, $Leaf)) $false }
    }
    $success = $true
} catch {
    # Deliberately discard native/PowerShell diagnostics, paths and identity data.
    $success = $false
} finally {
    for ($i = $locks.Count - 1; $i -ge 0; $i--) { $locks[$i].Dispose() }
}
if ($success) {
    if ($Operation -eq 'inspect-namespace') { [Console]::Out.WriteLine('{"version":1,"ok":true,"state":"' + $namespaceState + '"}') }
    else { [Console]::Out.WriteLine('{"version":1,"ok":true}') }
    exit 0
}
[Console]::Out.WriteLine('{"version":1,"ok":false}')
exit 1
