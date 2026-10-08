' xterm entry point. Paths come from this file's folder, never a fixed install dir.
Option Explicit

Dim ws, fso, base, nodeExe, launchJs, ps1, cmd, exitCode
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
launchJs = base & "\scripts\launch.js"
ps1 = base & "\launch.ps1"
nodeExe = FindNode(ws, fso)

If nodeExe <> "" And fso.FileExists(launchJs) Then
  cmd = """" & nodeExe & """ """ & launchJs & """"
ElseIf fso.FileExists(ps1) Then
  cmd = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
Else
  MsgBox "Cannot start xterm." & vbCrLf & vbCrLf & _
    "Node.js was not found, and launch.ps1 is missing next to launcher.vbs:" & vbCrLf & ps1, 16, "xterm"
  WScript.Quit 1
End If

exitCode = ws.Run(cmd, 0, True)
If exitCode <> 0 Then
  MsgBox "Startup failed (exit " & exitCode & ")." & vbCrLf & vbCrLf & TailLog(ws, fso), 16, "xterm"
  WScript.Quit exitCode
End If

Function FindNode(ws, fso)
  Dim tmp, ts, line, candidates, i
  FindNode = ""
  tmp = ws.ExpandEnvironmentStrings("%TEMP%") & "\xterm-node-which.txt"
  On Error Resume Next
  fso.DeleteFile tmp, True
  On Error GoTo 0
  ws.Run "cmd.exe /d /c where.exe node > """ & tmp & """ 2>nul", 0, True
  If fso.FileExists(tmp) Then
    On Error Resume Next
    Set ts = fso.OpenTextFile(tmp, 1, False)
    If Err.Number = 0 Then
      Do While Not ts.AtEndOfStream
        line = Trim(ts.ReadLine)
        If line <> "" Then
          If fso.FileExists(line) Then
            FindNode = line
            Exit Do
          End If
        End If
      Loop
      ts.Close
    End If
    Err.Clear
    fso.DeleteFile tmp, True
    On Error GoTo 0
  End If
  If FindNode <> "" Then Exit Function
  candidates = Array( _
    ws.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
    ws.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
    ws.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), _
    ws.ExpandEnvironmentStrings("%LOCALAPPDATA%\hermes\node\node.exe"))
  For i = 0 To UBound(candidates)
    If fso.FileExists(candidates(i)) Then
      FindNode = candidates(i)
      Exit Function
    End If
  Next
End Function

Function TailLog(ws, fso)
  Dim logFile, ts, text
  logFile = ws.ExpandEnvironmentStrings("%USERPROFILE%\.sshterm\logs\launcher.log")
  TailLog = "Log:" & vbCrLf & logFile
  If Not fso.FileExists(logFile) Then Exit Function
  On Error Resume Next
  Set ts = fso.OpenTextFile(logFile, 1, False)
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  text = ts.ReadAll
  ts.Close
  On Error GoTo 0
  If Len(text) > 700 Then text = Right(text, 700)
  TailLog = TailLog & vbCrLf & vbCrLf & text
End Function
