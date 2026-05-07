import Foundation

// SSE delegate dedicated to the replay channel. Runs alongside AppState's
// SSEDelegate (each task has its own URLSession) so we don't interfere
// with notification routing.

final class ReplaySSEDelegate: NSObject, URLSessionDataDelegate {
  static let shared = ReplaySSEDelegate()

  private var buffer = ""

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let chunk = String(data: data, encoding: .utf8) else { return }
    buffer += chunk
    while let nl = buffer.range(of: "\n\n") {
      let block = String(buffer[..<nl.lowerBound])
      buffer.removeSubrange(buffer.startIndex..<nl.upperBound)
      parseAndDispatch(block)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      ReplayController.shared.start()
    }
  }

  private func parseAndDispatch(_ block: String) {
    var event = "message"
    var data = ""
    for raw in block.split(separator: "\n") {
      let line = String(raw)
      if line.hasPrefix("event:") {
        event = line.dropFirst("event:".count).trimmingCharacters(in: .whitespaces)
      } else if line.hasPrefix("data:") {
        data += line.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
      }
    }
    if event == "replay" && !data.isEmpty {
      Task { @MainActor in ReplayController.shared.handleReplay(eventData: data) }
    }
  }
}
