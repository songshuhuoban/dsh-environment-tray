# 重启后探针：检测旧进程是否已退出、新进程是否起来了、插件是否活着。
#
# 为什么需要单独的脚本：3080 的 server 与 agent 会话运行时是**同一个进程**，
# 所以重启会终止对话所在的会话。这个脚本只依赖 HTTP（外加一个免鉴权的探针
# 实例），因此在新会话里能直接跑。
#
# 用法（重启并恢复会话后）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\post-restart-probe.ps1
#
# 选项：
#   -OldPid <n>        旧进程号（默认 59800），用于确认它真的退出了
#   -ProbePort 3180    同时起一个隔离实例来验证插件路由（推荐，能看到真实行为）
#   -SkipProbe         跳过探针实例

param(
  [int]$OldPid = 59800,
  [int]$ProbePort = 3180,
  [switch]$SkipProbe
)

$ErrorActionPreference = 'Continue'
$ws = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ws

$fail = 0
function Check($label, $cond, $detail) {
  if ($cond) { Write-Output "PASS  $label" }
  else { Write-Output "FAIL  $label — $detail"; $script:fail++ }
}
function Note($label, $detail) { Write-Output "      $label$(if ($detail) { ": $detail" })" }

Write-Output '=== 1. 旧进程是否已退出 ==='
$old = Get-Process -Id $OldPid -ErrorAction SilentlyContinue
Check "process $OldPid is gone" ($null -eq $old) "still running (uptime $([int]((Get-Date) - $old.StartTime).TotalMinutes)min)"

Write-Output ''
Write-Output '=== 2. 新实例是否在 3080 上监听 ==='
$listen = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
Check 'something listens on 3080' ($null -ne $listen) 'no listener'
if ($listen) {
  $newPid = $listen.OwningProcess | Select-Object -First 1
  Note 'new pid' $newPid
  $proc = Get-Process -Id $newPid -ErrorAction SilentlyContinue
  if ($proc) {
    $uptimeMin = [int]((Get-Date) - $proc.StartTime).TotalMinutes
    Note 'new uptime' "$uptimeMin min"
    Check 'the new process is genuinely fresh (< 5 min)' ($uptimeMin -lt 5) "$uptimeMin min — 看起来还是旧进程"
  }
}

Write-Output ''
Write-Output '=== 3. 静态预检（配置与加载路径）==='
& node preflight.mjs > "$env:TEMP\pf-post.txt" 2>&1
$pfExit = $LASTEXITCODE
$pf = Get-Content "$env:TEMP\pf-post.txt"
$pfPass = ($pf | Where-Object { $_ -match '^PASS' }).Count
$pfFail = ($pf | Where-Object { $_ -match '^FAIL' }).Count
Check 'preflight passes' ($pfExit -eq 0 -and $pfFail -eq 0) "exit=$pfExit fail=$pfFail pass=$pfPass"
if ($pfFail -gt 0) { ($pf | Where-Object { $_ -match '^FAIL' }) | ForEach-Object { "        $_" } }

Write-Output ''
Write-Output '=== 4. 测试套件 ==='
$total = 0; $bad = 0
foreach ($s in 'check-p0.mjs','verify-env-model.mjs','verify-env-write.mjs','verify-credentials.mjs','verify-host-api.mjs','verify-registry.mjs','verify-registry-roundtrip.mjs','verify-write-routes.mjs','audit-hostile-input.mjs') {
  & node $s > "$env:TEMP\s-post.txt" 2>&1
  $code = $LASTEXITCODE
  $l = Get-Content "$env:TEMP\s-post.txt"
  $n = ($l | Where-Object { $_ -match '^(PASS|FAIL)' }).Count
  $f = ($l | Where-Object { $_ -match '^FAIL' }).Count
  $total += $n; $bad += $f
  if ($f -gt 0 -or $code -ne 0) { Write-Output "        PROBLEM $s exit=$code fail=$f" }
}
Check 'all suites pass' ($bad -eq 0) "$bad failures"
Note 'assertions' $total

