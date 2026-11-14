#include "jobs.hpp"

#include <exception>
#include <string_view>
#include <utility>

#include "siann/engine/offline.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/media/memory_reader.hpp"
#include "siann/media/peaks.hpp"
#include "siann/media/wav_file_reader.hpp"
#include "siann/session/media_import.hpp"

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

// Reads the media file (streaming for WAV; FLAC decoded into memory until a
// streaming reader exists, as the playback engine does) and writes its pyramid.
Value computePeaksFile(const PeaksRequest& request) {
    const std::filesystem::path file = session::mediaPath(request.bundle, request.contentHash, request.format);
    if (!std::filesystem::exists(file)) {
        throw engine::EngineError("media_missing", "no media file at " + utf8(file));
    }
    media::PeakPyramid pyramid;
    if (request.format == model::MediaFormat::flac) {
        media::MemoryMediaReader reader(media::decode(io::readFile(file)));
        pyramid = media::computePeaks(reader);
    } else {
        media::WavFileReader reader(file);
        pyramid = media::computePeaks(reader);
    }
    const std::filesystem::path written = media::writePeaks(request.bundle, hash::toHex(request.contentHash), pyramid);
    return Value(Object{{"path", Value(utf8(written))},
                        {"contentHash", Value(hash::formatHash(request.contentHash))},
                        {"levels", Value(static_cast<double>(pyramid.levels.size()))}});
}

}  // namespace

