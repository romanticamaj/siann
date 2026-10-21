#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "siann/hash/json.hpp"
#include "siann/time/tempo_map.hpp"

using siann::json::Value;
using siann::time::AudioTime;
using siann::time::MusicTime;
using siann::time::TempoMap;
using siann::time::TempoPoint;

namespace {

Value readFixture(const std::string& relativePath) {
    std::ifstream in(std::string(SIANN_FIXTURES_DIR) + "/" + relativePath, std::ios::binary);
    REQUIRE(in.good());
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return siann::json::parse(buffer.str());
}

std::int64_t asInt64(const Value& value) {
    return std::stoll(value.asString());
}

}  // namespace

TEST_CASE("Shared time conversion fixtures", "[time][fixtures]") {
    const Value fixture = readFixture("time/conversions.json");
    REQUIRE(fixture.find("schemaVersion")->asString() == "siann.time_fixtures.v1");
    REQUIRE(fixture.find("ticksPerQuarter")->asNumber() == static_cast<double>(siann::time::kTicksPerQuarter));
    REQUIRE(fixture.find("superclockRate")->asNumber() == static_cast<double>(siann::time::kSuperclockRate));

    std::size_t checked = 0;
    for (const Value& entry : fixture.find("cases")->asArray()) {
        const std::string& name = entry.find("name")->asString();
        std::vector<TempoPoint> points;
        for (const Value& point : entry.find("tempoPoints")->asArray()) {
            points.push_back(TempoPoint{MusicTime{asInt64(*point.find("ticks"))},
                                        static_cast<std::int32_t>(point.find("milliBpm")->asNumber())});
        }
        const auto& expectedScpq = entry.find("superclocksPerQuarter")->asArray();
        for (std::size_t i = 0; i < points.size(); ++i) {
            INFO(name << " point " << i);
            CHECK(siann::time::superclocksPerQuarter(points[i].milliBpm) == asInt64(expectedScpq[i]));
        }
        const TempoMap map(points);
        for (const Value& conversion : entry.find("conversions")->asArray()) {
            const auto rate = static_cast<std::int64_t>(conversion.find("sampleRate")->asNumber());
            for (const Value& pair : conversion.find("toAudio")->asArray()) {
                const auto& items = pair.asArray();
                INFO(name << " @" << rate << " toAudio ticks " << items[0].asString());
                CHECK(map.toAudio(MusicTime{asInt64(items[0])}, rate).samples == asInt64(items[1]));
                ++checked;
            }
            for (const Value& pair : conversion.find("toMusic")->asArray()) {
                const auto& items = pair.asArray();
                INFO(name << " @" << rate << " toMusic samples " << items[0].asString());
                CHECK(map.toMusic(AudioTime{asInt64(items[0])}, rate).ticks == asInt64(items[1]));
                ++checked;
            }
        }
    }
    CHECK(checked > 1000);
}
