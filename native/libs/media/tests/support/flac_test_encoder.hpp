#pragma once

// A minimal FLAC encoder for tests: 16-bit samples, fixed block size, VERBATIM
// subframes, real CRC-8 and CRC-16. It is independent of the decoder under
// test, so decoded values can be checked exactly (sample / 32768).

#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace siann::test {

class BitWriter {
public:
    void put(std::uint64_t value, int bits) {
        for (int i = bits - 1; i >= 0; --i) {
            current_ = static_cast<std::uint8_t>((current_ << 1) | ((value >> i) & 1u));
            if (++filled_ == 8) {
                bytes_.push_back(static_cast<char>(current_));
                current_ = 0;
                filled_ = 0;
            }
        }
    }
    const std::string& bytes() const {
        if (filled_ != 0) {
            throw std::logic_error("bit writer is not byte aligned");
        }
        return bytes_;
    }

private:
    std::string bytes_;
    std::uint8_t current_ = 0;
    int filled_ = 0;
};

inline std::uint8_t flacCrc8(const std::string& data) {
    std::uint8_t crc = 0;
    for (const char c : data) {
        crc ^= static_cast<std::uint8_t>(c);
        for (int i = 0; i < 8; ++i) {
            crc = static_cast<std::uint8_t>((crc & 0x80) != 0 ? (crc << 1) ^ 0x07 : crc << 1);
        }
    }
    return crc;
}

inline std::uint16_t flacCrc16(const std::string& data) {
    std::uint16_t crc = 0;
    for (const char c : data) {
        crc ^= static_cast<std::uint16_t>(static_cast<std::uint8_t>(c) << 8);
        for (int i = 0; i < 8; ++i) {
            crc = static_cast<std::uint16_t>((crc & 0x8000) != 0 ? (crc << 1) ^ 0x8005 : crc << 1);
        }
    }
    return crc;
}

// samples: interleaved 16-bit values, frames * channels.
inline std::string encodeFlac16(int channels, std::uint32_t sampleRate, const std::vector<std::int16_t>& samples,
                                int blockSize = 16) {
    const auto frames = static_cast<std::uint64_t>(samples.size() / static_cast<std::size_t>(channels));
    if (blockSize < 16 || blockSize > 256 || frames == 0 || (frames + static_cast<std::uint64_t>(blockSize) - 1) /
                                                                   static_cast<std::uint64_t>(blockSize) > 127) {
        throw std::invalid_argument("test encoder limits: block 16..256, up to 127 frames");
    }

    BitWriter info;
    info.put(1, 1);   // last metadata block
    info.put(0, 7);   // STREAMINFO
    info.put(34, 24);
    info.put(static_cast<std::uint64_t>(blockSize), 16);
    info.put(static_cast<std::uint64_t>(blockSize), 16);
    info.put(0, 24);  // min frame size unknown
    info.put(0, 24);  // max frame size unknown
    info.put(sampleRate, 20);
    info.put(static_cast<std::uint64_t>(channels - 1), 3);
    info.put(15, 5);  // 16 bits per sample
    info.put(frames, 36);
    for (int i = 0; i < 16; ++i) {
        info.put(0, 8);  // MD5 unknown
    }
    std::string out = "fLaC" + info.bytes();

    std::uint64_t start = 0;
    for (int frameNumber = 0; start < frames; ++frameNumber) {
        const std::uint64_t count = std::min<std::uint64_t>(static_cast<std::uint64_t>(blockSize), frames - start);
        BitWriter header;
        header.put(0xFFF8, 16);  // sync, reserved, fixed block size
        header.put(6, 4);        // block size: 8 bits (n - 1) at the end of the header
        header.put(0, 4);        // sample rate from STREAMINFO
        header.put(static_cast<std::uint64_t>(channels - 1), 4);  // independent channels
        header.put(4, 3);        // 16 bits per sample
        header.put(0, 1);
        header.put(static_cast<std::uint64_t>(frameNumber), 8);   // UTF-8 coded, < 128
        header.put(count - 1, 8);
        std::string frame = header.bytes();
        frame.push_back(static_cast<char>(flacCrc8(frame)));

        BitWriter body;
        for (int c = 0; c < channels; ++c) {
            body.put(0x02, 8);  // VERBATIM subframe, no wasted bits
            for (std::uint64_t i = 0; i < count; ++i) {
                const auto s = samples[static_cast<std::size_t>((start + i) * static_cast<std::uint64_t>(channels) +
                                                                static_cast<std::uint64_t>(c))];
                body.put(static_cast<std::uint16_t>(s), 16);
            }
        }
        frame += body.bytes();
        const std::uint16_t crc = flacCrc16(frame);
        frame.push_back(static_cast<char>(crc >> 8));
        frame.push_back(static_cast<char>(crc & 0xFF));
        out += frame;
        start += count;
    }
    return out;
}

}  // namespace siann::test
