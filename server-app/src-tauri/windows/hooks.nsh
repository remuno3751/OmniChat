; Remove the per-user autostart entries (scheduled task / Run key) on uninstall.
!macro NSIS_HOOK_POSTUNINSTALL
  nsExec::Exec 'schtasks /Delete /TN "OmniChat Server Autostart" /F'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OmniChatServer"
!macroend
