<#
.SYNOPSIS
    Install Thursday on Windows.

.DESCRIPTION
    One command, from a normal PowerShell window - no administrator rights,
    no Visual Studio, no WSL:

        irm https://raw.githubusercontent.com/newearth18-wq/Thursday/claude/jarvis-assistant-mhfwe6/install.ps1 | iex

    and, once that branch is merged, the shorter

        irm https://raw.githubusercontent.com/newearth18-wq/Thursday/main/install.ps1 | iex

    Either way it works out for itself which branch of the repository holds
    the code, so there is nothing to pass and nothing to know. -Branch is
    there for anyone who wants a particular one.

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
    # Which branch to install from. Left empty it works this out itself, so
    # nobody has to know or care which branch the code is currently on.
    [string] $Branch = "",
    # Install the voice extras too. Off by default: they pull in torch.
    [switch] $WithVoice,
    # Run it when the install finishes.
    [switch] $Start
)

$ErrorActionPreference = "Stop"
$Owner = "newearth18-wq"
$Name = "Thursday"
$Repo = "https://github.com/$Owner/$Name"

# Where the code lives once it has been merged. Tried first, so this file
# needs no maintenance after that happens.
$MainBranch = "main"

# And where it lives before then. A one-line install should not require the
# person running it to know which branch a change is sitting on.
$WorkBranch = "claude/jarvis-assistant-mhfwe6"

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

# The newest Python is often the wrong one. Wheels for the heavier
# dependencies - playwright, pypdf, the uvicorn extras - lag a new release by
# months, and without a wheel pip builds from source, which needs the C++
# compiler this script exists to avoid. So: prefer the newest Python that is
# not newer than this, and fall back to whatever is there with a warning.
$KnownGood = [version]"3.13"
$Oldest = [version]"3.10"

function Get-PythonCandidates {
    $found = @()

    # The launcher knows about every install, including ones not on PATH -
    # which is the usual reason "python" fails on a box that definitely has
    # Python. -0p lists them all with their paths.
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($line in (& py -0p 2>$null)) {
            # " -V:3.12 *        C:\Python312\python.exe", and the older
            # " -3.12-64          C:\Python312\python.exe".
            if ($line -match "(\d+\.\d+).*?([A-Za-z]:\\.*python\.exe)") {
                $found += @{ version = [version]$Matches[1]; exe = $Matches[2].Trim() }
            }
        }
    }

    # And whatever plain `python` resolves to, in case the launcher is absent.
    if (Get-Command python -ErrorAction SilentlyContinue) {
        try {
            $exe = & python -c "import sys; print(sys.executable)" 2>$null
            $raw = & python -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
            if ($exe -and $raw) { $found += @{ version = [version]$raw; exe = $exe.Trim() } }
        } catch { }
    }

    # The Microsoft Store ships a stub that prints nothing and opens the Store
    # when you run it. It is not Python.
    $found | Where-Object {
        $_.exe -and ($_.exe -notmatch "WindowsApps") -and ($_.version -ge $Oldest)
    }
}

function Find-Python {
    $all = @(Get-PythonCandidates)
    if (-not $all) { return $null }

    $supported = @($all | Where-Object { $_.version -le $KnownGood } |
                   Sort-Object { $_.version } -Descending)
    if ($supported) { return $supported[0] }

    # Only something newer than we have wheels for. Usable, but say so: the
    # install may stop and ask for a compiler, and that is not a mystery
    # anyone should have to solve on their own.
    $newest = @($all | Sort-Object { $_.version })[0]
    Warn ("only Python $($newest.version) was found. Some packages have no wheels for it " +
          "yet and may try to build from source.")
    Warn ("If the install fails, get Python $KnownGood from python.org and run this again.")
    return $newest
}

