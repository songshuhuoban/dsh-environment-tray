# 遮蔽关系端到端：同一个名字同时存在于 .env 与注册表
#
# 注意变量名**不能**用 DSH_ 前缀 —— 那会被禁止名单正确拒绝（第一次写这个
# 测试时就是这么失败的，而那恰恰说明禁止名单在 HTTP 层真的生效）。
#
# 自建变量名，finally 里无条件删除注册表项与 .env。
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:3180'
$token = $args[0]
$ws = 'E:\opensource-work\dsh-environment-tray'
$varName = 'ENVMGR_LAYER_TEST'
$envFile = Join-Path $ws '.env'

function PostJson($url, $obj) {
  $tmp = Join-Path $env:TEMP 'p2.json'
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 8 -Compress), [System.Text.UTF8Encoding]::new($false))
  return curl.exe -s -m 60 -b $script:cj -X POST -H 'content-type: application/json' --data-binary "@$tmp" "$base$url"
}
function GetState() {
  return (curl.exe -s -m 90 -b $script:cj "$base/api/env-manager/state") | ConvertFrom-Json
}

$cj = Join-Path $env:TEMP 'cj4.txt'
Remove-Item -Force $cj -ErrorAction SilentlyContinue
curl.exe -s -L -c $cj -b $cj -o NUL "$base/?token=$token"

& reg.exe delete 'HKCU\Environment' /v $varName /f 2>&1 | Out-Null
Remove-Item -Force $envFile -ErrorAction SilentlyContinue

$fail = 0
function Check($label, $cond, $detail) {
  if ($cond) { Write-Output "PASS  $label" }
  else { Write-Output "FAIL  $label — $detail"; $script:fail++ }
}

try {
  Write-Output '=== 1. 写注册表 + 写 .env（同名，值不同）==='
  $rw = PostJson '/api/env-manager/registry' @{ scope = 'os-user'; name = $varName; value = 'registry-value'; type = 'REG_SZ' } | ConvertFrom-Json
  Check 'registry write ok' ($rw.ok -eq $true) ($rw | ConvertTo-Json -Compress)

  $rd = PostJson '/api/env-manager/env/read' @{ layer = 'project-env'; cwd = $ws } | ConvertFrom-Json
  $ew = PostJson '/api/env-manager/env' @{
    layer = 'project-env'; cwd = $ws; expectedRevision = $rd.revision
    edits = @(@{ op = 'set'; name = $varName; value = 'dotenv-value' })
  } | ConvertFrom-Json
  Check '.env write ok' ($ew.ok -eq $true) ($ew | ConvertTo-Json -Compress)

  Write-Output ''
  Write-Output '=== 2. state 里的遮蔽关系 ==='
  $s = GetState
  $v = $s.variables | Where-Object { $_.name -eq $varName }
  Check 'variable present' ($null -ne $v) 'not found'
  if ($v) {
    Check 'layerCount is 2' ($v.layerCount -eq 2) "layerCount=$($v.layerCount)"
    Check 'marked shadowed' ($v.shadowed -eq $true) "shadowed=$($v.shadowed)"
    Check 'project-env wins over os-user' ($v.effective -eq 'project-env') "effective=$($v.effective)"
    $order = ($v.layers | ForEach-Object { $_.layer }) -join ','
    Check 'layer order follows trust order' ($order -eq 'project-env,os-user') "layers=$order"
    Check 'both values distinguishable' (
      ($v.layers[0].valueSummary.preview -eq 'dotenv-value') -and ($v.layers[1].valueSummary.preview -eq 'registry-value')
    ) "dotenv=$($v.layers[0].valueSummary.preview) registry=$($v.layers[1].valueSummary.preview)"
    Check 'project layer is writable' ($v.layers[0].writable -eq $true) "$($v.layers[0].writable)"
    Check 'os-user layer carries its registry type' ($v.layers[1].registryType -eq 'REG_SZ') "$($v.layers[1].registryType)"
    Check 'project layer carries its file path' ($v.layers[0].path -eq $envFile) "$($v.layers[0].path)"
  }

  Write-Output ''
  Write-Output '=== 3. 删掉 .env 那一层 → 生效层回落到 os-user ==='
  $rd2 = PostJson '/api/env-manager/env/read' @{ layer = 'project-env'; cwd = $ws } | ConvertFrom-Json
  PostJson '/api/env-manager/env' @{
    layer = 'project-env'; cwd = $ws; expectedRevision = $rd2.revision
    edits = @(@{ op = 'unset'; name = $varName })
  } | Out-Null
  $s2 = GetState
  $v2 = $s2.variables | Where-Object { $_.name -eq $varName }
  Check 'variable still present (registry layer remains)' ($null -ne $v2) 'not found'
  if ($v2) {
    Check 'effective falls back to os-user' ($v2.effective -eq 'os-user') "effective=$($v2.effective)"
    Check 'no longer shadowed' ($v2.shadowed -eq $false) "layerCount=$($v2.layerCount)"
  }

  Write-Output ''
  Write-Output '=== 4. 删掉注册表那一层 → 变量完全消失 ==='
  PostJson '/api/env-manager/registry' @{ scope = 'os-user'; name = $varName; unset = $true } | Out-Null
  $s3 = GetState
  $v3 = $s3.variables | Where-Object { $_.name -eq $varName }
  Check 'variable gone entirely' ($null -eq $v3) ($v3 | ConvertTo-Json -Compress)
} finally {
  Write-Output ''
  Write-Output '=== 清理 ==='
  & reg.exe delete 'HKCU\Environment' /v $varName /f 2>&1 | Out-Null
  Remove-Item -Force $envFile -ErrorAction SilentlyContinue
  $residue = (& reg.exe query 'HKCU\Environment' 2>&1 | Select-String $varName).Count
  Check 'registry clean' ($residue -eq 0) "$residue remaining"
  Check '.env removed' (-not (Test-Path $envFile)) 'still present'
}

Write-Output ''
if ($fail -eq 0) { Write-Output 'ALL PASS' } else { Write-Output "$fail FAILURE(S)" }
exit $fail
