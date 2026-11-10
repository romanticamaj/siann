#include <catch2/catch_test_macros.hpp>

#include <string>

#include "siann/host/plugin_registry.hpp"

// host::PluginRegistry (m5-plugin-registry; architecture spec, "siann-host-api",
// Protocol v0 item 21): installs keyed by {format, path}, approved by the user,
// resolved by {format, uid} with the slot's path as a hint.

using siann::host::ApproveOutcome;
using siann::host::PluginInstall;
using siann::host::PluginRegistry;

namespace {

constexpr const char* kUid = "org.siann.test-plugin";

// A registry with `count` probed installs of kUid at /p/<n>.clap, approved or not.
PluginRegistry probed(int count, bool approved) {
    PluginRegistry registry;
    for (int i = 0; i < count; ++i) {
        const std::string path = "/p/" + std::to_string(i) + ".clap";
        registry.addScanned("clap", path, std::to_string(i));
        REQUIRE(registry.setProbed("clap", path, kUid, "Test"));
        if (approved) {
            REQUIRE(registry.approve("clap", path, true) == ApproveOutcome::done);
        }
    }
    return registry;
}

}  // namespace

TEST_CASE("plugin registry: a scanned install keeps what is known of it", "[host][registry]") {
    PluginRegistry registry;
    const PluginInstall& first = registry.addScanned("clap", "/p/a.clap", "a");
    CHECK(first.format == "clap");
    CHECK(first.path == "/p/a.clap");
    CHECK_FALSE(first.uid.has_value());
    CHECK(first.name == "a");
    CHECK_FALSE(first.approved);
    REQUIRE(registry.setProbed("clap", "/p/a.clap", kUid, "Test"));
    REQUIRE(registry.approve("clap", "/p/a.clap", true) == ApproveOutcome::done);

    // The same {format, path} again (a second scan): uid, name and approval stay.
    const PluginInstall& again = registry.addScanned("clap", "/p/a.clap", "a");
    CHECK(again.uid == std::optional<std::string>{kUid});
    CHECK(again.name == "Test");
    CHECK(again.approved);
    CHECK(registry.installs().size() == 1);

    // Another format at the same path is another install.
    registry.addScanned("vst3", "/p/a.clap", "a");
    CHECK(registry.installs().size() == 2);
    CHECK_FALSE(registry.find("vst3", "/p/a.clap")->approved);
    CHECK(registry.find("clap", "/p/b.clap") == nullptr);
}

TEST_CASE("plugin registry: approving needs a probe result first", "[host][registry]") {
    PluginRegistry registry;
    registry.addScanned("clap", "/p/a.clap", "a");
    CHECK(registry.approve("clap", "/p/a.clap", true) == ApproveOutcome::not_probed);
    CHECK_FALSE(registry.find("clap", "/p/a.clap")->approved);
    // Unapproving needs none.
    CHECK(registry.approve("clap", "/p/a.clap", false) == ApproveOutcome::done);
    CHECK(registry.approve("clap", "/p/b.clap", true) == ApproveOutcome::not_registered);
    CHECK_FALSE(registry.setProbed("clap", "/p/b.clap", kUid, "Test"));

    REQUIRE(registry.setProbed("clap", "/p/a.clap", kUid, "Test"));
    CHECK(registry.approve("clap", "/p/a.clap", true) == ApproveOutcome::done);
    CHECK(registry.find("clap", "/p/a.clap")->approved);
}

TEST_CASE("plugin registry: restore merges a kept entry onto a scanned path only", "[host][registry]") {
    PluginRegistry registry;
    registry.addScanned("clap", "/p/a.clap", "a");
    CHECK(registry.restore(PluginInstall{"clap", "/p/a.clap", kUid, "Test", true}));
    CHECK(registry.find("clap", "/p/a.clap")->approved);
    CHECK(registry.find("clap", "/p/a.clap")->uid == std::optional<std::string>{kUid});
    // An approval for a path nothing scanned adds nothing.
    CHECK_FALSE(registry.restore(PluginInstall{"clap", "/elsewhere/x.clap", kUid, "Test", true}));
    CHECK(registry.installs().size() == 1);
}

TEST_CASE("plugin registry: resolve by uid with the path as a hint", "[host][registry]") {
    SECTION("no install") {
        const auto resolved = PluginRegistry{}.resolve("clap", kUid, "");
        CHECK_FALSE(resolved.install.has_value());
        CHECK(resolved.code == "plugin_not_registered");
        CHECK_FALSE(resolved.message.empty());
    }
    SECTION("one approved install, whatever the hint") {
        const PluginRegistry registry = probed(1, true);
        for (const char* hint : {"", "/p/0.clap", "/elsewhere/copy.clap"}) {
            const auto resolved = registry.resolve("clap", kUid, hint);
            REQUIRE(resolved.install.has_value());
            CHECK(resolved.install->path == "/p/0.clap");
        }
        CHECK(registry.resolve("vst3", kUid, "").code == "plugin_not_registered");
        CHECK(registry.resolve("clap", "org.example.other", "").code == "plugin_not_registered");
    }
    SECTION("two approved installs: the hint chooses") {
        const PluginRegistry registry = probed(2, true);
        const auto chosen = registry.resolve("clap", kUid, "/p/1.clap");
        REQUIRE(chosen.install.has_value());
        CHECK(chosen.install->path == "/p/1.clap");
        // Separators and dot segments do not make another path.
        const auto spelled = registry.resolve("clap", kUid, "/p/./x/../1.clap");
        REQUIRE(spelled.install.has_value());
        CHECK(spelled.install->path == "/p/1.clap");
        for (const char* hint : {"", "/elsewhere/copy.clap"}) {
            const auto ambiguous = registry.resolve("clap", kUid, hint);
            CHECK_FALSE(ambiguous.install.has_value());
            CHECK(ambiguous.code == "plugin_not_registered");
            CHECK(ambiguous.message.find("ambiguous") != std::string::npos);
        }
    }
    SECTION("an install never resolves while it is not approved") {
        PluginRegistry registry = probed(1, true);
        REQUIRE(registry.approve("clap", "/p/0.clap", false) == ApproveOutcome::done);
        const auto resolved = registry.resolve("clap", kUid, "/p/0.clap");
        CHECK_FALSE(resolved.install.has_value());
        CHECK(resolved.code == "plugin_not_approved");
        // An unprobed install at the hint is not approved either.
        PluginRegistry scanned;
        scanned.addScanned("clap", "/p/0.clap", "0");
        CHECK(scanned.resolve("clap", kUid, "/p/0.clap").code == "plugin_not_approved");
        CHECK(scanned.resolve("clap", kUid, "").code == "plugin_not_registered");
    }
    SECTION("the hint's reason is in the message") {
        const PluginRegistry registry;
        CHECK(registry.resolve("clap", kUid, "/elsewhere/copy.clap").message.find("unregistered_path") !=
              std::string::npos);
        const auto refused = registry.resolve("clap", kUid, "//server/share/x.clap", "unc_path");
        CHECK(refused.code == "plugin_not_registered");
        CHECK(refused.message.find("unc_path") != std::string::npos);
        // A refused hint never chooses, even when it is a registered path.
        const PluginRegistry two = probed(2, true);
        const auto ignored = two.resolve("clap", kUid, "/p/1.clap", "inside_bundle");
        CHECK_FALSE(ignored.install.has_value());
        CHECK(ignored.message.find("inside_bundle") != std::string::npos);
    }
}