function Install-Python {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return $null }
    winget install --id Python.Python.3.12 --source winget `
        --accept-package-agreements --accept-source-agreements --silent
    # winget puts it on PATH for new processes, not this one.
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
    return Find-Python
}

$python = Find-Python

if ($python -and $python.version -gt $KnownGood) {
    # There is a Python, but it is ahead of the wheels. Getting a supported
    # one is a two-minute download and saves an install that stops halfway
    # asking for Visual Studio.
    Say "fetching Python 3.12 as well, so nothing has to be compiled"
    $better = Install-Python
    if ($better -and $better.version -le $KnownGood) { $python = $better }
}

if ($python) {
    Say "found Python $($python.version) at $($python.exe)" "Green"
} else {
    Warn "no Python 3.10 or newer found - installing it"
    $python = Install-Python
    if (-not $python) {
        Die "could not install Python. Get it from https://python.org/downloads and run this again."
    }
    Say "installed Python $($python.version)" "Green"
}

# ----------------------------------------------------------------- code

Step "Getting Thursday"

function Test-Branch($branch) {
    # A branch holds Thursday if it holds a pyproject.toml. Cheaper and more
    # reliable than cloning to find out, and it is the same check the install
    # would make three steps later anyway.
    if (-not $branch) { return $false }
    $url = "https://raw.githubusercontent.com/$Owner/$Name/$branch/pyproject.toml"
    try {
        Invoke-WebRequest $url -Method Head -UseBasicParsing -TimeoutSec 15 | Out-Null
        return $true
    } catch { return $false }
}

function Resolve-Branch {
    # main once it is merged, the working branch until then, and if someone
    # has renamed things since, ask GitHub what branches there are.
    foreach ($candidate in @($MainBranch, $WorkBranch)) {
        if (Test-Branch $candidate) { return $candidate }
    }
    try {
        $listed = Invoke-RestMethod "https://api.github.com/repos/$Owner/$Name/branches" `
            -TimeoutSec 20
        foreach ($entry in $listed) {
            if (Test-Branch $entry.name) { return $entry.name }
        }
    } catch { }
    return $null
}

if (-not $Path) {
    # $PSScriptRoot is empty when this is piped into iex - there is no script
    # file to be beside - and Join-Path throws on an empty path rather than
    # returning one, so it has to be checked before it is used.
    $beside = if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "pyproject.toml"))) {
        $PSScriptRoot
    } else { "" }

    $Path = if ($beside) { $beside }
            elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Thursday" }
            else { Join-Path $HOME "Thursday" }
}

if (Test-Path (Join-Path $Path "pyproject.toml")) {
    # Already here - run from a clone, or a second time. Nothing to fetch,
    # and no reason to ask the network which branch to fetch it from.
    Say "using $Path" "Green"
} else {
    if (-not $Branch) {
        $Branch = Resolve-Branch
        if (-not $Branch) {
            Die ("could not find a branch of $Repo holding Thursday. Check the " +
                 "network, or pass -Branch <name> if you know which one to use.")
        }
        Say "installing from $Branch"
    }

    if (Get-Command git -ErrorAction SilentlyContinue) {
        git clone --depth 1 --branch $Branch $Repo $Path
        Say "cloned $Branch into $Path" "Green"
    } else {
        # No git is normal on a fresh Windows machine, and installing it to
        # fetch one zip is not a reasonable ask.
        $zip = Join-Path $env:TEMP "thursday.zip"
        try {
            Invoke-WebRequest "$Repo/archive/refs/heads/$Branch.zip" -OutFile $zip
        } catch {
            Die "could not download branch '$Branch' from $Repo."
        }
        Expand-Archive $zip -DestinationPath $env:TEMP -Force
        # GitHub names the folder after the branch with every / turned into a
        # -, so a branch like feature/thing unpacks as Repo-feature-thing.
        $unpacked = Join-Path $env:TEMP ("Thursday-" + ($Branch -replace "/", "-"))
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
        Copy-Item (Join-Path $unpacked "*") $Path -Recurse -Force
        Remove-Item $zip -Force
        Say "downloaded $Branch into $Path" "Green"
    }
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
