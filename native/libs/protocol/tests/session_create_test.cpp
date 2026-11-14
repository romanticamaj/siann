// session.create (m5b-engine-project-media; architecture spec, Protocol v0 item 27;
// docs/schemas/protocol-engine-v0.md): an empty bundle at an absolute path that
// does not exist, served as session.open serves one, at the device's rate.

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "support/protocol_fixture.hpp"
#include "support/rate_port.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;
using protocol::ServerOptions;

namespace fs = std::filesystem;

namespace {

std::string utf8(const fs::path& path) {
    const std::u8string text = path.u8string();
    return std::string(text.begin(), text.end());
}

std::string requestFor(const std::string& sessionId, const std::string& requestId, const std::string& method) {
    return jcs::canonicalize(Value(Object{{"requestId", Value(requestId)},
                                          {"sessionId", Value(sessionId)},
                                          {"method", Value(method)},
                                          {"params", Value(Object{})}}));
}

// What siann-engine's callback does: create the new bundle (taking its lock), then
// let the old session go (releasing its lock).
struct Creator {
    std::optional<session::Session> served;
    std::vector<std::pair<fs::path, std::string>> calls;
    std::vector<std::int64_t> rates;

    session::Session& create(const fs::path& path, const std::string& name, std::int64_t rate) {
        calls.emplace_back(path, name);
        rates.push_back(rate);
        session::Session next =
            session::Session::create(path, model::Document::create(name, rate), "tester", "2026-11-14T00:00:00Z");
        served.reset();
        served.emplace(std::move(next));
        return *served;
    }
};

ServerOptions withCreator(Creator& creator, protocol::TransportPort* port) {
    ServerOptions options = manualOptions();
    options.transportPort = port;
    options.createSession = [&creator](const fs::path& path, const std::string& name, std::int64_t rate)
        -> session::Session& { return creator.create(path, name, rate); };
    return options;
}

}  // namespace

