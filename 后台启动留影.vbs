' Start Liuying panel silently (no console window).
' node.exe path is read from node-path.txt (UTF-8 - Chinese paths allowed) via ADODB,
' because VBS OpenTextFile only does ASCII/UTF-16 and would garble Chinese.
' Fallback: a plain "node" from PATH. Boot-start safe: if node is missing, quit quietly.
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

node = ""
hint = base & "node-path.txt"
If fso.FileExists(hint) Then
  Set ad = CreateObject("ADODB.Stream")
  ad.Type = 2
  ad.CharSet = "utf-8"
  ad.Open
  ad.LoadFromFile hint
  node = Trim(ad.ReadText)
  node = Replace(node, vbCr, "")
  node = Replace(node, vbLf, "")
  ad.Close
  If Left(node, 1) = Chr(65279) Then node = Trim(Mid(node, 2)) ' strip BOM if present
End If
If node = "" Then node = "node"

If Not fso.FileExists(node) Then WScript.Quit 1 ' no node at boot: quit quietly

ws.CurrentDirectory = base
ws.Run Chr(34) & node & Chr(34) & " src\panel.mjs", 0, False
