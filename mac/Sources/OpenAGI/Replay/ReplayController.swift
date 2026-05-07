import AppKit
import Foundation
import UserNotifications

// Subscribes to /events SSE for `replay` op:request messages, prompts the
// user to confirm (first run / always), then executes the action steps and
// posts the outcome back to /skills/replay-result/<jobId>.

@MainActor
final class ReplayController {
  static let shared = ReplayController()

  private var sseTask: URLSessionDataTask?
  private var session: URLSession?
  private let executor = ActionExecutor()
  private var seenJobs = Set<String>()
  private var trustedSkills: Set<String> = ReplayController.loadTrustedSkills()

  func start() {
    stop()
    guard let token = AppState.shared.authToken() else {
      // Will be retried when token becomes available.
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.start() }
      return
    }
    let url = AppState.shared.baseURL.appendingPathComponent("events")
    var req = URLRequest(url: url)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 0
    cfg.timeoutIntervalForResource = 0
    let s = URLSession(configuration: cfg, delegate: ReplaySSEDelegate.shared, delegateQueue: .main)
    self.session = s
    self.sseTask = s.dataTask(with: req)
    self.sseTask?.resume()
  }

  func stop() {
    sseTask?.cancel()
    session?.invalidateAndCancel()
  }

  /// Called from the SSE delegate when a `replay` event arrives.
  func handleReplay(eventData: String) {
    guard let data = eventData.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    guard json["op"] as? String == "request",
          let jobId = json["jobId"] as? String,
          let steps = json["steps"] as? [[String: Any]] else { return }
    if seenJobs.contains(jobId) { return }
    seenJobs.insert(jobId)
    let dryRun = (json["dryRun"] as? Bool) ?? false
    let confirm = (json["confirm"] as? String) ?? "first-run"
    let skill = json["skill"] as? String

    Task { @MainActor in
      let approved = await self.shouldRun(skill: skill, steps: steps, dryRun: dryRun, confirm: confirm)
      if !approved {
        await self.postResult(jobId: jobId, payload: ["error": "user-rejected", "skill": skill ?? NSNull()])
        return
      }
      let outcome = await self.executor.run(steps: steps, dryRun: dryRun)
      if outcome.error == nil, let s = skill {
        self.markTrusted(skill: s)
      }
      var payload: [String: Any] = [
        "jobId": jobId,
        "skill": skill ?? NSNull(),
        "dryRun": dryRun,
        "stepsExecuted": outcome.executed,
        "log": outcome.log
      ]
      if let err = outcome.error { payload["error"] = err }
      await self.postResult(jobId: jobId, payload: payload)
    }
  }

  // MARK: — confirmation

  private func shouldRun(skill: String?, steps: [[String: Any]], dryRun: Bool, confirm: String) async -> Bool {
    if dryRun { return true }
    if confirm == "never" { return true }
    if confirm == "always" { return await self.confirmModal(skill: skill, steps: steps) }
    // first-run: skip confirmation if we've previously trusted this skill.
    if let s = skill, trustedSkills.contains(s) { return true }
    return await self.confirmModal(skill: skill, steps: steps)
  }

  private func confirmModal(skill: String?, steps: [[String: Any]]) async -> Bool {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "Run skill" + (skill.map { ": \($0)" } ?? "") + "?"
    alert.informativeText = "OpenAGI is about to execute \(steps.count) action\(steps.count == 1 ? "" : "s") on your Mac:\n\n" +
      steps.prefix(8).enumerated().map { (i, s) in "\(i + 1). \(describe(step: s))" }.joined(separator: "\n") +
      (steps.count > 8 ? "\n…and \(steps.count - 8) more" : "")
    alert.alertStyle = .informational
    alert.addButton(withTitle: "Run")
    alert.addButton(withTitle: "Dry run only")
    alert.addButton(withTitle: "Cancel")
    let response = alert.runModal()
    return response == .alertFirstButtonReturn
  }

  private func describe(step: [String: Any]) -> String {
    if let kv = step.first {
      let v = kv.value
      let valStr: String
      if let s = v as? String { valStr = "\"\(s.prefix(50))\"" }
      else if let d = v as? Double { valStr = "\(d)" }
      else { valStr = "\(v)" }
      return "\(kv.key) → \(valStr)"
    }
    return "(empty step)"
  }

  // MARK: — trust persistence

  private static var trustFile: URL {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    return support.appendingPathComponent("OpenAGI/replay-trusted-skills.json", isDirectory: false)
  }

  private static func loadTrustedSkills() -> Set<String> {
    guard let data = try? Data(contentsOf: trustFile),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [String] else { return [] }
    return Set(arr)
  }

  private func markTrusted(skill: String) {
    if trustedSkills.contains(skill) { return }
    trustedSkills.insert(skill)
    let arr = Array(trustedSkills).sorted()
    if let data = try? JSONSerialization.data(withJSONObject: arr, options: [.prettyPrinted]) {
      try? data.write(to: ReplayController.trustFile, options: [.atomic])
    }
  }

  // MARK: — result POST

  private func postResult(jobId: String, payload: [String: Any]) async {
    guard let token = AppState.shared.authToken() else { return }
    let url = AppState.shared.baseURL.appendingPathComponent("skills/replay-result/\(jobId)")
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
    _ = try? await URLSession.shared.data(for: req)
  }
}
