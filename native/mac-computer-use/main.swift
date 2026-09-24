import AppKit
import ApplicationServices
import Foundation

struct Request: Decodable {
    let action: String
    let text: String?
    let expectedPid: Int32?
    let elementIndex: Int?
    let expectedRole: String?
    let expectedTitle: String?
    let expectedDescription: String?
    let expectedX: Double?
    let expectedY: Double?
    let expectedWidth: Double?
    let expectedHeight: Double?
}

func output(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let string = String(data: data, encoding: .utf8) else {
        fputs("{\"ok\":false,\"error\":\"响应编码失败\"}\n", stdout)
        return
    }
    fputs(string + "\n", stdout)
}

func screenLocked() -> Bool {
    guard let value = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
    if let locked = value["CGSSessionScreenIsLocked"] as? Bool { return locked }
    if (value["kCGSSessionOnConsoleKey"] as? Int) != 1 ||
       (value["kCGSessionLoginDoneKey"] as? Int) != 1 { return true }
    return NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.loginwindow"
}

func status() -> [String: Any] {
    return [
        "ok": true,
        "locked": screenLocked(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "accessibility": AXIsProcessTrusted(),
        "frontmostApp": NSWorkspace.shared.frontmostApplication?.localizedName ?? "",
        "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
    ]
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
    return attribute(element, name) as? String ?? ""
}

func elementFrame(_ element: AXUIElement) -> CGRect? {
    guard let raw = attribute(element, "AXFrame"),
          CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = raw as! AXValue
    guard AXValueGetType(value) == .cgRect else { return nil }
    var frame = CGRect.zero
    guard AXValueGetValue(value, .cgRect, &frame) else { return nil }
    return frame
}

func observedElements() -> [[String: Any]] {
    guard let app = NSWorkspace.shared.frontmostApplication else { return [] }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    var results: [[String: Any]] = []
    let actionableRoles: Set<String> = [
        "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXLink",
        "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXMenuItem",
    ]
    func visit(_ element: AXUIElement, _ depth: Int) {
        if results.count >= 100 || depth > 10 { return }
        let role = stringAttribute(element, kAXRoleAttribute)
        let title = stringAttribute(element, kAXTitleAttribute)
        let description = stringAttribute(element, kAXDescriptionAttribute)
        if let frame = elementFrame(element), frame.width > 1, frame.height > 1,
           (!title.isEmpty || !description.isEmpty || actionableRoles.contains(role)) {
            results.append([
                "index": results.count,
                "role": role,
                "title": title,
                "description": description,
                "x": frame.origin.x,
                "y": frame.origin.y,
                "width": frame.width,
                "height": frame.height,
            ])
        }
        guard let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return }
        for child in children { visit(child, depth + 1) }
    }
    if let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] {
        for window in windows.prefix(3) { visit(window, 0) }
    }
    return results
}

func perform(_ request: Request) -> [String: Any] {
    if request.action == "status" { return status() }
    if screenLocked() { return ["ok": false, "error": "屏幕已锁定或无法确认锁屏状态"] }
    if !CGPreflightScreenCaptureAccess() {
        return ["ok": false, "error": "缺少屏幕录制权限"]
    }
    if !AXIsProcessTrusted() { return ["ok": false, "error": "缺少辅助功能权限"] }
    if let expectedPid = request.expectedPid,
       NSWorkspace.shared.frontmostApplication?.processIdentifier != expectedPid {
        return ["ok": false, "error": "前台应用已切换"]
    }
    if request.action == "observe" {
        return ["ok": true, "frontmostApp": NSWorkspace.shared.frontmostApplication?.localizedName ?? "",
                "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
                "elements": observedElements()]
    }
    if request.action == "click" {
        guard let index = request.elementIndex, index >= 0, index < 100,
              let expectedRole = request.expectedRole,
              let expectedTitle = request.expectedTitle,
              let expectedDescription = request.expectedDescription,
              let expectedX = request.expectedX,
              let expectedY = request.expectedY,
              let expectedWidth = request.expectedWidth,
              let expectedHeight = request.expectedHeight,
              [expectedX, expectedY, expectedWidth, expectedHeight].allSatisfy({ $0.isFinite }),
              let element = observedElements().first(where: { ($0["index"] as? Int) == index }),
              (element["role"] as? String) == expectedRole,
              (element["title"] as? String) == expectedTitle,
              (element["description"] as? String) == expectedDescription,
              let x = element["x"] as? Double, abs(x - expectedX) <= 2,
              let y = element["y"] as? Double, abs(y - expectedY) <= 2,
              let width = element["width"] as? Double, abs(width - expectedWidth) <= 2,
              let height = element["height"] as? Double, abs(height - expectedHeight) <= 2 else {
            return ["ok": false, "error": "点击目标已变化，请重新观察"]
        }
        let point = CGPoint(x: x + width / 2, y: y + height / 2)
        guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                                 mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                               mouseCursorPosition: point, mouseButton: .left) else {
            return ["ok": false, "error": "无法创建鼠标事件"]
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        return ["ok": true]
    }
    if request.action == "type" {
        guard let text = request.text, text.utf16.count <= 4096 else {
            return ["ok": false, "error": "输入文本超过上限"]
        }
        for scalar in text.unicodeScalars {
            let units = Array(String(scalar).utf16)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                return ["ok": false, "error": "无法创建键盘事件"]
            }
            units.withUnsafeBufferPointer { pointer in
                down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: pointer.baseAddress!)
                up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: pointer.baseAddress!)
            }
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
        return ["ok": true]
    }
    return ["ok": false, "error": "不支持的电脑操作"]
}

let bytes = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try? JSONDecoder().decode(Request.self, from: bytes) else {
    output(["ok": false, "error": "请求格式无效"])
    exit(2)
}
output(perform(request))
