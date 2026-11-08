#include "jobs.hpp"

#include <exception>
#include <string_view>
#include <utility>

#include "siann/engine/offline.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"

namespace siann::protocol::detail {

namespace {

using json::Object;
using json::Value;

std::string utf8(const std::filesystem::path& path) {
    const std::u8string text = path.u8string();
    return std::string(text.begin(), text.end());
}

std::string_view stateName(JobState state) noexcept {
    switch (state) {
        case JobState::queued: return "queued";
        case JobState::running: return "running";
        case JobState::done: return "done";
        case JobState::failed: return "failed";
    }
    return "failed";
}

// Renders and writes the file; returns the job result.
Value render(const RenderRequest& request) {
    const engine::MediaLibrary library = engine::loadMedia(request.document, request.bundle);
    const media::AudioBuffer rendered = engine::renderOffline(
        request.document, library, engine::RenderOptions{request.start, request.frames, 512}, request.plugins.get());
    const std::string bytes = media::encodeWavFloat32(rendered);
    const std::filesystem::path directory = request.bundle / "renders";
    io::createDirectoriesDurable(directory);
    const std::filesystem::path file = directory / std::filesystem::path(std::u8string(
                                                       reinterpret_cast<const char8_t*>(request.name.data()),
                                                       request.name.size()) +
                                                   u8".wav");
    io::writeFileAtomic(file, bytes);
    return Value(Object{{"path", Value(utf8(file))},
                        {"frames", Value(std::to_string(rendered.info.frames))},
                        {"sampleRate", Value(static_cast<double>(rendered.info.sampleRate))},
                        {"channels", Value(static_cast<double>(rendered.info.channels))},
                        {"contentHash", Value(hash::formatHash(hash::sha256(bytes)))}});
}

}  // namespace

JobRunner::JobRunner(bool workerThread) {
    if (workerThread) {
        worker_ = std::thread([this] { work(); });
    }
}

JobRunner::~JobRunner() {
    stop();
}

void JobRunner::stop() {
    {
        std::lock_guard lock(mutex_);
        stopping_ = true;
    }
    changed_.notify_all();
    if (worker_.joinable()) {
        worker_.join();
    }
}

std::string JobRunner::startRender(RenderRequest request) {
    std::string id;
    {
        std::lock_guard lock(mutex_);
        id = "job_" + std::to_string(next_++);
        Job job;
        job.id = id;
        job.request = std::move(request);
        jobs_.emplace(id, std::move(job));
        queue_.push_back(id);
    }
    changed_.notify_all();
    return id;
}

std::string JobRunner::recordDone(std::string kind, json::Value result) {
    std::lock_guard lock(mutex_);
    const std::string id = "job_" + std::to_string(next_++);
    Job job;
    job.id = id;
    job.kind = std::move(kind);
    job.state = JobState::done;
    job.result = std::move(result);
    jobs_.emplace(id, std::move(job));
    return id;
}

std::string JobRunner::recordFailed(std::string kind, std::string code, std::string message) {
    std::lock_guard lock(mutex_);
    const std::string id = "job_" + std::to_string(next_++);
    Job job;
    job.id = id;
    job.kind = std::move(kind);
    job.state = JobState::failed;
    job.errorCode = std::move(code);
    job.errorMessage = std::move(message);
    jobs_.emplace(id, std::move(job));
    return id;
}

std::vector<std::shared_ptr<engine::PluginNodeSource>> JobRunner::takeFinishedPlugins() {
    std::lock_guard lock(mutex_);
    return std::exchange(finishedPlugins_, {});
}

std::optional<json::Value> JobRunner::status(const std::string& jobId) const {
    std::lock_guard lock(mutex_);
    auto it = jobs_.find(jobId);
    if (it == jobs_.end()) {
        return std::nullopt;
    }
    const Job& job = it->second;
    Object out{{"jobId", Value(job.id)},
               {"kind", Value(job.kind)},
               {"state", Value(std::string(stateName(job.state)))}};
    if (job.state == JobState::done) {
        out.emplace_back("result", job.result);
    } else if (job.state == JobState::failed) {
        out.emplace_back("error", Value(Object{{"code", Value(job.errorCode)}, {"message", Value(job.errorMessage)}}));
    }
    return Value(std::move(out));
}

bool JobRunner::runOne(std::unique_lock<std::mutex>& lock) {
    if (queue_.empty()) {
        return false;
    }
    Job& job = jobs_.at(queue_.front());
    queue_.pop_front();
    job.state = JobState::running;
    RenderRequest request = std::move(*job.request);
    job.request.reset();
    lock.unlock();

    Value result;
    std::string code;
    std::string message;
    try {
        result = render(request);
    } catch (const engine::EngineError& e) {
        code = e.code();
        message = e.what();
    } catch (const std::exception& e) {
        code = "internal_error";
        message = e.what();
    } catch (...) {
        code = "internal_error";
        message = "the render threw a non-standard exception";
    }

    lock.lock();
    if (request.plugins) {
        // Destroyed on the command thread, never here (Jobs v0, plugins).
        finishedPlugins_.push_back(std::move(request.plugins));
    }
    if (code.empty()) {
        job.state = JobState::done;
        job.result = std::move(result);
    } else {
        job.state = JobState::failed;
        job.errorCode = std::move(code);
        job.errorMessage = std::move(message);
    }
    changed_.notify_all();
    return true;
}

std::size_t JobRunner::runQueued() {
    std::unique_lock lock(mutex_);
    std::size_t ran = 0;
    while (runOne(lock)) {
        ++ran;
    }
    return ran;
}

void JobRunner::work() {
    std::unique_lock lock(mutex_);
    for (;;) {
        changed_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
        if (stopping_) {
            return;
        }
        runOne(lock);
    }
}

bool JobRunner::wait(const std::string& jobId, std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    if (jobs_.find(jobId) == jobs_.end()) {
        return false;
    }
    return changed_.wait_for(lock, timeout, [&] {
        const JobState state = jobs_.at(jobId).state;
        return state == JobState::done || state == JobState::failed;
    });
}

}  // namespace siann::protocol::detail
