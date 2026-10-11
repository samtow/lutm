// Included inside namespace cuttlefish by the managed source patch.
// Client containers and modem dispatch belong exclusively to the monitor thread.

namespace {
// Bound a slow reader's memory use without silently truncating AT responses.
constexpr size_t kMaxPendingResponseBytes = 256 * 1024;

bool MakeNonblocking(SharedFD fd) {
  const int flags = fd->Fcntl(F_GETFL, 0);
  return flags >= 0 && fd->Fcntl(F_SETFL, flags | O_NONBLOCK) == 0;
}
}  // namespace

void Client::SendCommandResponse(std::string response) const {
  if (response.empty()) return;
  if (response.back() != '\r') response += '\r';
  std::function<void()> wake;
  {
    std::lock_guard<std::mutex> lock(write_mutex);
    if (write_failed_) return;
    if (response.size() > kMaxPendingResponseBytes ||
        pending_output_.size() > kMaxPendingResponseBytes - response.size()) {
      LOG(ERROR) << "Disconnecting slow modem client: response buffer limit";
      pending_output_.clear();
      write_failed_ = true;
    } else {
      pending_output_ += response;
    }
    wake = wake_monitor_;
  }
  if (wake) wake();
}

bool Client::HasPendingOutput() const {
  std::lock_guard<std::mutex> lock(write_mutex);
  return !pending_output_.empty();
}

bool Client::WriteFailed() const {
  std::lock_guard<std::mutex> lock(write_mutex);
  return write_failed_;
}

void Client::FlushPendingOutput() const {
  std::lock_guard<std::mutex> lock(write_mutex);
  size_t sent = 0;
  while (sent < pending_output_.size()) {
    const auto count = client_write_fd_->Write(
        pending_output_.data() + sent, pending_output_.size() - sent);
    if (count > 0) {
      sent += static_cast<size_t>(count);
      continue;
    }
    const int error = client_write_fd_->GetErrno();
    if (count < 0 && error == EINTR) continue;
    if (count < 0 && (error == EAGAIN || error == EWOULDBLOCK)) break;
    write_failed_ = true;
    pending_output_.clear();
    return;
  }
  pending_output_.erase(0, sent);
}

void ChannelMonitor::WakeMonitor() {
  std::lock_guard<std::mutex> lock(wake_mutex_);
  if (!wake_pipe_ready_) {
    if (!write_pipe_->IsOpen() || !MakeNonblocking(write_pipe_)) {
      LOG(FATAL) << "Unable to initialize monitor wake pipe";
    }
    wake_pipe_ready_ = true;
  }
  ssize_t count;
  do {
    count = write_pipe_->Write("W", 1);
  } while (count < 0 && write_pipe_->GetErrno() == EINTR);
  if (count != 1 && write_pipe_->GetErrno() != EAGAIN &&
      write_pipe_->GetErrno() != EWOULDBLOCK) {
    LOG(FATAL) << "Unable to wake monitor: " << write_pipe_->StrError();
  }
  // A full pipe is already readable: notifications may safely coalesce.
}

void ChannelMonitor::QueueCommand(std::function<void()> command) {
  {
    std::lock_guard<std::mutex> lock(pending_mutex_);
    if (stopping_.load()) {
      LOG(DEBUG) << "Ignoring command during monitor shutdown";
      return;
    }
    pending_commands_.push_back(std::move(command));
  }
  WakeMonitor();
}

void ChannelMonitor::DrainCommands() {
  std::deque<std::function<void()>> commands;
  bool more;
  {
    std::lock_guard<std::mutex> lock(pending_mutex_);
    // Bound work so a burst of control requests cannot starve RIL reads or EOF
    // cleanup. In particular, broadcasts must not accumulate dead clients.
    while (!pending_commands_.empty() && commands.size() < 64) {
      commands.push_back(std::move(pending_commands_.front()));
      pending_commands_.pop_front();
    }
    more = !pending_commands_.empty();
  }
  for (auto& command : commands) {
    if (stopping_.load()) break;
    command();
  }
  if (more) WakeMonitor();
}

