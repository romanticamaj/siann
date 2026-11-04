// The running build's source location and commit reach every client
// (ADR-0017, point 4; AGPL section 13): in the auth reply and engine.about.

#include <catch2/catch_test_macros.hpp>

#include <cstdio>
#include <regex>
#include <string>

#include "support/protocol_fixture.hpp"
#include "siann/protocol/about.hpp"

namespace json = siann::json;
using namespace siann::protocol::testing;
using siann::protocol::ConnectionId;

#ifndef SIANN_TEST_SOURCE_DIR
#define SIANN_TEST_SOURCE_DIR "."
#endif
#ifndef SIANN_TEST_WITH_JUCE
#define SIANN_TEST_WITH_JUCE 0
#endif

namespace {

// `git rev-parse HEAD` of the source tree, or empty when git is unavailable.
std::string gitHead() {
    const std::string command = std::string("git -C \"") + SIANN_TEST_SOURCE_DIR + "\" rev-parse HEAD";
#if defined(_WIN32)
    FILE* pipe = _popen(command.c_str(), "r");
#else
    FILE* pipe = popen(command.c_str(), "r");
#endif
    if (pipe == nullptr) {
        return {};
    }
    std::string out;
    char buffer[128];
    while (std::fgets(buffer, sizeof buffer, pipe) != nullptr) {
        out += buffer;
    }
#if defined(_WIN32)
    const int status = _pclose(pipe);
#else
    const int status = pclose(pipe);
#endif
    while (!out.empty() && (out.back() == '\n' || out.back() == '\r')) {
        out.pop_back();
    }
    return status == 0 ? out : std::string();
}

void checkAbout(const Value& about) {
    INFO(canonical(about));
    CHECK(at(about, "name").asString() == "siann-engine");
    CHECK_FALSE(at(about, "version").asString().empty());
    const Value& source = at(about, "source");
    CHECK(at(source, "url").asString() == "https://github.com/romanticamaj/siann");
    const std::string commit = at(source, "commit").asString();
    CHECK(std::regex_match(commit, std::regex("^[0-9a-f]{40}$")));
    CHECK(at(source, "dirty").kind() == Value::Kind::boolean);
    CHECK(at(about, "license").asString() == (SIANN_TEST_WITH_JUCE ? "AGPL-3.0-or-later" : "GPL-2.0-or-later"));
}

}  // namespace

TEST_CASE("the auth reply and engine.about carry the source location and commit", "[protocol][about]") {
    Fixture f;
    const ConnectionId connection = f.authed(false);
    const Value hello = json::parse(f.transport.sent(connection)[0]);
    checkAbout(at(hello, "about"));

    const Value about = f.ok(connection, "engine.about");
    checkAbout(about);
    CHECK(canonical(about) == canonical(at(hello, "about")));
    CHECK(canonical(about) == canonical(siann::protocol::aboutJson()));

    const std::string head = gitHead();
    if (std::regex_match(head, std::regex("^[0-9a-f]{40}$"))) {
        // Built from this checkout: the commit is the checkout's HEAD.
        CHECK(at(at(about, "source"), "commit").asString() == head);
        CHECK(siann::protocol::buildInfo().commit == head);
    } else {
        WARN("git is not available; the commit is not compared with HEAD");
    }
}
