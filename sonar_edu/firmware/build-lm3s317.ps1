param(
    [string]$SourceCode = 'src\lm3s317_radar_v10.c',
    [string]$Stem       = 'lm3s317_radar_v10',
    [string]$Define     = ''
)

# Build an LM3S317 firmware with the STM32CubeCLT ARM GCC toolchain.
#
# Sandboxed child processes cannot write into the existing workspace
# subdirectories, so the compile happens in an ASCII TEMP stage and the finished
# artefacts are copied into the output directory that this script owns.
$ErrorActionPreference = 'Stop'

$tool    = 'C:\ST\STM32CubeCLT_1.21.0\GNU-tools-for-STM32\bin'
$source  = Join-Path $PSScriptRoot $SourceCode
$linker  = Join-Path $PSScriptRoot 'lm3s317.ld'
# Derived, never hard-coded: this script is UTF-8 without BOM and Windows
# PowerShell 5.1 would read a literal CJK path as ANSI mojibake.
$outDir  = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'stm32_build'

foreach ($p in @($source, $linker)) {
    if (-not (Test-Path -LiteralPath $p)) { throw "missing input: $p" }
}

$stage = Join-Path $env:TEMP ('lm3s317_' + $Stem)
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $stage 'main.c')
Copy-Item -LiteralPath $linker -Destination (Join-Path $stage 'link.ld')
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

function Test-IntelHex {
    param([string]$Path, [long]$FlashLimit, [long]$ExpectedSp)
    $bytes = @{}
    $base = [long]0
    $eof = $false
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($eof) { throw 'unexpected record after EOF' }
        if ($line -notmatch '^:[0-9A-Fa-f]+$') { throw "bad hex line: $line" }
        $rec = New-Object 'System.Collections.Generic.List[int]'
        for ($i = 1; $i -lt $line.Length; $i += 2) { $rec.Add([Convert]::ToInt32($line.Substring($i, 2), 16)) }
        $count = $rec[0]
        if ($rec.Count -ne $count + 5) { throw 'bad record length' }
        $sum = 0
        foreach ($b in $rec) { $sum += $b }
        if (($sum -band 255) -ne 0) { throw 'checksum mismatch' }
        $offset = $rec[1] * 256 + $rec[2]
        switch ($rec[3]) {
            0 {
                for ($i = 0; $i -lt $count; $i++) {
                    $addr = $base + $offset + $i
                    if ($addr -lt 0 -or $addr -ge $FlashLimit) { throw 'data outside flash' }
                    if ($bytes.ContainsKey($addr)) { throw 'overlapping data' }
                    $bytes[$addr] = $rec[4 + $i]
                }
            }
            1 { if ($count -ne 0) { throw 'bad EOF' }; $eof = $true }
            4 { if ($count -ne 2) { throw 'bad extended address' }; $base = ([long]$rec[4] * 256 + $rec[5]) * 65536 }
            5 { if ($count -ne 4) { throw 'unexpected start address' } }
            3 { }   # start segment address: harmless, ignored by the loader
            2 { }   # extended segment address: not emitted for our images
            default { throw "unexpected record type $($rec[3])" }
        }
    }
    if (-not $eof) { throw 'missing EOF' }
    $vec = New-Object 'System.Collections.Generic.List[int]'
    for ($i = 0; $i -lt 8; $i++) {
        if (-not $bytes.ContainsKey([long]$i)) { throw 'missing boot vector' }
        $vec.Add($bytes[[long]$i])
    }
    $arr = [byte[]]$vec.ToArray()
    $sp = [BitConverter]::ToUInt32($arr, 0)
    $reset = [BitConverter]::ToUInt32($arr, 4)
    if ($sp -ne $ExpectedSp) { throw ("bad initial stack pointer 0x{0:X8}" -f $sp) }
    if (($reset -band 1) -ne 1) { throw 'reset vector is not Thumb' }
    if (-not $bytes.ContainsKey([long]($reset -band (-bnot 1)))) { throw 'reset handler not in image' }
    Write-Output ('HEX OK: {0} bytes; SP=0x{1:X8}; Reset=0x{2:X8}' -f $bytes.Count, $sp, $reset)
}

Push-Location -LiteralPath $stage
try {
    $gccArgs = @('-mcpu=cortex-m3', '-mthumb', '-std=c11', '-Os', '-g3', '-Wall', '-Wextra', '-Werror',
        '-ffreestanding', '-fno-builtin', '-fdata-sections', '-ffunction-sections', '-nostdlib', '-T', 'link.ld',
        "-Wl,--gc-sections,-Map=$Stem.map")
    if ($Define -ne '') { $gccArgs += "-D$Define" }
    $gccArgs += @('main.c', '-lgcc', '-o', 'main.elf')
    & "$tool\arm-none-eabi-gcc.exe" @gccArgs
    if ($LASTEXITCODE -ne 0) { throw 'gcc failed' }

    & "$tool\arm-none-eabi-objcopy.exe" -O ihex main.elf main.hex
    if ($LASTEXITCODE -ne 0) { throw 'objcopy failed' }

    Test-IntelHex -Path (Join-Path $stage 'main.hex') -FlashLimit 0x4000 -ExpectedSp 0x20001000

    & "$tool\arm-none-eabi-size.exe" main.elf
    & "$tool\arm-none-eabi-objdump.exe" -d main.elf | Set-Content -LiteralPath 'main.disasm.txt' -Encoding utf8

    Copy-Item -LiteralPath 'main.elf'        -Destination (Join-Path $outDir "$Stem.elf") -Force
    Copy-Item -LiteralPath 'main.hex'        -Destination (Join-Path $outDir "$Stem.hex") -Force
    Copy-Item -LiteralPath "$Stem.map"       -Destination (Join-Path $outDir "$Stem.map") -Force
    Copy-Item -LiteralPath 'main.disasm.txt' -Destination (Join-Path $outDir "$Stem.disasm.txt") -Force

    Write-Output ("BUILD OK -> " + (Join-Path $outDir "$Stem.hex"))
} finally {
    Pop-Location
}
