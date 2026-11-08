#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <filesystem>
#include <map>
#include <random>
#include <string>

#include "plugin_double.hpp"
#include "siann/engine/offline.hpp"
#include "siann/graph/plugin_node.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/session.hpp"

// compileDocument with plugin slots (m4-plugin-node): PluginNodes sit between a
// track's clip player and its fader, in inserts order.

namespace fs = std::filesystem;
using siann::command::Command;
using siann::engine::MediaLibrary;
using siann::engine::PluginNodeSource;
using siann::engine::compileDocument;
using siann::engine::loadMedia;
using siann::engine::renderGraph;
using siann::media::AudioBuffer;
using siann::media::AudioInfo;
using siann::model::Document;
using siann::session::Session;
using siann::test::DoublePlugin;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-engine-plugin-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        fs::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }
    const fs::path& path() const { return path_; }

private:
    fs::path path_;
};

// Stereo noise, so a misaligned sum cannot pass for an aligned one.
fs::path writeNoise(const fs::path& file, std::int64_t frames) {
    AudioBuffer buffer;
    buffer.info = AudioInfo{2, 48'000, frames};
    buffer.samples.resize(static_cast<std::size_t>(frames * 2));
    std::mt19937 rng(7);
    std::uniform_real_distribution<float> dist(-0.5f, 0.5f);
    for (float& s : buffer.samples) {
        s = dist(rng);
    }
    siann::io::writeFileAtomic(file, siann::media::encodeWavFloat32(buffer));
    return file;
}

Command cmd(const std::string& json) {
    return Command::fromJson(siann::json::parse(json));
}

std::string insert(const std::string& slotId, const std::string& trackId, int index) {
    return R"({"op":"plugin.insert","trackId":")" + trackId + R"(","index":)" + std::to_string(index) +
           R"(,"slotId":")" + slotId + R"(","descriptor":{"format":"clap","uid":"double"},"stateBlob":null})";
}

struct Fixture {
    TempDir dir;
    Session session;

    Fixture() : session(Session::create(dir.path() / "Song.siann", Document::create("Song", 48'000), "test", "t0")) {
        siann::session::importMedia(session, writeNoise(dir.path() / "noise.wav", 4'000), "med_n", "test", "t1");
        session.commit({cmd(R"({"op":"track.add","trackId":"trk_a","name":"A","channels":2})"),
                        cmd(R"({"op":"track.add","trackId":"trk_b","name":"B","channels":2})"),
                        cmd(R"({"op":"clip.place","clipId":"clp_a","trackId":"trk_a","mediaId":"med_n",
                            "position":{"domain":"audio","value":"100"},"sourceStart":"0","length":"4000"})"),
                        cmd(R"({"op":"clip.place","clipId":"clp_b","trackId":"trk_b","mediaId":"med_n",
                            "position":{"domain":"audio","value":"300"},"sourceStart":"0","length":"4000"})")},
                       "test", "t2");
    }

    void exec(const std::string& json) { session.commit({cmd(json)}, "test", "t"); }
    const Document& doc() const { return session.history().head().document; }
    MediaLibrary library() const { return loadMedia(doc(), session.bundlePath()); }
};

class Source final : public PluginNodeSource {
public:
    std::unique_ptr<siann::graph::Node> pluginNode(const siann::model::PluginSlot& slot, int channels) const override {
        const auto it = plugins.find(slot.id);
        if (it == plugins.end()) {
            return nullptr;
        }
        auto node = std::make_unique<siann::graph::PluginNode>(*it->second, channels, 48'000, false);
        node->setBypass(slot.bypass);
        return node;
    }
    std::map<std::string, DoublePlugin*> plugins;
};

AudioBuffer render(const Document& doc, const MediaLibrary& library, const PluginNodeSource* source,
                   std::int64_t frames = 5'000) {
    auto graph = compileDocument(doc, library, 128, source);
    return renderGraph(*graph, 0, frames, 48'000);
}

}  // namespace

TEST_CASE("compileDocument runs a track's inserts in order between player and fader", "[engine][plugin]") {
    Fixture f;
    f.exec(insert("slt_1", "trk_a", 0));
    f.exec(insert("slt_0", "trk_a", 0));  // inserts: slt_0, slt_1
    std::atomic<int> sequence{0};
    DoublePlugin first(0, 2.0f);
    DoublePlugin second(0, 0.25f);
    first.sequence = &sequence;
    second.sequence = &sequence;
    Source source;
    source.plugins = {{"slt_0", &first}, {"slt_1", &second}};

    f.exec(R"({"op":"track.set_mute","trackId":"trk_b","mute":true})");
    const AudioBuffer dry = render(f.doc(), f.library(), nullptr);
    const AudioBuffer wet = render(f.doc(), f.library(), &source);
    CHECK(first.firstCall == 0);
    CHECK(second.firstCall == 1);
    REQUIRE(dry.samples.size() == wet.samples.size());
    bool halved = true;
    for (std::size_t i = 0; i < dry.samples.size(); ++i) {
        halved = halved && wet.samples[i] == dry.samples[i] * 0.5f;
    }
    CHECK(halved);

    // The fader comes after the inserts: a muted track still runs them.
    f.exec(R"({"op":"track.set_mute","trackId":"trk_a","mute":true})");
    const int callsBefore = first.calls.load();
    (void)render(f.doc(), f.library(), &source);
    CHECK(first.calls.load() > callsBefore);
}

TEST_CASE("A slot without an instance passes audio through", "[engine][plugin]") {
    Fixture f;
    const AudioBuffer before = render(f.doc(), f.library(), nullptr);
    f.exec(insert("slt_1", "trk_a", 0));
    Source empty;
    CHECK(render(f.doc(), f.library(), &empty).samples == before.samples);
    CHECK(render(f.doc(), f.library(), nullptr).samples == before.samples);
}

TEST_CASE("A bypassed slot passes audio through without processing", "[engine][plugin]") {
    Fixture f;
    const AudioBuffer before = render(f.doc(), f.library(), nullptr);
    f.exec(insert("slt_1", "trk_a", 0));
    f.exec(R"({"op":"plugin.set_bypass","slotId":"slt_1","bypass":true})");
    DoublePlugin plugin(300, 3.0f);
    Source source;
    source.plugins = {{"slt_1", &plugin}};
    CHECK(render(f.doc(), f.library(), &source).samples == before.samples);
    CHECK(plugin.calls.load() == 0);
}

TEST_CASE("PDC null test: a latency-reporting plugin on one track still lines up with the other", "[engine][plugin][pdc]") {
    Fixture f;
    const AudioBuffer reference = render(f.doc(), f.library(), nullptr);
    f.exec(insert("slt_1", "trk_a", 0));
    DoublePlugin plugin(333);
    Source source;
    source.plugins = {{"slt_1", &plugin}};
    auto graph = compileDocument(f.doc(), f.library(), 128, &source);
    CHECK(graph->totalLatency() == 333);
    const AudioBuffer delayed = renderGraph(*graph, 0, 5'000, 48'000);
    REQUIRE(delayed.samples.size() == reference.samples.size());
    // Null: the compensated render minus the plugin-free one is silence.
    float worst = 0.0f;
    for (std::size_t i = 0; i < reference.samples.size(); ++i) {
        worst = std::max(worst, std::abs(delayed.samples[i] - reference.samples[i]));
    }
    CHECK(worst == 0.0f);
}
