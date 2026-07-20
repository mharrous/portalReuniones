Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$PortalBaseUrl = "https://reuniones.camaraceuta.workers.dev"
$script:CurrentMeetingId = $null
$script:IsCollapsed = $true
$script:PortalSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession

function Set-InfinityFreeSessionCookie {
    param([string] $Html)

    try {
        $matches = [regex]::Matches($Html, 'toNumbers\("([a-f0-9]+)"\)')
        if ($matches.Count -lt 3) {
            return $false
        }

        $keyHex = $matches[0].Groups[1].Value
        $ivHex = $matches[1].Groups[1].Value
        $cipherHex = $matches[2].Groups[1].Value
        $aesScript = (Invoke-WebRequest -Uri "$PortalBaseUrl/aes.js" -UseBasicParsing -TimeoutSec 8).Content
        $tempScript = Join-Path $env:TEMP ("infy-cookie-" + [guid]::NewGuid().ToString("N") + ".js")

        $challengeScript = @"
$aesScript
function toNumbers(d){var e=[];d.replace(/(..)/g,function(d){e.push(parseInt(d,16))});return e}
function toHex(){for(var d=[],d=1==arguments.length&&arguments[0].constructor==Array?arguments[0]:arguments,e="",f=0;f<d.length;f++)e+=(16>d[f]?"0":"")+d[f].toString(16);return e.toLowerCase()}
var a=toNumbers("$keyHex"),b=toNumbers("$ivHex"),c=toNumbers("$cipherHex");
WScript.Echo(toHex(slowAES.decrypt(c,2,a,b)));
"@

        Set-Content -Path $tempScript -Value $challengeScript -Encoding ASCII
        $cookieValue = (& cscript.exe //Nologo $tempScript).Trim()
        Remove-Item -Path $tempScript -Force -ErrorAction SilentlyContinue

        if ([string]::IsNullOrWhiteSpace($cookieValue)) {
            return $false
        }

        $hostName = ([uri] $PortalBaseUrl).Host
        $cookie = New-Object System.Net.Cookie("__test", $cookieValue, "/", $hostName)
        $script:PortalSession.Cookies.Add($cookie)
        return $true
    } catch {
        return $false
    }
}

function Invoke-PortalJson {
    param(
        [string] $Uri,
        [string] $Method = "GET",
        [hashtable] $Body = $null
    )

    $requestParams = @{
        Uri = $Uri
        Method = $Method
        WebSession = $script:PortalSession
        UseBasicParsing = $true
        TimeoutSec = 8
    }

    if ($null -ne $Body) {
        $requestParams.Body = $Body
    }

    $response = Invoke-WebRequest @requestParams
    $content = [string] $response.Content

    if ($content -match 'slowAES\.decrypt') {
        if (-not (Set-InfinityFreeSessionCookie -Html $content)) {
            throw "No se pudo validar la proteccion de InfinityFree."
        }

        $response = Invoke-WebRequest @requestParams
        $content = [string] $response.Content
    }

    if ($content.TrimStart().StartsWith("{") -or $content.TrimStart().StartsWith("[")) {
        return $content | ConvertFrom-Json
    }

    throw "El portal no devolvio JSON."
}

function Invoke-PortalPost {
    param(
        [string] $Action,
        [string] $MeetingId
    )

    if ([string]::IsNullOrWhiteSpace($MeetingId)) {
        return
    }

    try {
        $response = Invoke-PortalJson `
            -Uri "$PortalBaseUrl/api-dock.php" `
            -Method "POST" `
            -Body @{ meeting_id = $MeetingId; action = $Action }

        if ($null -ne $response -and $response.ok -eq $false) {
            [System.Windows.Forms.MessageBox]::Show($response.message, "Portal de reuniones")
        }
    } catch {
        [System.Windows.Forms.MessageBox]::Show("No se pudo actualizar la reunion.", "Portal de reuniones")
    }
}

function Get-MeetingState {
    try {
        return Invoke-PortalJson -Uri "$PortalBaseUrl/api-dock.php?t=$(Get-Date -Format yyyyMMddHHmmss)"
    } catch {
        return $null
    }
}

function Set-WindowPosition {
    param([bool] $Collapsed)

    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

    if ($Collapsed) {
        $form.Width = 44
        $form.Height = 118
        $form.Left = $screen.Right - 38
        $form.Top = [Math]::Max(120, [int](($screen.Height - $form.Height) / 2))
        $panel.Visible = $false
        $tabButton.Text = "<"
        $tabButton.Width = 44
        $tabButton.Height = 118
        $tabButton.Left = 0
        $tabButton.Top = 0
        $tabButton.Visible = $true
    } else {
        $form.Width = 360
        $form.Height = 330
        $form.Left = $screen.Right - $form.Width - 18
        $form.Top = $screen.Bottom - $form.Height - 18
        $tabButton.Text = ">"
        $tabButton.Width = 38
        $tabButton.Height = 72
        $tabButton.Left = 0
        $tabButton.Top = 120
        $tabButton.Visible = $true
        $panel.Left = 38
        $panel.Top = 0
        $panel.Width = 322
        $panel.Height = 330
        $panel.Visible = $true
    }
}

function Refresh-Meeting {
    $state = Get-MeetingState

    if ($null -eq $state -or -not $state.has_meeting) {
        $script:CurrentMeetingId = $null
        $titleLabel.Text = "Sala disponible"
        $statusLabel.Text = "Sin reunion activa"
        $metaLabel.Text = "El panel se actualiza automaticamente."
        $finishButton.Enabled = $false
        $extendButton.Enabled = $false
        return
    }

    $previousMeetingId = $script:CurrentMeetingId
    $script:CurrentMeetingId = $state.id
    $titleLabel.Text = $state.title
    $statusLabel.Text = "$($state.status) - $($state.platform)"
    $metaLabel.Text = "$($state.date)`r`n$($state.time_range) - $($state.duration) min"
    $finishButton.Enabled = $true
    $extendButton.Enabled = $true

    if ($previousMeetingId -ne $script:CurrentMeetingId) {
        $script:IsCollapsed = $false
        Set-WindowPosition -Collapsed $false
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Control de reunion"
$form.FormBorderStyle = "None"
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(223, 35, 50)
$form.StartPosition = "Manual"

$tabButton = New-Object System.Windows.Forms.Button
$tabButton.FlatStyle = "Flat"
$tabButton.FlatAppearance.BorderSize = 0
$tabButton.BackColor = [System.Drawing.Color]::FromArgb(223, 35, 50)
$tabButton.ForeColor = [System.Drawing.Color]::White
$tabButton.Font = New-Object System.Drawing.Font("Segoe UI", 22, [System.Drawing.FontStyle]::Bold)
$tabButton.Cursor = [System.Windows.Forms.Cursors]::Hand
$tabButton.Add_Click({
    $script:IsCollapsed = -not $script:IsCollapsed
    Set-WindowPosition -Collapsed $script:IsCollapsed
})
$form.Controls.Add($tabButton)

$panel = New-Object System.Windows.Forms.Panel
$panel.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($panel)

$headerLabel = New-Object System.Windows.Forms.Label
$headerLabel.Text = "CONTROL DE SALA"
$headerLabel.ForeColor = [System.Drawing.Color]::FromArgb(223, 35, 50)
$headerLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$headerLabel.Left = 22
$headerLabel.Top = 24
$headerLabel.Width = 250
$panel.Controls.Add($headerLabel)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = "x"
$closeButton.FlatStyle = "Flat"
$closeButton.FlatAppearance.BorderSize = 0
$closeButton.BackColor = [System.Drawing.Color]::White
$closeButton.ForeColor = [System.Drawing.Color]::FromArgb(90, 90, 90)
$closeButton.Font = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$closeButton.Left = 270
$closeButton.Top = 10
$closeButton.Width = 38
$closeButton.Height = 38
$closeButton.Add_Click({ $form.Close() })
$panel.Controls.Add($closeButton)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = "Cargando..."
$titleLabel.ForeColor = [System.Drawing.Color]::FromArgb(20, 25, 34)
$titleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$titleLabel.Left = 22
$titleLabel.Top = 56
$titleLabel.Width = 270
$titleLabel.Height = 58
$panel.Controls.Add($titleLabel)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = ""
$statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(18, 60, 104)
$statusLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$statusLabel.Left = 22
$statusLabel.Top = 120
$statusLabel.Width = 270
$statusLabel.Height = 24
$panel.Controls.Add($statusLabel)

$metaLabel = New-Object System.Windows.Forms.Label
$metaLabel.Text = ""
$metaLabel.ForeColor = [System.Drawing.Color]::FromArgb(102, 112, 133)
$metaLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$metaLabel.Left = 22
$metaLabel.Top = 150
$metaLabel.Width = 270
$metaLabel.Height = 48
$panel.Controls.Add($metaLabel)

$finishButton = New-Object System.Windows.Forms.Button
$finishButton.Text = "Finalizar reunion"
$finishButton.BackColor = [System.Drawing.Color]::FromArgb(223, 35, 50)
$finishButton.ForeColor = [System.Drawing.Color]::White
$finishButton.FlatStyle = "Flat"
$finishButton.FlatAppearance.BorderSize = 0
$finishButton.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$finishButton.Left = 22
$finishButton.Top = 212
$finishButton.Width = 270
$finishButton.Height = 44
$finishButton.Add_Click({
    Invoke-PortalPost -Action "finish" -MeetingId $script:CurrentMeetingId
    Start-Sleep -Milliseconds 300
    Refresh-Meeting
})
$panel.Controls.Add($finishButton)

$extendButton = New-Object System.Windows.Forms.Button
$extendButton.Text = "Extender 15 min"
$extendButton.BackColor = [System.Drawing.Color]::White
$extendButton.ForeColor = [System.Drawing.Color]::FromArgb(18, 60, 104)
$extendButton.FlatStyle = "Flat"
$extendButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(216, 224, 234)
$extendButton.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$extendButton.Left = 22
$extendButton.Top = 266
$extendButton.Width = 270
$extendButton.Height = 40
$extendButton.Add_Click({
    Invoke-PortalPost -Action "extend" -MeetingId $script:CurrentMeetingId
    Start-Sleep -Milliseconds 300
    Refresh-Meeting
})
$panel.Controls.Add($extendButton)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Refresh-Meeting })
$timer.Start()

Set-WindowPosition -Collapsed $true
Refresh-Meeting
[void] $form.ShowDialog()

