$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '../src-tauri/resources/zapret/soundcloud-bypass.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $sourcePath), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'The bypass helper does not parse.' }
foreach ($name in @('Get-SoundCloudIps', 'Get-SoundCloudFilter')) {
  $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }.GetNewClosure(), $true)
  Invoke-Expression $function.Extent.Text
}
# Execute only extracted pure scope functions, never the elevated runner.
$script:resolvedHosts = @()
function Get-PlaybackIssue { return @{ probeUrl = 'https://regional-media.sndcdn.com/audio?token=test' } }
function Resolve-DnsName {
  param($Name, $Type, $ErrorAction)
  if ($Type -ne 'A_AAAA') { throw 'Both address families must be resolved.' }
  $script:resolvedHosts += $Name
  return @([pscustomobject]@{ Type = 'A'; IPAddress = '203.0.113.8' }, [pscustomobject]@{ Type = 'AAAA'; IPAddress = '2001:db8::8' }, [pscustomobject]@{ Type = 'A'; IPAddress = 'invalid-address' })
}
$ips = @(Get-SoundCloudIps)
if ($ips.Count -ne 2 -or $ips -notcontains '203.0.113.8' -or $ips -notcontains '2001:db8::8') { throw 'DNS scope lost an address family or accepted malformed input.' }
if ($script:resolvedHosts -notcontains 'regional-media.sndcdn.com') { throw 'The actual playback server is missing from DNS scope.' }
if ($script:resolvedHosts[0] -ne 'regional-media.sndcdn.com') { throw 'The actual playback server must precede the bounded common-host scope.' }
$filter = Get-SoundCloudFilter $ips
foreach ($term in @('ip.DstAddr==203.0.113.8', 'ip.SrcAddr==203.0.113.8', 'ipv6.DstAddr==2001:db8::8', 'ipv6.SrcAddr==2001:db8::8', 'tcp.DstPort==443', '!impostor', '!loopback')) {
  if (-not $filter.Contains($term)) { throw "Missing filter term: $term" }
}
if ($filter.Length -gt 16000) { throw 'The filter exceeds the WinDivert argument bound.' }
Write-Output 'PASS: helper syntax, dual-stack DNS, actual audio host, scoped inbound/outbound filter.'