JobRunner::JobRunner(bool workerThread, std::function<void()> wake) : wake_(std::move(wake)) {
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

std::string JobRunner::startPeaks(PeaksRequest request) {
    std::string id;
    {
        std::lock_guard lock(mutex_);
        id = "job_" + std::to_string(next_++);
        Job job;
        job.id = id;
        job.kind = "peaks";
        job.peaks = std::move(request);
        jobs_.emplace(id, std::move(job));
        queue_.push_back(id);
    }
    changed_.notify_all();
    return id;
}

std::string JobRunner::startImport(ImportRequest request) {
    std::string id;
    {
        std::lock_guard lock(mutex_);
        id = "job_" + std::to_string(next_++);
        Job job;
        job.id = id;
        job.kind = "media.import";
        job.import = std::move(request);
        job.progress = std::make_shared<session::ImportProgress>();
        jobs_.emplace(id, std::move(job));
        queue_.push_back(id);
    }
    changed_.notify_all();
    return id;
}

std::vector<FinishedImport> JobRunner::takeFinishedImports() {
    std::lock_guard lock(mutex_);
    return std::exchange(finishedImports_, {});
}

void JobRunner::completeImport(const std::string& jobId, json::Value result) {
    {
        std::lock_guard lock(mutex_);
        auto it = jobs_.find(jobId);
        if (it == jobs_.end()) {
            return;
        }
        it->second.state = JobState::done;
        it->second.result = std::move(result);
    }
    changed_.notify_all();
}

void JobRunner::failImport(const std::string& jobId, std::string code, std::string message) {
    {
        std::lock_guard lock(mutex_);
        auto it = jobs_.find(jobId);
        if (it == jobs_.end()) {
            return;
        }
        fail(it->second, std::move(code), std::move(message));
    }
    changed_.notify_all();
}

void JobRunner::fail(Job& job, std::string code, std::string message) {
    job.state = JobState::failed;
    job.errorCode = std::move(code);
    job.errorMessage = std::move(message);
}

void JobRunner::cancelImports() {
    std::vector<FinishedImport> prepared;
    {
        std::lock_guard lock(mutex_);
        for (auto it = queue_.begin(); it != queue_.end();) {
            Job& job = jobs_.at(*it);
            if (job.kind != "media.import") {
                ++it;
                continue;
            }
            job.import.reset();
            fail(job, "cancelled", "the import was cancelled before it started");
            it = queue_.erase(it);
        }
        for (auto& [id, job] : jobs_) {
            if (job.kind == "media.import" && job.state == JobState::running && job.progress) {
                job.progress->cancel = true;
                if (job.liveSource != nullptr) {
                    job.liveSource->interrupt();
                }
            }
        }
        prepared = std::exchange(finishedImports_, {});
        for (const FinishedImport& finished : prepared) {
            fail(jobs_.at(finished.jobId), "cancelled", "the import was cancelled before its commit");
        }
    }
    for (const FinishedImport& finished : prepared) {
        session::discardImport(finished.prepared);
    }
    changed_.notify_all();
}

std::optional<JobState> JobRunner::state(const std::string& jobId) const {
    std::lock_guard lock(mutex_);
    auto it = jobs_.find(jobId);
    if (it == jobs_.end()) {
        return std::nullopt;
    }
    return it->second.state;
}

std::optional<std::pair<std::string, std::string>> JobRunner::failure(const std::string& jobId) const {
    std::lock_guard lock(mutex_);
    auto it = jobs_.find(jobId);
    if (it == jobs_.end() || it->second.state != JobState::failed) {
        return std::nullopt;
    }
    return std::pair{it->second.errorCode, it->second.errorMessage};
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
    if (job.state == JobState::running && job.progress) {
        out.emplace_back("progress",
                         Value(Object{{"framesDone", Value(std::to_string(job.progress->framesDone.load()))},
                                      {"framesTotal", Value(std::to_string(job.progress->framesTotal.load()))}}));
    }
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
    if (job.import) {
        ImportRequest request = std::move(*job.import);
        job.import.reset();
        runImport(lock, job, std::move(request));
        return true;
    }
    std::optional<RenderRequest> renderRequest = std::move(job.request);
    std::optional<PeaksRequest> peaksRequest = std::move(job.peaks);
    job.request.reset();
    job.peaks.reset();
    lock.unlock();

    Value result;
    std::string code;
    std::string message;
    try {
        result = peaksRequest ? computePeaksFile(*peaksRequest) : render(*renderRequest);
    } catch (const engine::EngineError& e) {
        code = e.code();
        message = e.what();
    } catch (const media::MediaError& e) {
        code = e.code();
        message = e.what();
    } catch (const std::exception& e) {
        code = "internal_error";
        message = e.what();
    } catch (...) {
        code = "internal_error";
        message = "the job threw a non-standard exception";
    }

    lock.lock();
    if (renderRequest && renderRequest->plugins) {
        // Destroyed on the command thread, never here (Jobs v0, plugins).
        finishedPlugins_.push_back(std::move(renderRequest->plugins));
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

// Called and returns with the lock held. The Job lives in a std::map, so the
// reference stays valid while the lock is released.
void JobRunner::runImport(std::unique_lock<std::mutex>& lock, Job& job, ImportRequest request) {
    const std::shared_ptr<session::ImportProgress> progress = job.progress;
    lock.unlock();

    std::optional<session::PreparedImport> prepared;
    std::string code;
    std::string message;
    try {
        session::ImportSource source =
            request.open ? request.open(request.path) : session::openImportSource(request.path);
        {
            std::lock_guard guard(mutex_);
            job.liveSource = source.audio.get();
        }
        try {
            prepared = session::prepareImport(request.bundle, request.sessionRate, source, progress.get());
        } catch (...) {
            std::lock_guard guard(mutex_);
            job.liveSource = nullptr;
            throw;
        }
        std::lock_guard guard(mutex_);
        job.liveSource = nullptr;
    } catch (const media::MediaError& e) {
        code = e.code();
        message = e.what();
    } catch (const io::IoError& e) {
        code = "io_error";
        message = e.what();
    } catch (const std::exception& e) {
        code = "internal_error";
        message = e.what();
    } catch (...) {
        code = "internal_error";
        message = "the import threw a non-standard exception";
    }

    lock.lock();
    bool ready = false;
    if (!code.empty()) {
        fail(job, std::move(code), std::move(message));
    } else if (progress->cancel) {
        // Cancelled after the last block: nothing of it may stay.
        session::discardImport(*prepared);
        fail(job, "cancelled", "the import was cancelled");
    } else {
        finishedImports_.push_back(FinishedImport{job.id, request.owner, std::move(*prepared)});
        ready = true;
    }
    changed_.notify_all();
    if (ready && wake_) {
        lock.unlock();
        wake_();
        lock.lock();
    }
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
