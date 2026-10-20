; OmniChat Server installer (Inno Setup 6).
; Build (CI):
;   ISCC.exe /DMyAppVersion=1.2.3 /DStageDir=<abs>\.release\stage\server /DWinSWExe=<abs>\WinSW-x64.exe /DOutDir=<abs>\out packaging\windows\omnichat.iss
; Silent install examples:
;   OmniChat-Server-Setup-1.2.3.exe /VERYSILENT /SUPPRESSMSGBOXES /PORT=8787 /ALLOWREG=0 /SEARXNG=http://localhost:8888 /TASKS="firewall,startmenu"
; Silent uninstall:
;   "C:\Program Files\OmniChat\unins000.exe" /VERYSILENT /REMOVEDATA=1     (omit /REMOVEDATA to keep data + config)

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\..\.release\stage\server"
#endif
#ifndef WinSWExe
  #define WinSWExe "WinSW-x64.exe"
#endif
#ifndef OutDir
  #define OutDir "..\..\.release\out"
#endif

#define ServiceName "OmniChat"
#define RuleName "OmniChat Server"

[Setup]
AppId={{6E1F0C52-3B7A-4C4E-9D0B-5A1C2F9B7A11}
AppName=OmniChat Server
AppVersion={#MyAppVersion}
AppPublisher=OmniChat
DefaultDirName={autopf}\OmniChat
DefaultGroupName=OmniChat
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=OmniChat-Server-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=OmniChat Server
CloseApplications=no
; Upgrade in place: same AppId + same dir. Keep the previous install dir.
UsePreviousAppDir=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[Tasks]
Name: "firewall"; Description: "Windows ファイアウォールで受信を許可する (プライベートネットワークのみ) / Allow inbound connections (private networks only)"; Flags: checkedonce
Name: "startmenu"; Description: "スタートメニューにショートカットを作成 / Create Start Menu shortcuts"; Flags: checkedonce

[Dirs]
; uninsneveruninstall: Inno would otherwise remove these folders on uninstall when empty; data is never removed by the installer itself (see [Code]).
Name: "{commonappdata}\OmniChat"; Flags: uninsneveruninstall
Name: "{commonappdata}\OmniChat\data"; Flags: uninsneveruninstall
Name: "{commonappdata}\OmniChat\logs"; Flags: uninsneveruninstall

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#WinSWExe}"; DestDir: "{app}"; DestName: "omnichat-service.exe"; Flags: ignoreversion
Source: "omnichat-service.xml"; DestDir: "{app}"; Flags: ignoreversion
Source: "run-service.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "omnichat-admin.cmd"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Open OmniChat"; Filename: "{app}\OpenOmniChat.url"; Tasks: startmenu
Name: "{group}\OmniChat data folder"; Filename: "{win}\explorer.exe"; Parameters: """{commonappdata}\OmniChat\data"""; Tasks: startmenu
Name: "{group}\Edit OmniChat config"; Filename: "{win}\notepad.exe"; Parameters: """{commonappdata}\OmniChat\config.env"""; Tasks: startmenu
Name: "{group}\OmniChat logs"; Filename: "{win}\explorer.exe"; Parameters: """{commonappdata}\OmniChat\logs"""; Tasks: startmenu
Name: "{group}\Uninstall OmniChat Server"; Filename: "{uninstallexe}"; Tasks: startmenu

[Code]
var
  CfgPage: TWizardPage;
  PortEdit, SearxEdit: TNewEdit;
  AllowRegCheck: TNewCheckBox;

function ConfigPath: string;
begin
  Result := ExpandConstant('{commonappdata}\OmniChat\config.env');
end;

{ Read KEY=VALUE from an existing config.env ('' if absent). }
function ReadConfigValue(const Key, Default: string): string;
var
  Lines: TArrayOfString;
  I, P: Integer;
  L: string;
begin
  Result := Default;
  if not LoadStringsFromFile(ConfigPath, Lines) then Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    L := Trim(Lines[I]);
    if (L = '') or (L[1] = '#') then Continue;
    P := Pos('=', L);
    if (P > 1) and (CompareText(Trim(Copy(L, 1, P - 1)), Key) = 0) then
    begin
      Result := Trim(Copy(L, P + 1, MaxInt));
      Exit;
    end;
  end;
end;

procedure InitializeWizard;
var
  L1, L2: TNewStaticText;
  DefPort, DefSearx, DefReg: string;
begin
  { Defaults: command line > existing config > built-in }
  DefPort := ExpandConstant('{param:PORT|' + ReadConfigValue('PORT', '8787') + '}');
  DefSearx := ExpandConstant('{param:SEARXNG|' + ReadConfigValue('SEARXNG_URL', '') + '}');
  DefReg := ExpandConstant('{param:ALLOWREG|' + ReadConfigValue('ALLOW_REGISTRATION', '0') + '}');

  CfgPage := CreateCustomPage(wpSelectTasks, 'OmniChat 設定 / Settings',
    'ポートと検索(SearXNG)を設定します。後から config.env で変更できます。');

  L1 := TNewStaticText.Create(CfgPage);
  L1.Parent := CfgPage.Surface;
  L1.Caption := 'ポート番号 / Port (1-65535):';
  L1.Left := 0; L1.Top := 0;

  PortEdit := TNewEdit.Create(CfgPage);
  PortEdit.Parent := CfgPage.Surface;
  PortEdit.Left := 0; PortEdit.Top := L1.Top + L1.Height + 6; PortEdit.Width := 120;
  PortEdit.Text := DefPort;

  L2 := TNewStaticText.Create(CfgPage);
  L2.Parent := CfgPage.Surface;
  L2.Caption := 'SearXNG URL (任意 / optional, 例 http://localhost:8888):';
  L2.Left := 0; L2.Top := PortEdit.Top + PortEdit.Height + 16;

  SearxEdit := TNewEdit.Create(CfgPage);
  SearxEdit.Parent := CfgPage.Surface;
  SearxEdit.Left := 0; SearxEdit.Top := L2.Top + L2.Height + 6; SearxEdit.Width := CfgPage.SurfaceWidth;
  SearxEdit.Text := DefSearx;

  AllowRegCheck := TNewCheckBox.Create(CfgPage);
  AllowRegCheck.Parent := CfgPage.Surface;
  AllowRegCheck.Left := 0; AllowRegCheck.Top := SearxEdit.Top + SearxEdit.Height + 16;
  AllowRegCheck.Width := CfgPage.SurfaceWidth;
  AllowRegCheck.Caption := '管理者の作成後に一般ユーザーの新規登録を許可する / Allow self-registration (regular users) once an administrator exists';
  AllowRegCheck.Checked := (DefReg = '1');
end;

function IsValidPort(const S: string): Boolean;
var N: Integer;
begin
  N := StrToIntDef(S, 0);
  Result := (N >= 1) and (N <= 65535);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = CfgPage.ID then
    if not IsValidPort(Trim(PortEdit.Text)) then
    begin
      MsgBox('ポート番号は 1-65535 で指定してください。', mbError, MB_OK);
      Result := False;
    end;
end;

function ServiceExists: Boolean;
var RC: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\sc.exe'), 'query {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, RC) and (RC = 0);
end;

procedure StopService;
var RC: Integer;
begin
  if ServiceExists then
  begin
    Exec(ExpandConstant('{sys}\net.exe'), 'stop {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, RC);
    Sleep(1500);
  end;
end;

{ Called before files are copied: stop the running service so files can be replaced (upgrade in place). }
function PrepareToInstall(var NeedsRestart: Boolean): string;
begin
  StopService;
  Result := '';
end;

function FinalPort: string;
begin
  Result := Trim(PortEdit.Text);
  if not IsValidPort(Result) then Result := '8787';
end;

procedure WriteDefaultConfig;
var
  Lines: TArrayOfString;
  Reg: string;
begin
  { Never overwrite an existing config (upgrade keeps user settings). }
  if FileExists(ConfigPath) then Exit;
  if AllowRegCheck.Checked then Reg := '1' else Reg := '0';
  SetArrayLength(Lines, 9);
  Lines[0] := '# OmniChat server configuration. Restart the "OmniChat" service after editing.';
  Lines[1] := 'PORT=' + FinalPort;
  Lines[2] := 'HOST=0.0.0.0';
  Lines[3] := 'DATA_DIR=' + ExpandConstant('{commonappdata}\OmniChat\data');
  Lines[4] := '# 1 = after an admin exists, anyone can register (regular user); 0 = no self-registration';
  Lines[5] := 'ALLOW_REGISTRATION=' + Reg;
  Lines[6] := '# Optional SearXNG (JSON format must be enabled in its settings.yml)';
  if Trim(SearxEdit.Text) <> '' then
    Lines[7] := 'SEARXNG_URL=' + Trim(SearxEdit.Text)
  else
    Lines[7] := '#SEARXNG_URL=http://localhost:8888';
  Lines[8] := '';
  SaveStringsToFile(ConfigPath, Lines, False);
end;

procedure WriteUrlFile;
var Lines: TArrayOfString;
begin
  SetArrayLength(Lines, 2);
  Lines[0] := '[InternetShortcut]';
  Lines[1] := 'URL=http://localhost:' + ReadConfigValue('PORT', FinalPort) + '/';
  SaveStringsToFile(ExpandConstant('{app}\OpenOmniChat.url'), Lines, False);
end;

procedure ConfigureFirewall;
var RC: Integer;
begin
  Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="{#RuleName}"', '', SW_HIDE, ewWaitUntilTerminated, RC);
  if WizardIsTaskSelected('firewall') then
    Exec(ExpandConstant('{sys}\netsh.exe'),
      'advfirewall firewall add rule name="{#RuleName}" dir=in action=allow protocol=TCP localport=' +
      ReadConfigValue('PORT', FinalPort) + ' profile=private', '', SW_HIDE, ewWaitUntilTerminated, RC);
end;

{ Replaces inherited permissions of a folder tree (icacls /inheritance:r, recursive).
  SYSTEM and Administrators get full control; Users get read only when UsersRead is True, otherwise nothing.
  SIDs are used instead of names so this works on every Windows language:
  S-1-5-18 = SYSTEM, S-1-5-32-544 = Administrators, S-1-5-32-545 = Users. }
procedure RestrictAcl(const Target: string; UsersRead: Boolean);
var
  Grants: string;
  RC: Integer;
  Ok: Boolean;
begin
  Grants := '/grant:r *S-1-5-18:(OI)(CI)F /grant:r *S-1-5-32-544:(OI)(CI)F';
  if UsersRead then
    Grants := Grants + ' /grant:r *S-1-5-32-545:(OI)(CI)RX';
  Ok := Exec(ExpandConstant('{sys}\icacls.exe'), '"' + Target + '" /inheritance:r ' + Grants + ' /T /C', '', SW_HIDE, ewWaitUntilTerminated, RC);
  if (not Ok) or (RC <> 0) then
    MsgBox('フォルダの権限設定に失敗しました / Failed to set permissions: ' + Target + ' (code ' + IntToStr(RC) + ')', mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var RC: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    { Lock down before config.env is written, so the new file inherits the restricted ACL.
      Program folder: Users may read. Data folder (config.env, data, logs): Users get nothing. }
    RestrictAcl(ExpandConstant('{commonappdata}\OmniChat'), False);
    RestrictAcl(ExpandConstant('{app}'), True);
    WriteDefaultConfig;
    WriteUrlFile;
    ConfigureFirewall;
    if ServiceExists then
      Exec(ExpandConstant('{app}\omnichat-service.exe'), 'refresh', '', SW_HIDE, ewWaitUntilTerminated, RC)
    else
      Exec(ExpandConstant('{app}\omnichat-service.exe'), 'install', '', SW_HIDE, ewWaitUntilTerminated, RC);
    Exec(ExpandConstant('{sys}\net.exe'), 'start {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, RC);
  end;
end;

{ ---- uninstall ---- }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  RC: Integer;
  Remove: Boolean;
begin
  if CurUninstallStep = usUninstall then
  begin
    Exec(ExpandConstant('{sys}\net.exe'), 'stop {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, RC);
    Sleep(1500);
    Exec(ExpandConstant('{app}\omnichat-service.exe'), 'uninstall', '', SW_HIDE, ewWaitUntilTerminated, RC);
    Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="{#RuleName}"', '', SW_HIDE, ewWaitUntilTerminated, RC);
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    { Data (config.env, data, logs) is removed ONLY on explicit request: /REMOVEDATA=1 when silent, "Yes" in the prompt otherwise. }
    if UninstallSilent then
      Remove := (ExpandConstant('{param:REMOVEDATA|0}') = '1')
    else
      Remove := MsgBox('チャットデータと設定 (' + ExpandConstant('{commonappdata}\OmniChat') + ') も削除しますか?' + #13#10 +
                       '「いいえ」を選ぶとデータは残り、再インストール時に引き継がれます。',
                       mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
    if Remove then
      DelTree(ExpandConstant('{commonappdata}\OmniChat'), True, True, True);
  end;
end;
