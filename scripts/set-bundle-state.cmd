@echo off
rem Enable or disable a bundle in a DSH profile.
rem
rem Usage:
rem   set-bundle-state.cmd --name dsh-custom-instructions --action enable
rem   set-bundle-state.cmd --name @ztl0001/dsh-notify --action disable
rem
rem Node is not on PATH on a machine that only has the harness installed, so
rem this finds the copy the harness itself ships. Everything else -- including
rem reading and writing the profile's JSON -- lives in the .mjs file, which uses
rem Node's own JSON implementation: one implementation, identical everywhere.
rem That is exactly what the earlier PowerShell version of this got wrong (its
rem ConvertFrom-Json / ConvertTo-Json round trip emitted a trailing comma under
rem PowerShell 7, which is not valid JSON, and DSH then refused to boot).
rem
rem Quit DeepSeek Harness completely before running this. A live host rewrites
rem the profile from its in-memory composition, so the change would be reverted.

setlocal
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
  echo Could not find the bundled Node at:
  echo   %NODE%
  echo Run the .mjs file with any Node executable instead.
  exit /b 2
)
"%NODE%" "%~dp0set-bundle-state.mjs" %*
exit /b %ERRORLEVEL%
