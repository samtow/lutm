#include "host/commands/modem_simulator/channel_monitor.h"
#include "channel_monitor_test_support.h"
#include <cassert>
#include <chrono>
#include <csignal>
#include <iostream>
#include <sys/un.h>
#include <thread>
#include <sys/socket.h>

using namespace cuttlefish;

int main() {
  signal(SIGPIPE, SIG_IGN);
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::string name = "monitor-race-test-" + std::to_string(getpid());
  memcpy(address.sun_path + 1, name.data(), name.size());
  auto length = static_cast<socklen_t>(offsetof(sockaddr_un, sun_path) + 1 + name.size());
  int listener = socket(AF_UNIX, SOCK_STREAM, 0);
  assert(listener >= 0);
  assert(bind(listener, reinterpret_cast<sockaddr*>(&address), length) == 0);
  assert(listen(listener, 8) == 0);
  auto server = SharedFD::Own(listener);
  ModemSimulator modem;
  std::atomic<int> received{0};
  auto monitor = std::make_unique<ChannelMonitor>(modem, server);
  modem.handler = [&](Client& client, std::string command) {
    received++;
    if (command == "CLOSE") {
      monitor->CloseRemoteConnection(client.Id());
    } else if (command == "BULK") {
      for (int i = 0; i < 24; ++i) {
        client.SendCommandResponse(std::string(4096, 'X'));
      }
    } else if (command == "OVERFLOW") {
      for (int i = 0; i < 72; ++i) {
        client.SendCommandResponse(std::string(4096, 'X'));
      }
    } else {
      client.SendCommandResponse("OK");
      std::string report = "EVENT";
      monitor->SendCommandToRemoteClients(report);
    }
  };
  monitor->Start();

  int ril_socket = socket(AF_UNIX, SOCK_STREAM, 0);
  assert(ril_socket >= 0);
  assert(connect(ril_socket, reinterpret_cast<sockaddr*>(&address), length) == 0);
  auto ril_peer = SharedFD::Own(ril_socket);
  WriteAll(ril_peer, "PING\r");
  std::string unsolicited = "RADIO-EVENT";
  monitor->SendUnsolicitedCommand(unsolicited);
  pollfd ril_ready{ril_peer->FD(), POLLIN, 0};
  char ril_buffer[256];
  std::string ril_response;
  while (ril_response.find("RADIO-EVENT") == std::string::npos ||
         ril_response.find("OK") == std::string::npos) {
    assert(poll(&ril_ready, 1, 3000) == 1);
    auto bytes = ril_peer->Read(ril_buffer, sizeof(ril_buffer));
    assert(bytes > 0);
    ril_response.append(ril_buffer, bytes);
    if (ril_response.find("RADIO-EVENT") == std::string::npos) {
      monitor->SendUnsolicitedCommand(unsolicited);
    }
  }
  // An accepted console peer that sends nothing must never block its caller or
  // the monitor thread. The server makes accepted descriptors nonblocking.
  int quiet[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, quiet) == 0);
  auto quiet_fd = SharedFD::Own(quiet[0]);
  auto quiet_peer = SharedFD::Own(quiet[1]);
  auto quiet_id = monitor->SetRemoteClient(quiet_fd, true);
  WriteAll(ril_peer, "PING\r");
  pollfd ril_ping{ril_peer->FD(), POLLIN, 0};
  assert(poll(&ril_ping, 1, 3000) == 1);
  auto ping_bytes = ril_peer->Read(ril_buffer, sizeof(ril_buffer));
  assert(ping_bytes > 0 && std::string(ril_buffer, ping_bytes).find("OK") != std::string::npos);
  assert(quiet_fd->Fcntl(F_GETFL, 0) & O_NONBLOCK);
  monitor->CloseRemoteConnection(quiet_id);
  quiet_peer->Close();
  ril_peer->Close();  // EOF also exercises the RIL client list.

  // Keep one peer open to assert registration, ordering, and command dispatch.
  int pair[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
  auto remote = SharedFD::Own(pair[0]);
  auto peer = SharedFD::Own(pair[1]);
  WriteAll(peer, "AT+CPIN?\r");
  auto id = monitor->SetRemoteClient(remote, true);
  std::string response = "QUEUED";
  monitor->SendRemoteCommand(id, response);
  pollfd check{peer->FD(), POLLIN, 0};
  assert(poll(&check, 1, 3000) == 1);
  char buffer[256];
  auto count = peer->Read(buffer, sizeof(buffer));
  assert(count > 0);
  std::string collected(buffer, count);
  while (collected.find("QUEUED") == std::string::npos) {
    assert(poll(&check, 1, 3000) == 1);
    count = peer->Read(buffer, sizeof(buffer));
    assert(count > 0);
    collected.append(buffer, count);
  }
  assert(collected.find("OK") != std::string::npos);
  monitor->CloseRemoteConnection(id);
  peer->Close();

  // Concurrent registration, broadcasts, explicit closes, and EOF teardown.
  std::mutex ids_mutex;
  std::vector<ClientId> ids;
  std::vector<std::thread> workers;
  for (int worker = 0; worker < 8; ++worker) {
    workers.emplace_back([&, worker]() {
      for (int iteration = 0; iteration < 300; ++iteration) {
        int sockets[2];
        assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
        auto fd = SharedFD::Own(sockets[0]);
        auto other = SharedFD::Own(sockets[1]);
        WriteAll(other, iteration % 2 ? "CLOSE\r" : "AT+CPIN?\r");
        auto client = monitor->SetRemoteClient(fd, true);
        {
          std::lock_guard<std::mutex> lock(ids_mutex);
          ids.push_back(client);
        }
        std::string event = "BROADCAST";
        monitor->SendCommandToRemoteClients(event);
        if ((iteration + worker) % 3 == 0) monitor->CloseRemoteConnection(client);
        other->Close();
      }
    });
  }
  for (auto& worker : workers) worker.join();
  for (size_t a = 0; a < ids.size(); ++a) {
    for (size_t b = 0; b < a; ++b) assert(!(ids[a] == ids[b]));
  }
  // A full-sized read must not rely on an accidental NUL after the buffer.
  int large[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, large) == 0);
  auto large_fd = SharedFD::Own(large[0]), large_peer = SharedFD::Own(large[1]);
  std::string full(4096, 'A'); full.back() = '\r';
  WriteAll(large_peer, full);
  auto large_id = monitor->SetRemoteClient(large_fd, true);
  check = {large_peer->FD(), POLLIN, 0};
  assert(poll(&check, 1, 10000) == 1);
  assert(large_peer->Read(buffer, sizeof(buffer)) > 0);
  monitor->CloseRemoteConnection(large_id);
  large_peer->Close();

  int malformed[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, malformed) == 0);
  auto malformed_fd = SharedFD::Own(malformed[0]);
  auto malformed_peer = SharedFD::Own(malformed[1]);
  auto malformed_id = monitor->SetRemoteClient(malformed_fd, true);
  std::string unterminated(70 * 1024, 'Q');
  WriteAll(malformed_peer, unterminated);
  const auto close_deadline = std::chrono::steady_clock::now() +
                              std::chrono::seconds(3);
  while (malformed_fd->IsOpen() &&
         std::chrono::steady_clock::now() < close_deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  assert(!malformed_fd->IsOpen());
  (void)malformed_id;
  malformed_peer->Close();

  int overflow[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, overflow) == 0);
  auto overflow_fd = SharedFD::Own(overflow[0]);
  auto overflow_peer = SharedFD::Own(overflow[1]);
  auto overflow_id = monitor->SetRemoteClient(overflow_fd, true);
  WriteAll(overflow_peer, "OVERFLOW\r");
  const auto overflow_deadline = std::chrono::steady_clock::now() +
                                 std::chrono::seconds(3);
  while (overflow_fd->IsOpen() &&
         std::chrono::steady_clock::now() < overflow_deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  assert(!overflow_fd->IsOpen());
  (void)overflow_id;
  overflow_peer->Close();

  // Force a partial write/EAGAIN, then confirm that the complete buffered
  // response is delivered while radio reads continue.
  int slow[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, slow) == 0);
  auto slow_fd = SharedFD::Own(slow[0]), slow_peer = SharedFD::Own(slow[1]);
  int small_buffer = 1024;
  assert(setsockopt(slow_fd->FD(), SOL_SOCKET, SO_SNDBUF,
                    &small_buffer, sizeof(small_buffer)) == 0);
  auto slow_id = monitor->SetRemoteClient(slow_fd, true);
  WriteAll(slow_peer, "BULK\r");
  int radio_socket = socket(AF_UNIX, SOCK_STREAM, 0);
  assert(radio_socket >= 0);
  assert(connect(radio_socket, reinterpret_cast<sockaddr*>(&address), length) == 0);
  auto radio_peer = SharedFD::Own(radio_socket);
  WriteAll(radio_peer, "PING\r");
  pollfd radio_ready{radio_peer->FD(), POLLIN, 0};
  assert(poll(&radio_ready, 1, 3000) == 1);
  char radio_response[64];
  auto radio_bytes = radio_peer->Read(radio_response, sizeof(radio_response));
  assert(radio_bytes > 0 &&
         std::string(radio_response, radio_bytes).find("OK") != std::string::npos);

  std::string bulk;
  pollfd slow_ready{slow_peer->FD(), POLLIN, 0};
  size_t parsed = 0;
  int responses = 0;
  while (responses < 24) {
    assert(poll(&slow_ready, 1, 10000) == 1);
    auto bytes = slow_peer->Read(buffer, sizeof(buffer));
    assert(bytes > 0);
    bulk.append(buffer, static_cast<size_t>(bytes));
    while (parsed < bulk.size()) {
      const size_t available = bulk.size() - parsed;
      if (bulk[parsed] == 'X') {
        if (available < 4097) break;
        assert(std::all_of(bulk.begin() + parsed, bulk.begin() + parsed + 4096,
                           [](char value) { return value == 'X'; }));
        assert(bulk[parsed + 4096] == '\r');
        parsed += 4097;
        ++responses;
      } else if (available >= 6 && bulk.compare(parsed, 6, "EVENT\r") == 0) {
        parsed += 6;
      } else if (available < 6) {
        break;
      } else {
        assert(false && "Slow-reader stream contained truncated or corrupt data");
      }
    }
  }
  monitor->CloseRemoteConnection(slow_id);
  slow_peer->Close();
  radio_peer->Close();
  // Shutdown must wake Select even when idle or notifications have coalesced.
  auto start = std::chrono::steady_clock::now();
  monitor.reset();
  assert(std::chrono::steady_clock::now() - start < std::chrono::seconds(5));
  assert(received.load() > 0);
  std::cout << "PASS: blocking idle clients, bounded commands and responses, RIL responsiveness, partial-write recovery, 2400 concurrent clients, queued callbacks, EOF, and shutdown\n";
}
