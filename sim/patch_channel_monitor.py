#!/usr/bin/env python3
"""Install the single-owner client queue; --check only validates its provenance."""
from pathlib import Path
import re
import sys

IMPLEMENTATION = Path(__file__).parent / "overlay/modem_simulator/channel_monitor_concurrency.inc"
INCLUDE = '#include "channel_monitor_concurrency.inc"'
REFERENCE = Path(__file__).parent / "reference/modem_simulator/host/commands/modem_simulator"
FIELDS = """  // Only MonitorLoop accesses clients_ and remote_clients_.
  std::mutex pending_mutex_;
  std::mutex wake_mutex_;
  bool wake_pipe_ready_ = false;
  std::deque<std::function<void()>> pending_commands_;
  std::atomic<bool> stopping_{false};
  void QueueCommand(std::function<void()> command);
  void DrainCommands();
  void WakeMonitor();
"""


def replace(text, old, new):
    if new in text:
        return text
    if text.count(old) != 1:
        raise ValueError(f"unsupported monitor source near {old[:75]!r}")
    return text.replace(old, new, 1)


def remove_function(text, signature):
    # Only used after matching the complete supported reference source. Its
    # function closing braces are at column zero; braces in strings/comments
    # must not be counted as C++ syntax.
    pattern = re.compile(re.escape(signature) + r".*?^}\n", re.MULTILINE | re.DOTALL)
    if text.count(signature) != 1 or len(pattern.findall(text)) != 1:
        raise ValueError(f"missing or duplicate monitor method: {signature}")
    return pattern.sub("", text, count=1)


def check(root):
    root = Path(root)
    expected = render(
        (REFERENCE / "channel_monitor.h").read_text(),
        (REFERENCE / "channel_monitor.cpp").read_text(),
    )
    return all((root / name).is_file() and (root / name).read_text() == content
               for name, content in expected.items())


def render(header, cpp):
    """Validate all input before producing any filesystem changes."""
    for name, content in (("channel_monitor.h", header), ("channel_monitor.cpp", cpp)):
        if content != (REFERENCE / name).read_text():
            raise ValueError(
                f"{name}: unsupported source; update the tested reference before patching"
            )
    header = replace(header, "#include <mutex>",
                     "#include <atomic>\n#include <deque>\n#include <functional>\n#include <mutex>\n#include <utility>")
    header = replace(header, "static size_t next_id_;", "static std::atomic<size_t> next_id_;")
    header = replace(header, "  Client(SharedFD fd, ClientType client_type);",
                     "  Client(SharedFD fd, ClientType client_type);\n  Client(ClientId id, SharedFD fd, ClientType client_type);")
    header = replace(header, "  std::thread monitor_thread_;", "  std::thread monitor_thread_;\n" + FIELDS)
    header = replace(header, "  bool first_read_command_;  // Only used when ClientType::REMOTE",
                      """  mutable std::string pending_output_;
  mutable bool write_failed_ = false;
  mutable std::function<void()> wake_monitor_;
  void SetWakeCallback(std::function<void()> callback) {
    std::lock_guard<std::mutex> lock(write_mutex);
    wake_monitor_ = std::move(callback);
  }
  void FlushPendingOutput() const;
  bool HasPendingOutput() const;
  bool WriteFailed() const;""")
    cpp = replace(cpp, "#include <algorithm>", "#include <algorithm>\n#include <cerrno>\n#include <fcntl.h>")
    cpp = replace(cpp, "size_t ClientId::next_id_ = 0;", "std::atomic<size_t> ClientId::next_id_{0};")
    cpp = replace(cpp, "  id_ = next_id_;\n  next_id_++;", "  id_ = next_id_.fetch_add(1, std::memory_order_relaxed);")
    constructor = "Client::Client(SharedFD fd) : client_read_fd_(fd), client_write_fd_(fd) {}"
    cpp = replace(cpp, constructor, constructor + """

Client::Client(ClientId id, SharedFD fd, ClientType client_type)
    : id_(id), type(client_type), client_read_fd_(fd), client_write_fd_(fd) {}
""")
    old_erase = """    // Erase client from the vector clients
    auto& clients = client.type == Client::REMOTE ? remote_clients_ : clients_;
    auto iter = std::find_if(
        clients.begin(), clients.end(),
        [&](std::unique_ptr<Client>& other) { return *other == client; });
    if (iter != clients.end()) {
      clients.erase(iter);
    }"""
    cpp = replace(cpp, old_erase, """    // Defer destruction until the monitor is no longer iterating.
    client.is_valid = false;""")
    cpp = replace(cpp, "commands.append(buffer.data());",
                  "commands.append(buffer.data(), static_cast<size_t>(bytes_read));")
    cpp = replace(cpp, "auto commands = std::string{incomplete_command.data()};",
                  "auto commands = incomplete_command;")
    cpp = replace(cpp, "  incomplete_command.clear();", """  incomplete_command.clear();
  if (commands.size() > 64 * 1024) {
    LOG(ERROR) << "Disconnecting modem client: command buffer limit";
    client.client_read_fd_->Close();
    client.client_write_fd_->Close();
    client.is_valid = false;
    return;
  }""")
    cpp = replace(cpp, "if (errno == EAGAIN && client.type == Client::REMOTE &&\n        client.first_read_command_)",
                  "if (bytes_read < 0 &&\n        (client.client_read_fd_->GetErrno() == EAGAIN ||\n         client.client_read_fd_->GetErrno() == EWOULDBLOCK ||\n         client.client_read_fd_->GetErrno() == EINTR))")
    for signature in (
        "void Client::SendCommandResponse(std::string response)",
        "void ChannelMonitor::AcceptIncomingConnection(",
        "ClientId ChannelMonitor::SetRemoteClient(",
        "void ChannelMonitor::SendUnsolicitedCommand(",
        "void ChannelMonitor::SendRemoteCommand(",
        "void ChannelMonitor::SendCommandToRemoteClients(",
        "void ChannelMonitor::CloseRemoteConnection(",
        "ChannelMonitor::~ChannelMonitor(",
        "void ChannelMonitor::MonitorLoop(",
    ):
        cpp = remove_function(cpp, signature)
    cpp = replace(cpp, "}  // namespace cuttlefish", INCLUDE + "\n\n}  // namespace cuttlefish")
    return {
        "channel_monitor.h": header,
        "channel_monitor.cpp": cpp,
        "channel_monitor_concurrency.inc": IMPLEMENTATION.read_text(),
    }


def apply(root):
    cpp = (root / "channel_monitor.cpp").read_text()
    if INCLUDE in cpp:
        if not check(root):
            raise ValueError("incomplete or modified concurrency patch")
        return False
    updates = render((root / "channel_monitor.h").read_text(), cpp)
    for name, content in updates.items():
        (root / name).write_text(content)
    return True


if __name__ == "__main__":
    try:
        check_only = len(sys.argv) == 3 and sys.argv[1] == "--check"
        if check_only:
            if not check(Path(sys.argv[2])):
                raise ValueError("concurrency patch is absent or invalid")
            print("channel monitor concurrency patch verified")
        elif len(sys.argv) == 2:
            changed = apply(Path(sys.argv[1]))
            print("channel monitor concurrency patch " + ("applied" if changed else "already applied"))
        else:
            raise ValueError("usage: patch_channel_monitor.py [--check] source-directory")
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
