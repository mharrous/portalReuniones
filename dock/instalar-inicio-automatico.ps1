$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "Dock reunion sala.lnk"
$targetPath = Join-Path $PSScriptRoot "iniciar-dock-reunion.bat"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Description = "Dock flotante del portal de reuniones"
$shortcut.Save()

New-Item -Path "HKCU:\Software\Classes\meetingdock" -Force | Out-Null
Set-Item -Path "HKCU:\Software\Classes\meetingdock" -Value "URL:Meeting Dock Protocol"
New-ItemProperty -Path "HKCU:\Software\Classes\meetingdock" -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
New-Item -Path "HKCU:\Software\Classes\meetingdock\shell\open\command" -Force | Out-Null
Set-Item -Path "HKCU:\Software\Classes\meetingdock\shell\open\command" -Value "`"$targetPath`""

Write-Host "Dock configurado para arrancar con Windows:"
Write-Host $shortcutPath
Write-Host "Protocolo meetingdock:// registrado."
