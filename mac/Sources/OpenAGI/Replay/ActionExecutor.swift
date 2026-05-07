import AppKit
import Foundation

// Action vocabulary executor. Each step is a single-key dictionary; the key
// names the action and the value is its argument. Unknown keys are logged
// and skipped (they pass server-side validation, but we belt-and-suspenders).
//
// Implemented:
//   open_app: "Linear"               — NSWorkspace.shared.openApplication
//   wait: 1.5                        — sleep N seconds
//   keyboard_shortcut: "cmd+k"       — synthesized via CGEvent
//   type: "OpenAGI roadmap"          — synthesized character-by-character
//   press: "Return"                  — single named key
//   applescript: "tell …"            — NSAppleScript
//   shortcut: "MyShortcut"           — `shortcuts run "MyShortcut"` (CLI)
//   say: "ready"                     — `say "..."` (NSSpeechSynthesizer alternative)
//   browser: "https://…"             — open URL in default browser
//   comment: "anything"              — no-op, captured in the log
//
// All key-emitting actions require Accessibility permission. The executor
// prompts the user on first use via NSApp foreground.

@MainActor
final class ActionExecutor {
  struct Outcome {
    var executed: Int
    var error: String?
    var log: [String]
  }

  func run(steps: [[String: Any]], dryRun: Bool) async -> Outcome {
    var log: [String] = []
    var executed = 0
    for (i, step) in steps.enumerated() {
      guard let kv = step.first else { continue }
      let action = kv.key
      let value = kv.value
      let line = "\(i + 1). \(action): \(describe(value))"
      log.append(line)
      if dryRun { continue }
      do {
        try await dispatch(action: action, value: value)
        executed += 1
      } catch {
        return Outcome(executed: executed, error: "step \(i + 1) (\(action)): \(error.localizedDescription)", log: log)
      }
    }
    return Outcome(executed: executed, error: nil, log: log)
  }

  // MARK: — dispatch

  private func dispatch(action: String, value: Any) async throws {
    switch action {
    case "open_app":
      try await openApp(name: stringValue(value))
    case "wait":
      let secs = (value as? Double) ?? Double(stringValue(value)) ?? 0
      if secs > 0 { try? await Task.sleep(nanoseconds: UInt64(secs * 1_000_000_000)) }
    case "keyboard_shortcut":
      try sendShortcut(stringValue(value))
    case "type":
      try sendType(stringValue(value))
    case "press":
      try sendKey(named: stringValue(value), modifiers: [])
    case "applescript":
      try runAppleScript(stringValue(value))
    case "shortcut":
      try runShortcutsApp(name: stringValue(value))
    case "say":
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/usr/bin/say")
      p.arguments = [stringValue(value)]
      try p.run()
    case "browser":
      if let url = URL(string: stringValue(value)) { NSWorkspace.shared.open(url) }
    case "comment":
      break // no-op, kept for human-readable logs
    default:
      throw NSError(domain: "OpenAGI.replay", code: 1, userInfo: [NSLocalizedDescriptionKey: "unknown action '\(action)'"])
    }
  }

  // MARK: — helpers

  private func openApp(name: String) async throws {
    let workspace = NSWorkspace.shared
    // Try by bundle id first, then by visible name
    if let appURL = workspace.urlForApplication(withBundleIdentifier: name) {
      _ = try await workspace.openApplication(at: appURL, configuration: NSWorkspace.OpenConfiguration())
      return
    }
    if let appURL = workspace.urlForApplication(toOpen: URL(fileURLWithPath: "/Applications/\(name).app")) {
      _ = try await workspace.openApplication(at: appURL, configuration: NSWorkspace.OpenConfiguration())
      return
    }
    // Last resort — `open -a "Name"`
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-a", name]
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 {
      throw NSError(domain: "OpenAGI.replay", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not open app '\(name)'"])
    }
  }

  private func runAppleScript(_ src: String) throws {
    var error: NSDictionary?
    let script = NSAppleScript(source: src)
    _ = script?.executeAndReturnError(&error)
    if let err = error {
      throw NSError(domain: "OpenAGI.replay.applescript", code: 3, userInfo: [NSLocalizedDescriptionKey: "\(err)"])
    }
  }

  private func runShortcutsApp(name: String) throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/shortcuts")
    p.arguments = ["run", name]
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 {
      throw NSError(domain: "OpenAGI.replay.shortcuts", code: 4, userInfo: [NSLocalizedDescriptionKey: "shortcut '\(name)' failed"])
    }
  }

  private func sendShortcut(_ spec: String) throws {
    // Parse like "cmd+shift+k"
    let parts = spec.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
    var modifiers: CGEventFlags = []
    var key: String? = nil
    for p in parts {
      switch p {
      case "cmd", "command", "⌘": modifiers.insert(.maskCommand)
      case "shift", "⇧": modifiers.insert(.maskShift)
      case "alt", "option", "opt", "⌥": modifiers.insert(.maskAlternate)
      case "ctrl", "control", "⌃": modifiers.insert(.maskControl)
      default: key = p
      }
    }
    guard let key else { throw NSError(domain: "OpenAGI.replay", code: 5, userInfo: [NSLocalizedDescriptionKey: "no key in shortcut '\(spec)'"]) }
    try sendKey(named: key, modifiers: modifiers)
  }

  private func sendKey(named name: String, modifiers: CGEventFlags) throws {
    guard let code = keyCode(for: name) else {
      throw NSError(domain: "OpenAGI.replay", code: 6, userInfo: [NSLocalizedDescriptionKey: "unknown key '\(name)'"])
    }
    let src = CGEventSource(stateID: .hidSystemState)
    if let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true) {
      down.flags = modifiers
      down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) {
      up.flags = modifiers
      up.post(tap: .cghidEventTap)
    }
  }

  private func sendType(_ text: String) throws {
    let src = CGEventSource(stateID: .hidSystemState)
    for char in text.unicodeScalars {
      let utf16 = String(char).utf16
      let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
      let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
      down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: Array(utf16))
      up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: Array(utf16))
      down?.post(tap: .cghidEventTap)
      up?.post(tap: .cghidEventTap)
    }
  }

  private func keyCode(for name: String) -> CGKeyCode? {
    let n = name.lowercased()
    let map: [String: CGKeyCode] = [
      "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
      "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
      "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
      "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
      "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
      "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
      ",": 43, ".": 47, "/": 44, ";": 41, "'": 39, "[": 33, "]": 30, "-": 27, "=": 24, "`": 50
    ]
    return map[n]
  }

  private func stringValue(_ v: Any) -> String {
    if let s = v as? String { return s }
    return "\(v)"
  }

  private func describe(_ v: Any) -> String {
    if let s = v as? String { return "\"\(s.prefix(60))\"" }
    return "\(v)"
  }
}
