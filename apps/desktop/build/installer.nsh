; 安装时把命令行工具接上, 卸载时还原。
;
; 为什么要子目录: Windows 的文件名**不区分大小写**, `Kura.exe`(GUI) 和 `kura.exe`
; (CLI) 在同一个目录里就是同一个文件 —— 直接摊在 $INSTDIR 会把 GUI 覆盖掉。
; 所以 CLI 放 $INSTDIR\cli\, PATH 里加的也是这个子目录。
;
; 为什么改 HKCU 而不是 HKLM: 安装器是 per-user 的 (nsis.perMachine: false),
; 装到 %LOCALAPPDATA%\Programs\Kura, 不需要管理员权限 —— 也就不该去碰机器级的 PATH。
;
; 改 PATH 是**危险操作**: 写坏了整个系统的命令都找不到。所以这里三条规矩:
;   1. 只有确认 Path 里**没有**这一项才追加, 不重复写
;   2. 追加时保留原值, 只在自己后面接 `;`
;   3. 卸载时只删自己加的那一段, 其余原样保留

!macro customInstall
  DetailPrint "接入命令行工具 kura..."
  ReadRegStr $R0 HKCU "Environment" "Path"

  ; 内联子串查找, 不用 Function: NSIS 的 -WX 会把"定义了却没在安装段引用"的
  ; Function 当 warning, 而 electron-builder 用 -WX 编译, warning 直接变 error。
  ;   $R5 = 长度, $R6 = 位置, $R7 = 找到没
  StrLen $R5 "$INSTDIR\cli"
  StrCpy $R6 0
  StrCpy $R7 0
  kura_find_loop:
    StrCpy $R8 $R0 $R5 $R6
    StrCmp $R8 "" kura_find_done
    StrCmp $R8 "$INSTDIR\cli" kura_find_hit
    IntOp $R6 $R6 + 1
    Goto kura_find_loop
  kura_find_hit:
    StrCpy $R7 1
  kura_find_done:
  StrCmp $R7 1 kura_path_exists kura_path_append

  kura_path_append:
    ; 原值可能为空 (新建用户) —— 那就别留一个开头分号
    StrCmp $R0 "" 0 kura_path_has_value
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR\cli"
      Goto kura_path_notify
    kura_path_has_value:
      WriteRegExpandStr HKCU "Environment" "Path" "$R0;$INSTDIR\cli"
    kura_path_notify:
      ; 广播给已开的资源管理器, 新开的终端才会读到新 PATH。
      ; 已经打开的终端读不到 —— 这是 Windows 的机制, 文档里要写清楚。
      SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
      DetailPrint "已把 $INSTDIR\cli 加入 PATH (新开的终端才生效)"
      Goto kura_path_done
  kura_path_exists:
    DetailPrint "PATH 里已经有 $INSTDIR\cli, 跳过"
  kura_path_done:
!macroend

!macro customUnInstall
  ReadRegStr $R0 HKCU "Environment" "Path"
  StrCmp $R0 "" kura_uninstall_done

  ; 分号分隔: 把每一项拆出来, 只跳过自己那一项。
  ; 不做字符串替换 —— 那会把 "C:\Tools\kura\cli-extra" 这种同前缀的路径一起切坏。
  StrCpy $R1 ""
  StrCpy $R2 0
  kura_split_loop:
    StrCpy $R3 $R0 1 $R2
    StrCmp $R3 "" kura_split_flush
    StrCmp $R3 ";" kura_split_next

  ; 顺次落入 —— 这里不设标签: NSIS 会把"没被跳转引用的标签"当 warning, 而
  ; electron-builder 用 -WX 编译, warning 直接变 error。
    StrCpy $R4 "$R4$R3"
    IntOp $R2 $R2 + 1
    Goto kura_split_loop

  kura_split_next:
    ; 一段结束 ($R4 是这一段)
    StrCmp $R4 "$INSTDIR\cli" kura_split_skip
    StrCmp $R4 "" kura_split_skip
      StrCmp $R1 "" 0 kura_split_join
        StrCpy $R1 "$R4"
        Goto kura_split_skip
      kura_split_join:
        StrCpy $R1 "$R1;$R4"
    kura_split_skip:
    StrCpy $R4 ""
    IntOp $R2 $R2 + 1
    Goto kura_split_loop

  kura_split_flush:
    ; 最后一段
    StrCmp $R4 "$INSTDIR\cli" kura_split_write
    StrCmp $R4 "" kura_split_write
      StrCmp $R1 "" 0 kura_split_flush_join
        StrCpy $R1 "$R4"
        Goto kura_split_write
      kura_split_flush_join:
        StrCpy $R1 "$R1;$R4"

  kura_split_write:
    StrCmp $R1 "$R0" kura_uninstall_done
    WriteRegExpandStr HKCU "Environment" "Path" "$R1"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  kura_uninstall_done:
!macroend
