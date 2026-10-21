@echo off
rem Runs a command inside the Visual Studio x64 developer environment, which
rem also puts the bundled CMake and Ninja on PATH.
rem Example: native\tools\msvc-env.cmd cmake --preset dev
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo vswhere.exe not found; install Visual Studio 2022 or Build Tools with the C++ workload. 1>&2
  exit /b 1
)
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
if not defined VSINSTALL (
  echo No Visual Studio installation with the C++ x64 tools was found. 1>&2
  exit /b 1
)
call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
%*
exit /b %ERRORLEVEL%
