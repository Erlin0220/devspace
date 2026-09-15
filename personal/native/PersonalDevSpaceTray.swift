// One-time tray-only snapshot adapted from Team DevSpace 15ce088 TeamDevSpaceUI.swift.
// AppKit presentation only: shared Node controller owns lifecycle, settings and updates.
import AppKit
import Foundation
import Darwin

struct MenuEntry: Decodable {
    let id: String; let text: String; let enabled: Bool
    let action: String?; let separator: Bool?; let children: [MenuEntry]?
}
struct TrayState: Decodable {
    let status: String; let iconStatus: String; let tooltip: String; let menu: [MenuEntry]
    var entries: [MenuEntry] { menu.flatMap { [$0] + ($0.children ?? []) } }
    var valid: Bool {
        let states = ["ready", "partial", "suspended", "busy", "stopped"]
        return states.contains(status) && states.contains(iconStatus) && !menu.isEmpty && menu.count <= 20 && entries.count <= 32
            && Set(entries.map { $0.id }).count == entries.count
            && entries.allSatisfy { !$0.id.isEmpty && $0.id.utf8.count <= 64 }
            && menu.allSatisfy { ($0.children ?? []).allSatisfy { ($0.children ?? []).isEmpty } }
    }
}
func emit(_ event: String, _ fields: [String: Any] = [:]) {
    var value = fields; value["event"] = event
    if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) { FileHandle.standardOutput.write(bytes + Data([10])) }
}
func validInstanceID(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}
final class InstanceGuard {
    private let descriptor: Int32
    private init(_ descriptor: Int32) { self.descriptor = descriptor }
    static func acquire(_ identity: String) throws -> InstanceGuard? {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("personal-devspace-tray-\(geteuid())-\(identity).lock").path
        let descriptor = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        if flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            let code = errno; close(descriptor)
            if code == EWOULDBLOCK || code == EAGAIN { return nil }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
        }
        return InstanceGuard(descriptor)
    }
    deinit { close(descriptor) }
}
@MainActor final class Application: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var state: TrayState?
    private let smoke = CommandLine.arguments.contains("--smoke")
    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength); statusItem = item
        item.button?.image = NSImage(systemSymbolName: "terminal", accessibilityDescription: "Personal DevSpace")
        item.button?.image?.isTemplate = true; item.button?.toolTip = "Personal DevSpace · 正在启动…"
        emit("ready"); DispatchQueue.main.async { emit("tray-visible") }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let application = self else { return }
            var buffer = Data(); var chunk = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = chunk.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
                if count < 0 { if errno == EINTR { continue }; break }
                if count == 0 { break }; buffer.append(contentsOf: chunk.prefix(count))
                while let newline = buffer.firstIndex(of: 10) {
                    if buffer.distance(from: buffer.startIndex, to: newline) > 65536 { DispatchQueue.main.async { NSApp.terminate(nil) }; return }
                    let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
                    DispatchQueue.main.async { application.receive(line) }
                }
                if buffer.count > 65536 { break }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
    private func receive(_ bytes: Data) {
        if smoke, let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], let key = value["exerciseMenu"] as? String {
            if let entry = state?.entries.first(where: { $0.id == key && $0.enabled }), let action = entry.action, !action.isEmpty { emit("menu", ["action": action]) }; return
        }
        guard let value = try? JSONDecoder().decode(TrayState.self, from: bytes), value.valid else { emit("protocol-error"); return }
        state = value; let menu = NSMenu(); menu.autoenablesItems = false
        func add(_ entry: MenuEntry, to parent: NSMenu) {
            if entry.separator == true { parent.addItem(.separator()); return }
            let item = NSMenuItem(title: String(entry.text.prefix(64)), action: #selector(menuAction(_:)), keyEquivalent: "")
            item.target = self; item.isEnabled = entry.enabled; item.representedObject = entry.action
            if let children = entry.children, !children.isEmpty { let submenu = NSMenu(); submenu.autoenablesItems = false
                for child in children { add(child, to: submenu) }; item.submenu = submenu }
            parent.addItem(item)
        }
        for entry in value.menu { add(entry, to: menu) }; statusItem?.menu = menu
        statusItem?.button?.toolTip = String(value.tooltip.prefix(110))
        statusItem?.button?.title = value.status == "ready" ? "" : value.status == "busy" ? " …" : " ·"
        if smoke { emit("state-applied", ["status": value.status]) }
    }
    @objc private func menuAction(_ sender: NSMenuItem) {
        guard sender.isEnabled, let action = sender.representedObject as? String, !action.isEmpty else { return }
        emit("menu", ["action": action])
    }
}
@main struct PersonalTrayMain {
    @MainActor static func main() {
        let identity = ProcessInfo.processInfo.environment["PERSONAL_DEVSPACE_TRAY_INSTANCE_ID"] ?? ""
        guard validInstanceID(identity) else { fputs("Start through the Personal controller\n", stderr); exit(1) }
        let instance: InstanceGuard
        do { guard let acquired = try InstanceGuard.acquire(identity) else { emit("duplicate"); exit(0) }; instance = acquired }
        catch { fputs("Cannot acquire native tray ownership\n", stderr); exit(1) }
        let application = NSApplication.shared; let delegate = Application()
        application.delegate = delegate; application.setActivationPolicy(.accessory)
        withExtendedLifetime((instance, delegate)) { application.run() }
    }
}