ClientId ChannelMonitor::SetRemoteClient(SharedFD fd, bool is_accepted) {
  // Keep the upstream API, but never read eagerly: accepted sockets may be
  // blocking and the peer is not required to have sent its first command yet.
  (void)is_accepted;
  ClientId id;
  QueueCommand([this, fd, id]() {
    if (!fd->IsOpen() || !MakeNonblocking(fd)) {
      LOG(ERROR) << "Unable to register remote modem client";
      return;
    }
    auto client = std::make_unique<Client>(id, fd, Client::REMOTE);
    client->SetWakeCallback([this]() { WakeMonitor(); });
    remote_clients_.push_back(std::move(client));
  });
  return id;
}

void ChannelMonitor::SendUnsolicitedCommand(std::string& response) {
  QueueCommand([this, response]() {
    if (!clients_.empty() && clients_.front()->is_valid) {
      clients_.front()->SendCommandResponse(response);
    }
  });
}

void ChannelMonitor::SendRemoteCommand(ClientId id, std::string& response) {
  QueueCommand([this, id, response]() {
    for (auto& client : remote_clients_) {
      if (client->is_valid && client->Id() == id) {
        client->SendCommandResponse(response);
        return;
      }
    }
  });
}

void ChannelMonitor::SendCommandToRemoteClients(std::string& response) {
  QueueCommand([this, response]() {
    for (auto& client : remote_clients_) {
      if (client->is_valid) client->SendCommandResponse(response);
    }
  });
}

void ChannelMonitor::CloseRemoteConnection(ClientId id) {
  QueueCommand([this, id]() {
    for (auto& client : remote_clients_) {
      if (client->Id() == id) {
        client->client_read_fd_->Close();
        client->client_write_fd_->Close();
        client->is_valid = false;
        return;
      }
    }
  });
}

ChannelMonitor::~ChannelMonitor() {
  stopping_.store(true);
  WakeMonitor();
  if (monitor_thread_.joinable()) monitor_thread_.join();
}

void ChannelMonitor::AcceptIncomingConnection() {
  auto fd = SharedFD::Accept(*server_);
  if (!fd->IsOpen() || !MakeNonblocking(fd)) {
    LOG(ERROR) << "Unable to accept RIL client: " << fd->StrError();
    return;
  }
  auto client = std::make_unique<Client>(fd);
  client->SetWakeCallback([this]() { WakeMonitor(); });
  clients_.push_back(std::move(client));
  if (clients_.size() == 1) modem_.OnFirstClientConnected();
}

void ChannelMonitor::MonitorLoop() {
  LOG(INFO) << "Virtio control clients use the serialized monitor queue";
  while (!stopping_.load()) {
    DrainCommands();
    removeInvalidClients(clients_);
    removeInvalidClients(remote_clients_);
    if (stopping_.load()) break;

    SharedFDSet read_set, write_set;
    read_set.Set(server_);
    read_set.Set(read_pipe_);
    for (auto& client : clients_) {
      if (client->is_valid) {
        read_set.Set(client->client_read_fd_);
        if (client->HasPendingOutput()) write_set.Set(client->client_write_fd_);
      }
    }
    for (auto& client : remote_clients_) {
      if (client->is_valid) {
        read_set.Set(client->client_read_fd_);
        if (client->HasPendingOutput()) write_set.Set(client->client_write_fd_);
      }
    }
    int ready = cuttlefish::Select(&read_set, &write_set, nullptr, nullptr);
    if (ready < 0) {
      if (errno == EINTR) continue;
      LOG(ERROR) << "Select failed: " << strerror(errno);
      break;
    }
    if (read_set.IsSet(read_pipe_)) {
      char notification;
      read_pipe_->Read(&notification, sizeof(notification));
    }
    if (stopping_.load()) break;
    if (read_set.IsSet(server_)) AcceptIncomingConnection();
    for (auto* clients : {&clients_, &remote_clients_}) {
      for (auto& client : *clients) {
        if (!client->is_valid) continue;
        const bool read_ready = read_set.IsSet(client->client_read_fd_);
        if (read_ready) ReadCommand(*client);
        // Also flush responses produced by this iteration's command dispatch.
        // Every client socket is nonblocking; EAGAIN keeps the exact suffix.
        if (client->is_valid && client->HasPendingOutput() &&
            (read_ready || write_set.IsSet(client->client_write_fd_))) {
          client->FlushPendingOutput();
        }
        if (client->WriteFailed()) {
          client->client_read_fd_->Close();
          client->client_write_fd_->Close();
          client->is_valid = false;
        }
      }
    }
  }
}
