#Requires -Version 5.1
<#
.SYNOPSIS
  Installs the OmniChat server as the Windows service "OmniChat" without the Inno Setup installer.
.DESCRIPTION
  Produces the same layout as packaging\windows\omnichat.iss:
    -InstallDir  server files, runtime\node.exe, omnichat-service.exe (WinSW), omnichat-service.xml, run-service.cmd,
                 omnichat-admin.cmd (account administration)
    -DataRoot    data\, logs\, config.env (config.env is written only when it does not exist yet)
  Steps: prerequisite checks, build with packaging\build-release.mjs, stop/uninstall an existing service,
  copy files, download WinSW (pinned v2.12.0, same URL as .github\workflows\release.yml), write config.env,
  firewall rule, install and start the service, /healthz check, doctor, next steps.
  Use -DryRun to print the plan without changing anything.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\install-server.ps1 -DryRun -Yes -Port 8800
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8787,
    [switch]$AllowRegistration,
    [string]$SearxngUrl = '',
    [string]$BridgeName = '',
    [string]$BindHost = '0.0.0.0',
    [string]$InstallDir = "$env:ProgramFiles\OmniChat",
    [string]$DataRoot = "$env:ProgramData\OmniChat",
    [switch]$Yes,
    [switch]$DryRun,
    [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ServiceName = 'OmniChat'
$RuleName = 'OmniChat Server'
$WinSWVersion = 'v2.12.0'
$WinSWUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$WinSWSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'

$ScriptDir = $PSScriptRoot
$RepoRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$ServerDir = Join-Path $RepoRoot 'server'
$BuildScript = Join-Path $RepoRoot 'packaging\build-release.mjs'
$CliScript = Join-Path $RepoRoot 'cli\bin\omnichat.mjs'
$ServiceExe = Join-Path $InstallDir 'omnichat-service.exe'
$ConfigPath = Join-Path $DataRoot 'config.env'
$AllowRegBool = [bool]$AllowRegistration

function Show-Ok([string]$Text) { Write-Host "[OK]   $Text" }
function Show-Fail([string]$Text) { Write-Host "[FAIL] $Text" }
function Show-Note([string]$Text) { Write-Host "[NOTE] $Text" }

# Prints "+ <description>" and runs the action only when not in -DryRun.
function Invoke-Step {
    param([string]$Description, [scriptblock]$Action)
    Write-Host "+ $Description"
    if ($DryRun) { return }
    & $Action
}

function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments)
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "'$FilePath' exited with code $LASTEXITCODE"
    }
}

# Replaces inherited permissions on a folder tree (icacls /inheritance:r, applied recursively with /T).
# SYSTEM and Administrators get full control; Users get read only when -UsersRead is given, otherwise nothing.
# SIDs are used instead of names so this works on every Windows language:
#   S-1-5-18 = SYSTEM, S-1-5-32-544 = Administrators, S-1-5-32-545 = Users
function Set-RestrictedAcl {
    param([string]$Path, [switch]$UsersRead)
    $grants = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
    if ($UsersRead) { $grants += '*S-1-5-32-545:(OI)(CI)RX' }
    $icaclsArgs = @($Path, '/inheritance:r')
    foreach ($g in $grants) { $icaclsArgs += @('/grant:r', $g) }
    $icaclsArgs += @('/T', '/C')
    Invoke-Native 'icacls.exe' $icaclsArgs
}

