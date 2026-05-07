import AppKit
import SwiftUI

@main
struct OpenAGIApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
  @StateObject private var state = AppState.shared

  var body: some Scene {
    MenuBarExtra {
      TrayMenu(state: state)
    } label: {
      TrayLabel(state: state)
    }
    .menuBarExtraStyle(.menu)
  }
}
