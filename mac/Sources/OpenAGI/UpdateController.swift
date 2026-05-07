import Foundation
import Sparkle

// Sparkle wrapper. Reads SUFeedURL + SUPublicEDKey from Info.plist.
// Daily background check; user can also trigger from the tray menu.

final class UpdateController: NSObject {
  static let shared = UpdateController()

  private let updaterController: SPUStandardUpdaterController

  override init() {
    self.updaterController = SPUStandardUpdaterController(
      startingUpdater: false,
      updaterDelegate: nil,
      userDriverDelegate: nil
    )
    super.init()
  }

  func start() {
    updaterController.updater.automaticallyChecksForUpdates = true
    updaterController.updater.updateCheckInterval = 60 * 60 * 24 // daily
    updaterController.startUpdater()
  }

  func checkForUpdates() {
    updaterController.checkForUpdates(nil)
  }
}