try {
    if ($DryRun) { Write-Host 'DRY RUN: nothing will be changed' }
    Write-Host 'OmniChat server installer (Windows service, no Inno Setup)'
    Write-Host "Repository: $RepoRoot"
    Write-Host ''
    Write-Host 'Prerequisites'

    $Blocked = $false

    $principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Show-Ok 'running as Administrator'
    } elseif ($DryRun) {
        Show-Note 'not running as Administrator (a real run must be started from an elevated PowerShell)'
    } else {
        Show-Fail 'not running as Administrator: start PowerShell with "Run as administrator"'
        $Blocked = $true
    }

    $NodeExe = ''
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Show-Fail 'node not found on PATH (Node.js 24 or newer is required)'
        $Blocked = $true
    } else {
        $NodeExe = $nodeCmd.Source
        $nodeVersion = (& node -p 'process.versions.node').Trim()
        $nodeMajor = [int]($nodeVersion.Split('.')[0])
        if ($nodeMajor -ge 24) {
            Show-Ok "node $nodeVersion ($NodeExe)"
        } else {
            Show-Fail "node $nodeVersion is too old (Node.js 24 or newer is required)"
            $Blocked = $true
        }
    }

    foreach ($tool in @('git', 'npm')) {
        $cmd = Get-Command $tool -ErrorAction SilentlyContinue
        if ($cmd) {
            Show-Ok "$tool found ($($cmd.Source))"
        } else {
            Show-Fail "$tool not found on PATH"
            $Blocked = $true
        }
    }

    if (Test-Path (Join-Path $ServerDir 'package.json')) {
        Show-Ok "repository root $RepoRoot (server\package.json found)"
    } else {
        Show-Fail "server\package.json not found under $RepoRoot"
        $Blocked = $true
    }

    if ($Blocked -and -not $DryRun) {
        Write-Host 'Prerequisites failed. Nothing was changed.'
        exit 1
    }

    $Version = 'unknown'
    if (Test-Path (Join-Path $ServerDir 'package.json')) {
        $Version = [string]((Get-Content -Raw -Encoding UTF8 (Join-Path $ServerDir 'package.json')) | ConvertFrom-Json).version
    }

    # Interactive questions (only in a real, interactive run without -Yes)
    $interactive = (-not $DryRun) -and (-not $Yes) -and [Environment]::UserInteractive -and (-not [Console]::IsInputRedirected)
    if ($interactive) {
        Write-Host ''
        Write-Host 'Settings (press Enter to accept the default in brackets)'
        $answer = (Read-Host "Port [$Port]").Trim()
        if ($answer -ne '') {
            $n = 0
            if ((-not [int]::TryParse($answer, [ref]$n)) -or $n -lt 1 -or $n -gt 65535) {
                throw "invalid port '$answer' (must be 1-65535)"
            }
            $Port = $n
        }
        $defReg = 'n'
        if ($AllowRegBool) { $defReg = 'y' }
        $answer = (Read-Host "Allow registration of further accounts? (y/n) [$defReg]").Trim().ToLower()
        if ($answer -eq 'y') { $AllowRegBool = $true } elseif ($answer -eq 'n') { $AllowRegBool = $false }
        $answer = (Read-Host "SearXNG URL, e.g. http://localhost:8888 ('-' for none) [$SearxngUrl]").Trim()
        if ($answer -eq '-') { $SearxngUrl = '' } elseif ($answer -ne '') { $SearxngUrl = $answer }
        $answer = (Read-Host "DSH bridge name, for the printed hint only (blank for none) [$BridgeName]").Trim()
        if ($answer -ne '') { $BridgeName = $answer }
    } elseif (-not $DryRun -and -not $Yes) {
        Show-Note 'no interactive console: using the given or default settings (pass -Yes to silence this)'
    }

    if ($SearxngUrl -ne '' -and $SearxngUrl -notmatch '^https?://\S+$') {
        throw "SearxngUrl must be an http(s) URL without spaces: '$SearxngUrl'"
    }
    if ($BindHost -notmatch '^\S+$') {
        throw "BindHost must not be empty or contain spaces: '$BindHost'"
    }
    if ($BridgeName -ne '' -and $BridgeName -notmatch '^[A-Za-z0-9._-]+$') {
        throw "BridgeName may only contain letters, digits, '.', '_' and '-': '$BridgeName'"
    }

    $RegValue = '0'
    if ($AllowRegBool) { $RegValue = '1' }

    Write-Host ''
    Write-Host 'Settings'
    Write-Host "  Port          : $Port"
    Write-Host "  Bind host     : $BindHost"
    Write-Host "  Registration  : $RegValue (1 = self-registration after an admin exists)"
    Write-Host "  SearXNG URL   : $(if ($SearxngUrl -ne '') { $SearxngUrl } else { '(none)' })"
    Write-Host "  Bridge name   : $(if ($BridgeName -ne '') { $BridgeName } else { '(none)' })"
    Write-Host "  Version       : $Version"
    Write-Host "  Install dir   : $InstallDir"
    Write-Host "  Data root     : $DataRoot"
    Write-Host "  Firewall rule : $(if ($SkipFirewall) { 'skipped (-SkipFirewall)' } else { 'yes (Private profile)' })"

    # ---- 2. Build -------------------------------------------------------------
    Write-Host ''
    Write-Host 'Build'
    $TmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('omnichat-install-' + [guid]::NewGuid().ToString('N'))
    $StageDir = Join-Path $TmpRoot 'stage'
    $TmpLabel = $TmpRoot
    if ($DryRun) { $TmpLabel = '<tmpdir>' }
    $StageLabel = Join-Path $TmpLabel 'stage'

    Invoke-Step "npm ci in $ServerDir" {
        Push-Location $ServerDir
        try { Invoke-Native 'npm' @('ci') } finally { Pop-Location }
    }
    Invoke-Step "node $BuildScript --out $StageLabel --version $Version --node $NodeExe" {
        Push-Location $RepoRoot
        try {
            Invoke-Native 'node' @($BuildScript, '--out', $StageDir, '--version', $Version, '--node', $NodeExe)
        } finally { Pop-Location }
        if (-not (Test-Path (Join-Path $StageDir 'server\dist\index.js'))) {
            throw "build did not produce $StageDir\server\dist\index.js"
        }
    }

    # ---- 3. Existing service --------------------------------------------------
    Write-Host ''
    Write-Host 'Service'
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingService) {
        Invoke-Step "stop and uninstall the existing '$ServiceName' service (status: $($existingService.Status)) with omnichat-service.exe stop/uninstall (sc.exe if that file is missing)" {
            if (Test-Path $ServiceExe) {
                & $ServiceExe stop | Out-Null
                Start-Sleep -Seconds 2
                Invoke-Native $ServiceExe @('uninstall')
            } else {
                & sc.exe stop $ServiceName | Out-Null
                Start-Sleep -Seconds 2
                & sc.exe delete $ServiceName | Out-Null
            }
            $deadline = (Get-Date).AddSeconds(30)
            while ((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
                Start-Sleep -Seconds 1
            }
        }
    } else {
        Write-Host "  no existing '$ServiceName' service, nothing to stop"
    }

    # ---- 4. Copy files and WinSW ----------------------------------------------
    Invoke-Step "copy $StageLabel\server\* to $InstallDir (creates the folder)" {
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        Copy-Item -Path (Join-Path $StageDir 'server\*') -Destination $InstallDir -Recurse -Force
    }
    Invoke-Step "copy run-service.cmd, omnichat-service.xml and omnichat-admin.cmd from $ScriptDir to $InstallDir" {
        Copy-Item -Path (Join-Path $ScriptDir 'run-service.cmd') -Destination $InstallDir -Force
        Copy-Item -Path (Join-Path $ScriptDir 'omnichat-service.xml') -Destination $InstallDir -Force
        Copy-Item -Path (Join-Path $ScriptDir 'omnichat-admin.cmd') -Destination $InstallDir -Force
    }
    Invoke-Step "restrict permissions of $InstallDir (icacls): inheritance off, SYSTEM and Administrators full control, Users read only" {
        Set-RestrictedAcl -Path $InstallDir -UsersRead
    }
    if (Test-Path $ServiceExe) {
        Write-Host "  $ServiceExe already exists, skipping the WinSW download"
    } else {
        Invoke-Step "DOWNLOAD WinSW $WinSWVersion from GitHub (external download, not from this repo): $WinSWUrl -> $ServiceExe" {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            $partial = "${ServiceExe}.part"
            Invoke-WebRequest -UseBasicParsing -Uri $WinSWUrl -OutFile $partial
            $gotSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash.ToLowerInvariant()
            if ($gotSha -ne $WinSWSha256) {
                Remove-Item -Force -LiteralPath $partial -ErrorAction SilentlyContinue
                throw "WinSW checksum mismatch: expected $WinSWSha256, got $gotSha"
            }
            Move-Item -Force -Path $partial -Destination $ServiceExe
        }
    }
    Invoke-Step "remove the temporary build folder $TmpLabel" {
        Remove-Item -Recurse -Force -Path $TmpRoot
    }

    # ---- 5. Data folders and config.env ---------------------------------------
    Write-Host ''
    Write-Host 'Data and configuration'
    $ServerPort = $Port
    $cfgExists = Test-Path $ConfigPath
    if ($cfgExists) {
        Write-Host "  $ConfigPath already exists and is KEPT (not overwritten). Requested vs. existing:"
        $existing = @{}
        foreach ($raw in [System.IO.File]::ReadAllLines($ConfigPath)) {
            $line = $raw.Trim()
            if ($line -eq '' -or $line.StartsWith('#')) { continue }
            $eq = $line.IndexOf('=')
            if ($eq -gt 0) { $existing[$line.Substring(0, $eq).Trim()] = $line.Substring($eq + 1).Trim() }
        }
        $wanted = [ordered]@{ 'PORT' = [string]$Port; 'HOST' = $BindHost; 'ALLOW_REGISTRATION' = $RegValue }
        if ($SearxngUrl -ne '') { $wanted['SEARXNG_URL'] = $SearxngUrl }
        foreach ($key in $wanted.Keys) {
            $have = $existing[$key]
            if ($null -eq $have) { $have = '(unset)' }
            if ($key -eq 'ALLOW_REGISTRATION' -and $have -eq 'true') { $have = '1' }
            $want = $wanted[$key]
            if ($have -eq $want) {
                Write-Host "  [same] ${key}=$want"
            } else {
                Write-Host "  [DIFF] ${key}: config.env=$have, requested=$want"
            }
        }
        if ($existing.ContainsKey('PORT')) {
            $p = 0
            if ([int]::TryParse($existing['PORT'], [ref]$p) -and $p -ge 1 -and $p -le 65535) { $ServerPort = $p }
        }
        if ($ServerPort -ne $Port) {
            Show-Note "the service will listen on PORT=$ServerPort from config.env; the health check, firewall rule and doctor use $ServerPort"
        }
    }

    Invoke-Step "create $DataRoot, $(Join-Path $DataRoot 'data') and $(Join-Path $DataRoot 'logs')" {
        foreach ($d in @($DataRoot, (Join-Path $DataRoot 'data'), (Join-Path $DataRoot 'logs'))) {
            New-Item -ItemType Directory -Force -Path $d | Out-Null
        }
    }
    # Done before config.env is written, so the new file inherits the restricted ACL. Users get no access (config.env has secrets).
    Invoke-Step "restrict permissions of $DataRoot (icacls): inheritance off, SYSTEM and Administrators only (config.env, data, logs)" {
        Set-RestrictedAcl -Path $DataRoot
    }

    if (-not $cfgExists) {
        $cfgLines = @(
            '# OmniChat server configuration (KEY=VALUE, one per line, no quotes, # starts a comment).',
            '# Restart the "OmniChat" service after editing.',
            "PORT=$Port",
            "HOST=$BindHost",
            '# 1 = after an admin exists, anyone can register (as a regular user); 0 = no self-registration',
            "ALLOW_REGISTRATION=$RegValue"
        )
        if ($SearxngUrl -ne '') {
            $cfgLines += '# Optional SearXNG (JSON format must be enabled in its settings.yml)'
            $cfgLines += "SEARXNG_URL=$SearxngUrl"
        } else {
            $cfgLines += '# Optional SearXNG: set SEARXNG_URL here (JSON format must be enabled in its settings.yml)'
        }
        $cfgContent = ($cfgLines -join "`r`n") + "`r`n"
        Invoke-Step "write $ConfigPath (UTF-8 without BOM)" {
            [System.IO.File]::WriteAllText($ConfigPath, $cfgContent, (New-Object System.Text.UTF8Encoding($false)))
        }
        if ($DryRun) {
            Write-Host '  ----- begin config.env -----'
            foreach ($l in $cfgLines) { Write-Host "  $l" }
            Write-Host '  ----- end config.env -----'
        }
    }

    # ---- 6. Firewall ----------------------------------------------------------
    Write-Host ''
    Write-Host 'Firewall'
    if ($SkipFirewall) {
        Write-Host '  skipped (-SkipFirewall)'
    } else {
        $rule = $null
        try { $rule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue } catch { $rule = $null }
        if ($rule) {
            Write-Host "  rule '$RuleName' already exists, skipping"
        } else {
            Invoke-Step "create inbound firewall rule '$RuleName': TCP $ServerPort, Private profile only" {
                New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort $ServerPort -Profile Private -Action Allow | Out-Null
            }
        }
    }

    # ---- 7. Install, start, health check --------------------------------------
    Write-Host ''
    Write-Host 'Start'
    Invoke-Step "install the service: $ServiceExe install" {
        Invoke-Native $ServiceExe @('install')
    }
    Invoke-Step "start the service: $ServiceExe start" {
        Invoke-Native $ServiceExe @('start')
    }
    $healthUrl = "http://127.0.0.1:$ServerPort/healthz"
    if ($DryRun) {
        Write-Host "+ wait up to 30 s for $healthUrl to answer 'ok'"
    } else {
        $deadline = (Get-Date).AddSeconds(30)
        $healthy = $false
        $lastError = ''
        while ((-not $healthy) -and ((Get-Date) -lt $deadline)) {
            try {
                $resp = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 3
                if ("$($resp.Content)".Trim() -eq 'ok') { $healthy = $true }
            } catch {
                $lastError = $_.Exception.Message
            }
            if (-not $healthy) { Start-Sleep -Seconds 1 }
        }
        if ($healthy) {
            Show-Ok "server answers 'ok' at $healthUrl"
        } else {
            throw "server did not answer 'ok' at $healthUrl within 30 s ($lastError). Check $DataRoot\logs"
        }
    }

    # ---- 8. Doctor ------------------------------------------------------------
    Write-Host ''
    Write-Host 'Doctor'
    $doctorServer = "http://127.0.0.1:$ServerPort"
    $doctorData = Join-Path $DataRoot 'data'
    if (-not (Test-Path $CliScript)) {
        Show-Note "CLI not found at $CliScript, doctor skipped"
    } else {
        Invoke-Step "run doctor: node $CliScript doctor --server $doctorServer --data-dir $doctorData" {
            try {
                & node $CliScript doctor --server $doctorServer --data-dir $doctorData
                if ($LASTEXITCODE -ne 0) {
                    Show-Note "doctor exited with code $LASTEXITCODE (tolerated). Its server checks need an admin login, see below."
                }
            } catch {
                Show-Note "doctor could not run: $($_.Exception.Message) (tolerated)"
            }
        }
    }
    Write-Host '  The server part of doctor needs an admin session: create the first administrator (step 1 below),'
    Write-Host "  then run 'omnichat login' as that admin and run doctor again."

    # ---- 9. Next steps --------------------------------------------------------
    Write-Host ''
    Write-Host 'Next steps'
    Write-Host '  1. Create the first administrator (required before anyone can sign in). In an Administrator prompt:'
    Write-Host "       `"$InstallDir\omnichat-admin.cmd`" create <username>"
    Write-Host '       (the password is asked on the console; or use the OmniChat Server app, see docs/SERVER-APP.md)'
    Write-Host "  2. Open http://localhost:$ServerPort/ and log in with that account."
    if ($AllowRegBool) {
        Write-Host '  3. Other people can register (ALLOW_REGISTRATION=1); their accounts are regular users.'
    } else {
        Write-Host '  3. Self-registration is off (ALLOW_REGISTRATION=0). Change it in config.env if needed.'
    }
    Write-Host "  4. Config: $ConfigPath (restart the '$ServiceName' service after editing)."
    Write-Host "  5. Logs:   $DataRoot\logs"
    if ($BridgeName -ne '') {
        Write-Host '  6. Start the bridge on the PC that should run the DeepSeek Harness:'
        Write-Host "       cd `"$RepoRoot\bridge`""
        Write-Host '       npm install'
        Write-Host "       npm start -- --server http://<host>:$ServerPort --username <user> --cwd <dir> --name $BridgeName"
        Write-Host "  7. In the app add provider preset 'DeepSeek Harness (PC bridge)' with baseUrl = $BridgeName (see docs/DSH.md)."
    }
    Write-Host ''
    if ($DryRun) {
        Write-Host 'DRY RUN complete: nothing was changed.'
    } else {
        Write-Host 'Install complete.'
    }
    exit 0
} catch {
    Show-Fail $_.Exception.Message
    if (-not $DryRun) { Write-Host 'The install stopped part-way. Fix the problem above and run the script again.' }
    exit 1
}
