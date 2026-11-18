# Giu cua so Chrome kiosk (profile HoaLoKiosk) luon tren cung.
$mutex = New-Object System.Threading.Mutex($false, 'Global\HoaLoKioskTop')
if (-not $mutex.WaitOne(0)) { exit 0 }

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class HoaLoTop {
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    static EnumProc _cb;
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    public static void Pin(int[] pids) {
        var set = new HashSet<int>(pids);
        _cb = delegate (IntPtr h, IntPtr l) {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (set.Contains((int)pid) && IsWindowVisible(h))
                SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 3);
            return true;
        };
        EnumWindows(_cb, IntPtr.Zero);
    }
}
"@

while ($true) {
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'")
        $set = New-Object 'System.Collections.Generic.HashSet[int]'
        foreach ($p in $procs) {
            if ($p.CommandLine -and $p.CommandLine.Contains('HoaLoKiosk')) {
                [void]$set.Add([int]$p.ProcessId)
            }
        }
        for ($i = 0; $i -lt 6; $i++) {
            foreach ($p in $procs) {
                if ($set.Contains([int]$p.ParentProcessId)) {
                    [void]$set.Add([int]$p.ProcessId)
                }
            }
        }
        if ($set.Count -gt 0) {
            $ids = New-Object int[] $set.Count
            $set.CopyTo($ids)
            [HoaLoTop]::Pin($ids)
        }
    } catch {
    }
    Start-Sleep -Seconds 1
}
