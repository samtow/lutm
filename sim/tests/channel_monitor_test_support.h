#pragma once
// POSIX-backed host bindings for testing the actual patched monitor source.
#include <atomic>
#include <cerrno>
#include <cstring>
#include <functional>
#include <memory>
#include <mutex>
#include <poll.h>
#include <string>
#include <sys/socket.h>
#include <unistd.h>
#include <fcntl.h>
#include <vector>
#include <cstdlib>

namespace monitor_test {
struct Log {
  explicit Log(const char* severity) : fatal(std::string(severity) == "FATAL") {}
  ~Log() { if (fatal) std::abort(); }
  template <typename T> Log& operator<<(const T&) { return *this; }
  bool fatal;
};
}
#define LOG(level) monitor_test::Log(#level)

namespace android::base {
inline std::string StringReplace(std::string value, const std::string& from,
                                 const std::string& to, bool all) {
  size_t position = 0;
  while ((position = value.find(from, position)) != std::string::npos) {
    value.replace(position, from.size(), to);
    position += to.size();
    if (!all) break;
  }
  return value;
}
}

namespace cuttlefish {
class FileInstance {
 public:
  explicit FileInstance(int fd = -1) : fd_(fd) {}
  ~FileInstance() { Close(); }
  bool IsOpen() const { return fd_.load() >= 0; }
  int FD() const { return fd_.load(); }
  void Close() {
    int fd = fd_.exchange(-1);
    if (fd >= 0) close(fd);
  }
  ssize_t Read(void* buffer, size_t size) {
    ssize_t result = read(FD(), buffer, size);
    error_.store(result < 0 ? errno : 0);
    return result;
  }
  ssize_t Write(const void* buffer, size_t size) {
    ssize_t result = write(FD(), buffer, size);
    error_.store(result < 0 ? errno : 0);
    return result;
  }
  int Fcntl(int command, int value) {
    int result = fcntl(FD(), command, value);
    error_.store(result < 0 ? errno : 0);
    return result;
  }
  int GetErrno() const { return error_.load(); }
  std::string StrError() const { return strerror(GetErrno()); }
 private:
  std::atomic<int> fd_;
  std::atomic<int> error_{0};
};

class SharedFD {
 public:
  SharedFD() : instance_(std::make_shared<FileInstance>()) {}
  static SharedFD Own(int fd) { return SharedFD(std::make_shared<FileInstance>(fd)); }
  FileInstance* operator->() const { return instance_.get(); }
  FileInstance& operator*() const { return *instance_; }
  bool operator==(const SharedFD& other) const { return instance_ == other.instance_; }
  static bool Pipe(SharedFD* read_fd, SharedFD* write_fd) {
    int fds[2];
    if (pipe(fds)) return false;
    *read_fd = Own(fds[0]); *write_fd = Own(fds[1]);
    return true;
  }
  static SharedFD Accept(const FileInstance& server) {
    return Own(accept(server.FD(), nullptr, nullptr));
  }
 private:
  explicit SharedFD(std::shared_ptr<FileInstance> instance) : instance_(std::move(instance)) {}
  std::shared_ptr<FileInstance> instance_;
};

inline ssize_t WriteAll(SharedFD fd, const std::string& value) {
  size_t offset = 0;
  while (offset < value.size()) {
    ssize_t count = fd->Write(value.data() + offset, value.size() - offset);
    if (count < 0 && fd->GetErrno() == EINTR) continue;
    if (count <= 0) return -1;
    offset += count;
  }
  return offset;
}

class SharedFDSet {
 public:
  void Set(SharedFD fd) { if (fd->IsOpen()) members.push_back(fd); }
  bool IsSet(SharedFD fd) const {
    for (const auto& ready : readable) if (ready == fd) return true;
    for (const auto& ready : writable) if (ready == fd) return true;
    return false;
  }
  std::vector<SharedFD> members, writable, readable;
};

inline int Select(SharedFDSet* reads, SharedFDSet* writes, SharedFDSet*, void*) {
  std::vector<pollfd> fds;
  std::vector<SharedFD> descriptors;
  auto add = [&](SharedFD fd, short event) {
    for (size_t index = 0; index < descriptors.size(); ++index) {
      if (descriptors[index] == fd) {
        fds[index].events = static_cast<short>(fds[index].events | event);
        return;
      }
    }
    descriptors.push_back(fd);
    fds.push_back({fd->FD(), event, 0});
  };
  for (auto fd : reads->members) add(fd, POLLIN);
  if (writes) for (auto fd : writes->members) add(fd, POLLOUT);
  int result = poll(fds.data(), fds.size(), -1);
  if (result > 0) {
    for (size_t index = 0; index < fds.size(); ++index) {
      if (fds[index].revents & (POLLIN | POLLHUP | POLLERR)) {
        if (reads) reads->readable.push_back(descriptors[index]);
      }
      if (writes && fds[index].revents & (POLLOUT | POLLERR)) {
        writes->writable.push_back(descriptors[index]);
      }
    }
  }
  return result;
}

class Client;
class ModemSimulator {
 public:
  bool IsWaitingSmsPdu() const { return false; }
  void OnFirstClientConnected() {}
  void DispatchCommand(Client& client, std::string command) {
    handler(client, std::move(command));
  }
  std::function<void(Client&, std::string)> handler;
};
}
