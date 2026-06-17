import Foundation

// Durable consumer of a remote "main" Distiller's proactive-outreach feed.
//
// This points at a SEPARATE host from AppState's local daemon (the remote main
// the user designates), so it keeps its own baseURL/token and its own SSE
// connection rather than piggybacking on SSEDelegate.shared (which is hardwired
// to the local /events stream).
//
// Losslessness comes from the cursor: every item has a monotonic `seq`. We
// persist the highest seq we've folded in (`outreachCursor`) and, on every
// (re)connect, pull `GET /outreach/feed?since=<cursor>` to catch up everything
// that fired while we were offline. The SSE "outreach" event is only a nudge to
// re-pull — the cursor stays authoritative.
@MainActor
final class OutreachConsumer: ObservableObject {
  static let shared = OutreachConsumer()

  @Published private(set) var items: [OutreachItem] = []
  @Published private(set) var configured: Bool = false

  private var baseURL: URL?
  private var token: String = ""
  private var sse: OutreachSSEDelegate?
  private var sseSession: URLSession?

  private var cursor: Int { UserDefaults.standard.integer(forKey: "outreachCursor") }
  private func setCursor(_ v: Int) { UserDefaults.standard.set(v, forKey: "outreachCursor") }

  // Point the consumer at a remote main and start backfill + live stream.
  // Safe to call repeatedly (e.g. when the user changes the URL in settings).
  func reconfigure(url: String, token: String) {
    self.baseURL = URL(string: url)
    self.token = token
    self.configured = (self.baseURL != nil)
    guard configured else { return }
    Task { await backfill() }
    startSSE()
  }

  private func authed(_ req: inout URLRequest) {
    if !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
  }

  // Pull everything we missed since our last cursor — lossless on reconnect.
  func backfill() async {
    guard let base = baseURL else { return }
    var comps = URLComponents(url: base.appendingPathComponent("outreach/feed"), resolvingAgainstBaseURL: false)
    comps?.queryItems = [URLQueryItem(name: "since", value: String(cursor))]
    guard let feedURL = comps?.url else { return }
    var req = URLRequest(url: feedURL)
    authed(&req)
    do {
      let (data, _) = try await URLSession.shared.data(for: req)
      let feed = try JSONDecoder().decode(OutreachFeedResponse.self, from: data)
      ingest(feed.items)
      if feed.cursor > cursor { setCursor(feed.cursor) }
    } catch {
      // Offline / unreachable: keep the cursor and retry on the next SSE
      // reconnect or reconfigure. Nothing is lost.
    }
  }

  private func ingest(_ incoming: [OutreachItem]) {
    for item in incoming.sorted(by: { $0.seq < $1.seq }) {
      // Drop items already resolved server-side; only surface live ones.
      let resolved = (item.status == "acted" || item.status == "dismissed")
      if resolved {
        items.removeAll { $0.id == item.id }
        continue
      }
      if items.contains(where: { $0.id == item.id }) { continue }
      items.insert(item, at: 0)
      NotificationPresenter.shared.present(item)
    }
  }

  func act(_ id: String, action: String, note: String? = nil) async {
    var body: [String: Any] = ["action": action]
    if let note { body["note"] = note }
    await post("outreach/\(id)/act", body: body)
    items.removeAll { $0.id == id }
  }

  func reply(_ id: String, text: String) async {
    await post("outreach/\(id)/reply", body: ["text": text])
    items.removeAll { $0.id == id }
  }

  private func post(_ pathPart: String, body: [String: Any]) async {
    guard let base = baseURL else { return }
    var req = URLRequest(url: base.appendingPathComponent(pathPart))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    authed(&req)
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    _ = try? await URLSession.shared.data(for: req)
  }

  private func startSSE() {
    // Tear down the previous session before creating a new one so reconnects
    // and reconfigures don't leak sessions or leave overlapping streams.
    sseSession?.invalidateAndCancel()
    sseSession = nil
    sse = nil

    guard let base = baseURL else { return }
    let url = base.appendingPathComponent("events")
    var req = URLRequest(url: url)
    authed(&req)
    let delegate = OutreachSSEDelegate()
    self.sse = delegate
    self.sseSession = delegate.start(req)
  }

  // Called by the SSE delegate after a disconnect: re-pull (lossless) and
  // re-establish the live stream so we keep getting nudges.
  func reconnectSSE() {
    Task { await backfill() }
    startSSE()
  }
}

// Dedicated SSE listener for the remote main's /events stream. On any
// "outreach" / "outreach-resolved" event it asks the consumer to re-pull the
// feed (cursor stays authoritative). Auto-reconnects with a 5s backoff.
final class OutreachSSEDelegate: NSObject, URLSessionDataDelegate {
  private var buffer = ""
  private var session: URLSession?
  private var task: URLSessionDataTask?

  @discardableResult
  func start(_ req: URLRequest) -> URLSession {
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 0
    cfg.timeoutIntervalForResource = 0
    let session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    self.session = session
    let task = session.dataTask(with: req)
    self.task = task
    task.resume()
    return session
  }

  func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let chunk = String(data: data, encoding: .utf8) else { return }
    buffer += chunk
    while let nl = buffer.range(of: "\n\n") {
      let block = String(buffer[..<nl.lowerBound])
      buffer.removeSubrange(buffer.startIndex..<nl.upperBound)
      var event = "message"
      for raw in block.split(separator: "\n") {
        let line = String(raw)
        if line.hasPrefix("event:") {
          event = line.dropFirst("event:".count).trimmingCharacters(in: .whitespaces)
        }
      }
      if event == "outreach" || event == "outreach-resolved" {
        Task { @MainActor in await OutreachConsumer.shared.backfill() }
      }
    }
  }

  func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    // Reconnect through the consumer so a fresh request (current token/URL) is
    // built and a NEW live stream is established; backfill on reconnect catches
    // up anything missed while down.
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
      Task { @MainActor in OutreachConsumer.shared.reconnectSSE() }
    }
  }
}
