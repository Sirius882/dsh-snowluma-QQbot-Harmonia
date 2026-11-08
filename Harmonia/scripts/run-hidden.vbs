Option Explicit
Dim shell, command, i
If WScript.Arguments.Count = 0 Then WScript.Quit 2
command = ""
For i = 0 To WScript.Arguments.Count - 1
    If i > 0 Then command = command & " "
    command = command & Chr(34) & WScript.Arguments(i) & Chr(34)
Next
Set shell = CreateObject("WScript.Shell")
WScript.Quit shell.Run(command, 0, True)
