#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Task = 'menu',
    [switch]$List,
    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

try {
    $projectRoot = Split-Path -Path $PSScriptRoot -Parent
    $runner = Join-Path -Path $projectRoot -ChildPath 'run.mjs'
    $nodeCommand = Get-Command -Name node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $runnerArguments = @()
    if ($List) {
        $runnerArguments += '--list'
    }
    elseif ($Task -ne 'menu') {
        $runnerArguments += @('--task', $Task)
    }
    if ($DryRun) { $runnerArguments += '--dry-run' }
    & $nodeCommand.Source $runner @runnerArguments
    exit $LASTEXITCODE
}
catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
