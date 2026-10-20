@echo off
rem Install dsh-notify into the desktop profile -- both halves.
rem
rem A plugin is "installed" in two places in the profile, and the system reads
rem them for different reasons:
rem
rem   dsh.profile.bundles -> the loader composes it at boot (this is what runs it)
rem   dependencies        -> Settings - Plugins lists it, with a toggle
rem
rem Doing only the first one gives a plugin that works but cannot be switched
rem off from the UI. Both are done here.
rem
rem QUIT DEEPSEEK HARNESS FIRST (not just the window). A live host rewrites the
rem profile from its in-memory composition, so an edit made while it runs is
rem reverted -- and the scripts refuse to run in that case anyway.
rem
rem Undo: run this file with the argument:  remove
rem
rem ASCII only, CRLF line endings, no string building: a .cmd that violates any
rem of those makes cmd.exe misparse the command line as commands.

setlocal EnableExtensions
set "HERE=%~dp0."
set "ACTION=enable"
if /I "%~1"=="remove" set "ACTION=disable"
if /I "%~1"=="disable" set "ACTION=disable"

set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"

echo.
echo   dsh-notify install  ^(action: %ACTION%^)
echo   ==========================================
echo   plugin dir: %HERE%
echo.

if /I "%ACTION%"=="enable" (
  echo   [1/2] registering the dependency ^(makes it appear in Settings - Plugins^)
  "%NODE%" "%HERE%\scripts\register-local-plugin.mjs" --name @ztl0001/dsh-notify --dir "%HERE%"
  if errorlevel 1 goto failed
  echo.
  echo   [2/2] enabling the bundle ^(makes the loader run it^)
  "%NODE%" "%HERE%\scripts\set-bundle-state.mjs" --name @ztl0001/dsh-notify --action enable --link "%HERE%"
  if errorlevel 1 goto failed
) else (
  echo   disabling the bundle
  "%NODE%" "%HERE%\scripts\set-bundle-state.mjs" --name @ztl0001/dsh-notify --action disable
  if errorlevel 1 goto failed
  echo.
  echo   NOTE: the dependency row in profile package.json is left in place.
  echo         Remove it by hand if the plugin should also leave the plugin list;
  echo         register-local-plugin.mjs wrote a .bak-register-dsh_notify backup.
)

echo.
echo   Done. Now START DeepSeek Harness.
echo   The plugin should appear under Settings - Plugins with a toggle,
echo   and a notification should arrive when a task really finishes.
echo.
pause
exit /b 0

:failed
echo.
echo   Nothing further was changed ^(the step above failed^).
echo   The usual cause: DSH is still running. Quit it completely and retry.
echo.
pause
exit /b 1
