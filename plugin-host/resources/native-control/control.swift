import AppKit
import CoreGraphics
import Foundation
func fail(_ reason:String) -> Never { print("{\"error\":\"\(reason)\"}"); exit(1) }
let raw=FileHandle.standardInput.readDataToEndOfFile()
guard let input=(try? JSONSerialization.jsonObject(with:raw)) as? [String:Any], let action=input["action"] as? String else { fail("INVALID_INPUT") }
func windows()->[[String:Any]] { CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? [] }
func rect(_ w:[String:Any])->CGRect { var r=CGRect.zero; if let b=w[kCGWindowBounds as String] as? NSDictionary { _ = CGRectMakeWithDictionaryRepresentation(b,&r) }; return r }
func output(_ value:[String:Any]) { let d=try! JSONSerialization.data(withJSONObject:value);print(String(data:d,encoding:.utf8)!) }
// Only the explicit local setup flow invokes this; never exposed as a model action.
if action=="request-input-permission" {
 let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
 output(["inputPermission": AXIsProcessTrustedWithOptions(options)]);exit(0)
}
if action=="targets" {
 output(["screenPermission":CGPreflightScreenCaptureAccess(),"inputPermission":AXIsProcessTrusted(),"targets":windows().filter{($0[kCGWindowLayer as String] as? Int)==0}.map{ w in let r=rect(w);return ["bundleId":NSRunningApplication(processIdentifier:pid_t(w[kCGWindowOwnerPID as String] as? Int ?? 0))?.bundleIdentifier ?? "","path":NSRunningApplication(processIdentifier:pid_t(w[kCGWindowOwnerPID as String] as? Int ?? 0))?.bundleURL?.resolvingSymlinksInPath().path ?? "","windowId":w[kCGWindowNumber as String] as? Int ?? 0,"ownerPid":w[kCGWindowOwnerPID as String] as? Int ?? 0,"name":w[kCGWindowOwnerName as String] as? String ?? "","title":w[kCGWindowName as String] as? String ?? "","bounds":["x":r.minX,"y":r.minY,"width":r.width,"height":r.height]] as [String:Any] }]);exit(0)
}
guard let id=input["windowId"] as? Int, let pid=input["ownerPid"] as? Int, id>0,pid>0 else { fail("INVALID_TARGET") }
let denied=["terminal","iterm","warp","1password","keychain","system settings","activity monitor","codex","deepseek harness"]
func target(_ requireFront:Bool)->CGRect {
 guard let w=windows().first(where:{($0[kCGWindowNumber as String] as? Int)==id && ($0[kCGWindowOwnerPID as String] as? Int)==pid && ($0[kCGWindowLayer as String] as? Int)==0}) else { fail("TARGET_GONE") }
 if let bundle=input["bundleId"] as? String, let path=input["path"] as? String { guard let app=NSRunningApplication(processIdentifier:pid_t(pid)),app.bundleIdentifier==bundle,app.bundleURL?.resolvingSymlinksInPath().path==path else { fail("APP_IDENTITY_CHANGED") } }
 let name=(w[kCGWindowOwnerName as String] as? String ?? "").lowercased()
 if denied.contains(where:{name.contains($0)}) { fail("TARGET_DENIED") }
 if requireFront && (NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0) != pid_t(pid) { fail("TARGET_NOT_FOREGROUND") }
 let r=rect(w);if r.width<2 || r.height<2 { fail("TARGET_HIDDEN") }
 if requireFront {
  let app=AXUIElementCreateApplication(pid_t(pid));var focused:CFTypeRef?
  guard AXUIElementCopyAttributeValue(app,kAXFocusedWindowAttribute as CFString,&focused) == .success,let focused else { fail("FOCUSED_WINDOW_UNAVAILABLE") }
  let window=focused as! AXUIElement;var position:CFTypeRef?;var size:CFTypeRef?
  guard AXUIElementCopyAttributeValue(window,kAXPositionAttribute as CFString,&position) == .success,AXUIElementCopyAttributeValue(window,kAXSizeAttribute as CFString,&size) == .success,let position,let size else { fail("FOCUSED_WINDOW_UNAVAILABLE") }
  var point=CGPoint.zero;var dimensions=CGSize.zero
  guard AXValueGetValue(position as! AXValue,.cgPoint,&point),AXValueGetValue(size as! AXValue,.cgSize,&dimensions),CGRect(origin:point,size:dimensions)==r else { fail("TARGET_WINDOW_NOT_FOCUSED") }
  // Bounds alone are ambiguous when sibling windows exactly overlap: fail closed.
  let matches=windows().filter{($0[kCGWindowOwnerPID as String] as? Int)==pid && ($0[kCGWindowLayer as String] as? Int)==0 && rect($0)==r}
  guard matches.count==1 else { fail("AMBIGUOUS_FOCUSED_WINDOW") }
 }
 return r
}
let initial=target(false)
if action=="observe" {
 guard CGPreflightScreenCaptureAccess() else { fail("SCREEN_PERMISSION_REQUIRED") }
 // Fixed system utility captures only the selected existing window; no whole-desktop fallback.
 guard let path=input["output"] as? String else { fail("OUTPUT_REQUIRED") }
 let p=Process();p.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture");p.arguments=["-x","-o","-l",String(id),path]
 try p.run();p.waitUntilExit();if p.terminationStatus != 0 { fail("CAPTURE_FAILED") }
 _=target(false);output(["bounds":["x":initial.minX,"y":initial.minY,"width":initial.width,"height":initial.height]]);exit(0)
}
guard AXIsProcessTrusted() else { fail("INPUT_PERMISSION_REQUIRED") }
func check() { let now=target(true);if now != initial { fail("TARGET_MOVED") } }
func point()->CGPoint { guard let x=input["x"] as? Double,let y=input["y"] as? Double,x.isFinite,y.isFinite,x>=0,y>=0,x<initial.width,y<initial.height else { fail("INVALID_COORDINATE") };return CGPoint(x:initial.minX+x,y:initial.minY+y) }
if action=="click" {let p=point();check();guard let down=CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:p,mouseButton:.left),let up=CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:p,mouseButton:.left) else { fail("EVENT_FAILED") };down.postToPid(pid_t(pid));up.postToPid(pid_t(pid))}
else if action=="type" { guard let text=input["text"] as? String,text.count<=500,!text.unicodeScalars.contains(where:{$0.value<32 || $0.value==127}) else { fail("INVALID_TEXT") };for character in text {check();let chars=Array(String(character).utf16);chars.withUnsafeBufferPointer{buffer in let down=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true)!;let up=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false)!;down.keyboardSetUnicodeString(stringLength:chars.count,unicodeString:buffer.baseAddress!);up.keyboardSetUnicodeString(stringLength:chars.count,unicodeString:buffer.baseAddress!);down.postToPid(pid_t(pid));up.postToPid(pid_t(pid))};usleep(12000)}}
else if action=="scroll" {let p=point();guard let delta=input["delta"] as? Int,abs(delta)<=768 else { fail("INVALID_SCROLL") };check();let event=CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:1,wheel1:Int32(delta),wheel2:0,wheel3:0)!;event.location=p;event.postToPid(pid_t(pid))}
else {fail("UNSUPPORTED_ACTION")}
output(["executed":true])
