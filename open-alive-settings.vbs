Option Explicit
Dim fs, shell, root, gui
Set fs = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(WScript.ScriptFullName)
gui = fs.BuildPath(root, "Harmonia\vendor\dsh-alive\tools\settings-alive.ps1")
If Not fs.FileExists(gui) Then
    MsgBox "dsh-alive GUI is missing: " & gui, vbExclamation, "Harmonia"
    WScript.Quit 1
End If
shell.CurrentDirectory = root
shell.Run "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & gui & """", 0, False
