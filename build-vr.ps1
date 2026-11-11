$ErrorActionPreference = 'Stop'
$build = Join-Path $PSScriptRoot '.build'
$sdk = Join-Path $build 'openxr'
$bin = Join-Path $build 'bin'
$package = Join-Path $sdk 'loader.zip'
$version = '1.1.65'
$runtime = Join-Path $sdk 'native\x64\release'
if (!(Test-Path -LiteralPath (Join-Path $runtime 'lib\openxr_loader.lib'))) {
    New-Item -ItemType Directory -Path $sdk -Force | Out-Null
    Invoke-WebRequest "https://github.com/KhronosGroup/OpenXR-SDK/releases/download/release-$version/OpenXR.Loader.$version.nupkg" -OutFile $package
    $checksum = '05638c526f07ba3a5f1084bbc3308d654d5167f844ffa1e35515325cb72e0c34'
    if ((Get-FileHash -LiteralPath $package).Hash -ne $checksum) { throw 'OpenXR package checksum mismatch' }
    Expand-Archive -LiteralPath $package -DestinationPath $sdk -Force
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Visual Studio C++ build tools are required' }
New-Item -ItemType Directory -Path $bin -Force | Out-Null
$loader = Join-Path $bin 'openxr_loader.dll'
if (!(Test-Path -LiteralPath $loader)) {
    Copy-Item -LiteralPath (Join-Path $runtime 'bin\openxr_loader.dll') -Destination $loader
}
$developerEnv = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$compile = 'call "{0}" && cl /nologo /std:c++17 /EHsc /W4 /O2 /MT /LD /I"{1}\include" "{2}\quest_bridge.cpp" /link /OUT:"{3}\BlueEstateQuest.dll" /LIBPATH:"{4}\lib" openxr_loader.lib d3d11.lib dxgi.lib gdi32.lib user32.lib' -f $developerEnv, $sdk, $PSScriptRoot, $bin, $runtime
Push-Location -LiteralPath $bin
try {
    & cmd.exe /d /c $compile
    if ($LASTEXITCODE -ne 0) { throw 'Quest bridge build failed' }
} finally {
    Pop-Location
}

$pythonPackages = Join-Path $build 'python'
if (!(Test-Path -LiteralPath (Join-Path $pythonPackages 'frida'))) {
    & python -m pip install --disable-pip-version-check --target $pythonPackages 'frida==17.26.2'
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the local launcher dependency' }
}
