import AppKit
import Foundation
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  private let daemon = DaemonController.shared
  private let updater = UpdateController.shared

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory) // No Dock icon, only menubar.

    UNUserNotificationCenter.current().delegate = self
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

    daemon.start()
    AppState.shared.startPolling()
    AppState.shared.startSSE()
    updater.start()
  }

  func applicationWillTerminate(_ notification: Notification) {
    daemon.stop()
  }

  // Tap a notification → open the dashboard, deep-linked when possible.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    let path = info["path"] as? String ?? "/"
    AppState.shared.openDashboard(path: path)
    completionHandler()
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }
}
