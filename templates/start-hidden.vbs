' wa-concierge — headless launcher (Windows).
' The installer copies this to the PROJECT ROOT, replaces PROJETO_AQUI with the
' absolute project path, and creates a shortcut to it in the user's Startup folder.
' Runs the server hidden with a restart loop; the port-check inside start-server.bat
' prevents duplicate instances.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & "PROJETO_AQUI\start-server.bat" & Chr(34), 0, False
