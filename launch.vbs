Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "F:\code\openclaw-desktop"
WshShell.Run "cmd /c npm run dev", 0, False
