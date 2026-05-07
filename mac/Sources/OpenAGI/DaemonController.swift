import Foundation

// Manages the lifecycle of the bundled Node daemon. Spawns once at app launch,
// passes data dir + port via env, captures stdout/stderr to a log file, kills
// it cleanly on quit.

final class DaemonController {
  static let shared = DaemonController()

  private var process: Process?
  private var logHandle: FileHandle?

  private var bundleResources: URL {
    Bundle.main.resourceURL ?? URL(fileURLWithPath: ".")
  }

  private var nodeBinary: URL {
    bundleResources.appendingPathComponent("node/bin/node")
  }

  private var entrypoint: URL {
    bundleResources.appendingPathComponent("openAGI/examples/hosted-server.js")
  }

  private var dataDir: URL {
    AppState.dataDir()
  }

  private var logFile: URL {
    dataDir.appendingPathComponent("daemon.log")
  }

  func start() {
    guard process == nil else { return }
    if !FileManager.default.fileExists(atPath: nodeBinary.path) {
      NSLog("OpenAGI: missing bundled Node binary at \(nodeBinary.path)")
      return
    }
    if !FileManager.default.fileExists(atPath: entrypoint.path) {
      NSLog("OpenAGI: missing JS entrypoint at \(entrypoint.path)")
      return
    }

    if !FileManager.default.fileExists(atPath: logFile.path) {
      FileManager.default.createFile(atPath: logFile.path, contents: nil)
    }
    logHandle = try? FileHandle(forWritingTo: logFile)
    logHandle?.seekToEndOfFile()

    let proc = Process()
    proc.executableURL = nodeBinary
    proc.arguments = [entrypoint.path]
    proc.currentDirectoryURL = dataDir

    var env = ProcessInfo.processInfo.environment
    env["OPENAGI_DATA_DIR"] = dataDir.path
    env["HOST"] = "127.0.0.1"
    env["PORT"] = "43210"
    proc.environment = env

    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    proc.standardOutput = stdoutPipe
    proc.standardError = stderrPipe
    stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      if !d.isEmpty { self?.logHandle?.write(d) }
    }
    stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      if !d.isEmpty { self?.logHandle?.write(d) }
    }
    proc.terminationHandler = { [weak self] p in
      NSLog("OpenAGI: daemon exited with \(p.terminationStatus)")
      // Auto-restart on unexpected exit (e.g. crash) after a backoff.
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
        if self?.process != nil { self?.process = nil; self?.start() }
      }
    }

    do {
      try proc.run()
      process = proc
      NSLog("OpenAGI: daemon started (pid \(proc.processIdentifier))")
    } catch {
      NSLog("OpenAGI: failed to launch daemon: \(error)")
    }
  }

  func stop() {
    guard let proc = process else { return }
    process = nil
    proc.terminationHandler = nil
    proc.terminate()
    // Give it a moment, then SIGKILL if still alive
    DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
      if proc.isRunning { kill(proc.processIdentifier, SIGKILL) }
    }
  }

  func restart() {
    stop()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.start() }
  }
}
