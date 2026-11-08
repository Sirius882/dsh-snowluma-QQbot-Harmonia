Option Explicit
Dim fs, shell, root, gui
Set fs = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(WScript.ScriptFullName)
gui = fs.BuildPath(root, "Harmonia\scripts\alive-emotions.ps1")
If Not fs.FileExists(gui) Then
    MsgBox "Emotion editor is missing: " & gui, vbExclamation, "Harmonia"
    WScript.Quit 1
End If
shell.CurrentDirectory = root
shell.Run "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & gui & """", 0, False
