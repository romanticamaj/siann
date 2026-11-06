# The top-level windows of one process, as "<hwnd> <owner hwnd> <visible>" lines.
# Electron has no view of another process's windows, and the point of the test is
# what Windows itself says about them.
param([Parameter(Mandatory = $true)][uint32]$ProcessId)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class OwnedWindows {
    delegate bool EnumProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    const uint GW_OWNER = 4;

    public static List<string> Of(uint process) {
        var lines = new List<string>();
        EnumWindows((window, parameter) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner == process) {
                lines.Add(window.ToInt64() + " " + GetWindow(window, GW_OWNER).ToInt64() + " " + IsWindowVisible(window));
            }
            return true;
        }, IntPtr.Zero);
        return lines;
    }
}
'@

[OwnedWindows]::Of($ProcessId) | ForEach-Object { Write-Output $_ }