if ($SkipProbe) {
  Write-Output ''
  Write-Output '=== 5. 插件运行时行为（已跳过）==='
  Note 'skipped' '加 -SkipProbe 时不做'
} else {
  Write-Output ''
  Write-Output '=== 5. 插件运行时行为（隔离实例，不碰真实数据）==='
  $probeHome = Join-Path $ws '.probe-home'
  if (Test-Path $probeHome) { Remove-Item -Recurse -Force $probeHome }
  New-Item -ItemType Directory -Force -Path "$probeHome\profiles\web\node_modules" | Out-Null
  foreach ($f in 'package.json','cordis.yml','cordis.patch.yml','pnpm-workspace.yaml','pnpm-lock.yaml') {
    $src = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles\web') $f
    if (Test-Path $src) { Copy-Item $src (Join-Path "$probeHome\profiles\web" $f) -Force }
  }
  New-Item -ItemType Junction -Path "$probeHome\profiles\node_modules" -Target (Join-Path $env:USERPROFILE '.dsh\profiles\node_modules') -ErrorAction SilentlyContinue | Out-Null
  New-Item -ItemType Junction -Path "$probeHome\profiles\web\node_modules\dsh-env-manager" -Target $ws -ErrorAction SilentlyContinue | Out-Null

  $env:DSH_HOME = $probeHome
  $logFile = Join-Path $env:TEMP 'probe-post.log'
  Remove-Item -Force $logFile,"$logFile.err" -ErrorAction SilentlyContinue

  # **不要硬编码 npm 缓存路径。** 我第一版用了 `$env:APPDATA\npm-cache\...`，
  # 而实际在 `$env:LOCALAPPDATA\npm-cache\...` —— AppData\Roaming 里没有它。
  # 正确做法是从 profile 自己的解析结果里找 dsh 的 bin。
  $spawnJs = Join-Path $env:TEMP 'spawn-probe.cjs'
  @'
// 启动隔离探针实例，把它的 stdout/stderr 落到文件，并把 pid 写出来。
// 走 node 而不是 dsh 脚本：PATH 上的 `dsh` 在 Windows 只有 dsh.ps1，
// PowerShell 之外无法直接执行。
const { createRequire } = require('node:module')
const { spawn } = require('node:child_process')
const { join, dirname } = require('node:path')
const { readFileSync, writeFileSync, openSync } = require('node:fs')

const [profilePkg, probeHome, port, pidFile, outFile, errFile] = process.argv.slice(2)
const req = createRequire(profilePkg)
const pkgPath = req.resolve('@deepseek-ai/dsh/package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const bin = join(dirname(pkgPath), pkg.bin.dsh)

// 重定向到文件才能读到 "contributor registered" 这类证据
const out = openSync(outFile, 'a')
const err = openSync(errFile, 'a')

const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', String(port), '--no-open'], {
  env: { ...process.env, DSH_HOME: probeHome },
  stdio: ['ignore', out, err],
  detached: true,
})
child.unref()
writeFileSync(pidFile, String(child.pid))
console.log('spawned pid ' + String(child.pid) + ' via ' + bin)
'@ | Set-Content -Path $spawnJs -Encoding UTF8

  $pidFile = Join-Path $env:TEMP 'probe-post.pid'
  Remove-Item -Force $pidFile,$logFile,"$logFile.err" -ErrorAction SilentlyContinue
  & node $spawnJs (Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles\web') 'package.json') $probeHome $ProbePort $pidFile $logFile "$logFile.err" 2>&1 | ForEach-Object { "        $($_.ToString().Trim())" }

  # 等它起来
  $booted = $false
  for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 1500
    $code = curl.exe -s -o NUL -w '%{http_code}' "http://127.0.0.1:$ProbePort/api/env-manager/health" 2>$null
    if ($code -eq '401' -or $code -eq '200') { $booted = $true; break }
  }
  Check 'the isolated instance booted' $booted "no answer on port $ProbePort"

  # 子进程日志：这是插件真的加载并注册贡献者的直接证据
  $errText = ''
  try { $errText = (Get-Content "$logFile.err" -Raw -ErrorAction SilentlyContinue) } catch { }
  if (-not $errText) { $errText = '' }
  Note 'plugin load lines'
  ($errText -split "`n") | Where-Object { $_ -match '\[env-manager\]' } | ForEach-Object { "        $($_.Trim())" }

  Check 'plugin loaded and registered the contributor' ($errText -match 'contributor registered') 'no registration line in stdout/stderr'
  Check 'credentials probe succeeded' ($errText -match 'credentials service available') 'no credentials line'

  # 路由存在但必须被闸门挡住：401 证明"路由已注册 + 策略生效"两件事
  $healthCode = curl.exe -s -o NUL -w '%{http_code}' "http://127.0.0.1:$ProbePort/api/env-manager/health"
  Check 'health route exists and is gated (401)' ($healthCode -eq '401') "got $healthCode"

  # 从子进程的 stdout 里取 token —— 它启动时会打印带 token 的 URL
  $outText = ''
  try { $outText = (Get-Content $logFile -Raw -ErrorAction SilentlyContinue) } catch { }
  if (-not $outText) { $outText = '' }
  $token = $null
  if ($outText -match 'token=([A-Za-z0-9_\-]+)') { $token = $Matches[1] }
  Check 'the instance printed an authenticated URL' ($null -ne $token) 'no token in stdout'

  if ($token) {
    $cj = Join-Path $env:TEMP 'cj-post.txt'
    Remove-Item -Force $cj -ErrorAction SilentlyContinue
    curl.exe -s -L -c $cj -b $cj -o NUL "http://127.0.0.1:$ProbePort/?token=$token"

    # 跨站请求必须被闸门挡住（Host/Origin 围栏）
    $cross = curl.exe -s -o NUL -w '%{http_code}' -H 'sec-fetch-site: cross-site' -H 'origin: https://evil.example' "http://127.0.0.1:$ProbePort/api/env-manager/state"
    Check 'cross-site request is refused (403)' ($cross -eq '403') "got $cross"

    # 外部 Host（DNS rebinding 形状）也必须被挡
    $rebind = curl.exe -s -o NUL -w '%{http_code}' -H 'host: attacker.example' "http://127.0.0.1:$ProbePort/api/env-manager/state"
    Check 'foreign Host is refused (403)' ($rebind -eq '403') "got $rebind"

    # 已认证请求必须成功
    $authed = curl.exe -s -m 60 -b $cj -w '|%{http_code}' "http://127.0.0.1:$ProbePort/api/env-manager/state?reveal=0"
    $code = ($authed -split '\|')[-1]
    Check 'authenticated state request succeeds' ($code -eq '200') "got $code"
    if ($code -eq '200') {
      $json = ($authed -split '\|')[0] | ConvertFrom-Json
      Note 'variables' $json.variables.Count
      Note 'shadowed' $json.counts.shadowed
      Note 'os layers' "user=$($json.os.scopes.'os-user'.count) machine=$($json.os.scopes.'os-machine'.count)"
      Check 'the model carries all four layers' ($json.variables.Count -gt 50 -and $json.os.supported -eq $true) "vars=$($json.variables.Count) os=$($json.os.supported)"
    }

    # 客户端 bundle 必须在 index 的组合 URL 里。
    # **必须带 -L**：`/?token=` 会 303 重定向到 `/`，不跟随只会拿到 0 字节。
    # 用 `-o 文件` 而不是捕获 stdout：PowerShell 会把多行输出拆成数组，
    # `$idx.Length` 就变成了行数而不是字节数（踩过，报出 "47 bytes" 这种假象）。
    $idxFile = Join-Path $env:TEMP 'idx-post.html'
    Remove-Item -Force $idxFile -ErrorAction SilentlyContinue
    curl.exe -s -L -b $cj -c $cj -o $idxFile "http://127.0.0.1:$ProbePort/?token=$token" | Out-Null
    $idxBytes = if (Test-Path $idxFile) { (Get-Item $idxFile).Length } else { 0 }
    Check 'the index rendered (non-empty)' ($idxBytes -gt 1000) "got $idxBytes bytes"
    $idx = if (Test-Path $idxFile) { Get-Content $idxFile -Raw } else { '' }
    Check 'client bundle is in the boot graph' ($idx -match 'dsh-env-manager/client\.js') 'not found in index'
    if ($idx -match 'dsh-env-manager/client\.js') {
      Note 'client bundle present' 'dsh-env-manager/client.js 已在应用组合 URL 中'
    }
    Remove-Item -Force $idxFile -ErrorAction SilentlyContinue
  }

  # 收尾：按 pid 文件杀子进程
  $childPid = $null
  try { $childPid = [int](Get-Content $pidFile -Raw -ErrorAction SilentlyContinue) } catch { }
  if ($childPid) {
    Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
    Note 'probe instance stopped' "pid $childPid"
  } else {
    Note 'probe pid unknown' '可能需要手工结束端口占用'
  }
  Start-Sleep -Seconds 2
  Remove-Item -Recurse -Force $probeHome -ErrorAction SilentlyContinue
  Remove-Item -Force $logFile,"$logFile.err",$pidFile,$spawnJs -ErrorAction SilentlyContinue
  Note 'cleaned up' 'probe home removed'
}

Write-Output ''
Write-Output '=== 6. 残留检查 ==='
$residue = (& reg.exe query 'HKCU\Environment' 2>&1 | Select-String 'ENVMGR|DSH_ENV_MANAGER').Count
Check 'no registry residue' ($residue -eq 0) "$residue remaining"
Check 'no .env left in the workspace' (-not (Test-Path (Join-Path $ws '.env'))) 'still present'
Check 'no probe home left behind' (-not (Test-Path (Join-Path $ws '.probe-home'))) 'still present'

Write-Output ''
if ($fail -eq 0) {
  Write-Output 'ALL PASS'
  Write-Output ''
  Write-Output '还剩一件只有人眼能做的事：打开 Settings -> Plugins，确认出现「环境变量」页签。'
} else {
  Write-Output "$fail FAILURE(S)"
}
exit $fail
