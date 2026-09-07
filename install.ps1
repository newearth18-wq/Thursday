<#
.SYNOPSIS
    Install Thursday on Windows.

.DESCRIPTION
    One command, from a normal PowerShell window - no administrator rights,
    no Visual Studio, no WSL:

        irm https://raw.githubusercontent.com/newearth18-wq/Thursday/main/install.ps1 | iex

    From a branch that has not been merged yet, both halves need the branch -
    the URL to fetch this script, and -Branch to tell it what to install:

        & ([scriptblock]::Create((irm https://raw.githubusercontent.com/newearth18-wq/Thursday/BRANCH/install.ps1))) -Branch BRANCH

    Or, from a clone:

        .\install.ps1

    It installs Python if it is missing, makes a virtual environment beside
    the code, installs Thursday with the extras that actually work on
    Windows, writes a .env, and puts a shortcut on the Start menu.

    What it deliberately does not do: install anything that needs a C++
    compiler. Face recognition needs dlib, which needs Visual Studio Build
    Tools - several gigabytes, for a feature this script would then have to
    explain. It is one line to add later, and the script says so at the end.
#>

[CmdletBinding()]
param(
    # Where to put it. Defaults beside this script when run from a clone.
    [string] $Path = "",
    # Which branch to install from. Only worth changing before a change has
    # been merged - see the README.
    [string] $Branch = "main",
    # Install the voice extras too. Off by default: they pull in torch.
    [switch] $WithVoice,
    # Run it when the install finishes.
    [switch] $Start
)

$ErrorActionPreference = "Stop"
$Repo = "https://github.com/newearth18-wq/Thursday"

function Say($text, $colour = "Cyan") { Write-Host "  $text" -ForegroundColor $colour }
function Step($text) { Write-Host "`n$text" -ForegroundColor White }
function Warn($text) { Write-Host "  ! $text" -ForegroundColor Yellow }
function Die($text) { Write-Host "`n  x $text" -ForegroundColor Red; exit 1 }

Write-Host @"

   THURSDAY
   a personal assistant, on this machine

"@ -ForegroundColor Cyan

# --------------------------------------------------------------- python

Step "Looking for Python"

function Find-Python {
    # The launcher first: it knows about every install, including ones not on
    # PATH, which is the usual reason "python" fails on a Windows box that
    # definitely has Python.
    foreach ($candidate in @(
        @{ exe = "py";     args = @("-3", "-c", "import sys; print(sys.executable)") },
        @{ exe = "python"; args = @("-c", "import sys; print(sys.executable)") }
    )) {
        if (-not (Get-Command $candidate.exe -ErrorAction SilentlyContinue)) { continue }
        try {
            $found = & $candidate.exe @($candidate.args) 2>$null
        } catch { continue }
        # The Microsoft Store ships a stub that prints nothing and opens the
        # Store when you run it. It is not Python.
        if (-not $found -or $found -match "WindowsApps") { continue }
        $version = & $found -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($version -and [version]$version -ge [version]"3.10") {
            return @{ exe = $found; version = $version }
        }
    }
    return $null
}

$python = Find-Python
if ($python) {
    Say "found Python $($python.version) at $($python.exe)" "Green"
} else {
    Warn "no Python 3.10 or newer found - installing it"
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id Python.Python.3.12 --source winget `
            --accept-package-agreements --accept-source-agreements --silent
        # winget puts it on PATH for new processes, not this one.
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                    [Environment]::GetEnvironmentVariable("Path", "User")
        $python = Find-Python
    }
    if (-not $python) {
        Die "could not install Python. Get it from https://python.org/downloads and run this again."
    }
    Say "installed Python $($python.version)" "Green"
}

# ----------------------------------------------------------------- code

Step "Getting Thursday"

if (-not $Path) {
    $Path = if (Test-Path (Join-Path $PSScriptRoot "pyproject.toml")) { $PSScriptRoot }
            else { Join-Path $env:LOCALAPPDATA "Thursday" }
}

if (Test-Path (Join-Path $Path "pyproject.toml")) {
    Say "using $Path" "Green"
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
    git clone --depth 1 --branch $Branch $Repo $Path
    Say "cloned $Branch into $Path" "Green"
} else {
    # No git is normal on a fresh Windows machine, and installing it to fetch
    # one zip is not a reasonable ask.
    $zip = Join-Path $env:TEMP "thursday.zip"
    try {
        Invoke-WebRequest "$Repo/archive/refs/heads/$Branch.zip" -OutFile $zip
    } catch {
        Die "could not download branch '$Branch' from $Repo. Check the name and try again."
    }
    Expand-Archive $zip -DestinationPath $env:TEMP -Force
    # GitHub names the folder after the branch with every / turned into a -,
    # so a branch like feature/thing unpacks as Repo-feature-thing.
    $unpacked = Join-Path $env:TEMP ("Thursday-" + ($Branch -replace "/", "-"))
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    Copy-Item (Join-Path $unpacked "*") $Path -Recurse -Force
    Remove-Item $zip -Force
    Say "downloaded $Branch into $Path" "Green"
}

Set-Location $Path

# Checked rather than assumed: a branch that exists but holds no code clones
# perfectly happily, and the first sign would otherwise be a confusing pip
# error several steps later.
if (-not (Test-Path (Join-Path $Path "pyproject.toml"))) {
    Die ("no pyproject.toml in $Path - branch '$Branch' does not contain Thursday. " +
         "If the code is still on a feature branch, pass -Branch <name>.")
}

# ------------------------------------------------------------- the venv

Step "Setting up"

$venv = Join-Path $Path ".venv"
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
    & $python.exe -m venv $venv
}
$vpython = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $vpython)) { Die "the virtual environment did not come out right" }

& $vpython -m pip install --upgrade pip --quiet

# web: the UI. documents: PDF and Word. browser: Playwright.
# Not identity (dlib needs a C++ compiler) and not voice unless asked
# (torch is ~2 GB and most people use the browser's own speech).
$extras = "web,documents,browser"
if ($WithVoice) { $extras += ",voice" }

Say "installing thursday[$extras] - this takes a few minutes"
& $vpython -m pip install -e ".[$extras]" --quiet
if ($LASTEXITCODE -ne 0) { Die "the install failed. Run it again without --quiet to see why." }
Say "installed" "Green"

if (-not $WithVoice) {
    & $vpython -m playwright install chromium 2>&1 | Out-Null
}

# ------------------------------------------------------------------ .env

Step "Configuring"

$envFile = Join-Path $Path ".env"
if (Test-Path $envFile) {
    Say "keeping the .env that is already there" "Green"
} else {
    Copy-Item (Join-Path $Path ".env.example") $envFile
    Write-Host ""
    Write-Host "  Paste your Anthropic API key (from console.anthropic.com)," -ForegroundColor White
    Write-Host "  or press Enter to skip and use a local model instead." -ForegroundColor DarkGray
    $key = Read-Host "  key"
    if ($key) {
        # Appended rather than edited in place: the example file is comments
        # and defaults, and the last assignment wins.
        Add-Content $envFile "`nANTHROPIC_API_KEY=$key"
        Say "saved to .env" "Green"
    } else {
        Warn "no key set. Install Ollama and run: thursday --local"
    }

    Write-Host ""
    Write-Host "  Where is your Obsidian vault? (Enter to skip)" -ForegroundColor White
    Write-Host "  The folder with .obsidian in it - Thursday uses it as a second brain." -ForegroundColor DarkGray
    $vault = Read-Host "  path"
    if ($vault -and (Test-Path $vault)) {
        Add-Content $envFile "THURSDAY_VAULT=$vault"
        Say "vault set" "Green"
    } elseif ($vault) {
        Warn "$vault is not a folder - set THURSDAY_VAULT in .env later"
    }
}

# ------------------------------------------------------------- shortcuts

Step "Adding shortcuts"

$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$shell = New-Object -ComObject WScript.Shell

$link = $shell.CreateShortcut((Join-Path $startMenu "Thursday.lnk"))
$link.TargetPath = Join-Path $venv "Scripts\pythonw.exe"
$link.Arguments = "-m thursday serve"
$link.WorkingDirectory = $Path
$link.Description = "Thursday, a personal assistant"
$link.Save()

$terminal = $shell.CreateShortcut((Join-Path $startMenu "Thursday (terminal).lnk"))
$terminal.TargetPath = Join-Path $venv "Scripts\thursday.exe"
$terminal.WorkingDirectory = $Path
$terminal.Save()

Say "on the Start menu" "Green"

# ------------------------------------------------------------------ done

Write-Host @"

  Ready.

    Start menu    Thursday                the web UI at http://127.0.0.1:8765
                  Thursday (terminal)     chat in a console window

    From here     .\.venv\Scripts\thursday              terminal
                  .\.venv\Scripts\thursday serve        web UI
                  .\.venv\Scripts\thursday pair         put it on your phone
                  .\.venv\Scripts\thursday service --apply    start it at logon

"@ -ForegroundColor White

if (-not $WithVoice) {
    Write-Host "  Voice in and out needs one more step:" -ForegroundColor DarkGray
    Write-Host "    .\.venv\Scripts\pip install -e "".[voice]""" -ForegroundColor DarkGray
    Write-Host "  Face recognition needs a C++ compiler, so it is left out:" -ForegroundColor DarkGray
    Write-Host "    winget install Microsoft.VisualStudio.2022.BuildTools" -ForegroundColor DarkGray
    Write-Host "    .\.venv\Scripts\pip install -e "".[identity]""" -ForegroundColor DarkGray
    Write-Host ""
}

if ($Start) {
    Say "starting the web UI" "Green"
    Start-Process (Join-Path $venv "Scripts\thursday.exe") -ArgumentList "serve" -WorkingDirectory $Path
    Start-Sleep -Seconds 3
    Start-Process "http://127.0.0.1:8765"
}
