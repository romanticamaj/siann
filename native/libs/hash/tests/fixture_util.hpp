#pragma once

#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>

#include "siann/hash/json.hpp"

namespace siann::test {

inline std::string readFixtureText(const std::string& relativePath) {
    const std::string path = std::string(SIANN_FIXTURES_DIR) + "/" + relativePath;
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        throw std::runtime_error("cannot open fixture " + path);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

inline json::Value readFixture(const std::string& relativePath) {
    return json::parse(readFixtureText(relativePath));
}

}  // namespace siann::test
