' xterm: unified double-click entry, including first-run preparation.
Option Explicit
Dim ws, fso, base, powershell, cmd, code, arg
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
powershell = ws.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
If Not fso.FileExists(base & "\launch.ps1") Then
  MsgBox "Extract the complete repository before launching xterm.", 16, "xterm"
  WScript.Quit 1
End If
cmd = """" & powershell & """ -NoLogo -NoProfile -ExecutionPolicy Bypass -File """ & base & "\launch.ps1" & """"
For Each arg In WScript.Arguments
  cmd = cmd & " """ & Replace(arg, """", """""") & """"
Next
code = ws.Run(cmd, 1, True)
If code <> 0 Then
  If ws.Environment("PROCESS")("XTERM_PROOF") = "" And ws.Environment("PROCESS")("XTERM_TEST_NO_DIALOG") <> "1" Then
    MsgBox "Startup failed (exit " & code & ")." & vbCrLf & _
      "Details: %USERPROFILE%\.xterm\logs\launcher.log" & vbCrLf & _
      "Desktop: %USERPROFILE%\.xterm\logs\desktop.log", 16, "xterm"
  End If
  WScript.Quit code
End If