TEST_CASE("session.create makes an empty bundle at the device rate and serves it", "[protocol][session][create]") {
    TempDir dir;
    Creator creator;
    creator.served.emplace(session::Session::create(dir.bundle(), model::Document::create("Song", 48'000), "tester",
                                                    "2026-11-14T00:00:00Z"));
    RatePort port(44'100);
    Harness h(*creator.served, withCreator(creator, &port));
    const ConnectionId c = h.authed();
    const ConnectionId watcher = h.authed(true);
    const std::string oldId = h.server.sessionId();
    const fs::path oldBundle = dir.bundle();
    const fs::path target = dir.bundle().parent_path() / "Fresh Song.siann";

    const Value result = h.ok(c, "session.create", Value(Object{{"path", Value(utf8(target))}}));
    REQUIRE(creator.calls.size() == 1);
    CHECK(creator.calls[0].first == target);
    CHECK(creator.calls[0].second == "Fresh Song");
    CHECK(creator.rates[0] == 44'100);

    const std::string newId = at(result, "sessionId").asString();
    CHECK(newId != oldId);
    CHECK(newId.rfind("ses_", 0) == 0);
    CHECK(at(result, "revision").asString() == "r1");
    const auto& head = h.server.session().history().head();
    CHECK(at(result, "documentHash").asString() == hash::formatHash(head.envelope.documentHash));
    CHECK(head.document.root().name == "Fresh Song");
    CHECK(head.document.root().sampleRate == 44'100);
    CHECK(head.document.tracksInOrder().empty());
    CHECK(fs::exists(target / "session.json"));
    CHECK(fs::exists(target / "journal.ndjson"));
    CHECK(fs::exists(target / "lock"));

    const auto events = h.events(watcher);
    REQUIRE_FALSE(events.empty());
    CHECK(at(events.back(), "type").asString() == "session.opened");
    CHECK(at(events.back(), "sessionId").asString() == newId);

    h.transport.deliver(c, requestFor(oldId, "late", "session.inspect"));
    h.server.pump();
    CHECK(errorCode(json::parse(h.transport.sent(c).back())) == "session_mismatch");
    CHECK(at(h.ok(c, "session.inspect"), "revision").asString() == "r1");

    // The previous bundle's lock went with its session; the new one is held.
    CHECK_FALSE(fs::exists(oldBundle / "lock"));
    { const session::Session reopened = session::Session::open(oldBundle); }
    CHECK_THROWS_AS(session::Session::open(target), session::SessionError);

    // A given name is the root's name.
    const fs::path named = dir.bundle().parent_path() / "Other.siann";
    h.ok(c, "session.create", Value(Object{{"path", Value(utf8(named))}, {"name", Value("Night Drive")}}));
    CHECK(h.server.session().history().head().document.root().name == "Night Drive");
}

TEST_CASE("session.create runs at 48000 without a device or without a transport port", "[protocol][session][create]") {
    for (const bool withPort : {true, false}) {
        INFO(withPort);
        TempDir dir;
        Creator creator;
        creator.served.emplace(session::Session::create(dir.bundle(), model::Document::create("Song", 44'100),
                                                        "tester", "2026-11-14T00:00:00Z"));
        RatePort port(std::nullopt);
        Harness h(*creator.served, withCreator(creator, withPort ? &port : nullptr));
        const ConnectionId c = h.authed();
        h.ok(c, "session.create", Value(Object{{"path", Value(utf8(dir.bundle().parent_path() / "New.siann"))}}));
        REQUIRE(creator.rates.size() == 1);
        CHECK(creator.rates[0] == 48'000);
        CHECK(h.server.session().history().head().document.root().sampleRate == 48'000);
    }
}

TEST_CASE("session.create refuses an existing, relative, UNC or orphaned path and creates nothing",
          "[protocol][session][create]") {
    TempDir dir;
    Creator creator;
    creator.served.emplace(session::Session::create(dir.bundle(), model::Document::create("Song", 48'000), "tester",
                                                    "2026-11-14T00:00:00Z"));
    RatePort port(48'000);
    Harness h(*creator.served, withCreator(creator, &port));
    const ConnectionId c = h.authed();
    const fs::path root = dir.bundle().parent_path();
    const std::string servedId = h.server.sessionId();

    const fs::path file = root / "file.siann";
    io::writeFileAtomic(file, "not a bundle");
    const fs::path empty = root / "Empty.siann";
    fs::create_directories(empty);
    const auto entriesBefore = [&] {
        std::vector<fs::path> out;
        for (const auto& entry : fs::recursive_directory_iterator(root)) {
            out.push_back(entry.path());
        }
        return out;
    }();

    const std::vector<std::pair<Value, std::string>> cases = {
        {Value(utf8(file)), "already_exists"},
        {Value(utf8(empty)), "already_exists"},
        {Value(utf8(dir.bundle())), "already_exists"},
        {Value(utf8(fs::path("relative") / "New.siann")), "invalid_params"},
        {Value("\\\\server\\share\\New.siann"), "invalid_params"},
        {Value("\\\\?\\UNC\\server\\share\\New.siann"), "invalid_params"},
        {Value("//server/share/New.siann"), "invalid_params"},
        {Value(utf8(root / "missing" / "New.siann")), "not_found"},
        {Value(42), "invalid_params"},
    };
    for (const auto& [path, code] : cases) {
        INFO(canonical(path));
        CHECK(errorCode(h.call(c, "session.create", Value(Object{{"path", path}}))) == code);
    }
    CHECK(errorCode(h.call(c, "session.create", Value(Object{}))) == "invalid_params");
    CHECK(creator.calls.empty());
    CHECK(h.server.sessionId() == servedId);
    std::vector<fs::path> entriesAfter;
    for (const auto& entry : fs::recursive_directory_iterator(root)) {
        entriesAfter.push_back(entry.path());
    }
    CHECK(entriesAfter == entriesBefore);
    CHECK(fs::is_empty(empty));
}

TEST_CASE("without a createSession callback session.create is not_supported", "[protocol][session][create]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const fs::path target = f.dir.bundle().parent_path() / "New.siann";
    CHECK(errorCode(f.call(c, "session.create", Value(Object{{"path", Value(utf8(target))}}))) == "not_supported");
    CHECK_FALSE(fs::exists(target));
}
